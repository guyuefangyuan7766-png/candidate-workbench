import { createReadStream } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parentPort, workerData } from 'node:worker_threads'
import { createInflateRaw } from 'node:zlib'
import { SaxesParser } from 'saxes'

const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50
const ZIP64_EXTRA_FIELD = 0x0001
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50
const MAX_ZIP_FILENAME_BYTES = 4_096
const SPREADSHEETML_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const DOCUMENT_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PACKAGE_RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships'
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/'
const WORKSHEET_RELATIONSHIP_TYPES = new Set([
  `${DOCUMENT_RELATIONSHIPS_NAMESPACE}/worksheet`,
  'http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet'
])

const CRC32_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  CRC32_TABLE[index] = value >>> 0
}

function importError(status, message, code = 'import_parse_error', details) {
  const error = new Error(message)
  error.status = status
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

function formatResourceLimit(value) {
  return new Intl.NumberFormat('en-US').format(value)
}

function assertDeadline(startedAt, limits) {
  if (performance.now() - startedAt <= limits.maxParseMs) return
  throw importError(422, `文件解析超过 ${Math.ceil(limits.maxParseMs / 1000)} 秒安全时限`, 'import_parse_timeout')
}

function reportProgress(phase, progress, metrics = undefined) {
  parentPort?.postMessage({
    type: 'progress',
    phase,
    progress,
    ...(metrics ? { metrics } : {})
  })
}

function createResourceTracker(limits) {
  const startedAt = performance.now()
  let cells = 0
  let characters = 0

  return {
    limits,
    inspect(value) {
      cells += 1
      if (cells > limits.maxCells) {
        throw importError(
          422,
          `文件包含的单元格超过 ${formatResourceLimit(limits.maxCells)} 个解析安全限制`,
          'import_cell_limit_exceeded'
        )
      }
      const length = typeof value === 'string' ? value.length : String(value ?? '').length
      if (length > limits.maxCellCharacters) {
        throw importError(
          422,
          `文件包含超过 ${formatResourceLimit(limits.maxCellCharacters)} 字符的单元格`,
          'import_cell_text_limit_exceeded'
        )
      }
      characters += length
      if (characters > limits.maxTotalCharacters) {
        throw importError(
          422,
          `文件提取文本超过 ${formatResourceLimit(limits.maxTotalCharacters)} 字符安全限制`,
          'import_text_limit_exceeded'
        )
      }
      if ((cells & 0x3fff) === 0) assertDeadline(startedAt, limits)
      return value
    },
    checkDeadline() {
      assertDeadline(startedAt, limits)
    },
    snapshot() {
      return { cells, characters }
    }
  }
}

async function readExactly(handle, length, position, code = 'import_zip_invalid') {
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(position) || position < 0) {
    throw importError(422, 'Excel ZIP 数据范围无效', code)
  }
  const buffer = Buffer.alloc(length)
  let total = 0
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, position + total)
    if (bytesRead === 0) throw importError(422, 'Excel ZIP 数据被截断', code)
    total += bytesRead
  }
  return buffer
}

function findEndOfCentralDirectory(tail, tailStart, fileSize) {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) continue
    const commentLength = tail.readUInt16LE(offset + 20)
    if (tailStart + offset + 22 + commentLength === fileSize) return offset
  }
  return -1
}

function assertNoZip64Extra(extra) {
  let cursor = 0
  while (cursor < extra.length) {
    if (cursor + 4 > extra.length) throw importError(422, 'Excel ZIP 扩展字段损坏', 'import_zip_invalid')
    const fieldId = extra.readUInt16LE(cursor)
    const fieldLength = extra.readUInt16LE(cursor + 2)
    cursor += 4
    if (cursor + fieldLength > extra.length) throw importError(422, 'Excel ZIP 扩展字段损坏', 'import_zip_invalid')
    if (fieldId === ZIP64_EXTRA_FIELD) {
      throw importError(422, '暂不支持 ZIP64 Excel 容器', 'import_zip64_unsupported')
    }
    cursor += fieldLength
  }
}

function decodeEntryName(bytes, utf8) {
  try {
    return utf8 ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes.toString('latin1')
  } catch {
    throw importError(422, 'Excel ZIP 条目名称编码无效', 'import_zip_invalid')
  }
}

function canonicalEntryName(name) {
  if (
    !name ||
    Buffer.byteLength(name, 'utf8') > MAX_ZIP_FILENAME_BYTES ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[a-z]:/i.test(name) ||
    name.includes(':')
  ) {
    throw importError(422, 'Excel ZIP 包含不安全的内部路径', 'import_zip_unsafe_path')
  }
  const path = name.endsWith('/') ? name.slice(0, -1) : name
  const parts = path.split('/')
  if (!path || parts.some((part) => !part || part === '.' || part === '..')) {
    throw importError(422, 'Excel ZIP 包含不安全的内部路径', 'import_zip_unsafe_path')
  }
  return name.normalize('NFC').toLowerCase()
}

function assertSupportedFlags(flags, compressionMethod) {
  if ((flags & 0x0041) !== 0 || (flags & 0x2000) !== 0) {
    throw importError(422, '不支持加密的 Excel 文件', 'import_encrypted')
  }
  const allowed = compressionMethod === 8 ? 0x080e : 0x0808
  if ((flags & ~allowed) !== 0) {
    throw importError(422, 'Excel ZIP 使用了不支持的条目标志', 'import_zip_invalid')
  }
}

function isSymlink(versionMadeBy, externalAttributes) {
  const creatorSystem = versionMadeBy >>> 8
  if (creatorSystem !== 3) return false
  return ((externalAttributes >>> 16) & 0xf000) === 0xa000
}

async function readDataDescriptor(handle, dataEnd, centralOffset, entry) {
  const available = centralOffset - dataEnd
  if (available < 12) throw importError(422, 'Excel ZIP 数据描述符缺失', 'import_zip_header_mismatch')
  const descriptor = await readExactly(handle, Math.min(16, available), dataEnd, 'import_zip_header_mismatch')
  const matchesUnsigned =
    descriptor.readUInt32LE(0) === entry.crc32 &&
    descriptor.readUInt32LE(4) === entry.compressedSize &&
    descriptor.readUInt32LE(8) === entry.uncompressedSize
  if (matchesUnsigned) return 12
  const matchesSigned =
    descriptor.length >= 16 &&
    descriptor.readUInt32LE(0) === ZIP_DATA_DESCRIPTOR_SIGNATURE &&
    descriptor.readUInt32LE(4) === entry.crc32 &&
    descriptor.readUInt32LE(8) === entry.compressedSize &&
    descriptor.readUInt32LE(12) === entry.uncompressedSize
  if (matchesSigned) return 16
  throw importError(422, 'Excel ZIP 数据描述符与中央目录不一致', 'import_zip_header_mismatch')
}

