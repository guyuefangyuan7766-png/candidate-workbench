import { crc32, inflateRawSync } from 'node:zlib'

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50
const DESCRIPTOR_SIGNATURE = 0x08074b50
const ZIP64_EXTRA_FIELD = 0x0001
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50

function zipError(code, message, status = 422) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function limitsFor(input) {
  return {
    maxEntries: Number(input.maxZipEntries),
    maxEntryBytes: Number(input.maxZipEntryBytes),
    maxTotalBytes: Number(input.maxUncompressedBytes),
    maxRatio: Number(input.maxZipCompressionRatio ?? 200),
    maxFilenameBytes: Number(input.maxZipFilenameBytes ?? 4096),
    maxCentralBytes: Number(input.maxZipCentralDirectoryBytes ?? 4 * 1024 * 1024)
  }
}

function findEocd(buffer) {
  const searchStart = Math.max(0, buffer.length - 65_557)
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === buffer.length) return offset
  }
  return -1
}

function inspectExtra(extra) {
  let cursor = 0
  while (cursor < extra.length) {
    if (cursor + 4 > extra.length) throw zipError('invalid_zip', 'Office ZIP 扩展字段已损坏')
    const id = extra.readUInt16LE(cursor)
    const length = extra.readUInt16LE(cursor + 2)
    cursor += 4
    if (cursor + length > extra.length) throw zipError('invalid_zip', 'Office ZIP 扩展字段已损坏')
    if (id === ZIP64_EXTRA_FIELD) {
      throw zipError('zip64_unsupported', '不支持 ZIP64 Office 文件，请缩小文件后重试', 413)
    }
    cursor += length
  }
}

function decodeName(bytes, utf8) {
  try {
    return utf8 ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes.toString('latin1')
  } catch {
    throw zipError('invalid_zip', 'Office ZIP 条目名称编码无效')
  }
}

function canonicalName(name, maximum) {
  if (
    !name || Buffer.byteLength(name, 'utf8') > maximum ||
    /[\0\u0001-\u001f\u007f]/.test(name) || name.includes('\\') ||
    name.startsWith('/') || /^[a-z]:/i.test(name) || name.includes(':')
  ) {
    throw zipError('unsafe_zip_path', 'Office 文件包含不安全的内部路径')
  }
  const directory = name.endsWith('/')
  const path = directory ? name.slice(0, -1) : name
  const parts = path.split('/')
  if (!path || parts.some((part) => !part || part === '.' || part === '..')) {
    throw zipError('unsafe_zip_path', 'Office 文件包含不安全的内部路径')
  }
  return { canonical: path.normalize('NFC').toLocaleLowerCase('en-US'), directory }
}

function assertFlags(flags, method) {
  if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || (flags & 0x2000) !== 0) {
    throw zipError('encrypted_office_unsupported', '不支持加密或带密码的 Office 文件')
  }
  const allowed = method === 8 ? 0x080e : 0x0808
  if ((flags & ~allowed) !== 0) throw zipError('invalid_zip', 'Office ZIP 使用了不支持的条目标志')
}

function assertEntryType(versionMadeBy, attributes, directory) {
  if ((versionMadeBy >>> 8) !== 3) return
  const type = (attributes >>> 16) & 0xf000
  if (type === 0 || directory && type === 0x4000 || !directory && type === 0x8000) return
  throw zipError('unsafe_zip_path', 'Office ZIP 包含符号链接或特殊文件')
}

function assertPathCollision(entries, candidate) {
  for (const existing of entries) {
    if (existing.canonical === candidate.canonical) {
      throw zipError('zip_duplicate_path', 'Office ZIP 包含重复的规范化内部路径')
    }
    if (
      (!existing.directory && candidate.canonical.startsWith(`${existing.canonical}/`)) ||
      (!candidate.directory && existing.canonical.startsWith(`${candidate.canonical}/`))
    ) {
      throw zipError('unsafe_zip_path', 'Office ZIP 包含文件与目录路径冲突')
    }
  }
}

function descriptorLength(buffer, dataEnd, centralOffset, entry) {
  const available = centralOffset - dataEnd
  if (available < 12) throw zipError('invalid_zip', 'Office ZIP 数据描述符缺失')
  const first = buffer.readUInt32LE(dataEnd)
  if (
    first === entry.crc32 &&
    buffer.readUInt32LE(dataEnd + 4) === entry.compressedSize &&
    buffer.readUInt32LE(dataEnd + 8) === entry.uncompressedSize
  ) return 12
  if (
    available >= 16 && first === DESCRIPTOR_SIGNATURE &&
    buffer.readUInt32LE(dataEnd + 4) === entry.crc32 &&
    buffer.readUInt32LE(dataEnd + 8) === entry.compressedSize &&
    buffer.readUInt32LE(dataEnd + 12) === entry.uncompressedSize
  ) return 16
  throw zipError('invalid_zip', 'Office ZIP 数据描述符与中央目录不一致')
}

