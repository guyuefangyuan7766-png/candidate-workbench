import { parentPort, workerData } from 'node:worker_threads'
import { Readable } from 'node:stream'
import ExcelJS from 'exceljs'
import mammothModule from 'mammoth'
import { readFirstSheet, XlsError } from 'xls-reader'
import { getDocument, PasswordException } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { inspectSecureZipBuffer } from './secure-zip-buffer.js'

const mammoth = mammothModule.default ?? mammothModule

function verifyZipPayload(buffer, limits) {
  inspectSecureZipBuffer(buffer, limits, { verifyPayload: true })
}

function parserError(code, message, status = 422, details) {
  const error = new Error(message)
  error.code = code
  error.status = status
  if (details !== undefined) error.details = details
  return error
}

function cleanText(value, maximum) {
  const text = String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
  return text.length <= maximum ? { text, truncated: false } : { text: text.slice(0, maximum), truncated: true }
}

function cellValue(value) {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'object') return value
  if ('result' in value) return cellValue(value.result)
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? '').join('')
  if ('text' in value) return value.text
  if ('hyperlink' in value) return value.text ?? null
  return null
}

function uniqueHeaders(values, maximumColumns) {
  if (values.length > maximumColumns) {
    throw parserError('spreadsheet_column_limit', `工作表最多支持 ${maximumColumns} 列`, 413)
  }
  const seen = new Map()
  return values.map((value, index) => {
    const base = String(cellValue(value) ?? '').trim() || `未命名列${index + 1}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}_${count + 1}`
  })
}

function rowsFromWorksheet(worksheet, limits) {
  if (!worksheet || worksheet.rowCount < 1) {
    throw parserError('spreadsheet_empty', '文件中没有可读取的工作表或表头')
  }
  if (worksheet.rowCount - 1 > limits.maxSpreadsheetRows) {
    throw parserError('spreadsheet_row_limit', `简历附件单个工作表最多支持 ${limits.maxSpreadsheetRows} 行`, 413)
  }
  const headerRow = worksheet.getRow(1)
  const headers = uniqueHeaders(
    Array.from({ length: headerRow.cellCount }, (_, index) => headerRow.getCell(index + 1).value),
    limits.maxSpreadsheetColumns
  )
  const rows = []
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return
    const values = {}
    let populated = false
    for (let index = 0; index < headers.length; index += 1) {
      const value = cellValue(row.getCell(index + 1).value)
      if (value != null && String(value).trim()) populated = true
      values[headers[index]] = value
    }
    if (populated) rows.push({ row_number: rowNumber, values })
  })
  if (rows.length === 0) throw parserError('spreadsheet_empty', '文件只有表头，没有候选人数据行')
  return { headers, rows, sheetName: worksheet.name }
}

function rowsFromLegacyXls(buffer, limits) {
  let sheet
  try {
    sheet = readFirstSheet(buffer)
  } catch (cause) {
    throw parserError(
      cause instanceof XlsError ? 'xls_encrypted_or_invalid' : 'xls_parse_failed',
      cause instanceof XlsError
        ? '无法读取该 .xls；仅支持未加密的 Excel 97-2003 BIFF8 工作簿'
        : '解析 .xls 时发生错误'
    )
  }
  if (!sheet || sheet.rows.length < 1) throw parserError('spreadsheet_empty', '文件中没有可读取的工作表或表头')
  if (sheet.rows.length - 1 > limits.maxSpreadsheetRows) {
    throw parserError('spreadsheet_row_limit', `简历附件最多支持 ${limits.maxSpreadsheetRows} 行`, 413)
  }
  const headers = uniqueHeaders(sheet.rows[0] ?? [], limits.maxSpreadsheetColumns)
  const rows = []
  for (let rowIndex = 1; rowIndex < sheet.rows.length; rowIndex += 1) {
    const source = sheet.rows[rowIndex] ?? []
    const values = {}
    let populated = false
    for (let index = 0; index < headers.length; index += 1) {
      const value = cellValue(source[index])
      if (value != null && String(value).trim()) populated = true
      values[headers[index]] = value
    }
    if (populated) rows.push({ row_number: rowIndex + 1, values })
  }
  if (rows.length === 0) throw parserError('spreadsheet_empty', '文件只有表头，没有候选人数据行')
  return { headers, rows, sheetName: sheet.name }
}

function spreadsheetText(parsed, maximum) {
  let output = ''
  let truncated = false
  for (const row of parsed.rows) {
    const line = parsed.headers
      .map((header) => `${header}: ${String(row.values[header] ?? '').trim()}`)
      .filter((entry) => !entry.endsWith(': '))
      .join(' | ')
    if (!line) continue
    if (output.length + line.length + 1 > maximum) {
      output += line.slice(0, Math.max(0, maximum - output.length))
      truncated = true
      break
    }
    output += `${line}\n`
  }
  return { text: output.trim(), truncated }
}

