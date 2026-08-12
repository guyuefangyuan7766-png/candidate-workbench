import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { routeAgentQuestion } from '../../server/agent.js'
import {
  createWebSearchService,
  fetchPublicText,
  isBlockedNetworkAddress,
  validatePublicWebUrl
} from '../../server/web-search.js'

const PUBLIC_ADDRESS = [{ address: '93.184.216.34', family: 4 }]

function fakeRequest(responder) {
  return (url, options, callback) => {
    const request = new EventEmitter()
    request.destroyed = false
    request.destroy = (error) => {
      if (request.destroyed) return
      request.destroyed = true
      queueMicrotask(() => {
        if (error) request.emit('error', error)
        else request.emit('close')
      })
    }
    request.end = () => {
      queueMicrotask(() => {
        if (request.destroyed) return
        try {
          const result = responder(url, options)
          const response = new PassThrough()
          response.statusCode = result.status ?? 200
          response.headers = result.headers ?? { 'content-type': 'text/html; charset=utf-8' }
          callback(response)
          response.end(result.body ?? '')
        } catch (error) {
          request.emit('error', error)
        }
      })
    }
    return request
  }
}

test('deterministic Agent routing distinguishes database, web, mixed, and generic questions', () => {
  assert.equal(routeAgentQuestion('我们人才库有多少候选人'), 'database')
  assert.equal(routeAgentQuestion('招聘管道情况如何？'), 'database')
  assert.equal(routeAgentQuestion('Run a long database evidence task'), 'database')
  assert.equal(routeAgentQuestion('请联网查找 Node.js 24 当前最新的安全公告，并给出来源链接和访问时间。'), 'web')
  assert.equal(routeAgentQuestion('我们现在有多少人'), 'database')
  assert.equal(routeAgentQuestion('搜索最新招聘行业新闻'), 'web')
  assert.equal(routeAgentQuestion('搜索市场需要哪些技能'), 'web')
  assert.equal(routeAgentQuestion('结合我们人才库与最新市场趋势给建议'), 'mixed')
  assert.equal(routeAgentQuestion('人才库候选人和行业趋势有什么差异'), 'mixed')
  assert.equal(routeAgentQuestion('量子计算是什么？'), 'web')
  assert.equal(routeAgentQuestion('那上海呢？', [{ role: 'user', content: '列出人才库候选人' }]), 'database')
  assert.equal(routeAgentQuestion('再具体一点', [{ role: 'user', content: '比较人才库与行业趋势' }]), 'mixed')
})

test('DuckDuckGo HTML search returns bounded citation metadata with access time', async () => {
  let requestedUrl
  const service = createWebSearchService({
    provider: 'duckduckgo',
    endpoint: 'https://html.duckduckgo.com/html/',
    now: () => '2026-08-10T04:05:06.000Z',
    fetchText: async (url, options) => {
      requestedUrl = new URL(url)
      assert.equal(options.maxBytes, 1_000_000)
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        content_type: 'text/html',
        url,
        redirects: [],
        body: `
          <div class="result">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fhiring">Hiring &amp; outlook</a>
            <a class="result__snippet">Fresh &lt;market&gt; evidence</a>
          </div>
          <div class="result">
            <a class="result__a" href="https://news.example.org/report">Second report</a>
            <div class="result__snippet">Another source</div>
          </div>
        `
      }
    }
  })

  const result = await service.searchWeb({ query: '招聘 趋势', max_results: 2 })
  assert.equal(requestedUrl.searchParams.get('q'), '招聘 趋势')
  assert.equal(result.source_type, 'internet')
  assert.equal(result.provider, 'duckduckgo')
  assert.equal(result.untrusted, true)
  assert.equal(result.result_count, 2)
  assert.deepEqual(result.items[0], {
    rank: 1,
    title: 'Hiring & outlook',
    url: 'https://example.com/hiring',
    snippet: 'Fresh <market> evidence',
    accessed_at: '2026-08-10T04:05:06.000Z'
  })
  assert.equal(result.items[1].url, 'https://news.example.org/report')
})

