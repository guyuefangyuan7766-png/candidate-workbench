import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, unlink } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'

const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50
const ZIP64_EXTRA_FIELD = 0x0001
const ZIP_UNICODE_PATH_EXTRA_FIELD = 0x7075
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50
const MAX_EOCD_SEARCH_BYTES = 65_557

const CP437_HIGH_CHARACTERS = [...(
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
  'áíóúñÑªº¿⌐¬½¼¡«»' +
  '░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' +
  '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤' +
  'ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀' +
  'ÓßÔÒõÕµþÞÚÛÙýÝ¯´' +
  '≡±‗¾¶§÷¸°¨·¹³²■ '
)]

export const SECURE_ZIP_LIMITS = Object.freeze({
  maxArchiveBytes: 128 * 1024 * 1024,
  maxCentralDirectoryBytes: 4 * 1024 * 1024,
  maxEntries: 256,
  maxFilenameBytes: 4_096,
  maxEntryUncompressedBytes: 15 * 1024 * 1024,
  maxUncompressedBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 100
})

export function zipError(code, message, details) {
  const error = new Error(message)
  error.status = code === 'zip_archive_too_large' || code.endsWith('_limit_exceeded') ? 413 : 422
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

function abortError() {
  const error = new Error('ZIP extraction was cancelled')
  error.name = 'AbortError'
  error.code = 'attachment_batch_cancelled'
  error.status = 409
  return error
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw abortError()
}

async function readExactly(handle, length, position, code = 'zip_invalid') {
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(position) || position < 0) {
    throw zipError(code, 'ZIP contains an invalid byte range')
  }
  const buffer = Buffer.alloc(length)
  let total = 0
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, position + total)
    if (bytesRead === 0) throw zipError(code, 'ZIP data is truncated')
    total += bytesRead
  }
  return buffer
}

function findEocd(tail, tailStart, fileSize) {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) continue
    const commentLength = tail.readUInt16LE(offset + 20)
    if (tailStart + offset + 22 + commentLength === fileSize) return offset
  }
  return -1
}

function inspectExtraFields(extra, filenameBytes = null) {
  let cursor = 0
  let unicodePath = null
  while (cursor < extra.length) {
    if (cursor + 4 > extra.length) throw zipError('zip_invalid', 'ZIP contains a truncated extra field')
    const fieldId = extra.readUInt16LE(cursor)
    const fieldLength = extra.readUInt16LE(cursor + 2)
    cursor += 4
    if (cursor + fieldLength > extra.length) throw zipError('zip_invalid', 'ZIP contains a truncated extra field')
    if (fieldId === ZIP64_EXTRA_FIELD) {
      throw zipError('zip64_unsupported', 'ZIP64 archives are not supported')
    }
    if (fieldId === ZIP_UNICODE_PATH_EXTRA_FIELD) {
      if (!filenameBytes || fieldLength < 6 || extra[cursor] !== 1 || unicodePath !== null) {
        throw zipError('zip_invalid_filename', 'ZIP Unicode filename metadata is invalid')
      }
      const expectedCrc32 = extra.readUInt32LE(cursor + 1)
      if (expectedCrc32 !== crc32Buffer(filenameBytes)) {
        throw zipError('zip_invalid_filename', 'ZIP Unicode filename metadata does not match the entry name')
      }
      try {
        unicodePath = new TextDecoder('utf-8', { fatal: true }).decode(
          extra.subarray(cursor + 5, cursor + fieldLength)
        )
      } catch {
        throw zipError('zip_invalid_filename', 'ZIP Unicode filename metadata is not valid UTF-8')
      }
      if (!unicodePath) throw zipError('zip_invalid_filename', 'ZIP Unicode filename metadata is empty')
    }
    cursor += fieldLength
  }
  return { unicodePath }
}

function decodeCp437(bytes) {
  let decoded = ''
  for (const byte of bytes) decoded += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH_CHARACTERS[byte - 0x80]
  return decoded
}

function decodeEntryName(bytes, utf8, unicodePath) {
  try {
    const decoded = utf8
      ? new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      : decodeCp437(bytes)
    if (unicodePath && utf8 && unicodePath !== decoded) {
      throw zipError('zip_invalid_filename', 'ZIP Unicode filename metadata conflicts with the UTF-8 entry name')
    }
    return unicodePath ?? decoded
  } catch {
    throw zipError('zip_invalid_filename', 'ZIP entry filename encoding is invalid')
  }
}

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

