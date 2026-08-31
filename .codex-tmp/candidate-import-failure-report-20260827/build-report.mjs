import fs from 'node:fs/promises'
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool'

const root = 'C:/Users/cboy/Documents/北森'
const csvPath = `${root}/output/candidate-import-a-issue-rows-intermediate-20260827.csv`
const summaryPath = `${root}/output/candidate-import-a-failure-reasons-intermediate-20260827.json`
const outputPath = `${root}/output/candidate-import-a-issue-rows-intermediate-20260827.xlsx`
const previewPath = `${root}/.codex-tmp/candidate-import-failure-report-20260827/summary-preview.png`

const summary = JSON.parse(await fs.readFile(summaryPath, 'utf8'))
const csvText = await fs.readFile(csvPath, 'utf8')
const workbook = await Workbook.fromCSV(csvText, { sheetName: '问题行' })
const overview = workbook.worksheets.add('汇总')
const issues = workbook.worksheets.getItem('问题行')

overview.showGridLines = false
overview.mergeCells('A1:F1')
overview.getRange('A1').values = [['人才库简历导入问题行汇总']]
overview.mergeCells('A2:F2')
overview.getRange('A2').values = [['中间结果：A 组完成 17/18；第 18 片提交超时，未重试']]

overview.getRange('A4:B10').values = [
  ['已完成分片', '17 / 18'],
  ['已完成数据行', 109402],
  ['正式导入', 80323],
  ['正式更新', 25607],
  ['正式失败', 3472],
  ['行数守恒', '109,402 = 80,323 + 25,607 + 3,472'],
  ['明确失败/无效行', Number(summary.failed_rows_indexed)]
]
overview.getRange('D4:E10').values = [
  ['第18片源行', 10000],
  ['第18片预览无效', 574],
  ['提交超时未确认', Number(summary.timeout_unconfirmed_rows)],
  ['第18片业务写入', 0],
  ['报告状态', '中间结果'],
  ['B组应聘者数据', '未处理'],
  ['完整性检查', '未运行完整 PRAGMA integrity_check']
]

const reasonLabels = {
  missing_identity: '缺少可用身份标识',
  birth_date: '出生日期格式或取值无效',
  identity_conflict: '手机或邮箱命中不同候选人',
  photo_url: '照片地址无效',
  email: '邮箱格式无效',
  phone: '手机号格式无效',
  age: '年龄无效'
}
const reasons = Object.entries(summary.row_reason_counts)
  .sort((a, b) => b[1] - a[1])
overview.getRange('A12:E12').values = [['失败原因代码', '去重失败行数', '原因事件次数', '占明确失败/无效行', '说明']]
overview.getRange(`A13:E${12 + reasons.length}`).values = reasons.map(([code, count]) => [
  code,
  Number(count),
  Number(summary.event_reason_counts?.[code] ?? 0),
  null,
  reasonLabels[code] ?? ''
])
overview.getRange('D13').formulas = [['=B13/$B$10']]
overview.getRange(`D13:D${12 + reasons.length}`).fillDown()

overview.mergeCells('A22:F22')
overview.getRange('A22').values = [['口径说明']]
overview.mergeCells('A23:F23')
overview.getRange('A23').values = [['一行可同时有多个失败原因；原因行数之和可能大于 4,046。第 18 片 9,426 条超时未确认行不计入失败原因。']]
overview.mergeCells('A24:F24')
overview.getRange('A24').values = [['问题行工作表包含用户要求保留的原始字段；未写入 preview token。']]

