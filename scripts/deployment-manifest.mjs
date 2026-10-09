#!/usr/bin/env node
// 部署清单：扫描项目文件并计算 SHA256，用于比对本地与服务器上的项目是否一致。
//
//   node scripts/deployment-manifest.mjs                                  # 生成当前项目清单
//   node scripts/deployment-manifest.mjs --out data/deploy/local.json     # 落盘
//   node scripts/deployment-manifest.mjs --root C:\apps\talent-workbench --out data/deploy/server.json
//   node scripts/deployment-manifest.mjs --compare data/deploy/local.json data/deploy/server.json
//
// 排除构建缓存、运行数据与临时产物；源码、脚本、文档、dist/ 构建产物都参与比对
// （与 C 盘项目的 scripts/deployment-manifest.mjs 保持同一口径）。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'data', 'tmp', 'output', 'outputs', 'backups', 'exports',
  '.codex-tmp', '.playwright-cli', '.superpowers', '.claude', 'dist-ssr', 'coverage'
])
const EXCLUDED_DIR_PREFIXES = ['.tmp-']
const EXCLUDED_FILE_PATTERNS = [
  /\.log$/iu,
  /^\.env$/iu,
  /\.db(-wal|-shm)?$/iu,
  /^\.DS_Store$/iu,
  /^\.candidate-workbench-maintenance.*\.lock$/iu,
  /^page\d+\.png$/iu
]
const EXCLUDED_FILE_PREFIXES = ['.tmp-']

function excludedEntry(name, isDirectory) {
  if (isDirectory) {
    if (EXCLUDED_DIRS.has(name)) return true
    return EXCLUDED_DIR_PREFIXES.some((prefix) => name.startsWith(prefix))
  }
  if (excluded(name)) return true
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name))
}

function excluded(name) {
  return EXCLUDED_FILE_PREFIXES.some((prefix) => name.startsWith(prefix))
}

function collectFiles(current, out = []) {
  let entries
  try {
    entries = readdirSync(current, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (excludedEntry(entry.name, entry.isDirectory())) continue
    const fullPath = join(current, entry.name)
    if (entry.isDirectory()) collectFiles(fullPath, out)
    else if (entry.isFile()) out.push(fullPath)
  }
  return out
}

function gitHead(root) {
  try {
    const head = readFileSync(join(root, '.git', 'HEAD'), 'utf8').trim()
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim()
      try {
        return { ref, commit: readFileSync(join(root, '.git', ref), 'utf8').trim() }
      } catch {
        return { ref, commit: null }
      }
    }
    return { ref: null, commit: head }
  } catch {
    return null
  }
}

function buildManifest(root) {
  const files = []
  for (const fullPath of collectFiles(root)) {
    let stats
    try {
      stats = statSync(fullPath)
    } catch {
      continue
    }
    let digest = null
    try {
      digest = createHash('sha256').update(readFileSync(fullPath)).digest('hex')
    } catch {
      digest = 'unreadable'
    }
    files.push({
      path: relative(root, fullPath).split(sep).join('/'),
      size: stats.size,
      sha256: digest
    })
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  return {
    generated_at: new Date().toISOString(),
    hostname: hostname(),
    node: process.version,
    root,
    git: gitHead(root),
    file_count: files.length,
    files
  }
}

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : null
}

function compareManifests(leftPath, rightPath) {
  const left = JSON.parse(readFileSync(leftPath, 'utf8'))
  const right = JSON.parse(readFileSync(rightPath, 'utf8'))
  const leftMap = new Map(left.files.map((file) => [file.path, file]))
  const rightMap = new Map(right.files.map((file) => [file.path, file]))
  const onlyLeft = []
  const onlyRight = []
  const differ = []
  for (const [path, file] of leftMap) {
    const other = rightMap.get(path)
    if (!other) onlyLeft.push(path)
    else if (other.sha256 !== file.sha256) differ.push(path)
  }
  for (const path of rightMap.keys()) if (!leftMap.has(path)) onlyRight.push(path)
  return {
    left: { root: left.root, hostname: left.hostname, file_count: left.file_count },
    right: { root: right.root, hostname: right.hostname, file_count: right.file_count },
    only_left: onlyLeft,
    only_right: onlyRight,
    differ,
    identical: onlyLeft.length === 0 && onlyRight.length === 0 && differ.length === 0
  }
}

const compareIndex = process.argv.indexOf('--compare')
if (compareIndex >= 0) {
  const leftPath = resolve(process.argv[compareIndex + 1] ?? '')
  const rightPath = resolve(process.argv[compareIndex + 2] ?? '')
  if (!existsSync(leftPath) || !existsSync(rightPath)) {
    console.error(JSON.stringify({ error: 'manifest_missing', left: leftPath, right: rightPath }))
    process.exit(1)
  }
  const result = compareManifests(leftPath, rightPath)
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.identical ? 0 : 1)
}

const root = resolve(argValue('--root') ?? join(scriptDir, '..'))
const manifest = buildManifest(root)
const json = `${JSON.stringify(manifest, null, 2)}\n`
const outPath = argValue('--out')
if (outPath) {
  const target = resolve(outPath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, json)
  console.log(JSON.stringify({ written: target, file_count: manifest.file_count, hostname: manifest.hostname }, null, 1))
} else {
  process.stdout.write(json)
}