async function parseCentralDirectory(handle, fileSize, limits) {
  const tailLength = Math.min(fileSize, 65_557)
  const tailStart = fileSize - tailLength
  const tail = await readExactly(handle, tailLength, tailStart)
  const eocdInTail = findEndOfCentralDirectory(tail, tailStart, fileSize)
  if (eocdInTail < 0) {
    throw importError(422, 'Excel ZIP 容器缺少中央目录，文件可能已损坏', 'import_zip_invalid')
  }
  const eocdOffset = tailStart + eocdInTail
  if (eocdOffset >= 20 && tailStart <= eocdOffset - 20) {
    const locatorOffset = eocdInTail - 20
    if (locatorOffset >= 0 && tail.readUInt32LE(locatorOffset) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
      throw importError(422, '暂不支持 ZIP64 Excel 容器', 'import_zip64_unsupported')
    }
  }

  const diskNumber = tail.readUInt16LE(eocdInTail + 4)
  const centralDisk = tail.readUInt16LE(eocdInTail + 6)
  const entriesOnDisk = tail.readUInt16LE(eocdInTail + 8)
  const entryCount = tail.readUInt16LE(eocdInTail + 10)
  const centralSize = tail.readUInt32LE(eocdInTail + 12)
  const centralOffset = tail.readUInt32LE(eocdInTail + 16)
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw importError(422, '不支持跨卷或分段 Excel ZIP 容器', 'import_zip_invalid')
  }
  if (
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw importError(422, '暂不支持 ZIP64 Excel 容器', 'import_zip64_unsupported')
  }
  if (entryCount < 1 || entryCount > limits.maxZipEntries) {
    throw importError(
      422,
      `Excel 容器条目必须在 1 至 ${formatResourceLimit(limits.maxZipEntries)} 个之间`,
      'import_zip_entry_limit_exceeded'
    )
  }
  if (
    centralSize > limits.maxCentralDirectoryBytes ||
    centralOffset > eocdOffset ||
    centralOffset + centralSize !== eocdOffset
  ) {
    throw importError(422, 'Excel ZIP 中央目录范围无效', 'import_zip_invalid')
  }

  const central = await readExactly(handle, centralSize, centralOffset)
  const entries = []
  const names = new Set()
  const localOffsets = new Set()
  let cursor = 0
  let declaredTotal = 0
  let worksheetCount = 0
  let hasContentTypes = false
  let hasWorkbook = false

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw importError(422, 'Excel ZIP 中央目录条目损坏', 'import_zip_invalid')
    }
    const versionMadeBy = central.readUInt16LE(cursor + 4)
    const versionNeeded = central.readUInt16LE(cursor + 6)
    const flags = central.readUInt16LE(cursor + 8)
    const compressionMethod = central.readUInt16LE(cursor + 10)
    const crc32 = central.readUInt32LE(cursor + 16)
    const compressedSize = central.readUInt32LE(cursor + 20)
    const uncompressedSize = central.readUInt32LE(cursor + 24)
    const filenameLength = central.readUInt16LE(cursor + 28)
    const extraLength = central.readUInt16LE(cursor + 30)
    const commentLength = central.readUInt16LE(cursor + 32)
    const diskStart = central.readUInt16LE(cursor + 34)
    const externalAttributes = central.readUInt32LE(cursor + 38)
    const localHeaderOffset = central.readUInt32LE(cursor + 42)
    const entryEnd = cursor + 46 + filenameLength + extraLength + commentLength
    if (entryEnd > central.length || filenameLength === 0) {
      throw importError(422, 'Excel ZIP 文件名或扩展字段损坏', 'import_zip_invalid')
    }
    if (
      versionNeeded >= 45 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      diskStart === 0xffff
    ) {
      throw importError(422, '暂不支持 ZIP64 Excel 条目', 'import_zip64_unsupported')
    }
    if (diskStart !== 0) throw importError(422, '不支持跨卷 Excel ZIP 条目', 'import_zip_invalid')
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw importError(
        422,
        `Excel ZIP 包含不支持的压缩算法 ${compressionMethod}`,
        'import_zip_compression_unsupported'
      )
    }
    assertSupportedFlags(flags, compressionMethod)
    if (isSymlink(versionMadeBy, externalAttributes)) {
      throw importError(422, 'Excel ZIP 包含不安全的符号链接条目', 'import_zip_unsafe_path')
    }

    const filenameBytes = central.subarray(cursor + 46, cursor + 46 + filenameLength)
    const extra = central.subarray(cursor + 46 + filenameLength, cursor + 46 + filenameLength + extraLength)
    assertNoZip64Extra(extra)
    const name = decodeEntryName(filenameBytes, (flags & 0x0800) !== 0)
    const canonical = canonicalEntryName(name)
    if (names.has(canonical)) {
      throw importError(422, 'Excel ZIP 包含重复的内部路径', 'import_zip_duplicate_path')
    }
    names.add(canonical)
    if (localOffsets.has(localHeaderOffset)) {
      throw importError(422, 'Excel ZIP 多个条目指向同一本地记录', 'import_zip_header_mismatch')
    }
    localOffsets.add(localHeaderOffset)

    if (uncompressedSize > limits.maxEntryUncompressedBytes) {
      throw importError(422, 'Excel 容器包含解压后过大的单个条目', 'import_uncompressed_limit_exceeded')
    }
    declaredTotal += uncompressedSize
    if (declaredTotal > limits.maxUncompressedBytes) {
      throw importError(422, 'Excel 文件声明的解压总体积超过安全限制', 'import_uncompressed_limit_exceeded')
    }
    if (name === '[Content_Types].xml') hasContentTypes = true
    if (name === 'xl/workbook.xml') hasWorkbook = true
    if (/^xl\/worksheets\/[^/]+\.xml$/i.test(name)) worksheetCount += 1

    entries.push({
      name,
      canonicalName: canonical,
      filenameBytes: Buffer.from(filenameBytes),
      versionNeeded,
      flags,
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dataStart: 0,
      dataEnd: 0,
      localRangeEnd: 0
    })
    cursor = entryEnd
  }

  if (cursor !== central.length || !hasContentTypes || !hasWorkbook || worksheetCount === 0) {
    throw importError(422, 'ZIP 容器不是完整的 Excel 工作簿', 'import_zip_invalid')
  }
  if (worksheetCount > limits.maxWorksheets) {
    throw importError(
      422,
      `工作表数量超过 ${limits.maxWorksheets} 个解析安全限制`,
      'import_worksheet_limit_exceeded'
    )
  }

  for (const entry of entries) {
    if (entry.localHeaderOffset + 30 > centralOffset) {
      throw importError(422, 'Excel ZIP 本地条目范围无效', 'import_zip_invalid')
    }
    const local = await readExactly(handle, 30, entry.localHeaderOffset)
    if (local.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) {
      throw importError(422, 'Excel ZIP 本地条目签名无效', 'import_zip_invalid')
    }
    const localVersionNeeded = local.readUInt16LE(4)
    const localFlags = local.readUInt16LE(6)
    const localMethod = local.readUInt16LE(8)
    const localCrc32 = local.readUInt32LE(14)
    const localCompressedSize = local.readUInt32LE(18)
    const localUncompressedSize = local.readUInt32LE(22)
    const localFilenameLength = local.readUInt16LE(26)
    const localExtraLength = local.readUInt16LE(28)
    if (
      localVersionNeeded !== entry.versionNeeded ||
      localFlags !== entry.flags ||
      localMethod !== entry.compressionMethod
    ) {
      throw importError(422, 'Excel ZIP 中央目录与本地条目头不一致', 'import_zip_header_mismatch')
    }
    if (
      localVersionNeeded >= 45 ||
      localCompressedSize === 0xffffffff ||
      localUncompressedSize === 0xffffffff
    ) {
      throw importError(422, '暂不支持 ZIP64 Excel 条目', 'import_zip64_unsupported')
    }
    const usesDescriptor = (entry.flags & 0x0008) !== 0
    if (usesDescriptor) {
      const localValuesAreZero = localCrc32 === 0 && localCompressedSize === 0 && localUncompressedSize === 0
      const localValuesMatch =
        localCrc32 === entry.crc32 &&
        localCompressedSize === entry.compressedSize &&
        localUncompressedSize === entry.uncompressedSize
      if (!localValuesAreZero && !localValuesMatch) {
        throw importError(422, 'Excel ZIP 本地条目大小与中央目录不一致', 'import_zip_header_mismatch')
      }
    } else if (
      localCrc32 !== entry.crc32 ||
      localCompressedSize !== entry.compressedSize ||
      localUncompressedSize !== entry.uncompressedSize
    ) {
      throw importError(422, 'Excel ZIP 本地条目大小与中央目录不一致', 'import_zip_header_mismatch')
    }

    const variableLength = localFilenameLength + localExtraLength
    if (entry.localHeaderOffset + 30 + variableLength > centralOffset) {
      throw importError(422, 'Excel ZIP 本地条目名称范围无效', 'import_zip_invalid')
    }
    const variable = await readExactly(handle, variableLength, entry.localHeaderOffset + 30)
    const localFilenameBytes = variable.subarray(0, localFilenameLength)
    if (!localFilenameBytes.equals(entry.filenameBytes)) {
      throw importError(422, 'Excel ZIP 中央目录与本地条目名称不一致', 'import_zip_header_mismatch')
    }
    assertNoZip64Extra(variable.subarray(localFilenameLength))

    entry.dataStart = entry.localHeaderOffset + 30 + variableLength
    entry.dataEnd = entry.dataStart + entry.compressedSize
    if (entry.dataEnd > centralOffset || entry.dataEnd > fileSize) {
      throw importError(422, 'Excel ZIP 压缩数据范围无效', 'import_zip_invalid')
    }
    const descriptorLength = usesDescriptor
      ? await readDataDescriptor(handle, entry.dataEnd, centralOffset, entry)
      : 0
    entry.localRangeEnd = entry.dataEnd + descriptorLength
  }

  const ranges = [...entries].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset)
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].localHeaderOffset < ranges[index - 1].localRangeEnd) {
      throw importError(422, 'Excel ZIP 本地条目范围重叠', 'import_zip_header_mismatch')
    }
  }
  return entries
}

