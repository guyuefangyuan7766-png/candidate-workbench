import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const outputDirectory = path.join(root, 'output', 'large-import-v7')
const outputPath = path.join(outputDirectory, 'anonymous-candidates-10241.csv')
const candidateCount = 10_241
const entropyBytesPerRow = 3_650

function deterministicPayload(seed, byteLength) {
  const bytes = Buffer.allocUnsafe(byteLength)
  let state = (seed ^ 0x9e3779b9) >>> 0
  for (let index = 0; index < byteLength; index += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    bytes[index] = state & 0xff
  }
  return `payload_${bytes.toString('base64')}`
}

function candidateRow(index) {
  const serial = String(index).padStart(5, '0')
  const year = 1980 + (index % 22)
  const month = String((index % 12) + 1).padStart(2, '0')
  const day = String((index % 27) + 1).padStart(2, '0')
  return [
    `ANON-PERF-${serial}`,
    `匿名候选人${serial}`,
    `candidate.${serial}@example.test`,
    index % 2 === 0 ? '女' : '男',
    `${year}-${month}-${day}`,
    2026 - year,
    index % 3 === 0 ? '上海市' : index % 3 === 1 ? '北京市' : '深圳市',
    deterministicPayload(index, entropyBytesPerRow)
  ].join(',')
}

mkdirSync(outputDirectory, { recursive: true })
const output = createWriteStream(outputPath, { encoding: 'utf8', flags: 'wx' })
const hash = createHash('sha256')
let fileBytes = 0

async function write(value) {
  const chunk = Buffer.from(value, 'utf8')
  hash.update(chunk)
  fileBytes += chunk.length
  if (!output.write(chunk)) await once(output, 'drain')
}

try {
  await write('\uFEFF应聘者ID,姓名,邮箱,性别,出生日期,年龄,所在地,匿名解析负载\n')
  for (let index = 1; index <= candidateCount; index += 1) {
    await write(`${candidateRow(index)}\n`)
  }
  output.end()
  await once(output, 'finish')
  console.log(JSON.stringify({
    outputPath,
    candidateCount,
    fileBytes,
    fileMiB: fileBytes / 1024 / 1024,
    sha256: hash.digest('hex')
  }, null, 2))
} catch (error) {
  output.destroy()
  throw error
}