function canonicalEntryName(name, maxFilenameBytes) {
  if (
    !name ||
    Buffer.byteLength(name, 'utf8') > maxFilenameBytes ||
    /[\0\u0001-\u001f\u007f]/.test(name) ||
    name.includes('\\') ||
    name.startsWith('/') ||
    name.startsWith('//') ||
    /^[a-z]:/i.test(name) ||
    name.includes(':')
  ) {
    throw zipError('zip_unsafe_path', 'ZIP contains an unsafe entry path')
  }
  const directory = name.endsWith('/')
  const withoutSlash = directory ? name.slice(0, -1) : name
  const parts = withoutSlash.split('/')
  if (
    !withoutSlash ||
    parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || WINDOWS_DEVICE_NAME.test(part))
  ) {
    throw zipError('zip_unsafe_path', 'ZIP contains an unsafe entry path')
  }
  return {
    canonical: withoutSlash.normalize('NFC').toLocaleLowerCase('en-US'),
    directory
  }
}

function assertSupportedFlags(flags, compressionMethod) {
  if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || (flags & 0x2000) !== 0) {
    throw zipError('zip_encrypted', 'Encrypted ZIP archives are not supported')
  }
  const allowed = compressionMethod === 8 ? 0x080e : 0x0808
  if ((flags & ~allowed) !== 0) {
    throw zipError('zip_unsupported_flags', 'ZIP entry uses unsupported flags')
  }
}

function assertSafeEntryType(versionMadeBy, externalAttributes, directory) {
  const creatorSystem = versionMadeBy >>> 8
  if (creatorSystem !== 3) return
  const fileType = (externalAttributes >>> 16) & 0xf000
  if (fileType === 0) return
  if (fileType === 0xa000) throw zipError('zip_symlink_unsupported', 'ZIP symbolic links are not supported')
  if (directory && fileType === 0x4000) return
  if (!directory && fileType === 0x8000) return
  throw zipError('zip_special_file_unsupported', 'ZIP special-file entries are not supported')
}

function assertNoPathCollision(entries, candidate) {
  for (const existing of entries) {
    if (existing.canonical === candidate.canonical) {
      throw zipError('zip_duplicate_path', 'ZIP contains duplicate normalized entry paths')
    }
    if (
      (!existing.directory && candidate.canonical.startsWith(`${existing.canonical}/`)) ||
      (!candidate.directory && existing.canonical.startsWith(`${candidate.canonical}/`))
    ) {
      throw zipError('zip_path_collision', 'ZIP contains a file and directory path collision')
    }
  }
}

async function readDataDescriptor(handle, dataEnd, centralOffset, entry) {
  const available = centralOffset - dataEnd
  if (available < 12) throw zipError('zip_header_mismatch', 'ZIP data descriptor is missing')
  const descriptor = await readExactly(handle, Math.min(16, available), dataEnd, 'zip_header_mismatch')
  const unsigned =
    descriptor.readUInt32LE(0) === entry.crc32 &&
    descriptor.readUInt32LE(4) === entry.compressedSize &&
    descriptor.readUInt32LE(8) === entry.uncompressedSize
  if (unsigned) return 12
  const signed =
    descriptor.length >= 16 &&
    descriptor.readUInt32LE(0) === ZIP_DATA_DESCRIPTOR_SIGNATURE &&
    descriptor.readUInt32LE(4) === entry.crc32 &&
    descriptor.readUInt32LE(8) === entry.compressedSize &&
    descriptor.readUInt32LE(12) === entry.uncompressedSize
  if (signed) return 16
  throw zipError('zip_header_mismatch', 'ZIP data descriptor does not match the central directory')
}