function updateCrc32(state, chunk) {
  let value = state
  for (const byte of chunk) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return value >>> 0
}

function createSharedStringCollector() {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const values = []
  let inItem = false
  let inText = false
  let current = ''
  const parser = new SaxesParser({ xmlns: false })
  const localName = (value) => String(value ?? '').split(':').at(-1)
  parser.on('opentag', (node) => {
    const name = localName(node.name)
    if (name === 'si') {
      inItem = true
      current = ''
    } else if (inItem && name === 't') {
      inText = true
    }
  })
  parser.on('text', (value) => {
    if (inItem && inText) current += value
  })
  parser.on('cdata', (value) => {
    if (inItem && inText) current += value
  })
  parser.on('closetag', (node) => {
    const name = localName(node.name)
    if (name === 't') inText = false
    if (name === 'si') {
      values.push(current)
      current = ''
      inItem = false
    }
  })
  return {
    values,
    write(chunk) {
      parser.write(decoder.decode(chunk, { stream: true }))
    },
    finish() {
      parser.write(decoder.decode())
      parser.close()
    }
  }
}

async function verifyEntryPayload(handle, entry, limits, totalActualBytes, { collect = false, onChunk } = {}) {
  if (entry.compressedSize === 0) {
    if (entry.uncompressedSize !== 0 || entry.crc32 !== 0) {
      throw importError(422, 'Excel ZIP 条目声明大小与实际内容不一致', 'import_zip_size_mismatch')
    }
    return 0
  }

  let actualSize = 0
  let crcState = 0xffffffff
  const collected = collect ? [] : null
  const counter = new Writable({
    write(chunk, _encoding, callback) {
      actualSize += chunk.length
      if (
        actualSize > limits.maxEntryUncompressedBytes ||
        totalActualBytes + actualSize > limits.maxUncompressedBytes
      ) {
        callback(importError(422, 'Excel 文件实际解压大小超过安全限制', 'import_uncompressed_limit_exceeded'))
        return
      }
      if (actualSize > entry.compressedSize * limits.maxCompressionRatio) {
        callback(importError(422, 'Excel ZIP 实际压缩比异常，已阻止解析', 'import_zip_ratio_limit_exceeded'))
        return
      }
      crcState = updateCrc32(crcState, chunk)
      if (collected) collected.push(Buffer.from(chunk))
      onChunk?.(chunk)
      callback()
    }
  })
  const source = handle.createReadStream({
    start: entry.dataStart,
    end: entry.dataEnd - 1,
    autoClose: false,
    highWaterMark: 64 * 1024
  })
  try {
    if (entry.compressionMethod === 0) await pipeline(source, counter)
    else await pipeline(source, createInflateRaw(), counter)
  } catch (cause) {
    if (cause?.status) throw cause
    throw importError(422, 'Excel ZIP 压缩数据已损坏或无法安全解压', 'import_zip_invalid')
  }
  if (source.bytesRead !== entry.compressedSize) {
    throw importError(422, 'Excel ZIP 压缩数据被截断', 'import_zip_invalid')
  }
  if (actualSize !== entry.uncompressedSize) {
    throw importError(422, 'Excel ZIP 条目声明大小与实际内容不一致', 'import_zip_size_mismatch')
  }
  const actualCrc32 = (crcState ^ 0xffffffff) >>> 0
  if (actualCrc32 !== entry.crc32) {
    throw importError(422, 'Excel ZIP 条目 CRC 校验失败', 'import_zip_crc_mismatch')
  }
  if (collected) entry.payload = Buffer.concat(collected)
  return actualSize
}