test('default DuckDuckGo Lite parsing skips sponsored rows and challenge pages fail explicitly', async () => {
  let endpoint
  const service = createWebSearchService({
    now: () => '2026-08-10T04:05:06.000Z',
    fetchText: async (url) => {
      endpoint = new URL(url)
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        content_type: 'text/html',
        url,
        redirects: [],
        body: `
          <table>
            <tr class="result-sponsored"><td><a class="result-link" href="https://ads.example/ad">Sponsored result</a></td></tr>
            <tr class="result-sponsored"><td class="result-snippet">Paid copy</td></tr>
            <tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Freport">Public report</a></td></tr>
            <tr><td class="result-snippet">Public evidence</td></tr>
          </table>
        `
      }
    }
  })
  const result = await service.searchWeb({ query: 'public report' })
  assert.equal(endpoint.hostname, 'lite.duckduckgo.com')
  assert.equal(endpoint.pathname, '/lite/')
  assert.equal(result.result_count, 1)
  assert.equal(result.items[0].title, 'Public report')
  assert.equal(result.items[0].snippet, 'Public evidence')

  const challenged = createWebSearchService({
    fetchText: async (url) => ({
      status: 202,
      headers: { 'content-type': 'text/html' },
      content_type: 'text/html',
      url,
      redirects: [],
      body: '<html><body><form class="challenge-form">bots use DuckDuckGo</form></body></html>'
    })
  })
  await assert.rejects(
    challenged.searchWeb({ query: 'challenge' }),
    (error) => error?.code === 'web_search_challenged' && error.retryable === true
  )
})

test('default search can fall back from a challenged provider to bounded Bing RSS results', async () => {
  const requestedHosts = []
  const service = createWebSearchService({
    endpoint: 'https://lite.duckduckgo.com/lite/',
    searchFallbacks: [{ provider: 'bing_rss', endpoint: 'https://www.bing.com/search' }],
    now: () => '2026-08-11T02:45:00.000Z',
    fetchText: async (url) => {
      const target = new URL(url)
      requestedHosts.push(target.hostname)
      if (target.hostname === 'lite.duckduckgo.com') {
        return {
          status: 202,
          headers: { 'content-type': 'text/html' },
          content_type: 'text/html',
          url,
          redirects: [],
          body: '<html><form class="challenge-form">bots use DuckDuckGo</form></html>'
        }
      }
      assert.equal(target.searchParams.get('format'), 'rss')
      return {
        status: 200,
        headers: { 'content-type': 'text/xml' },
        content_type: 'text/xml',
        url,
        redirects: [],
        body: `<?xml version="1.0"?><rss><channel><item>
          <title><![CDATA[Node.js security release & details]]></title>
          <link>https://nodejs.org/en/blog/vulnerability/security-release</link>
          <description>Current release information &amp; supported lines.</description>
        </item></channel></rss>`
      }
    }
  })

  const result = await service.searchWeb({ query: 'Node.js 24 security release', max_results: 3 })
  assert.deepEqual(requestedHosts, ['lite.duckduckgo.com', 'www.bing.com'])
  assert.equal(result.provider, 'bing_rss')
  assert.equal(result.result_count, 1)
  assert.deepEqual(result.items[0], {
    rank: 1,
    title: 'Node.js security release & details',
    url: 'https://nodejs.org/en/blog/vulnerability/security-release',
    snippet: 'Current release information & supported lines.',
    accessed_at: '2026-08-11T02:45:00.000Z'
  })
})

