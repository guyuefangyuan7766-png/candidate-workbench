// Checks whether any request shape other than an explicit max_tokens yields a
// usable default budget. Prints only statuses, finish_reason and lengths.
const base = (process.env.AGENT_BASE_URL ?? '').replace(/\/+$/, '')
const key = process.env.AGENT_API_KEY ?? ''
const model = process.env.AGENT_MODEL ?? ''
const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`

const variants = [
  { name: '不传 max_tokens', body: { model, messages: [{ role: 'user', content: '用一句话回答：1+1 等于几？' }] } },
  { name: '不传 max_tokens + stream:false', body: { model, messages: [{ role: 'user', content: '用一句话回答：1+1 等于几？' }], stream: false } },
  { name: '不传 max_tokens + 系统提示', body: { model, messages: [{ role: 'system', content: '你是助手，直接给出简短答案。' }, { role: 'user', content: '用一句话回答：1+1 等于几？' }] } },
  { name: '传 max_completion_tokens=2048', body: { model, messages: [{ role: 'user', content: '用一句话回答：1+1 等于几？' }], max_completion_tokens: 2048 } },
  { name: '传 max_tokens=2048（对照）', body: { model, messages: [{ role: 'user', content: '用一句话回答：1+1 等于几？' }], max_tokens: 2048 } }
]

console.log('变体                              | HTTP | finish_reason | content | reasoning | 耗时')
console.log('----------------------------------+------+---------------+---------+-----------+------')

for (const variant of variants) {
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(variant.body),
      signal: AbortSignal.timeout(120000)
    })
    const text = await response.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    const choice = parsed?.choices?.[0]
    console.log(
      variant.name.padEnd(33) + ' | ' +
      String(response.status).padStart(4) + ' | ' +
      String(choice?.finish_reason ?? (parsed ? '-' : 'JSON解析失败')).padEnd(13) + ' | ' +
      String(String(choice?.message?.content ?? '').length).padStart(7) + ' | ' +
      String(String(choice?.message?.reasoning_content ?? '').length).padStart(9) + ' | ' +
      ((Date.now() - started) / 1000).toFixed(1) + 's'
    )
    if (!parsed) console.log('    非 JSON 响应:', text.slice(0, 200))
  } catch (error) {
    console.log(variant.name.padEnd(33) + ' | 请求失败: ' + error.message)
  }
}