async function inspectZipContainer(path, limits) {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    if (size < 22) throw importError(422, 'Excel ZIP 容器不完整', 'import_zip_invalid')
    const entries = await parseCentralDirectory(handle, size, limits)
    let totalActualBytes = 0
    const sharedStrings = createSharedStringCollector()
    let hasSharedStrings = false
    for (const entry of entries) {
      const isSharedStrings = entry.name.toLowerCase() === 'xl/sharedstrings.xml'
      hasSharedStrings ||= isSharedStrings
      totalActualBytes += await verifyEntryPayload(handle, entry, limits, totalActualBytes, {
        collect: entry.name === 'xl/workbook.xml' || entry.name === 'xl/_rels/workbook.xml.rels',
        onChunk: isSharedStrings ? (chunk) => sharedStrings.write(chunk) : undefined
      })
    }
    if (hasSharedStrings) sharedStrings.finish()
    const categoryBytes = {
      worksheets: 0,
      shared_strings: 0,
      styles: 0,
      workbook: 0,
      media: 0,
      other: 0
    }
    for (const entry of entries) {
      const name = entry.name.toLowerCase()
      const category = /^xl\/worksheets\//.test(name)
        ? 'worksheets'
        : name === 'xl/sharedstrings.xml'
          ? 'shared_strings'
          : name === 'xl/styles.xml'
            ? 'styles'
            : name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels'
              ? 'workbook'
              : /^xl\/media\//.test(name)
                ? 'media'
                : 'other'
      categoryBytes[category] += entry.uncompressedSize
    }
    return {
      validated_entries: entries,
      compressed_bytes: size,
      zip_entries: entries.length,
      worksheet_entries: entries.filter((entry) => /^xl\/worksheets\/[^/]+\.xml$/i.test(entry.name)).length,
      declared_uncompressed_bytes: entries.reduce((total, entry) => total + entry.uncompressedSize, 0),
      actual_uncompressed_bytes: totalActualBytes,
      uncompressed_bytes_by_category: categoryBytes,
      workbook_xml: entries.find((entry) => entry.name === 'xl/workbook.xml')?.payload?.toString('utf8') ?? null,
      workbook_rels_xml: entries.find((entry) => entry.name === 'xl/_rels/workbook.xml.rels')?.payload?.toString('utf8') ?? null,
      shared_strings: hasSharedStrings ? sharedStrings.values : null
    }
  } finally {
    await handle.close()
  }
}

async function* readValidatedZipEntry(path, entry, limits, tracker) {
  if (entry.compressedSize === 0) return
  const handle = await open(path, 'r')
  const source = handle.createReadStream({
    start: entry.dataStart,
    end: entry.dataEnd - 1,
    autoClose: false,
    highWaterMark: 64 * 1024
  })
  const payload = entry.compressionMethod === 0 ? source : createInflateRaw()
  if (payload !== source) {
    source.on('error', (error) => payload.destroy(error))
    source.pipe(payload)
  }
  let actualSize = 0
  let crcState = 0xffffffff
  try {
    for await (const chunk of payload) {
      actualSize += chunk.length
      if (actualSize > entry.uncompressedSize) {
        throw importError(422, 'Excel ZIP 条目声明大小与实际内容不一致', 'import_zip_size_mismatch')
      }
      if (actualSize > limits.maxEntryUncompressedBytes) {
        throw importError(422, 'Excel 文件实际解压大小超过安全限制', 'import_uncompressed_limit_exceeded')
      }
      if (actualSize > entry.compressedSize * limits.maxCompressionRatio) {
        throw importError(422, 'Excel ZIP 实际压缩比异常，已阻止解析', 'import_zip_ratio_limit_exceeded')
      }
      crcState = updateCrc32(crcState, chunk)
      tracker.checkDeadline()
      yield chunk
    }
    if (source.bytesRead !== entry.compressedSize) {
      throw importError(422, 'Excel ZIP 压缩数据被截断', 'import_zip_invalid')
    }
    if (actualSize !== entry.uncompressedSize) {
      throw importError(422, 'Excel ZIP 条目声明大小与实际内容不一致', 'import_zip_size_mismatch')
    }
    if (((crcState ^ 0xffffffff) >>> 0) !== entry.crc32) {
      throw importError(422, 'Excel ZIP 条目 CRC 校验失败', 'import_zip_crc_mismatch')
    }
  } catch (cause) {
    if (cause?.status) throw cause
    throw importError(422, 'Excel ZIP 压缩数据已损坏或无法安全解压', 'import_zip_invalid')
  } finally {
    payload.destroy()
    if (payload !== source) source.destroy()
    await handle.close()
  }
}

function cellValue(value) {
  if (value == null) return null
  if (value instanceof Date) {
    const date = [value.getFullYear(), value.getMonth() + 1, value.getDate()]
      .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
      .join('-')
    const hasTime = value.getHours() || value.getMinutes() || value.getSeconds() || value.getMilliseconds()
    if (!hasTime) return date
    const time = [value.getHours(), value.getMinutes(), value.getSeconds()]
      .map((part) => String(part).padStart(2, '0'))
      .join(':')
    return `${date}T${time}`
  }
  if (typeof value !== 'object') return value
  if ('result' in value) return cellValue(value.result)
  if ('text' in value) return value.text
  if ('hyperlink' in value) return value.text ?? value.hyperlink
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('')
  if ('code' in value && typeof value.code === 'string') return value.code
  return String(value)
}

function uniqueHeaderValues(headerValues) {
  const seen = new Map()
  const values = []
  for (let index = 0; index < headerValues.length; index += 1) {
    const raw = String(headerValues[index] ?? '').trim() || `未命名列${index + 1}`
    const count = seen.get(raw) ?? 0
    seen.set(raw, count + 1)
    values.push(count === 0 ? raw : `${raw}_${count + 1}`)
  }
  return values
}

function assertColumnCount(count, limits) {
  if (count <= limits.maxColumns) return
  throw importError(
    422,
    `工作表列数超过 ${formatResourceLimit(limits.maxColumns)} 列解析安全限制`,
    'import_column_limit_exceeded'
  )
}

function buildRecord(headers, sourceValues, rowNumber, tracker) {
  assertColumnCount(sourceValues.length, tracker.limits)
  const record = {}
  let populated = false
  const inspected = sourceValues.map((raw) => tracker.inspect(cellValue(raw)))
  for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
    const value = inspected[columnIndex] ?? null
    if (value != null && String(value).trim() !== '') populated = true
    record[headers[columnIndex]] = value
  }
  return populated ? { row_number: rowNumber, values: record } : null
}

function rowsFromLegacySheet(sheet, limits, tracker) {
  if (!sheet || sheet.rows.length < 1) {
    throw importError(422, '文件中没有可读取的工作表或表头', 'import_empty_workbook')
  }
  assertColumnCount(sheet.rows[0]?.length ?? 0, limits)
  const headers = uniqueHeaderValues((sheet.rows[0] ?? []).map((value) => tracker.inspect(cellValue(value))))
  const rows = []
  for (let rowIndex = 1; rowIndex < sheet.rows.length; rowIndex += 1) {
    const sourceValues = sheet.rows[rowIndex] ?? []
    assertColumnCount(sourceValues.length, limits)
    const record = buildRecord(headers, sourceValues, rowIndex + 1, tracker)
    if (record) rows.push(record)
  }
  tracker.checkDeadline()
  if (rows.length === 0) throw importError(422, '文件只有表头，没有数据行', 'import_empty_workbook')
  return { headers, rows, sheetName: sheet.name }
}

