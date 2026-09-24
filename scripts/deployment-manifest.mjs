#!/usr/bin/env node
/**
 * 部署清单：扫描项目文件并计算 SHA256，用于比对本地与服务器上的项目是否一致。
 *
 * 用法：
 *   node scripts/deployment-manifest.mjs
 *   node scripts/deployment-manifest.mjs --out tmp/manifest.json
 *   node scripts/deployment-manifest.mjs --post http://192.168.190.71:8899/upload
 *   node scripts/deployment-manifest.mjs --root D:\apps\project
 *
 * 排除的是构建缓存、运行数据和临时产物（见 EXCLUDED_DIRS / EXCLUDED_FILES），
 * 源码、脚本、文档、构建产物 dist/ 都参与比对。
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'data', 'tmp', 'output', 'outputs', 'backups', 'exports',
  '.codex-tmp', '.playwright-cli', '.superpowers', '.claude', 'dist-ssr', 'coverage',
  '.tmp-baseline-db', '.tmp-contact-check', '.tmp-contact-check-2', '.tmp-import-benchmark',
  '.tmp-ldap-rehearsal', '.tmp-position-diagnosis-work', '.tmp-search-deploy'
])
const EXCLUDED_DIR_PREFIXES = ['.tmp-']
const EXCLUDED_FILE_PATTERNS = [
  /\.log$/i, /^\.env$/i, /\.db(-wal|-shm)?$/i, /^\.DS_Store$/i,
  /^\.candidate-workbench-maintenance.*\.lock$/i, /^\.raw-cookie-output\.txt$/i,
  /^page\d+\.png$/i, /^wd-root-ca\.(cer|crt)$/i
]
const EXCLUDED_FILE_PREFIXES = ['.tmp-']

function excludedEntry(name, isDirectory) {
  if (isDirectory) {
    if (EXCLUDED_DIRS.has(name)) return true
    return EXCLUDED_DIR_PREFIXES.some((prefix) => name.startsWith(prefix))
  }
  if (EXCLUDED_FILE_PREFIXES.some((prefix) => name.startsWith(prefix))) return true
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name))
}

function collectFiles(root, current = root, out = []) {
  let entries
  try {
    entries = readdirSync(current, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (excludedEntry(entry.name, entry.isDirectory())) continue
    const fullPath = join(current, entry.name)
    if (entry.isDirectory()) collectFiles(root, fullPath, out)
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
  files.sort((a, b) => a.path.localeCompare(b.path))
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

const root = resolve(argValue('--root') ?? join(scriptDir, '..'))
const manifest = buildManifest(root)
const json = JSON.stringify(manifest, null, 2)

const postUrl = argValue('--post')
const outPath = argValue('--out')

if (postUrl) {
  const response = await fetch(postUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: json
  })
  console.log(`POST ${postUrl} -> HTTP ${response.status}`)
  console.log(`files=${manifest.file_count} root=${manifest.root}`)
} else if (outPath) {
  writeFileSync(resolve(outPath), json, 'utf8')
  console.log(`已写入 ${outPath}（files=${manifest.file_count}）`)
} else {
  console.log(json)
}
