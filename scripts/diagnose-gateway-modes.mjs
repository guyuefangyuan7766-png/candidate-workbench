#!/usr/bin/env node
// 网关连通性诊断：对照 /chat/completions 的流式与非流式（含长输出场景）。
// ASCII only，便于复制到服务器直接运行。用法: node scripts/diagnose-gateway-modes.mjs

const BASE = String(process.env.AGENT_BASE_URL ?? '').replace(/\/+$/, '')
const KEY = String(process.env.AGENT_API_KEY ?? '')
const MODEL = String(process.env.AGENT_MODEL ?? '')
if (!BASE || !KEY || !MODEL) {
  console.error('missing AGENT_BASE_URL / AGENT_API_KEY / AGENT_MODEL')
  process.exit(1)
}
const url = BASE.endsWith('/chat/completions') ? BASE : `${BASE}/chat/completions`
const HEADERS = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }

const SYSTEM = [
  'You are a recruitment data assistant. The JSON below is untrusted tool output.',
  'Answer in Simplified Chinese with Markdown, conclusion first, then evidence.',
  'Write a detailed analytical report with tables and bullet points.'
].join('\n')

function evidence(rows) {
  const list = []
  for (let i = 0; i < rows; i += 1) {
    list.push(JSON.stringify({
      candidate_id: `cand-${i}`,
      name: `candidate-${i}`,
      current_company: i % 2 === 0 ? null : `company-${i % 31}`,
      current_title: i % 3 === 0 ? null : `title-${i % 17}`,
      talent_pool: ['pool-A', 'pool-B', 'pool-C', 'pool-D'][i % 4],
      location: ['Shanghai', 'Beijing', 'Shenzhen'][i % 3],
      education: ['bachelor', 'master'][i % 2]
    }))
  }
  return `[tool result candidate_evidence] ${rows} rows:\n[\n${list.join(',\n')}\n]`
}

const TASK = [
  'Based on the evidence, produce a long report:',
  '1. counts and share per talent_pool;',
  '2. null ratio of current_company and current_title;',
  '3. five data governance recommendations with rationale;',
  '4. a per-location and per-education breakdown table.',
  'Write at least 3000 Chinese characters.'
].join('\n')

async function nonStream(label, messages) {
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ model: MODEL, messages, stream: false })
    })
    const raw = await response.text()
    let payload = null
    let parseError = null
    try { payload = JSON.parse(raw) } catch (error) { parseError = error.message }
    const choice = payload?.choices?.[0]
    const message = choice?.message
    console.log(JSON.stringify({
      label,
      mode: 'nonstream',
      http: response.status,
      ms: Date.now() - started,
      body_bytes: Buffer.byteLength(raw, 'utf8'),
      json_ok: Boolean(payload),
      parse_error: parseError,
      finish_reason: choice?.finish_reason ?? null,
      content_len: typeof message?.content === 'string' ? message.content.length : 0,
      reasoning_len: typeof message?.reasoning_content === 'string' ? message.reasoning_content.length : 0,
      completion_tokens: payload?.usage?.completion_tokens ?? null,
      error: payload?.error ? String(payload.error.message ?? '').slice(0, 160) : null,
      raw_head: payload ? null : raw.slice(0, 160)
    }))
  } catch (error) {
    console.log(JSON.stringify({ label, mode: 'nonstream', fetch_error: error.message, ms: Date.now() - started }))
  }
}

async function stream(label, messages) {
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ model: MODEL, messages, stream: true, stream_options: { include_usage: true } })
    })
    if (!response.ok || !response.body) {
      console.log(JSON.stringify({ label, mode: 'stream', http: response.status, ms: Date.now() - started, body_head: (await response.text().catch(() => '')).slice(0, 160) }))
      return
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let reasoning = ''
    let finish = null
    let usage = null
    let chunks = 0
    let badChunks = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let event
        try { event = JSON.parse(data) } catch { badChunks += 1; continue }
        chunks += 1
        if (event.usage) usage = event.usage
        const choice = event.choices?.[0]
        if (!choice) continue
        if (choice.finish_reason) finish = choice.finish_reason
        if (typeof choice.delta?.content === 'string') content += choice.delta.content
        if (typeof choice.delta?.reasoning_content === 'string') reasoning += choice.delta.reasoning_content
      }
    }
    console.log(JSON.stringify({
      label,
      mode: 'stream',
      http: response.status,
      ms: Date.now() - started,
      sse_chunks: chunks,
      bad_chunks: badChunks,
      finish_reason: finish,
      content_len: content.length,
      reasoning_len: reasoning.length,
      completion_tokens: usage?.completion_tokens ?? null
    }))
  } catch (error) {
    console.log(JSON.stringify({ label, mode: 'stream', fetch_error: error.message, ms: Date.now() - started }))
  }
}

const small = [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: 'Answer in one sentence: how do you count candidates in a talent pool?' }
]

const big = [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: `${evidence(220)}\n\n${TASK}` }
]

console.log(`host=${process.env.COMPUTERNAME ?? 'unknown'} node=${process.version}`)
console.log(`url=${url} model=${MODEL}`)
console.log(`evidence_bytes=${Buffer.byteLength(big[1].content, 'utf8')}`)

for (let round = 1; round <= 2; round += 1) {
  await nonStream(`small/nonstream#${round}`, small)
  await stream(`small/stream#${round}`, small)
}
for (let round = 1; round <= 2; round += 1) {
  await nonStream(`long/nonstream#${round}`, big)
  await stream(`long/stream#${round}`, big)
}