async function legacyXlsToRows(file, limits, tracker) {
  let sheet
  try {
    const { readFirstSheet, XlsError } = await import('xls-reader')
    sheet = readFirstSheet(await readFile(file.path))
  } catch (cause) {
    if (cause?.status) throw cause
    const { XlsError } = await import('xls-reader')
    throw importError(
      422,
      cause instanceof XlsError
        ? '无法读取该 .xls；仅支持未加密的 Excel 97-2003 BIFF8 工作簿'
        : '解析 .xls 时发生错误，文件可能已损坏或不是 BIFF8 工作簿',
      'request_error'
    )
  }
  return rowsFromLegacySheet(sheet, limits, tracker)
}

async function xlsxToRowsMaterialized(file, limits, tracker, metrics) {
  const zipStartedAt = performance.now()
  Object.assign(metrics, await inspectZipContainer(file.path, limits))
  metrics.zip_security_ms = Math.round(performance.now() - zipStartedAt)
  metrics.peak_rss_bytes = Math.max(metrics.peak_rss_bytes, process.memoryUsage().rss)
  const rows = []
  let headers = null
  let sheetName = null
  try {
    const { default: ExcelJS } = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    const workbookStartedAt = performance.now()
    await workbook.xlsx.load(await readFile(file.path), {
      ignoreNodes: [
        'sheetPr',
        'sheetViews',
        'sheetFormatPr',
        'cols',
        'autoFilter',
        'mergeCells',
        'rowBreaks',
        'hyperlinks',
        'pageMargins',
        'dataValidations',
        'pageSetup',
        'headerFooter',
        'printOptions',
        'picture',
        'drawing',
        'sheetProtection',
        'tableParts',
        'conditionalFormatting',
        'extLst'
      ]
    })
    metrics.workbook_load_ms = Math.round(performance.now() - workbookStartedAt)
    metrics.peak_rss_bytes = Math.max(metrics.peak_rss_bytes, process.memoryUsage().rss)
    if (workbook.worksheets.length > limits.maxWorksheets) {
      throw importError(
        422,
        `工作表数量超过 ${limits.maxWorksheets} 个解析安全限制`,
        'import_worksheet_limit_exceeded'
      )
    }
    const iterationStartedAt = performance.now()
    for (let worksheetIndex = 0; worksheetIndex < workbook.worksheets.length; worksheetIndex += 1) {
      const worksheet = workbook.worksheets[worksheetIndex]
      assertColumnCount(worksheet.columnCount, limits)
      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const width = row.cellCount ?? 0
        assertColumnCount(width, limits)
        const values = Array.from({ length: width }, (_, index) => cellValue(row.getCell(index + 1).value))
        if (worksheetIndex !== 0) {
          for (const value of values) tracker.inspect(value)
          return
        }
        if (rowNumber === 1) {
          headers = uniqueHeaderValues(values.map((value) => tracker.inspect(value)))
          sheetName = worksheet.name
          return
        }
        const record = buildRecord(headers ?? [], values, rowNumber, tracker)
        if (record) rows.push(record)
      })
      tracker.checkDeadline()
    }
    metrics.worksheet_iteration_ms = Math.round(performance.now() - iterationStartedAt)
    metrics.worksheets = workbook.worksheets.length
    metrics.peak_rss_bytes = Math.max(metrics.peak_rss_bytes, process.memoryUsage().rss)
  } catch (cause) {
    if (cause?.status) throw cause
    throw importError(
      422,
      '无法解析 Excel 工作簿；文件可能已损坏、加密或包含不受支持的结构',
      'import_xlsx_invalid'
    )
  }
  tracker.checkDeadline()
  if (!headers) throw importError(422, '文件中没有可读取的工作表或表头', 'import_empty_workbook')
  if (rows.length === 0) throw importError(422, '文件只有表头，没有数据行', 'import_empty_workbook')
  return { headers, rows, sheetName }
}

function invalidXlsxStructure() {
  return importError(
    422,
    'Unable to parse the Excel workbook; it may be damaged, encrypted, or unsupported.',
    'import_xlsx_invalid'
  )
}

function xmlAttribute(node, local, uri = '') {
  return Object.values(node.attributes ?? {}).find((attribute) => attribute.local === local && attribute.uri === uri)?.value
}

function parseNamespacedXmlPart(xml, expectedRoot, visitElement) {
  if (typeof xml !== 'string' || xml.length === 0) throw invalidXlsxStructure()
  const stack = []
  let rootSeen = false
  let rootPrefix = ''
  let parseFailure = null
  const parser = new SaxesParser({ xmlns: true })

  parser.on('error', () => {
    parseFailure ??= invalidXlsxStructure()
  })
  parser.on('doctype', () => {
    parseFailure ??= invalidXlsxStructure()
  })
  parser.on('opentag', (node) => {
    if (parseFailure) return
    if (stack.length === 0) {
      if (rootSeen || node.local !== expectedRoot.local || node.uri !== expectedRoot.uri) {
        throw invalidXlsxStructure()
      }
      rootSeen = true
      rootPrefix = node.prefix
    } else if (rootPrefix && node.prefix === rootPrefix && node.uri !== expectedRoot.uri) {
      throw invalidXlsxStructure()
    }
    visitElement?.(node, stack.at(-1) ?? null, stack)
    stack.push(node)
  })
  parser.on('closetag', () => {
    stack.pop()
  })

  try {
    parser.write(xml)
    parser.close()
  } catch (cause) {
    if (cause?.status) throw cause
    parseFailure ??= invalidXlsxStructure()
  }
  if (parseFailure || !rootSeen || stack.length !== 0) throw parseFailure ?? invalidXlsxStructure()
}

function parseWorkbookXml(workbookXml) {
  const sheets = []
  const sheetIds = new Set()
  const relationshipIds = new Set()
  const properties = { model: {} }
  let sheetsElementSeen = false
  parseNamespacedXmlPart(
    workbookXml,
    { local: 'workbook', uri: SPREADSHEETML_NAMESPACE },
    (node, parent, ancestors) => {
      if (node.uri !== SPREADSHEETML_NAMESPACE) return
      const directWorkbookChild =
        ancestors.length === 1 &&
        ancestors[0].local === 'workbook' &&
        ancestors[0].uri === SPREADSHEETML_NAMESPACE
      if (node.local === 'workbookPr') {
        if (!directWorkbookChild) throw invalidXlsxStructure()
        const date1904 = xmlAttribute(node, 'date1904')
        if (date1904 !== undefined) {
          if (!['0', '1', 'false', 'true'].includes(date1904)) throw invalidXlsxStructure()
          properties.model.date1904 = date1904 === '1' || date1904 === 'true'
        }
        return
      }
      if (node.local === 'sheets') {
        if (!directWorkbookChild || sheetsElementSeen) throw invalidXlsxStructure()
        sheetsElementSeen = true
        return
      }
      if (node.local !== 'sheet') return
      if (
        ancestors.length !== 2 ||
        ancestors[0].local !== 'workbook' ||
        ancestors[0].uri !== SPREADSHEETML_NAMESPACE ||
        parent?.local !== 'sheets' ||
        parent.uri !== SPREADSHEETML_NAMESPACE
      ) {
        throw invalidXlsxStructure()
      }
      const name = xmlAttribute(node, 'name')
      const rawSheetId = xmlAttribute(node, 'sheetId')
      const relationshipId = xmlAttribute(node, 'id', DOCUMENT_RELATIONSHIPS_NAMESPACE)
      const sheetId = Number(rawSheetId)
      if (
        !name ||
        !relationshipId ||
        !/^[1-9]\d*$/.test(rawSheetId ?? '') ||
        !Number.isSafeInteger(sheetId) ||
        sheetIds.has(sheetId) ||
        relationshipIds.has(relationshipId)
      ) {
        throw invalidXlsxStructure()
      }
      sheetIds.add(sheetId)
      relationshipIds.add(relationshipId)
      sheets.push({
        name,
        id: sheetId,
        rId: relationshipId,
        ...(xmlAttribute(node, 'state') ? { state: xmlAttribute(node, 'state') } : {})
      })
    }
  )
  return { model: { sheets }, properties }
}