overview.getRange('A1:F1').format = {
  fill: '#173B36',
  font: { bold: true, color: '#FFFFFF', size: 18 },
  verticalAlignment: 'center'
}
overview.getRange('A1:F1').format.rowHeight = 34
overview.getRange('A2:F2').format = {
  fill: '#DCEBE7',
  font: { color: '#173B36', size: 11 },
  verticalAlignment: 'center'
}
overview.getRange('A2:F2').format.rowHeight = 26
overview.getRange('A4:A10').format = { fill: '#EFF5F3', font: { bold: true, color: '#26433E' } }
overview.getRange('D4:D10').format = { fill: '#FFF4D8', font: { bold: true, color: '#6B4D00' } }
overview.getRange('B4:B10').format = { font: { bold: true, color: '#173B36' } }
overview.getRange('E4:E10').format = { font: { bold: true, color: '#7A2E2E' } }
overview.getRange('A12:E12').format = {
  fill: '#2F5E57',
  font: { bold: true, color: '#FFFFFF' },
  verticalAlignment: 'center'
}
overview.getRange(`A13:E${12 + reasons.length}`).format.borders = {
  preset: 'inside',
  style: 'thin',
  color: '#D8E1DF'
}
overview.getRange(`B13:C${12 + reasons.length}`).format.numberFormat = '#,##0'
overview.getRange(`D13:D${12 + reasons.length}`).format.numberFormat = '0.0%'
overview.getRange('A22:F22').format = { fill: '#E8ECEB', font: { bold: true, color: '#243B37' } }
overview.getRange('A23:F24').format = { font: { color: '#4B5D59', size: 10 }, wrapText: true }
overview.getRange('A4:E10').format.rowHeight = 23
overview.getRange('A12:E19').format.rowHeight = 22
overview.getRange('A:A').format.columnWidth = 27
overview.getRange('B:B').format.columnWidth = 18
overview.getRange('C:C').format.columnWidth = 18
overview.getRange('D:D').format.columnWidth = 24
overview.getRange('E:E').format.columnWidth = 32
overview.getRange('F:F').format.columnWidth = 4
overview.freezePanes.freezeRows(2)

const issueHeader = issues.getRangeByIndexes(0, 0, 1, 201)
issueHeader.format = {
  fill: '#263238',
  font: { bold: true, color: '#FFFFFF', size: 10 },
  wrapText: true,
  verticalAlignment: 'center'
}
issueHeader.format.rowHeight = 36
issues.getRangeByIndexes(0, 0, 1, 1).format.columnWidth = 26
issues.getRangeByIndexes(0, 1, 1, 1).format.columnWidth = 34
issues.getRangeByIndexes(0, 2, 1, 2).format.columnWidth = 11
issues.getRangeByIndexes(0, 4, 1, 2).format.columnWidth = 25
issues.getRangeByIndexes(0, 6, 1, 2).format.columnWidth = 29
issues.getRangeByIndexes(0, 8, 1, 2).format.columnWidth = 13
issues.getRangeByIndexes(0, 10, 1, 191).format.columnWidth = 14
issues.freezePanes.freezeRows(1)
issues.freezePanes.freezeColumns(4)
const statusRange = issues.getRangeByIndexes(1, 5, 13472, 1)
statusRange.conditionalFormats.add('containsText', {
  text: '正式提交失败',
  format: { fill: '#FDE7E7', font: { color: '#8F1D1D' } }
})
statusRange.conditionalFormats.add('containsText', {
  text: '预览判定无效',
  format: { fill: '#FFF0D6', font: { color: '#7A4A00' } }
})
statusRange.conditionalFormats.add('containsText', {
  text: '第18片提交超时',
  format: { fill: '#FFF6C7', font: { color: '#705B00' } }
})

const inspect = await workbook.inspect({
  kind: 'table',
  range: '汇总!A1:F24',
  include: 'values,formulas',
  tableMaxRows: 24,
  tableMaxCols: 6,
  maxChars: 10000
})
const formulaErrors = await workbook.inspect({
  kind: 'match',
  searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A',
  options: { useRegex: true, maxResults: 100 },
  summary: 'final formula error scan',
  maxChars: 3000
})
const preview = await workbook.render({ sheetName: '汇总', range: 'A1:F24', scale: 1.5, format: 'png' })
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()))
const output = await SpreadsheetFile.exportXlsx(workbook)
await output.save(outputPath)
console.log(JSON.stringify({
  event: 'workbook_exported',
  output_path: outputPath,
  issue_rows: 13472,
  summary_inspect_chars: inspect.ndjson.length,
  formula_error_matches: formulaErrors.ndjson.includes('"matchCount":0') ? 0 : null,
  preview_path: previewPath
}))
