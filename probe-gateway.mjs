// Minimal probe against the configured model gateway. Uses the same environment
// variables as the service; prints the raw status and body prefix so a wrong
// endpoint / model / HTML error page can be told apart from a real API error.
const base = (process.env.AGENT_BASE_URL ?? '').replace(/\/+$/, '')
const key = process.env.AGENT_API_KEY ?? ''
const model = process.env.AGENT_MODEL ?? ''

console.log('AGENT_BASE_URL :', base || '(未设置)')
console.log('AGENT_MODEL    :', model || '(未设置)')
console.log('AGENT_API_KEY  :', key ? `${key.length} 字符` : '(未设置)')
console.log('extra CA       :', process.env.NODE_EXTRA_CA_CERTS || '(未设置)')
console.log('')

if (!base) { console.log('缺少 AGENT_BASE_URL，无法探测。'); process.exit(1) }

const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
console.log('请求 URL       :', url)
console.log('')

try {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'reply with the single word: ok' }],
      max_tokens: 8
    }),
    signal: AbortSignal.timeout(30000)
  })
  const text = await response.text()
  console.log('HTTP           :', response.status)
  console.log('content-type   :', response.headers.get('content-type'))
  console.log('content-length :', response.headers.get('content-length'))
  console.log('响应长度       :', text.length)
  console.log('')
  console.log('响应前 400 字符:')
  console.log(text.slice(0, 400))
  console.log('')
  let parsed = null
  try { parsed = JSON.parse(text) } catch (e) { console.log('JSON 解析失败   :', e.message) }
  if (parsed) {
    console.log('JSON 解析成功   : true')
    console.log('choices 存在    :', Array.isArray(parsed.choices))
    if (parsed.choices?.[0]) {
      console.log('message.content :', JSON.stringify(String(parsed.choices[0].message?.content ?? '').slice(0, 120)))
      console.log('finish_reason   :', parsed.choices[0].finish_reason)
      console.log('tool_calls      :', Array.isArray(parsed.choices[0].message?.tool_calls) ? parsed.choices[0].message.tool_calls.length : '无')
    }
    if (parsed.error) console.log('网关错误对象    :', JSON.stringify(parsed.error).slice(0, 300))
  }
} catch (error) {
  console.log('请求失败        :', error.message)
  console.log('原因码          :', error.cause?.code ?? '(无)')
}