function normalizeOpcRelationshipTarget(value) {
  const target = String(value ?? '')
  if (
    !target ||
    target !== target.trim() ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(target) ||
    target.startsWith('//') ||
    /[\\?#:\u0000-\u001f\u007f]/.test(target)
  ) {
    throw invalidXlsxStructure()
  }

  const packageParts = target.startsWith('/') ? [] : ['xl']
  const rawParts = target.split('/').slice(target.startsWith('/') ? 1 : 0)
  if (rawParts.length === 0 || rawParts.some((part) => part === '')) throw invalidXlsxStructure()
  for (const rawPart of rawParts) {
    let part
    try {
      part = decodeURIComponent(rawPart)
    } catch {
      throw invalidXlsxStructure()
    }
    if (!part || /[\\/?#:\u0000-\u001f\u007f]/.test(part)) throw invalidXlsxStructure()
    if (part === '.') continue
    if (part === '..') {
      if (packageParts.length === 0) throw invalidXlsxStructure()
      packageParts.pop()
      continue
    }
    packageParts.push(part)
  }
  if (packageParts.length === 0) throw invalidXlsxStructure()
  return packageParts[0] === 'xl'
    ? packageParts.slice(1).join('/')
    : `../${packageParts.join('/')}`
}

function parseWorkbookRelationshipsXml(relationshipsXml) {
  const rels = []
  const relationshipIds = new Set()
  parseNamespacedXmlPart(
    relationshipsXml,
    { local: 'Relationships', uri: PACKAGE_RELATIONSHIPS_NAMESPACE },
    (node, parent) => {
      if (node.local !== 'Relationship') return
      if (node.uri !== PACKAGE_RELATIONSHIPS_NAMESPACE || parent?.local !== 'Relationships' || parent.uri !== PACKAGE_RELATIONSHIPS_NAMESPACE) {
        throw invalidXlsxStructure()
      }
      const Id = xmlAttribute(node, 'Id')
      const Type = xmlAttribute(node, 'Type')
      const rawTarget = xmlAttribute(node, 'Target')
      const TargetMode = xmlAttribute(node, 'TargetMode')
      if (
        !Id ||
        !Type ||
        !rawTarget ||
        relationshipIds.has(Id) ||
        !/^[A-Za-z][A-Za-z\d+.-]*:\/\/[^\s]+$/.test(Type) ||
        (TargetMode !== undefined && TargetMode !== 'Internal')
      ) {
        throw invalidXlsxStructure()
      }
      relationshipIds.add(Id)
      rels.push({
        Id,
        Type,
        Target: normalizeOpcRelationshipTarget(rawTarget),
        ...(TargetMode ? { TargetMode } : {})
      })
    }
  )
  return { rels }
}

function bindWorkbookWorksheets(model, rels, entries) {
  const entriesByCanonicalName = new Map(entries.map((entry) => [entry.canonicalName, entry]))
  const relationshipById = new Map(rels.map((relationship) => [relationship.Id, relationship]))
  const worksheetTargetOwners = new Map()

  for (const relationship of rels) {
    if (!WORKSHEET_RELATIONSHIP_TYPES.has(relationship.Type)) continue
    if (!/^worksheets\/[^/]+\.xml$/i.test(relationship.Target)) throw invalidXlsxStructure()
    const canonicalTarget = `xl/${relationship.Target}`.normalize('NFC').toLowerCase()
    if (worksheetTargetOwners.has(canonicalTarget)) throw invalidXlsxStructure()
    worksheetTargetOwners.set(canonicalTarget, relationship.Id)
  }

  return model.sheets.map((sheet) => {
    const relationship = relationshipById.get(sheet.rId)
    if (!relationship || !WORKSHEET_RELATIONSHIP_TYPES.has(relationship.Type)) throw invalidXlsxStructure()
    const canonicalTarget = `xl/${relationship.Target}`.normalize('NFC').toLowerCase()
    const entry = entriesByCanonicalName.get(canonicalTarget)
    if (!entry || worksheetTargetOwners.get(canonicalTarget) !== relationship.Id) throw invalidXlsxStructure()
    return { sheet, entry }
  })
}

function escapeXmlText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeXmlAttribute(value) {
  return escapeXmlText(value).replace(/"/g, '&quot;').replace(/\r/g, '&#13;').replace(/\n/g, '&#10;')
}

async function* normalizeSpreadsheetMlWorksheet(iterator) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const output = []
  const emittedElements = []
  let rootSeen = false
  let rootPrefix = ''
  let skippedDepth = 0
  let parseFailure = null
  const parser = new SaxesParser({ xmlns: true })

  parser.on('error', () => {
    parseFailure ??= invalidXlsxStructure()
  })
  parser.on('doctype', () => {
    parseFailure ??= invalidXlsxStructure()
  })
  parser.on('opentag', (node) => {
    if (parseFailure) return
    if (!rootSeen) {
      if (node.local !== 'worksheet' || node.uri !== SPREADSHEETML_NAMESPACE) throw invalidXlsxStructure()
      rootSeen = true
      rootPrefix = node.prefix
    } else if (emittedElements.length === 0) {
      throw invalidXlsxStructure()
    }
    if (rootPrefix && node.prefix === rootPrefix && node.uri !== SPREADSHEETML_NAMESPACE) {
      throw invalidXlsxStructure()
    }
    if (skippedDepth > 0 || node.uri !== SPREADSHEETML_NAMESPACE) {
      skippedDepth += 1
      emittedElements.push(null)
      return
    }

    const attributes = Object.values(node.attributes ?? {})
      .filter((attribute) => attribute.uri !== XMLNS_NAMESPACE)
      .map((attribute) => ` ${attribute.name}="${escapeXmlAttribute(attribute.value)}"`)
      .join('')
    output.push(`<${node.local}${attributes}>`)
    emittedElements.push(node.local)
  })
  parser.on('text', (value) => {
    if (skippedDepth === 0) output.push(escapeXmlText(value))
  })
  parser.on('cdata', (value) => {
    if (skippedDepth === 0) output.push(escapeXmlText(value))
  })
  parser.on('closetag', () => {
    const emittedName = emittedElements.pop()
    if (emittedName === null) {
      skippedDepth -= 1
      return
    }
    if (emittedName) output.push(`</${emittedName}>`)
  })

  const write = (value) => {
    try {
      parser.write(value)
    } catch (cause) {
      if (cause?.status) throw cause
      throw invalidXlsxStructure()
    }
    if (parseFailure) throw parseFailure
  }

  try {
    for await (const chunk of iterator) {
      write(decoder.decode(chunk, { stream: true }))
      if (output.length) yield output.splice(0).join('')
    }
    write(decoder.decode())
    parser.close()
  } catch (cause) {
    if (cause?.status) throw cause
    throw invalidXlsxStructure()
  }
  if (parseFailure || !rootSeen || emittedElements.length !== 0 || skippedDepth !== 0) {
    throw parseFailure ?? invalidXlsxStructure()
  }
  if (output.length) yield output.join('')
}

function seedStreamingWorkbookModel(metrics, entries) {
  const workbook = parseWorkbookXml(metrics.workbook_xml)
  const relationships = parseWorkbookRelationshipsXml(metrics.workbook_rels_xml)
  const worksheetBindings = bindWorkbookWorksheets(workbook.model, relationships.rels, entries)
  delete metrics.workbook_xml
  delete metrics.workbook_rels_xml
  const sharedStrings = Array.isArray(metrics.shared_strings) ? metrics.shared_strings : null
  delete metrics.shared_strings
  return {
    model: workbook.model,
    properties: workbook.properties,
    rels: relationships.rels,
    sharedStrings,
    worksheetBindings
  }
}

async function xlsxToRows(file, limits, tracker, metrics) {
  const zipStartedAt = performance.now()
  const container = await inspectZipContainer(file.path, limits)
  const validatedEntries = container.validated_entries
  delete container.validated_entries
  Object.assign(metrics, container)
  metrics.zip_validation_ms = Math.round(performance.now() - zipStartedAt)
  metrics.zip_security_ms = metrics.zip_validation_ms
  metrics.peak_rss_bytes = Math.max(metrics.peak_rss_bytes, process.memoryUsage().rss)
  reportProgress('parsing', 40, {
    zip_validation_ms: metrics.zip_validation_ms,
    actual_uncompressed_bytes: metrics.actual_uncompressed_bytes,
    zip_entries: metrics.zip_entries
  })

  const rows = []
  let headers = null
  let sheetName = null
  let worksheetCount = 0
  let formulaCells = 0
  let blankCellsSkipped = 0
  try {
    const { default: ExcelJS } = await import('exceljs')
    const workbookStartedAt = performance.now()
    const workbook = new ExcelJS.stream.xlsx.WorkbookReader(file.path, {
      entries: 'ignore',
      sharedStrings: 'ignore',
      hyperlinks: 'ignore',
      styles: 'ignore',
      worksheets: 'emit'
    })
    reportProgress('parsing', 45)
    const seed = seedStreamingWorkbookModel(metrics, validatedEntries)
    workbook.model = seed.model
    workbook.properties = seed.properties
    workbook.workbookRels = seed.rels
    if (seed.sharedStrings) workbook.sharedStrings = seed.sharedStrings
    const parseWorksheet = workbook._parseWorksheet.bind(workbook)
    metrics.shared_string_count = seed.sharedStrings?.length ?? 0
    let rowExtractMs = 0
    for (const binding of seed.worksheetBindings) {
      worksheetCount += 1
      if (worksheetCount > limits.maxWorksheets) {
        throw importError(
          422,
          `Workbook contains more than ${limits.maxWorksheets} worksheets.`,
          'import_worksheet_limit_exceeded'
        )
      }
      const iterator = normalizeSpreadsheetMlWorksheet(
        readValidatedZipEntry(file.path, binding.entry, limits, tracker)
      )
      let worksheet = null
      for (const event of parseWorksheet(iterator, String(worksheetCount))) {
        if (event?.eventType === 'worksheet') worksheet = event.value
      }
      if (!worksheet) throw invalidXlsxStructure()
      worksheet.id = binding.sheet.id
      worksheet.name = binding.sheet.name
      worksheet.state = binding.sheet.state
      const worksheetStartedAt = performance.now()
      for await (const row of worksheet) {
        const width = Number(row.cellCount ?? 0)
        assertColumnCount(width, limits)
        blankCellsSkipped += Math.max(0, width - Number(row.actualCellCount ?? width))
        const values = Array.from({ length: width }, (_, index) => {
          const raw = row.getCell(index + 1).value
          if (raw && typeof raw === 'object' && ('formula' in raw || 'sharedFormula' in raw)) formulaCells += 1
          return cellValue(raw)
        })
        if (worksheetCount !== 1) {
          for (const value of values) tracker.inspect(value)
          continue
        }
        if (row.number === 1) {
          headers = uniqueHeaderValues(values.map((value) => tracker.inspect(value)))
          sheetName = worksheet.name
          continue
        }
        const record = buildRecord(headers ?? [], values, row.number, tracker)
        if (record) rows.push(record)
        if ((rows.length & 0x3ff) === 0) {
          const memory = process.memoryUsage()
          metrics.peak_rss_bytes = Math.max(metrics.peak_rss_bytes, memory.rss)
          metrics.peak_heap_used_bytes = Math.max(metrics.peak_heap_used_bytes, memory.heapUsed)
        }
      }
      rowExtractMs += performance.now() - worksheetStartedAt
      tracker.checkDeadline()
    }
    metrics.workbook_parse_ms = Math.round(performance.now() - workbookStartedAt)
    metrics.workbook_load_ms = metrics.workbook_parse_ms
    metrics.row_extract_ms = Math.round(rowExtractMs)
    metrics.worksheet_iteration_ms = metrics.row_extract_ms
    metrics.worksheets = worksheetCount
    metrics.shared_strings_mode = 'security-pass-cache'
    metrics.styles_mode = 'ignore'
    metrics.formula_cells = formulaCells
    metrics.blank_cells_skipped = blankCellsSkipped
    reportProgress('parsing', 58, {
      workbook_parse_ms: metrics.workbook_parse_ms,
      row_extract_ms: metrics.row_extract_ms,
      data_rows: rows.length
    })
  } catch (cause) {
    if (cause?.status) throw cause
    throw importError(
      422,
      'Unable to parse the Excel workbook; it may be damaged, encrypted, or unsupported.',
      'import_xlsx_invalid',
      { parser_error: String(cause?.name ?? 'Error').slice(0, 100) }
    )
  }
  tracker.checkDeadline()
  if (!headers) throw importError(422, 'The workbook does not contain a readable first-row header.', 'import_empty_workbook')
  if (rows.length === 0) throw importError(422, 'The workbook contains a header but no data rows.', 'import_empty_workbook')
  return { headers, rows, sheetName }
}

async function csvToRows(file, limits, tracker) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const rows = []
  let headers = null
  let currentRow = []
  let fieldParts = []
  let fieldLength = 0
  let inQuotes = false
  let quotePending = false
  let skipLineFeed = false
  let firstChunk = true
  let rowNumber = 0

  const appendSegment = (text, start, end) => {
    if (end <= start) return
    const length = end - start
    fieldLength += length
    if (fieldLength > limits.maxCellCharacters) {
      throw importError(
        422,
        `CSV 包含超过 ${formatResourceLimit(limits.maxCellCharacters)} 字符的单元格`,
        'import_cell_text_limit_exceeded'
      )
    }
    fieldParts.push(text.slice(start, end))
  }
  const appendLiteral = (value) => {
    fieldLength += value.length
    if (fieldLength > limits.maxCellCharacters) {
      throw importError(
        422,
        `CSV 包含超过 ${formatResourceLimit(limits.maxCellCharacters)} 字符的单元格`,
        'import_cell_text_limit_exceeded'
      )
    }
    fieldParts.push(value)
  }
  const finishField = () => {
    const value = fieldParts.length === 0 ? '' : fieldParts.length === 1 ? fieldParts[0] : fieldParts.join('')
    currentRow.push(tracker.inspect(value))
    assertColumnCount(currentRow.length, limits)
    fieldParts = []
    fieldLength = 0
  }
  const finishRow = () => {
    finishField()
    rowNumber += 1
    if (headers === null) {
      headers = uniqueHeaderValues(currentRow)
    } else if (currentRow.some((value) => value.trim() !== '')) {
      const record = {}
      for (let index = 0; index < headers.length; index += 1) record[headers[index]] = currentRow[index] ?? null
      rows.push({ row_number: rowNumber, values: record })
    }
    currentRow = []
  }
  const invalidQuote = () => {
    throw importError(422, `CSV 第 ${rowNumber + 1} 行的引号格式无效`, 'import_csv_invalid')
  }
  const processText = (text) => {
    let segmentStart = 0
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index]
      if (skipLineFeed) {
        skipLineFeed = false
        if (character === '\n') {
          segmentStart = index + 1
          continue
        }
      }
      if (inQuotes) {
        if (quotePending) {
          if (character === '"') {
            appendLiteral('"')
            quotePending = false
            segmentStart = index + 1
            continue
          }
          if (character === ',') {
            inQuotes = false
            quotePending = false
            finishField()
            segmentStart = index + 1
            continue
          }
          if (character === '\r' || character === '\n') {
            inQuotes = false
            quotePending = false
            finishRow()
            skipLineFeed = character === '\r'
            segmentStart = index + 1
            continue
          }
          if (character === ' ' || character === '\t') {
            segmentStart = index + 1
            continue
          }
          invalidQuote()
        }
        if (character === '"') {
          appendSegment(text, segmentStart, index)
          quotePending = true
          segmentStart = index + 1
        }
        continue
      }
      if (character === '"') {
        appendSegment(text, segmentStart, index)
        if (fieldLength !== 0) invalidQuote()
        inQuotes = true
        segmentStart = index + 1
      } else if (character === ',') {
        appendSegment(text, segmentStart, index)
        finishField()
        segmentStart = index + 1
      } else if (character === '\r' || character === '\n') {
        appendSegment(text, segmentStart, index)
        finishRow()
        skipLineFeed = character === '\r'
        segmentStart = index + 1
      }
    }
    if (!quotePending) appendSegment(text, segmentStart, text.length)
  }

  try {
    for await (const chunk of createReadStream(file.path)) {
      if (chunk.includes(0)) {
        throw importError(422, 'CSV 包含 NUL 字节，文件可能不是文本格式', 'import_csv_binary')
      }
      let text = decoder.decode(chunk, { stream: true })
      if (firstChunk) {
        firstChunk = false
        if (text.startsWith('\uFEFF')) text = text.slice(1)
      }
      processText(text)
      tracker.checkDeadline()
    }
    processText(decoder.decode())
  } catch (cause) {
    if (cause?.status) throw cause
    if (cause instanceof TypeError) {
      throw importError(422, 'CSV 必须使用有效的 UTF-8 编码', 'import_csv_encoding_invalid')
    }
    throw cause
  }
  if (inQuotes && !quotePending) throw importError(422, 'CSV 末尾存在未闭合的引号字段', 'import_csv_invalid')
  if (fieldLength > 0 || fieldParts.length > 0 || currentRow.length > 0) finishRow()
  tracker.checkDeadline()
  if (!headers) throw importError(422, 'CSV 中没有可读取的表头', 'import_empty_workbook')
  if (rows.length === 0) throw importError(422, '文件只有表头，没有数据行', 'import_empty_workbook')
  return { headers, rows, sheetName: 'CSV' }
}