async function parseSpreadsheet(buffer, format, limits) {
  let parsed
  if (format === 'xls') {
    parsed = rowsFromLegacyXls(buffer, limits)
  } else {
    const workbook = new ExcelJS.Workbook()
    if (format === 'csv') {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      } catch {
        throw parserError('invalid_csv_encoding', 'CSV 必须使用有效的 UTF-8 编码')
      }
      const worksheet = await workbook.csv.read(Readable.from([buffer]))
      parsed = rowsFromWorksheet(worksheet, limits)
    } else {
      try {
        await workbook.xlsx.load(buffer)
      } catch {
        throw parserError('office_encrypted_or_invalid', '无法读取工作簿；请确认文件未加密、未损坏且格式正确')
      }
      if (workbook.worksheets.length > limits.maxWorksheets) {
        throw parserError('worksheet_limit', `工作簿最多支持 ${limits.maxWorksheets} 个工作表`, 413)
      }
      parsed = rowsFromWorksheet(workbook.worksheets[0], limits)
    }
  }
  const extracted = spreadsheetText(parsed, limits.maxExtractedText)
  return {
    text: extracted.text,
    text_truncated: extracted.truncated,
    records: parsed.rows,
    metadata: {
      sheet_name: parsed.sheetName,
      row_count: parsed.rows.length,
      column_count: parsed.headers.length,
      headers: parsed.headers
    }
  }
}

async function parsePdf(buffer, limits) {
  let loadingTask
  let pdf
  try {
    loadingTask = getDocument({
      data: new Uint8Array(buffer),
      enableScripting: false,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      verbosity: 0
    })
    pdf = await loadingTask.promise
    if (pdf.numPages > limits.maxPdfPages) {
      throw parserError('pdf_page_limit', `PDF 最多支持 ${limits.maxPdfPages} 页`, 413)
    }
    let combined = ''
    let truncated = false
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false })
      let pageText = ''
      for (const item of content.items) {
        if (!item || typeof item.str !== 'string') continue
        pageText += item.str
        pageText += item.hasEOL ? '\n' : ' '
      }
      const remaining = limits.maxExtractedText - combined.length
      if (pageText.length > remaining) {
        combined += pageText.slice(0, Math.max(0, remaining))
        truncated = true
        break
      }
      combined += `${pageText}\n`
    }
    const cleaned = cleanText(combined, limits.maxExtractedText)
    if (cleaned.text.replace(/\s/g, '').length < 20) {
      throw parserError('pdf_no_text', 'PDF 中没有可提取文本；扫描件和需要 OCR 的文件暂不支持')
    }
    return {
      text: cleaned.text,
      text_truncated: truncated || cleaned.truncated,
      records: [{ row_number: 1, values: { raw_text: cleaned.text } }],
      metadata: { page_count: pdf.numPages }
    }
  } catch (cause) {
    if (cause instanceof PasswordException || cause?.name === 'PasswordException') {
      throw parserError('encrypted_pdf_unsupported', '不支持加密或带密码的 PDF')
    }
    if (cause?.code && cause?.status) throw cause
    throw parserError('pdf_parse_failed', 'PDF 已损坏或无法安全提取文本')
  } finally {
    try { await pdf?.destroy() } catch {}
    try { await loadingTask?.destroy() } catch {}
  }
}

async function parseDocx(buffer, limits) {
  let result
  try {
    result = await mammoth.extractRawText({ buffer }, { externalFileAccess: false })
  } catch {
    throw parserError('docx_parse_failed', 'DOCX 已损坏、加密或无法安全提取文本')
  }
  const cleaned = cleanText(result?.value, limits.maxExtractedText)
  if (cleaned.text.replace(/\s/g, '').length < 20) {
    throw parserError('docx_no_text', 'DOCX 中没有可提取的简历文本')
  }
  return {
    text: cleaned.text,
    text_truncated: cleaned.truncated,
    records: [{ row_number: 1, values: { raw_text: cleaned.text } }],
    metadata: { parser_messages: Array.isArray(result?.messages) ? result.messages.length : 0 }
  }
}

async function main() {
  const buffer = Buffer.from(workerData.buffer)
  const { format, limits } = workerData
  if (['docx', 'xlsx', 'xlsm'].includes(format)) verifyZipPayload(buffer, limits)
  if (format === 'pdf') return parsePdf(buffer, limits)
  if (format === 'docx') return parseDocx(buffer, limits)
  if (['xlsx', 'xlsm', 'xls', 'csv'].includes(format)) return parseSpreadsheet(buffer, format, limits)
  throw parserError('unsupported_attachment_type', '不支持该附件格式', 415)
}

try {
  const result = await main()
  parentPort.postMessage({ ok: true, result })
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      status: Number.isInteger(error?.status) ? error.status : 422,
      code: error?.code ?? 'attachment_parse_failed',
      message: error?.message ?? '附件解析失败',
      details: error?.details
    }
  })
}