async function parseCentralDirectory(handle, fileSize, limits, signal) {
  assertNotAborted(signal)
  if (fileSize < 22) throw zipError('zip_invalid', 'ZIP archive is incomplete')
  if (fileSize > limits.maxArchiveBytes) throw zipError('zip_archive_too_large', 'ZIP archive exceeds the upload limit')

  const tailLength = Math.min(fileSize, MAX_EOCD_SEARCH_BYTES)
  const tailStart = fileSize - tailLength
  const tail = await readExactly(handle, tailLength, tailStart)
  const eocdInTail = findEocd(tail, tailStart, fileSize)
  if (eocdInTail < 0) throw zipError('zip_invalid', 'ZIP end-of-central-directory record is missing')
  const eocdOffset = tailStart + eocdInTail
  if (eocdInTail >= 20 && tail.readUInt32LE(eocdInTail - 20) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
    throw zipError('zip64_unsupported', 'ZIP64 archives are not supported')
  }

  const diskNumber = tail.readUInt16LE(eocdInTail + 4)
  const centralDisk = tail.readUInt16LE(eocdInTail + 6)
  const entriesOnDisk = tail.readUInt16LE(eocdInTail + 8)
  const entryCount = tail.readUInt16LE(eocdInTail + 10)
  const centralSize = tail.readUInt32LE(eocdInTail + 12)
  const centralOffset = tail.readUInt32LE(eocdInTail + 16)
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw zipError('zip_multidisk_unsupported', 'Multi-disk ZIP archives are not supported')
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw zipError('zip64_unsupported', 'ZIP64 archives are not supported')
  }
  if (entryCount < 1 || entryCount > limits.maxEntries) {
    throw zipError('zip_entry_limit_exceeded', `ZIP entry count must be between 1 and ${limits.maxEntries}`)
  }
  if (
    centralSize > limits.maxCentralDirectoryBytes ||
    centralOffset > eocdOffset ||
    centralOffset + centralSize !== eocdOffset
  ) {
    throw zipError('zip_invalid', 'ZIP central-directory range is invalid')
  }

  const central = await readExactly(handle, centralSize, centralOffset)
  const entries = []
  const localOffsets = new Set()
  let cursor = 0
  let declaredTotal = 0
  for (let index = 0; index < entryCount; index += 1) {
    assertNotAborted(signal)
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw zipError('zip_invalid', 'ZIP central-directory entry is invalid')
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
    if (filenameLength < 1 || entryEnd > central.length) throw zipError('zip_invalid', 'ZIP entry metadata is truncated')
    if (
      versionNeeded >= 45 || compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff || diskStart === 0xffff
    ) {
      throw zipError('zip64_unsupported', 'ZIP64 entries are not supported')
    }
    if (diskStart !== 0) throw zipError('zip_multidisk_unsupported', 'Multi-disk ZIP entries are not supported')
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw zipError('zip_compression_unsupported', `ZIP compression method ${compressionMethod} is not supported`)
    }
    assertSupportedFlags(flags, compressionMethod)
    const filenameBytes = central.subarray(cursor + 46, cursor + 46 + filenameLength)
    const extra = central.subarray(cursor + 46 + filenameLength, cursor + 46 + filenameLength + extraLength)
    const extraMetadata = inspectExtraFields(extra, filenameBytes)
    const name = decodeEntryName(filenameBytes, (flags & 0x0800) !== 0, extraMetadata.unicodePath)
    const canonicalPath = canonicalEntryName(name, limits.maxFilenameBytes)
    assertSafeEntryType(versionMadeBy, externalAttributes, canonicalPath.directory)
    assertNoPathCollision(entries, canonicalPath)
    if (localOffsets.has(localHeaderOffset)) throw zipError('zip_header_mismatch', 'ZIP entries share a local header')
    localOffsets.add(localHeaderOffset)
    if (uncompressedSize > limits.maxEntryUncompressedBytes) {
      throw zipError('zip_entry_limit_exceeded', 'A ZIP entry exceeds the uncompressed size limit')
    }
    declaredTotal += uncompressedSize
    if (declaredTotal > limits.maxUncompressedBytes) {
      throw zipError('zip_uncompressed_limit_exceeded', 'ZIP declared uncompressed size exceeds the batch limit')
    }
    if (compressedSize === 0 ? uncompressedSize !== 0 : uncompressedSize > compressedSize * limits.maxCompressionRatio) {
      throw zipError('zip_ratio_limit_exceeded', 'ZIP entry has an unsafe declared compression ratio')
    }
    entries.push({
      index,
      name,
      canonical: canonicalPath.canonical,
      directory: canonicalPath.directory,
      filenameBytes: Buffer.from(filenameBytes),
      unicodePath: extraMetadata.unicodePath,
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
  if (cursor !== central.length) throw zipError('zip_invalid', 'ZIP central directory contains trailing records')

  for (const entry of entries) {
    assertNotAborted(signal)
    if (entry.localHeaderOffset + 30 > centralOffset) throw zipError('zip_invalid', 'ZIP local-header range is invalid')
    const local = await readExactly(handle, 30, entry.localHeaderOffset)
    if (local.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) throw zipError('zip_invalid', 'ZIP local-header signature is invalid')
    const localVersionNeeded = local.readUInt16LE(4)
    const localFlags = local.readUInt16LE(6)
    const localMethod = local.readUInt16LE(8)
    const localCrc32 = local.readUInt32LE(14)
    const localCompressedSize = local.readUInt32LE(18)
    const localUncompressedSize = local.readUInt32LE(22)
    const localFilenameLength = local.readUInt16LE(26)
    const localExtraLength = local.readUInt16LE(28)
    if (
      localVersionNeeded !== entry.versionNeeded || localFlags !== entry.flags || localMethod !== entry.compressionMethod
    ) {
      throw zipError('zip_header_mismatch', 'ZIP local header does not match the central directory')
    }
    if (localVersionNeeded >= 45 || localCompressedSize === 0xffffffff || localUncompressedSize === 0xffffffff) {
      throw zipError('zip64_unsupported', 'ZIP64 entries are not supported')
    }
    const usesDescriptor = (entry.flags & 0x0008) !== 0
    if (usesDescriptor) {
      if (localCrc32 !== 0 || localCompressedSize !== 0 || localUncompressedSize !== 0) {
        throw zipError('zip_header_mismatch', 'ZIP descriptor entry has non-zero local sizes')
      }
    } else if (
      localCrc32 !== entry.crc32 || localCompressedSize !== entry.compressedSize ||
      localUncompressedSize !== entry.uncompressedSize
    ) {
      throw zipError('zip_header_mismatch', 'ZIP local sizes or CRC do not match the central directory')
    }
    const variable = await readExactly(handle, localFilenameLength + localExtraLength, entry.localHeaderOffset + 30)
    const localName = variable.subarray(0, localFilenameLength)
    if (!localName.equals(entry.filenameBytes)) throw zipError('zip_header_mismatch', 'ZIP local filename does not match the central directory')
    const localExtra = inspectExtraFields(variable.subarray(localFilenameLength), localName)
    if (entry.unicodePath && localExtra.unicodePath && entry.unicodePath !== localExtra.unicodePath) {
      throw zipError('zip_header_mismatch', 'ZIP local Unicode filename does not match the central directory')
    }
    entry.dataStart = entry.localHeaderOffset + 30 + variable.length
    entry.dataEnd = entry.dataStart + entry.compressedSize
    if (entry.dataEnd > centralOffset) throw zipError('zip_invalid', 'ZIP entry data overlaps the central directory')
    const descriptorLength = usesDescriptor
      ? await readDataDescriptor(handle, entry.dataEnd, centralOffset, entry)
      : 0
    entry.localRangeEnd = entry.dataEnd + descriptorLength
    if (entry.localRangeEnd > centralOffset) throw zipError('zip_invalid', 'ZIP entry descriptor overlaps the central directory')
  }

  const ranges = entries
    .map((entry) => ({ start: entry.localHeaderOffset, end: entry.localRangeEnd }))
    .sort((left, right) => left.start - right.start)
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) throw zipError('zip_overlapping_entries', 'ZIP local entry ranges overlap')
  }
  return entries
}