async function parseImportFile() {
  const { path, extension, limits } = workerData
  const file = { path }
  const tracker = createResourceTracker(limits)
  const startedAt = performance.now()
  const memory = process.memoryUsage()
  const metrics = {
    format: extension.slice(1),
    started_at: new Date().toISOString(),
    peak_rss_bytes: memory.rss,
    peak_heap_used_bytes: memory.heapUsed,
    zip_security_ms: 0,
    workbook_load_ms: 0,
    worksheet_iteration_ms: 0,
    csv_stream_ms: 0,
    legacy_workbook_ms: 0
  }
  let result
  if (extension === '.csv') {
    reportProgress('parsing', 35)
    const phaseStartedAt = performance.now()
    result = await csvToRows(file, limits, tracker)
    metrics.csv_stream_ms = Math.round(performance.now() - phaseStartedAt)
  } else if (extension === '.xls') {
    reportProgress('parsing', 35)
    const phaseStartedAt = performance.now()
    result = await legacyXlsToRows(file, limits, tracker)
    metrics.legacy_workbook_ms = Math.round(performance.now() - phaseStartedAt)
  } else {
    result = await xlsxToRows(file, limits, tracker, metrics)
  }
  const completedMemory = process.memoryUsage()
  metrics.peak_rss_bytes = Math.max(metrics.peak_rss_bytes, completedMemory.rss)
  metrics.peak_heap_used_bytes = Math.max(metrics.peak_heap_used_bytes, completedMemory.heapUsed)
  metrics.parse_ms = Math.round(performance.now() - startedAt)
  metrics.completed_at = new Date().toISOString()
  Object.assign(metrics, tracker.snapshot(), { data_rows: result.rows.length })
  return { ...result, metrics }
}

try {
  const result = await parseImportFile()
  parentPort.postMessage({ ok: true, result })
} catch (cause) {
  parentPort.postMessage({
    ok: false,
    error: {
      status: cause?.status ?? 422,
      code: cause?.code ?? 'import_parse_error',
      message: cause?.message ?? '候选人导入文件解析失败',
      details: cause?.details
    }
  })
}
