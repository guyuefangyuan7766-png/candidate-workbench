// Sends the exact same request as the service does and prints everything that
// could plausibly affect a gateway's default budget: request headers, the body
// actually sent, and the full usage/reasoning breakdown of the response.
const base = (process.env.AGENT_BASE_URL ?? '').replace(/\/+$/, '')
const key = process.env.AGENT_API_KEY ?? ''
const model = process.env.AGENT_MODEL ?? ''
const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`

const body = {
  model,
  messages: [{ role: 'user', content: '用一句话回答：1+1 等于几？' }],
  tools: [],
  tool_choice: 'auto',
  stream: false
}

console.log('host           :', process.env.COMPUTERNAME ?? '(unknown)')
console.log('node version   :', process.version)
console.log('url            :', url)
console.log('model          :', model)
console.log('key length     :', key.length)
console.log('key 前6位      :', key.slice(0, 6) + '...')
console.log('')
console.log('请求体 (无预算参数):')
console.log(JSON.stringify(body))
console.log('')
console.log('默认请求头 (undici):')
const probe = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) })
for (const [k, v] of probe.headers) console.log('  ' + k + ': ' + (k === 'authorization' ? 'Bearer ' + key.slice(0, 6) + '...' : v))
console.log('')

const started = Date.now()
const response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(120000)
})
const text = await response.text()
console.log('HTTP           :', response.status)
console.log('耗时           :', ((Date.now() - started) / 1000).toFixed(1) + 's')
console.log('响应头:')
for (const [k, v] of response.headers) console.log('  ' + k + ': ' + v)
console.log('')

let parsed = null
try { parsed = JSON.parse(text) } catch {}
if (!parsed) {
  console.log('非 JSON 响应:', text.slice(0, 300))
  process.exit(0)
}
const choice = parsed.choices?.[0]
console.log('finish_reason  :', choice?.finish_reason)
console.log('content 长度   :', String(choice?.message?.content ?? '').length)
console.log('reasoning 长度 :', String(choice?.message?.reasoning_content ?? '').length)
console.log('usage          :', JSON.stringify(parsed.usage))
console.log('响应长度       :', text.length)
console.log('')
console.log('完整响应前 600 字符:')
console.log(text.slice(0, 600))