const CRC32_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  CRC32_TABLE[index] = value >>> 0
}

function updateCrc32(state, chunk) {
  let value = state
  for (const byte of chunk) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return value >>> 0
}

function crc32Buffer(buffer) {
  return (updateCrc32(0xffffffff, buffer) ^ 0xffffffff) >>> 0
}

function safeOutputExtension(name) {
  const extension = extname(basename(name)).toLowerCase()
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '.bin'
}

async function extractEntry(handle, entry, destinationDir, limits, totalActualBytes, signal) {
  assertNotAborted(signal)
  if (entry.directory) {
    if (entry.compressedSize !== 0 || entry.uncompressedSize !== 0 || entry.crc32 !== 0) {
      throw zipError('zip_size_mismatch', 'ZIP directory entry contains unexpected payload data')
    }
    return { directory: true, actualSize: 0 }
  }
  const outputPath = resolve(destinationDir, `${randomUUID()}${safeOutputExtension(entry.name)}`)
  if (entry.compressedSize === 0) {
    const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
    try {
      await new Promise((resolvePromise, reject) => {
        output.once('finish', resolvePromise)
        output.once('error', reject)
        output.end()
      })
      if (entry.uncompressedSize !== 0 || entry.crc32 !== 0) {
        throw zipError('zip_size_mismatch', 'ZIP empty entry size or CRC does not match its declaration')
      }
      return {
        directory: false,
        actualSize: 0,
        outputPath,
        sha256: createHash('sha256').digest('hex')
      }
    } catch (error) {
      try { await unlink(outputPath) } catch {}
      throw error
    }
  }
  let actualSize = 0
  let crcState = 0xffffffff
  const hash = createHash('sha256')
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        assertNotAborted(signal)
        actualSize += chunk.length
        if (
          actualSize > limits.maxEntryUncompressedBytes ||
          totalActualBytes + actualSize > limits.maxUncompressedBytes
        ) {
          callback(zipError('zip_uncompressed_limit_exceeded', 'ZIP actual uncompressed size exceeds the batch limit'))
          return
        }
        if (entry.compressedSize === 0 ? actualSize > 0 : actualSize > entry.compressedSize * limits.maxCompressionRatio) {
          callback(zipError('zip_ratio_limit_exceeded', 'ZIP entry has an unsafe actual compression ratio'))
          return
        }
        crcState = updateCrc32(crcState, chunk)
        hash.update(chunk)
        callback(null, chunk)
      } catch (error) {
        callback(error)
      }
    }
  })
  const source = handle.createReadStream({
    start: entry.dataStart,
    end: entry.dataEnd - 1,
    autoClose: false,
    highWaterMark: 64 * 1024
  })
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
  try {
    if (entry.compressionMethod === 0) {
      await pipeline(source, guard, output, { signal })
    } else {
      await pipeline(source, createInflateRaw(), guard, output, { signal })
    }
    if (source.bytesRead !== entry.compressedSize) throw zipError('zip_invalid', 'ZIP compressed data is truncated')
    if (actualSize !== entry.uncompressedSize) throw zipError('zip_size_mismatch', 'ZIP entry size does not match its declaration')
    const actualCrc32 = (crcState ^ 0xffffffff) >>> 0
    if (actualCrc32 !== entry.crc32) throw zipError('zip_crc_mismatch', 'ZIP entry CRC check failed')
    return {
      directory: false,
      actualSize,
      outputPath,
      sha256: hash.digest('hex')
    }
  } catch (cause) {
    try { await unlink(outputPath) } catch {}
    if (cause?.code === 'ABORT_ERR' || cause?.name === 'AbortError') throw abortError()
    if (cause?.status) throw cause
    throw zipError('zip_invalid', 'ZIP compressed data is corrupt or cannot be decompressed')
  }
}