function parseEntries(buffer, limits) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw zipError('invalid_zip', 'Office 文件的 ZIP 容器不完整或已损坏')
  }
  const eocd = findEocd(buffer)
  if (eocd < 0) throw zipError('invalid_zip', 'Office 文件缺少有效的 ZIP 中央目录')
  if (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIGNATURE) {
    throw zipError('zip64_unsupported', '不支持 ZIP64 Office 文件，请缩小文件后重试', 413)
  }
  const disk = buffer.readUInt16LE(eocd + 4)
  const centralDisk = buffer.readUInt16LE(eocd + 6)
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8)
  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw zipError('multipart_zip_unsupported', '不支持跨卷或分段 Office 文件')
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw zipError('zip64_unsupported', '不支持 ZIP64 Office 文件，请缩小文件后重试', 413)
  }
  if (entryCount < 1 || entryCount > limits.maxEntries) {
    throw zipError('zip_entry_limit', `Office 文件条目数必须在 1 至 ${limits.maxEntries} 之间`, 413)
  }
  if (centralSize > limits.maxCentralBytes || centralOffset + centralSize !== eocd) {
    throw zipError('invalid_zip', 'Office 文件中央目录范围无效')
  }

  const entries = []
  const localOffsets = new Set()
  let cursor = centralOffset
  let declaredTotal = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw zipError('invalid_zip', 'Office 文件中央目录条目无效')
    }
    const versionMadeBy = buffer.readUInt16LE(cursor + 4)
    const versionNeeded = buffer.readUInt16LE(cursor + 6)
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const checksum = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const filenameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const diskStart = buffer.readUInt16LE(cursor + 34)
    const attributes = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const end = cursor + 46 + filenameLength + extraLength + commentLength
    if (filenameLength < 1 || end > eocd) throw zipError('invalid_zip', 'Office ZIP 条目元数据已损坏')
    if (
      versionNeeded >= 45 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff || diskStart === 0xffff
    ) {
      throw zipError('zip64_unsupported', '不支持 ZIP64 Office 文件，请缩小文件后重试', 413)
    }
    if (diskStart !== 0) throw zipError('multipart_zip_unsupported', '不支持跨卷或分段 Office 文件')
    if (method !== 0 && method !== 8) {
      throw zipError('zip_compression_unsupported', `Office 文件包含不支持的 ZIP 压缩算法 ${method}`)
    }
    assertFlags(flags, method)
    const filenameBytes = buffer.subarray(cursor + 46, cursor + 46 + filenameLength)
    const extra = buffer.subarray(cursor + 46 + filenameLength, cursor + 46 + filenameLength + extraLength)
    inspectExtra(extra)
    const name = decodeName(filenameBytes, (flags & 0x0800) !== 0)
    const safeName = canonicalName(name, limits.maxFilenameBytes)
    assertEntryType(versionMadeBy, attributes, safeName.directory)
    assertPathCollision(entries, safeName)
    if (localOffsets.has(localOffset)) throw zipError('invalid_zip', 'Office ZIP 多个条目共用本地头')
    localOffsets.add(localOffset)
    if (uncompressedSize > limits.maxEntryBytes) {
      throw zipError('zip_entry_too_large', 'Office 文件包含超出解压限制的单个条目', 413)
    }
    declaredTotal += uncompressedSize
    if (declaredTotal > limits.maxTotalBytes) {
      throw zipError('zip_uncompressed_limit', 'Office 文件解压后超过安全限制', 413)
    }
    if (compressedSize === 0 ? uncompressedSize !== 0 : uncompressedSize > compressedSize * limits.maxRatio) {
      throw zipError('zip_ratio_limit', 'Office 文件压缩比异常，已阻止解析', 413)
    }
    entries.push({
      name,
      canonical: safeName.canonical,
      directory: safeName.directory,
      filenameBytes: Buffer.from(filenameBytes),
      versionNeeded,
      flags,
      method,
      crc32: checksum,
      compressedSize,
      uncompressedSize,
      localOffset,
      dataStart: 0,
      dataEnd: 0,
      rangeEnd: 0
    })
    cursor = end
  }
  if (cursor !== eocd) throw zipError('invalid_zip', 'Office ZIP 中央目录包含未识别记录')

  for (const entry of entries) {
    if (entry.localOffset + 30 > centralOffset || buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) {
      throw zipError('invalid_zip', 'Office 文件本地 ZIP 条目无效')
    }
    const localVersion = buffer.readUInt16LE(entry.localOffset + 4)
    const localFlags = buffer.readUInt16LE(entry.localOffset + 6)
    const localMethod = buffer.readUInt16LE(entry.localOffset + 8)
    const localCrc = buffer.readUInt32LE(entry.localOffset + 14)
    const localCompressed = buffer.readUInt32LE(entry.localOffset + 18)
    const localUncompressed = buffer.readUInt32LE(entry.localOffset + 22)
    const localNameLength = buffer.readUInt16LE(entry.localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28)
    if (localVersion !== entry.versionNeeded || localFlags !== entry.flags || localMethod !== entry.method) {
      throw zipError('invalid_zip', 'Office ZIP 本地头与中央目录不一致')
    }
    const descriptor = (entry.flags & 0x0008) !== 0
    if (descriptor) {
      if (localCrc !== 0 || localCompressed !== 0 || localUncompressed !== 0) {
        throw zipError('invalid_zip', 'Office ZIP 数据描述条目的本地大小无效')
      }
    } else if (
      localCrc !== entry.crc32 || localCompressed !== entry.compressedSize ||
      localUncompressed !== entry.uncompressedSize
    ) {
      throw zipError('invalid_zip', 'Office ZIP 本地大小或 CRC 与中央目录不一致')
    }
    const nameStart = entry.localOffset + 30
    const variableEnd = nameStart + localNameLength + localExtraLength
    if (variableEnd > centralOffset) throw zipError('invalid_zip', 'Office ZIP 本地头范围无效')
    if (!buffer.subarray(nameStart, nameStart + localNameLength).equals(entry.filenameBytes)) {
      throw zipError('invalid_zip', 'Office ZIP 本地文件名与中央目录不一致')
    }
    inspectExtra(buffer.subarray(nameStart + localNameLength, variableEnd))
    entry.dataStart = variableEnd
    entry.dataEnd = entry.dataStart + entry.compressedSize
    if (entry.dataEnd > centralOffset) throw zipError('invalid_zip', 'Office ZIP 压缩数据范围无效')
    entry.rangeEnd = entry.dataEnd + (descriptor ? descriptorLength(buffer, entry.dataEnd, centralOffset, entry) : 0)
    if (entry.rangeEnd > centralOffset) throw zipError('invalid_zip', 'Office ZIP 条目范围与中央目录重叠')
  }
  const ranges = entries
    .map((entry) => ({ start: entry.localOffset, end: entry.rangeEnd }))
    .sort((left, right) => left.start - right.start)
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) throw zipError('invalid_zip', 'Office ZIP 条目数据范围重叠')
  }
  return { entries, declaredTotal }
}

