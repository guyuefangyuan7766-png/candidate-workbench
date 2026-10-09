#!/usr/bin/env node
// Embedding 计费探针：用**匿名合成文本**跑一次真实的向量化调用，读网关累计用量
// 在探针前后的差值，算出单价，再外推全量语料成本。
//
//   node scripts/probe-embedding-cost.mjs                            # 预演（不联网、不花钱）
//   node scripts/probe-embedding-cost.mjs --apply --max-requests 5   # 冒烟：5 批
//   node scripts/probe-embedding-cost.mjs --apply                    # 全量探针（约 150 万 tokens）
//
// 硬门禁依据：docs/VECTOR_HYBRID_PLAN.md §3.5 —— 单价未实测前禁止全量向量化。
// 只用合成文本，不发任何候选人数据；批次固定 10 条（网关实测 11 条会失败）。

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createSearchModelAdapters } from '../server/search-model-adapters.js'

const DEFAULT_TARGET_TOKENS = 1_500_000
const CHARS_PER_CHUNK = 600
const BATCH_SIZE = 10
// 全量语料（2026-10-07 实测）：区块 132,060,450 + 主档 1,381,947 + 附件 140,199,784
const CORPUS_CHARS = 273_642_181
const REPORT_PATH = resolve('data/embedding-cost-probe.json')

function parseArgs(argv) {
  const options = { apply: false, targetTokens: DEFAULT_TARGET_TOKENS, maxRequests: Infinity, report: REPORT_PATH, charsPerChunk: CHARS_PER_CHUNK, settleSeconds: 30, concurrency: 1 }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') options.apply = true
    else if (arg === '--target-tokens') { index += 1; options.targetTokens = Number.parseInt(argv[index], 10) }
    else if (arg === '--max-requests') { index += 1; options.maxRequests = Number.parseInt(argv[index], 10) }
    else if (arg === '--chars-per-chunk') { index += 1; options.charsPerChunk = Number.parseInt(argv[index], 10) }
    else if (arg === '--settle-seconds') { index += 1; options.settleSeconds = Number.parseInt(argv[index], 10) }
    else if (arg === '--concurrency') { index += 1; options.concurrency = Number.parseInt(argv[index], 10) }
    else if (arg === '--report') { index += 1; options.report = resolve(argv[index]) }
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  if (!Number.isInteger(options.targetTokens) || options.targetTokens < 1000) throw new Error('--target-tokens 必须 ≥1000')
  if (options.maxRequests !== Infinity && (!Number.isInteger(options.maxRequests) || options.maxRequests < 1)) throw new Error('--max-requests 必须是正整数')
  if (!Number.isInteger(options.charsPerChunk) || options.charsPerChunk < 100 || options.charsPerChunk > 8000) throw new Error('--chars-per-chunk 必须在 100–8000 之间')
  if (!Number.isInteger(options.settleSeconds) || options.settleSeconds < 0 || options.settleSeconds > 600) throw new Error('--settle-seconds 必须在 0–600 之间')
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4) throw new Error('--concurrency 必须在 1–4 之间')
  return options
}

const baseUrl = String(process.env.AGENT_BASE_URL ?? '').replace(/\/$/, '')
const apiKey = String(process.env.AGENT_API_KEY ?? '')
const model = process.env.SEARCH_EMBEDDING_MODEL ?? 'text-embedding-v4'
const dimensions = Number(process.env.SEARCH_EMBEDDING_DIMENSIONS ?? 1024)

async function readGatewayQuota() {
  const response = await fetch(`${baseUrl}/dashboard/billing/usage`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) throw new Error(`用量接口 HTTP ${response.status}`)
  const body = await response.json()
  const raw = Number(body?.total_usage)
  if (!Number.isFinite(raw)) throw new Error('用量接口返回无法解析')
  return { raw, usd: Number((raw / 100).toFixed(4)), at: new Date().toISOString() }
}

// 确定性匿名语料：只由固定词表与序号生成，不含任何候选人数据。
const TOPICS = ['分布式任务调度', '渲染管线优化', '战斗数值平衡', '服务端框架', '支付风控', '数据仓库建模',
  '客户端热更新', '匹配算法', '反作弊策略', '关卡编辑器', '美术资源管线', '性能剖析', '容器编排', '灰度发布']
const VERBS = ['负责', '参与', '主导', '优化', '重构', '维护', '设计了', '落地了']
const DETAILS = ['将平均延迟降低百分之三十', '覆盖日均千万级请求', '支撑三十人团队协作', '通过压测验证稳定性',
  '沉淀为内部文档', '配套监控与告警', '完成多轮灰度验证', '复用到三条业务线']