export async function extractSecureZip(zipPath, destinationDir, {
  limits: suppliedLimits = {},
  signal,
  onProgress
} = {}) {
  const limits = { ...SECURE_ZIP_LIMITS, ...suppliedLimits }
  await mkdir(destinationDir, { recursive: true })
  const handle = await open(zipPath, 'r')
  const created = []
  try {
    const { size } = await handle.stat()
    const entries = await parseCentralDirectory(handle, size, limits, signal)
    let totalActualBytes = 0
    let completed = 0
    const extracted = []
    for (const entry of entries) {
      assertNotAborted(signal)
      const result = await extractEntry(handle, entry, destinationDir, limits, totalActualBytes, signal)
      totalActualBytes += result.actualSize
      completed += 1
      if (!result.directory) {
        created.push(result.outputPath)
        extracted.push({
          entry_index: entry.index,
          archive_path: entry.name,
          original_filename: basename(entry.name),
          output_path: result.outputPath,
          file_size: result.actualSize,
          sha256: result.sha256,
          compressed_size: entry.compressedSize,
          crc32: entry.crc32
        })
      }
      onProgress?.({ completed, total: entries.length, progress: completed / entries.length })
    }
    return {
      entries: extracted,
      entry_count: entries.length,
      file_count: extracted.length,
      actual_uncompressed_bytes: totalActualBytes
    }
  } catch (error) {
    for (const path of created) {
      try { await unlink(path) } catch {}
    }
    throw error
  } finally {
    await handle.close()
  }
}