export function inspectSecureZipBuffer(buffer, inputLimits, { verifyPayload = false } = {}) {
  const limits = limitsFor(inputLimits)
  const { entries, declaredTotal } = parseEntries(buffer, limits)
  let totalActual = 0
  if (verifyPayload) {
    for (const entry of entries) {
      let payload
      try {
        const compressed = buffer.subarray(entry.dataStart, entry.dataEnd)
        if (entry.compressedSize === 0) payload = Buffer.alloc(0)
        else if (entry.method === 0) payload = compressed
        else payload = inflateRawSync(compressed, { maxOutputLength: limits.maxEntryBytes + 1 })
      } catch (error) {
        if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
          throw zipError('zip_entry_too_large', 'Office 文件实际解压大小超过单条安全限制', 413)
        }
        if (error?.status) throw error
        throw zipError('invalid_zip', 'Office 文件压缩数据已损坏或无法安全解压')
      }
      if (payload.length !== entry.uncompressedSize) {
        throw zipError('zip_size_mismatch', 'Office 文件声明的解压大小与实际内容不一致')
      }
      totalActual += payload.length
      if (totalActual > limits.maxTotalBytes) {
        throw zipError('zip_uncompressed_limit', 'Office 文件实际解压后超过安全限制', 413)
      }
      if ((crc32(payload) >>> 0) !== entry.crc32) {
        throw zipError('zip_crc_mismatch', 'Office ZIP 条目 CRC 校验失败')
      }
    }
  }
  return {
    names: entries.map((entry) => entry.name.toLocaleLowerCase('en-US')),
    entryCount: entries.length,
    totalUncompressed: verifyPayload ? totalActual : declaredTotal
  }
}

