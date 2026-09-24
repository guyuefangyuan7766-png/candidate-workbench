// Same probe, but sweeps max_tokens to prove whether the empty content is a
// budget problem. Prints only lengths and finish_reason, not model output.
const base = (process.env.AGENT_BASE_URL ?? '').replace(/\/+$/, '')
const key = process.env.AGENT_API_KEY ?? ''
const model = process.env.AGENT_MODEL ?? ''
const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`

console.log('model:', model)
console.log('')
console.log('max_tokens | HTTP | finish_reason | content长度 | reasoning长度')
console.log('-----------+------+---------------+-------------+--------------')

for (const maxTokens of [8, 100, 512, 2048, 8192]) {
  const started = Date.now()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '用一句话回答：1+1 等于几？' }],
        max_tokens: maxTokens
      }),
      signal: AbortSignal.timeout(120000)
    })
    const text = await response.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    const choice = parsed?.choices?.[0]
    const content = String(choice?.message?.content ?? '')
    const reasoning = String(choice?.message?.reasoning_content ?? '')
    console.log(
      String(maxTokens).padStart(10) + ' | ' +
      String(response.status).padStart(4) + ' | ' +
      String(choice?.finish_reason ?? '-').padEnd(13) + ' | ' +
      String(content.length).padStart(11) + ' | ' +
      String(reasoning.length).padStart(12) +
      '   (' + ((Date.now() - started) / 1000).toFixed(1) + 's)'
    )
    if (!parsed) console.log('    响应不是 JSON:', text.slice(0, 200))
  } catch (error) {
    console.log(String(maxTokens).padStart(10) + ' | 请求失败: ' + error.message)
  }
}