function anonymousChunk(index, size = CHARS_PER_CHUNK) {
  const parts = [`匿名语料样本 #${index}（合成文本，非真实简历）`]
  let cursor = index + 1
  while (parts.join(' ').length < size) {
    cursor = (cursor * 1103515245 + 12345) % 2147483647
    const topic = TOPICS[cursor % TOPICS.length]
    const verb = VERBS[(cursor >> 3) % VERBS.length]
    const detail = DETAILS[(cursor >> 7) % DETAILS.length]
    parts.push(`${verb}${topic}相关模块，${detail}。熟悉 TypeScript 与 Node.js，具备跨部门协作能力。`)
  }
  return parts.join(' ').slice(0, size)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node scripts/probe-embedding-cost.mjs [--apply] [--target-tokens N] [--max-requests N] [--report PATH]')
    return
  }
  const estimatedBatches = Math.ceil(options.targetTokens / (options.charsPerChunk * BATCH_SIZE / 2))
  const plan = {
    mode: options.apply ? 'apply' : 'dry-run',
    gateway_host: baseUrl ? new URL(baseUrl).host : null,
    model,
    dimensions,
    batch_size: BATCH_SIZE,
    chars_per_chunk: options.charsPerChunk,
    settle_seconds: options.settleSeconds,
    concurrency: options.concurrency,
    target_tokens: options.targetTokens,
    estimated_batches: estimatedBatches,
    max_requests: options.maxRequests === Infinity ? null : options.maxRequests,
    corpus_chars: CORPUS_CHARS,
    note: '匿名合成文本；只调用 /embeddings 与用量接口'
  }
  if (!options.apply) {
    console.log(JSON.stringify({ ...plan, hint: '加 --apply 才会真正调用网关并产生费用' }, null, 1))
    return
  }
  if (!baseUrl || !apiKey) throw new Error('缺少 AGENT_BASE_URL / AGENT_API_KEY')

  // 与本项目服务相同的出站校验路径（https + 可信私网主机白名单）。
  const host = new URL(baseUrl).hostname.toLowerCase()
  const trusted = String(process.env.SEARCH_MODEL_TRUSTED_PRIVATE_HOSTS ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  if (!trusted.includes(host)) process.env.SEARCH_MODEL_TRUSTED_PRIVATE_HOSTS = [...trusted, host].join(',')
  const adapters = createSearchModelAdapters({ maintenance: true })
  if (!adapters.configured.embedding) throw new Error('Embedding 未配置')

  const quotaBefore = await readGatewayQuota()
  const started = Date.now()
  let chunks = 0
  let chars = 0
  let requests = 0
  let nextBatch = 0
  let failedRequests = 0
  let consecutiveFailures = 0
  const worker = async () => {
    while (true) {
      const index = nextBatch
      nextBatch += 1
      if (index >= estimatedBatches || requests >= options.maxRequests) return
      const batch = Array.from({ length: BATCH_SIZE }, (_, offset) => anonymousChunk(index * BATCH_SIZE + offset, options.charsPerChunk))
      try {
        const vectors = await adapters.embedTexts(batch, { dimensions })
        if (!Array.isArray(vectors) || vectors.length !== batch.length) throw new Error('返回向量数量异常')
        requests += 1
        chunks += batch.length
        chars += batch.reduce((sum, text) => sum + text.length, 0)
        consecutiveFailures = 0
        if (requests % 20 === 0) console.log(JSON.stringify({ at: new Date().toISOString(), requests, chunks, chars, failed: failedRequests, elapsed_s: Math.round((Date.now() - started) / 1000) }))
      } catch (error) {
        // 单批超时/失败不终止探针：网关对大批量请求可能超时，失败批次仍可能被计费，
        // 所以只统计失败数，最终以用量差值（而不是成功字符数）为计价依据。
        failedRequests += 1
        consecutiveFailures += 1
        console.log(JSON.stringify({ at: new Date().toISOString(), failed_batch: index, error: String(error?.code ?? error?.message ?? 'error').slice(0, 80), failed_total: failedRequests }))
        if (consecutiveFailures >= 5) throw new Error(`连续 ${consecutiveFailures} 批失败，停止探针`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, estimatedBatches, options.maxRequests) }, worker))
  // 网关计数可能有结算延迟：先读一次，静置后再读一次，取较大值。
  const quotaAfter = await readGatewayQuota()
  let quotaSettled = null
  if (options.settleSeconds > 0) {
    await new Promise((done) => setTimeout(done, options.settleSeconds * 1000))
    quotaSettled = await readGatewayQuota()
  }
  const quotaFinal = quotaSettled && quotaSettled.raw > quotaAfter.raw ? quotaSettled : quotaAfter
  const deltaRaw = Number((quotaFinal.raw - quotaBefore.raw).toFixed(4))
  const deltaUsd = Number((deltaRaw / 100).toFixed(6))
  const perMillionChars = chars ? Number((deltaUsd / (chars / 1_000_000)).toFixed(4)) : null
  const perMillionTokens = chars ? Number((deltaUsd / (chars / 2 / 1_000_000)).toFixed(4)) : null
  const fullCorpusUsd = chars ? Number((deltaUsd * (CORPUS_CHARS / chars)).toFixed(2)) : null
  const report = {
    at: new Date().toISOString(),
    anonymous: true,
    gateway_host: new URL(baseUrl).host,
    model,
    dimensions,
    batch_size: BATCH_SIZE,
    requests,
    failed_requests: failedRequests,
    chunks,
    chars,
    elapsed_s: Math.round((Date.now() - started) / 1000),
    chars_per_second: Math.round(chars / Math.max(1, (Date.now() - started) / 1000)),
    quota: { before: quotaBefore, after: quotaAfter, after_settle: quotaSettled, used: quotaFinal, delta_raw: deltaRaw, delta_usd: deltaUsd },
    unit_price: {
      usd_per_million_chars: perMillionChars,
      usd_per_million_tokens_estimated: perMillionTokens,
      token_estimate_basis: '按 0.5 token/字符 估算，tokenizer 比未实测'
    },
    projection: {
      corpus_chars: CORPUS_CHARS,
      full_corpus_usd: fullCorpusUsd,
      basis: '按本次探针的美元/字符线性外推，未含重试与去重收益'
    }
  }
  writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 1))
}

main().catch((error) => {
  console.error(JSON.stringify({ state: 'failed', error: String(error?.message ?? error).slice(0, 300) }))
  process.exitCode = 1
})