test('page fetch strips active markup and reports the final public URL', async () => {
  const service = createWebSearchService({
    now: () => '2026-08-10T05:06:07.000Z',
    fetchText: async () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      content_type: 'text/html',
      url: 'https://example.com/final',
      redirects: ['https://example.com/final'],
      body: '<html><head><title>Report &amp; Update</title><script>ignore()</script></head><body><main><h1>Hiring report</h1><p>Verified public text.</p></main></body></html>'
    })
  })

  const result = await service.fetchWebPage({ url: 'https://example.com/start', max_characters: 2_000 })
  assert.equal(result.source_type, 'internet')
  assert.equal(result.title, 'Report & Update')
  assert.equal(result.url, 'https://example.com/final')
  assert.equal(result.accessed_at, '2026-08-10T05:06:07.000Z')
  assert.match(result.text, /Hiring report/)
  assert.match(result.text, /Verified public text/)
  assert.doesNotMatch(result.text, /ignore\(\)/)
  assert.equal(result.untrusted, true)
})

test('SSRF validation rejects local, metadata, private DNS, and IPv6 tunnel forms', async () => {
  for (const url of [
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[fd00::1]/',
    'http://[::ffff:7f00:1]/',
    'http://[64:ff9b::7f00:1]/',
    'http://[2002:7f00:1::]/'
  ]) {
    await assert.rejects(
      validatePublicWebUrl(url),
      (error) => error?.code === 'web_url_blocked',
      url
    )
  }

  await assert.rejects(
    validatePublicWebUrl('https://public-name.example/path', {
      lookup: async () => [{ address: '10.0.0.8', family: 4 }]
    }),
    (error) => error?.code === 'web_url_blocked'
  )
  assert.equal(isBlockedNetworkAddress('192.0.1.1'), false)
  assert.equal(isBlockedNetworkAddress('198.51.1.1'), false)
  assert.equal(isBlockedNetworkAddress('203.0.114.1'), false)
  assert.equal(isBlockedNetworkAddress('2606:4700:4700::1111'), false)
})

test('redirect targets are DNS-validated again before a second connection', async () => {
  let requests = 0
  const lookup = async (hostname) => hostname === 'redirect-private.example'
    ? [{ address: '10.1.2.3', family: 4 }]
    : PUBLIC_ADDRESS
  const httpRequest = fakeRequest((_url, options) => {
    requests += 1
    assert.equal(typeof options.lookup, 'function')
    return {
      status: 302,
      headers: {
        location: 'http://redirect-private.example/secret',
        'content-type': 'text/html'
      }
    }
  })

  await assert.rejects(
    fetchPublicText('http://public.example/start', { lookup, httpRequest }),
    (error) => error?.code === 'web_url_blocked'
  )
  assert.equal(requests, 1)
})

test('the web request budget also bounds DNS resolution', async () => {
  const startedAt = Date.now()
  await assert.rejects(
    fetchPublicText('https://slow-dns.example/', {
      timeoutMs: 100,
      lookup: () => new Promise(() => {}),
      httpsRequest: () => { throw new Error('HTTP must not start before DNS succeeds') }
    }),
    (error) => error?.code === 'web_timeout' && error.retryable === true
  )
  assert.ok(Date.now() - startedAt < 1_000)
})

test('web transport enforces byte and content-type limits with structured errors', async () => {
  const lookup = async () => PUBLIC_ADDRESS
  await assert.rejects(
    fetchPublicText('http://public.example/large', {
      lookup,
      maxBytes: 1_024,
      httpRequest: fakeRequest(() => ({
        headers: { 'content-type': 'text/plain', 'content-length': '2048' },
        body: 'ignored'
      }))
    }),
    (error) => error?.code === 'web_response_too_large' && error.status === 413
  )

  await assert.rejects(
    fetchPublicText('http://public.example/binary', {
      lookup,
      httpRequest: fakeRequest(() => ({
        headers: { 'content-type': 'application/octet-stream' },
        body: 'binary-looking response'
      }))
    }),
    (error) => error?.code === 'web_content_type_unsupported' && error.status === 415
  )
})
