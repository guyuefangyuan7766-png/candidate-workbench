import fs from 'node:fs/promises'
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool'

const root = 'C:/Users/cboy/Documents/北森'
const sourceCsv = `${root}/output/candidate-import-a-failed-rows-final-20260827.csv`
const reasonsJson = `${root}/output/candidate-import-a-failure-reasons-final-20260827.json`
const outputDir = `${root}/outputs/failed-candidates-20260828`
const outputPath = `${outputDir}/failed-candidates-4047-full-fields.xlsx`
const previewDir = `${outputDir}/preview`

function columnName(index) {
  let n = index
  let result = ''
  while (n > 0) {
    const remainder = (n - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    n = Math.floor((n - 1) / 26)
  }
  return result
}

const csv = (await fs.readFile(sourceCsv, 'utf8')).replace(/^\uFEFF/, '')
const reasons = JSON.parse(await fs.readFile(reasonsJson, 'utf8'))
const workbook = await Workbook.fromCSV(csv, { sheetName: '失败行明细' })
const detail = workbook.worksheets.getItem('失败行明细')
const used = detail.getUsedRange()
const values = used.values
const headers = values[0] ?? []
const rowCount = Math.max(0, values.length - 1)
const columnCount = headers.length
const lastColumn = columnName(columnCount)
const lastRow = values.length

detail.showGridLines = false
detail.getRange(`A1:${lastColumn}${lastRow}`).format = {
  font: { name: 'Aptos', size: 9, color: '#1F2937' },
  verticalAlignment: 'center'
}
detail.getRange(`A1:${lastColumn}1`).format = {
  fill: '#1F4E78',
  font: { name: 'Aptos Display', size: 10, bold: true, color: '#FFFFFF' },
  horizontalAlignment: 'center',
  verticalAlignment: 'center',
  wrapText: true,
  borders: { preset: 'outside', style: 'thin', color: '#163A5A' }
}
detail.getRange(`A1:${lastColumn}1`).format.rowHeight = 34
detail.getRange(`A1:${lastColumn}${lastRow}`).format.columnWidth = 14
detail.getRange(`A1:B${lastRow}`).format.columnWidth = 34
detail.getRange(`C1:D${lastRow}`).format.columnWidth = 12
detail.getRange(`E1:F${lastRow}`).format.columnWidth = 24
detail.getRange(`G1:H${lastRow}`).format.columnWidth = 12
detail.getRange(`I1:M${lastRow}`).format.columnWidth = 16
detail.getRange(`N1:${lastColumn}${lastRow}`).format.columnWidth = 15
detail.getRange(`A2:${lastColumn}${lastRow}`).format.rowHeight = 18
detail.getRange(`F2:F${lastRow}`).format = {
  fill: '#FFF2CC',
  font: { color: '#7F1D1D' },
  wrapText: true
}
detail.getRange(`E2:E${lastRow}`).format = {
  fill: '#FCE4D6',
  font: { color: '#7C2D12' }
}
detail.freezePanes.freezeRows(1)
detail.freezePanes.freezeColumns(6)
detail.tables.add(`A1:${lastColumn}${lastRow}`, true, 'FailedCandidatesTable')

const summary = workbook.worksheets.add('失败原因统计')
summary.showGridLines = false
summary.mergeCells('A1:D1')
summary.getRange('A1').values = [['正式失败候选人完整字段导出']]
summary.getRange('A1:D1').format = {
  fill: '#1F4E78',
  font: { name: 'Aptos Display', size: 16, bold: true, color: '#FFFFFF' },
  horizontalAlignment: 'left',
  verticalAlignment: 'center'
}
summary.getRange('A1:D1').format.rowHeight = 30
summary.mergeCells('A2:D2')
summary.getRange('A2').values = [['来源：A 组“人才库简历”正式失败行表；此工作簿保留原始失败行的完整字段和失败元数据。']]
summary.getRange('A2:D2').format = {
  fill: '#EAF2F8',
  font: { color: '#334155', italic: true, size: 10 },
  wrapText: true
}
summary.getRange('A4:B7').values = [
  ['指标', '数值'],
  ['失败行总数', null],
  ['未解决失败行', Number(reasons.unresolved_failure_rows ?? 0)],
  ['超时未确认行', Number(reasons.timeout_unconfirmed_rows ?? 0)]
]
summary.getRange('B5').formulas = [[`=COUNTA('失败行明细'!$A$2:$A$${lastRow})`]]
summary.getRange('A4:B4').format = {
  fill: '#5B9BD5',
  font: { bold: true, color: '#FFFFFF' },
  horizontalAlignment: 'center'
}
summary.getRange('A5:A7').format.font = { bold: true, color: '#1F2937' }
summary.getRange('B5:B7').format.numberFormat = '#,##0'
summary.getRange('A4:B7').format.borders = { preset: 'all', style: 'thin', color: '#D9E2F3' }

summary.getRange('A10:C10').values = [['失败原因', '失败行数', '事件次数（来源统计）']]
summary.getRange('A10:C10').format = {
  fill: '#5B9BD5',
  font: { bold: true, color: '#FFFFFF' },
  horizontalAlignment: 'center',
  wrapText: true
}
const reasonRows = Object.entries(reasons.row_reason_counts ?? {}).map(([code, count]) => [code, Number(count), Number(reasons.event_reason_counts?.[code] ?? 0)])
summary.getRange(`A11:C${10 + reasonRows.length}`).values = reasonRows
summary.getRange(`B11:C${10 + reasonRows.length}`).format.numberFormat = '#,##0'
summary.getRange(`A10:C${10 + reasonRows.length}`).format.borders = { preset: 'all', style: 'thin', color: '#D9E2F3' }
summary.getRange(`A11:A${10 + reasonRows.length}`).format.font = { color: '#7F1D1D' }
summary.getRange('A19:D21').values = [
  ['说明', null, null, null],
  ['失败原因一行可能包含多个代码，因此失败行数不能简单相加。', null, null, null],
  ['明细页中的字段顺序和内容来自正式失败行 CSV；未重新调用预览或提交接口。', null, null, null]
]
summary.mergeCells('A19:D19')
summary.mergeCells('A20:D20')
summary.mergeCells('A21:D21')
summary.getRange('A19:D19').format = { fill: '#D9EAF7', font: { bold: true, color: '#1F2937' } }
summary.getRange('A20:D21').format = { fill: '#F8FAFC', font: { color: '#475569', size: 10 }, wrapText: true }
summary.getRange('A19:D21').format.borders = { preset: 'outside', style: 'thin', color: '#CBD5E1' }
summary.getRange('A1:D21').format.verticalAlignment = 'center'
summary.getRange('A1:D21').format.columnWidth = 22
summary.getRange('A1:A21').format.columnWidth = 26
summary.getRange('B1:C21').format.columnWidth = 18
summary.getRange('D1:D21').format.columnWidth = 22
summary.freezePanes.freezeRows(4)
summary.tables.add(`A10:C${10 + reasonRows.length}`, true, 'FailureReasonsTable')

await fs.mkdir(previewDir, { recursive: true })
const summaryPreview = await workbook.render({ sheetName: '失败原因统计', autoCrop: 'all', scale: 1, format: 'png' })
await fs.writeFile(`${previewDir}/failure-summary.png`, new Uint8Array(await summaryPreview.arrayBuffer()))
const detailPreview = await workbook.render({ sheetName: '失败行明细', range: `A1:N20`, scale: 1, format: 'png' })
await fs.writeFile(`${previewDir}/failure-detail-sample.png`, new Uint8Array(await detailPreview.arrayBuffer()))

const summaryCheck = await workbook.inspect({
  kind: 'table',
  range: `失败原因统计!A1:D21`,
  include: 'values,formulas',
  tableMaxRows: 21,
  tableMaxCols: 4,
  maxChars: 8000
})
console.log(summaryCheck.ndjson)
const detailCheck = await workbook.inspect({
  kind: 'table',
  range: `失败行明细!A1:N6`,
  include: 'values,formulas',
  tableMaxRows: 6,
  tableMaxCols: 14,
  maxChars: 8000,
  tableMaxCellChars: 120
})
console.log(detailCheck.ndjson)
const errors = await workbook.inspect({
  kind: 'match',
  searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
  options: { useRegex: true, maxResults: 100 },
  summary: 'final formula error scan'
})
console.log(errors.ndjson)

await fs.mkdir(outputDir, { recursive: true })
const output = await SpreadsheetFile.exportXlsx(workbook)
await output.save(outputPath)
console.log(JSON.stringify({ outputPath, rowCount, columnCount, reasonCount: reasonRows.length }))
