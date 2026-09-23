import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'

export const WEB_SEARCH_LIMITS = Object.freeze({
  timeoutMs: 12_000,
  maxTimeoutMs: 30_000,
  maxRedirects: 3,
  maxSearchBytes: 1_000_000,
  maxPageBytes: 2_000_000,
  maxPageCharacters: 120_000,
  maxResults: 10
})

const TEXT_CONTENT_TYPES = new Set([
  'application/json',
  'application/rss+xml',
  'application/xml',
  'application/xhtml+xml',
  'text/html',
  'text/plain',
  'text/xml'
])

export class WebToolError extends Error {
  constructor(code, message, { status = 400, details, retryable = false, cause } = {}) {
    super(message, { cause })
    this.name = 'WebToolError'
    this.code = code
    this.status = status
    this.retryable = retryable
    if (details !== undefined) this.details = details
  }
}

function webError(code, message, options) {
  return new WebToolError(code, message, options)
}

function abortSignalError(signal, timeoutMs) {
  const reason = signal?.reason
  if (reason instanceof WebToolError || (reason && typeof reason.code === 'string')) return reason
  if (reason?.name === 'TimeoutError') {
    return webError('web_timeout', `The web request exceeded ${timeoutMs} ms.`, {
      status: 504,
      retryable: true,
      cause: reason
    })
  }
  return webError('web_request_cancelled', 'The web request was cancelled.', {
    status: 499,
    cause: reason
  })
}

function integer(value, fallback, minimum, maximum, label) {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw webError('invalid_web_tool_arguments', `${label} must be an integer between ${minimum} and ${maximum}.`)
  }
  return parsed
}

function normalizedQuery(value) {
  const query = typeof value === 'string' ? value.trim() : ''
  if (!query || query.length > 500) {
    throw webError('invalid_web_tool_arguments', 'query must contain between 1 and 500 characters.')
  }
  return query
}

function ipv4Parts(address) {
  if (isIP(address) !== 4) return null
  return address.split('.').map(Number)
}

function isBlockedIpv4(address) {
  const parts = ipv4Parts(address)
  if (!parts) return false
  const [a, b, c] = parts
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  )
}

function ipv6Words(address) {
  let normalized = String(address).toLowerCase().split('%')[0]
  if (isIP(normalized) !== 6) return null
  if (normalized.includes('.')) {
    const separator = normalized.lastIndexOf(':')
    const parts = ipv4Parts(normalized.slice(separator + 1))
    if (!parts) return null
    normalized = `${normalized.slice(0, separator)}:${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`
  }
  const halves = normalized.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null
  const words = [...left, ...Array(missing).fill('0'), ...right].map((word) => Number.parseInt(word || '0', 16))
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : null
}

function embeddedIpv4(words, offset) {
  return `${words[offset] >> 8}.${words[offset] & 0xff}.${words[offset + 1] >> 8}.${words[offset + 1] & 0xff}`
}

function isBlockedIpv6(address) {
  const words = ipv6Words(address)
  if (!words) return true
  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = words
  const ipv4Mapped = first === 0 && second === 0 && third === 0 && fourth === 0 && fifth === 0 && sixth === 0xffff
  if (ipv4Mapped) return isBlockedIpv4(embeddedIpv4(words, 6))
  const nat64WellKnown = first === 0x64 && second === 0xff9b && third === 0 && fourth === 0 && fifth === 0 && sixth === 0
  if (nat64WellKnown && isBlockedIpv4(embeddedIpv4(words, 6))) return true
  const sixToFour = first === 0x2002
  if (sixToFour && isBlockedIpv4(embeddedIpv4(words, 1))) return true
  return (
    (first === 0 && second === 0 && third === 0 && fourth === 0 && fifth === 0 && sixth === 0 && seventh === 0 && (eighth === 0 || eighth === 1))
    || (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xffc0) === 0xfec0
    || (first & 0xff00) === 0xff00
    || (first === 0x2001 && second === 0x0db8)
    || (first === 0x64 && second === 0xff9b && third === 1)
    || (first === 0x100 && second === 0 && third === 0 && fourth === 0)
  )
}

export function isBlockedNetworkAddress(address) {
  const family = isIP(String(address).split('%')[0])
  if (family === 4) return isBlockedIpv4(address)
  if (family === 6) return isBlockedIpv6(address)
  return true
}

function parseWebUrl(value) {
  let parsed
  try {
    parsed = new URL(String(value ?? ''))
  } catch (cause) {
    throw webError('invalid_web_url', 'A valid absolute HTTP or HTTPS URL is required.', { cause })
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw webError('invalid_web_url', 'Only HTTP and HTTPS URLs are allowed.')
  }
  if (parsed.username || parsed.password) {
    throw webError('invalid_web_url', 'URLs containing credentials are not allowed.')
  }
  parsed.hash = ''
  return parsed
}

function blockedHostname(hostname) {
  const normalized = String(hostname).toLowerCase().replace(/\.$/, '')
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === 'metadata.google.internal'
    || normalized.endsWith('.internal')
    || normalized.endsWith('.local')
}

export async function validatePublicWebUrl(value, options = {}) {
  const parsed = parseWebUrl(value)
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  if (blockedHostname(hostname)) {
    throw webError('web_url_blocked', 'The URL resolves to a local or internal host.', {
      details: { reason: 'blocked_hostname' }
    })
  }

  let addresses
  const literalFamily = isIP(hostname)
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }]
  } else {
    try {
      const lookupPromise = Promise.resolve().then(() => (options.lookup ?? dnsLookup)(hostname, { all: true, verbatim: true }))
      if (!options.signal) {
        addresses = await lookupPromise
      } else if (options.signal.aborted) {
        throw abortSignalError(options.signal, options.timeoutMs ?? WEB_SEARCH_LIMITS.timeoutMs)
      } else {
        addresses = await new Promise((resolve, reject) => {
          const abort = () => reject(abortSignalError(options.signal, options.timeoutMs ?? WEB_SEARCH_LIMITS.timeoutMs))
          options.signal.addEventListener('abort', abort, { once: true })
          lookupPromise.then(
            (value) => {
              options.signal.removeEventListener('abort', abort)
              resolve(value)
            },
            (error) => {
              options.signal.removeEventListener('abort', abort)
              reject(error)
            }
          )
        })
      }
    } catch (cause) {
      if (cause instanceof WebToolError || cause === options.signal?.reason) throw cause
      throw webError('web_dns_failed', 'The web host could not be resolved.', {
        status: 502,
        retryable: true,
        details: { hostname },
        cause
      })
    }
  }
  if (!Array.isArray(addresses) || !addresses.length) {
    throw webError('web_dns_failed', 'The web host did not resolve to an address.', {
      status: 502,
      retryable: true,
      details: { hostname }
    })
  }
  const normalizedAddresses = addresses.map((entry) => ({
    address: String(entry.address),
    family: Number(entry.family) || isIP(String(entry.address))
  }))
  if (normalizedAddresses.some((entry) => ![4, 6].includes(entry.family) || isBlockedNetworkAddress(entry.address))) {
    throw webError('web_url_blocked', 'The URL resolves to a private, loopback, link-local, reserved, or metadata address.', {
      details: { reason: 'blocked_address', hostname }
    })
  }
  return { url: parsed, addresses: normalizedAddresses }
}

function pinnedLookup(addresses) {
  return (hostname, options, callback) => {
    const settings = typeof options === 'number' ? { family: options } : (options ?? {})
    const family = Number(settings.family) || 0
    const eligible = family ? addresses.filter((entry) => entry.family === family) : addresses
    if (!eligible.length) {
      const error = Object.assign(new Error(`No validated address is available for ${hostname}.`), { code: 'ENOTFOUND' })
      queueMicrotask(() => callback(error))
      return
    }
    if (settings.all) {
      queueMicrotask(() => callback(null, eligible.map((entry) => ({ ...entry }))))
      return
    }
    queueMicrotask(() => callback(null, eligible[0].address, eligible[0].family))
  }
}

function contentType(headers) {
  return String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
}

function responseEncoding(headers) {
  return String(headers['content-encoding'] ?? '').trim().toLowerCase()
}

function requestOnce(validated, options) {
  const timeoutMs = integer(options.timeoutMs, WEB_SEARCH_LIMITS.timeoutMs, 100, WEB_SEARCH_LIMITS.maxTimeoutMs, 'timeoutMs')
  const maxBytes = integer(options.maxBytes, WEB_SEARCH_LIMITS.maxPageBytes, 1_024, WEB_SEARCH_LIMITS.maxPageBytes, 'maxBytes')
  const requestImpl = validated.url.protocol === 'https:' ? (options.httpsRequest ?? httpsRequest) : (options.httpRequest ?? httpRequest)

  return new Promise((resolve, reject) => {
    let settled = false
    let request
    let timer
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener?.('abort', abort)
      callback(value)
    }
    const fail = (error) => finish(reject, error)
    function abort() {
      request?.destroy(abortSignalError(options.signal, timeoutMs))
    }
    request = requestImpl(validated.url, {
      method: 'GET',
      headers: {
        accept: options.accept ?? 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8',
        'accept-encoding': 'identity',
        'user-agent': options.userAgent ?? 'CandidateWorkbenchAgent/1.0'
      },
      lookup: pinnedLookup(validated.addresses)
    }, (response) => {
      const status = Number(response.statusCode) || 0
      const length = Number(response.headers['content-length'])
      if (Number.isFinite(length) && length > maxBytes) {
        response.destroy()
        fail(webError('web_response_too_large', 'The web response exceeds the configured byte limit.', { status: 413 }))
        return
      }
      const encoding = responseEncoding(response.headers)
      if (encoding && encoding !== 'identity') {
        response.destroy()
        fail(webError('web_content_encoding_unsupported', 'Compressed web responses are not accepted.', { status: 415 }))
        return
      }
      const chunks = []
      let bytes = 0
      response.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > maxBytes) {
          response.destroy(webError('web_response_too_large', 'The web response exceeds the configured byte limit.', { status: 413 }))
          return
        }
        chunks.push(chunk)
      })
      response.once('error', fail)
      response.once('end', () => finish(resolve, {
        status,
        headers: response.headers,
        content_type: contentType(response.headers),
        body: Buffer.concat(chunks).toString('utf8')
      }))
    })
    request.once('error', (cause) => {
      if (cause instanceof WebToolError) {
        fail(cause)
        return
      }
      fail(webError('web_network_error', 'The web request failed.', {
        status: 502,
        retryable: true,
        cause
      }))
    })
    timer = setTimeout(() => request.destroy(webError('web_timeout', `The web request exceeded ${timeoutMs} ms.`, {
      status: 504,
      retryable: true
    })), timeoutMs)
    timer.unref?.()
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener?.('abort', abort, { once: true })
    request.end()
  })
}

export async function fetchPublicText(value, options = {}) {
  const maximumRedirects = integer(options.maxRedirects, WEB_SEARCH_LIMITS.maxRedirects, 0, 10, 'maxRedirects')
  const timeoutMs = integer(options.timeoutMs, WEB_SEARCH_LIMITS.timeoutMs, 100, WEB_SEARCH_LIMITS.maxTimeoutMs, 'timeoutMs')
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = options.signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([options.signal, timeoutSignal])
    : options.signal ?? timeoutSignal
  const scopedOptions = { ...options, timeoutMs, signal }
  let current = parseWebUrl(value)
  const redirects = []
  for (let redirect = 0; redirect <= maximumRedirects; redirect += 1) {
    // Resolve immediately before every connection. The pinned lookup below
    // prevents a second DNS answer from rebinding the validated hostname.
    const validated = await validatePublicWebUrl(current, scopedOptions)
    const response = await requestOnce(validated, scopedOptions)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location
      if (!location) throw webError('web_invalid_redirect', 'The web server returned a redirect without a Location header.', { status: 502 })
      if (redirect >= maximumRedirects) {
        throw webError('web_redirect_limit', 'The web request exceeded the redirect limit.', {
          status: 502,
          retryable: true,
          details: { max_redirects: maximumRedirects }
        })
      }
      current = parseWebUrl(new URL(String(location), current).href)
      redirects.push(current.href)
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      throw webError('web_http_error', `The web server returned HTTP ${response.status}.`, {
        status: response.status === 408 || response.status === 429 || response.status >= 500 ? 502 : 400,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        details: { http_status: response.status }
      })
    }
    if (!TEXT_CONTENT_TYPES.has(response.content_type)) {
      throw webError('web_content_type_unsupported', 'The web response is not an allowed text content type.', {
        status: 415,
        details: { content_type: response.content_type || null }
      })
    }
    return { ...response, url: current.href, redirects }
  }
  throw webError('web_redirect_limit', 'The web request exceeded the redirect limit.', { status: 502, retryable: true })
}

function decodeHtml(value) {
  const named = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
    '#39': "'"
  }
  const codePoint = (digits, radix) => {
    const parsed = Number.parseInt(digits, radix)
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0x10ffff && !(parsed >= 0xd800 && parsed <= 0xdfff)
      ? String.fromCodePoint(parsed)
      : '\uFFFD'
  }
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, digits) => codePoint(digits, 16))
    .replace(/&#(\d+);/g, (_, digits) => codePoint(digits, 10))
    .replace(/&([a-z]+|#39);/gi, (entity, name) => named[name.toLowerCase()] ?? entity)
}

function stripHtml(value) {
  return decodeHtml(String(value ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function attributeValue(attributes, name) {
  const match = String(attributes).match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? ''
}

function publicResultUrl(value, baseUrl) {
  try {
    const parsed = new URL(decodeHtml(value), baseUrl)
    const redirected = parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname.startsWith('/l/')
      ? parsed.searchParams.get('uddg')
      : null
    const result = redirected ? new URL(redirected) : parsed
    if (!['http:', 'https:'].includes(result.protocol) || result.username || result.password) return null
    if (blockedHostname(result.hostname) || (isIP(result.hostname) && isBlockedNetworkAddress(result.hostname))) return null
    result.hash = ''
    return result.href
  } catch {
    return null
  }
}

function parseDuckDuckGoHtml(body, baseUrl, maximumResults, accessedAt) {
  const anchors = []
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  for (const match of String(body).matchAll(pattern)) {
    const classes = attributeValue(match[1], 'class').split(/\s+/)
    if (!classes.includes('result__a') && !classes.includes('result-link')) continue
    const before = String(body).slice(Math.max(0, (match.index ?? 0) - 2_000), match.index ?? 0)
    const rowStart = before.lastIndexOf('<tr')
    const rowEnd = before.lastIndexOf('</tr>')
    if (rowStart > rowEnd) {
      const rowTag = before.slice(rowStart, before.indexOf('>', rowStart) + 1)
      if (attributeValue(rowTag, 'class').split(/\s+/).includes('result-sponsored')) continue
    }
    const url = publicResultUrl(attributeValue(match[1], 'href'), baseUrl)
    const title = stripHtml(match[2])
    if (!url || !title) continue
    anchors.push({ index: match.index ?? 0, end: (match.index ?? 0) + match[0].length, title, url })
    if (anchors.length >= maximumResults) break
  }
  return anchors.map((entry, index) => {
    const segment = String(body).slice(entry.end, anchors[index + 1]?.index ?? entry.end + 8_000)
    const snippetMatch = segment.match(/<(?:a|div|span|td)\b([^>]*\bclass\s*=\s*(?:"[^"]*result(?:__|-)?snippet[^"]*"|'[^']*result(?:__|-)?snippet[^']*')[^>]*)>([\s\S]*?)<\/(?:a|div|span|td)>/i)
    return {
      rank: index + 1,
      title: entry.title.slice(0, 500),
      url: entry.url,
      snippet: stripHtml(snippetMatch?.[2] ?? '').slice(0, 2_000),
      accessed_at: accessedAt
    }
  })
}

function parseJsonSearch(body, baseUrl, maximumResults, accessedAt, provider) {
  let payload
  try {
    payload = JSON.parse(body)
  } catch (cause) {
    throw webError('web_search_invalid_response', 'The search provider returned invalid JSON.', { status: 502, retryable: true, cause })
  }
  let rawResults = Array.isArray(payload?.results) ? payload.results : []
  if (provider === 'duckduckgo_instant') {
    rawResults = []
    if (payload?.AbstractURL && payload?.Heading) {
      rawResults.push({ title: payload.Heading, url: payload.AbstractURL, content: payload.AbstractText })
    }
    const visit = (items) => {
      for (const item of Array.isArray(items) ? items : []) {
        if (Array.isArray(item?.Topics)) visit(item.Topics)
        else if (item?.FirstURL && item?.Text) rawResults.push({ title: item.Text, url: item.FirstURL, content: item.Text })
      }
    }
    visit(payload?.RelatedTopics)
  }
  const results = []
  for (const item of rawResults) {
    const url = publicResultUrl(item?.url ?? item?.link ?? item?.FirstURL, baseUrl)
    const title = stripHtml(item?.title ?? item?.name ?? item?.Text)
    if (!url || !title) continue
    results.push({
      rank: results.length + 1,
      title: title.slice(0, 500),
      url,
      snippet: stripHtml(item?.content ?? item?.snippet ?? item?.description ?? '').slice(0, 2_000),
      accessed_at: accessedAt
    })
    if (results.length >= maximumResults) break
  }
  return results
}

function xmlTag(item, name) {
  const match = String(item).match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))
  return String(match?.[1] ?? '').replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/i, '$1')
}

function parseBingRss(body, baseUrl, maximumResults, accessedAt) {
  const results = []
  for (const match of String(body).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const item = match[1]
    const url = publicResultUrl(stripHtml(xmlTag(item, 'link')), baseUrl)
    const title = stripHtml(xmlTag(item, 'title'))
    if (!url || !title) continue
    results.push({
      rank: results.length + 1,
      title: title.slice(0, 500),
      url,
      snippet: stripHtml(xmlTag(item, 'description')).slice(0, 2_000),
      accessed_at: accessedAt
    })
    if (results.length >= maximumResults) break
  }
  return results
}

function pageText(body, maximumCharacters) {
  const withoutActiveContent = String(body)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(?:article|blockquote|div|h[1-6]|li|main|p|section|tr)>/gi, '\n')
  return decodeHtml(withoutActiveContent.replace(/<[^>]*>/g, ' '))
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maximumCharacters)
}

function pageTitle(body, fallback) {
  const match = String(body).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  return (stripHtml(match?.[1] ?? '') || fallback).slice(0, 500)
}

export function createWebSearchService(options = {}) {
  const provider = String(options.provider ?? process.env.WEB_SEARCH_PROVIDER ?? 'duckduckgo').trim().toLowerCase()
  const configuredEndpoint = options.endpoint ?? process.env.WEB_SEARCH_ENDPOINT
  const endpoint = configuredEndpoint || (
    provider === 'duckduckgo_instant'
      ? 'https://api.duckduckgo.com/'
      : 'https://lite.duckduckgo.com/lite/'
  )
  const fetchText = options.fetchText ?? fetchPublicText
  const now = options.now ?? (() => new Date().toISOString())
  const configuredFallbacks = Array.isArray(options.searchFallbacks) ? options.searchFallbacks : null
  const searchFallbacks = configuredFallbacks ?? (
    !configuredEndpoint && !options.fetchText && provider === 'duckduckgo'
      ? [{ provider: 'bing_rss', endpoint: 'https://www.bing.com/search' }]
      : []
  )

  const searchWeb = async (input = {}, context = {}) => {
    const query = normalizedQuery(input.query ?? input.q)
    const maximumResults = integer(input.max_results ?? input.maxResults, 5, 1, WEB_SEARCH_LIMITS.maxResults, 'max_results')
    const candidates = [{ provider, endpoint }, ...searchFallbacks]
    let lastError = null
    let emptyResult = null

    for (const candidate of candidates) {
      const candidateProvider = String(candidate?.provider ?? '').trim().toLowerCase()
      const candidateEndpoint = candidate?.endpoint
      if (!candidateProvider || !candidateEndpoint) continue
      try {
        const target = parseWebUrl(candidateEndpoint)
        target.searchParams.set('q', query)
        if (candidateProvider === 'searxng') target.searchParams.set('format', 'json')
        if (candidateProvider === 'bing_rss') target.searchParams.set('format', 'rss')
        if (candidateProvider === 'duckduckgo_instant') {
          target.searchParams.set('format', 'json')
          target.searchParams.set('no_html', '1')
          target.searchParams.set('skip_disambig', '0')
        }
        const response = await fetchText(target.href, {
          signal: context.signal,
          timeoutMs: context.timeoutMs,
          maxBytes: WEB_SEARCH_LIMITS.maxSearchBytes,
          maxRedirects: WEB_SEARCH_LIMITS.maxRedirects,
          lookup: options.lookup,
          httpRequest: options.httpRequest,
          httpsRequest: options.httpsRequest
        })
        const accessedAt = now()
        const results = candidateProvider === 'duckduckgo'
          ? parseDuckDuckGoHtml(response.body, response.url, maximumResults, accessedAt)
          : candidateProvider === 'bing_rss'
            ? parseBingRss(response.body, response.url, maximumResults, accessedAt)
            : parseJsonSearch(response.body, response.url, maximumResults, accessedAt, candidateProvider)
        if (
          candidateProvider === 'duckduckgo'
          && results.length === 0
          && (response.status === 202 || /(?:anomaly-modal|bots use DuckDuckGo|challenge-form)/i.test(response.body))
        ) {
          throw webError('web_search_challenged', 'The search provider requested an anti-automation challenge.', {
            status: 502,
            retryable: true
          })
        }
        const result = {
          source_type: 'internet',
          provider: candidateProvider,
          query,
          accessed_at: accessedAt,
          items: results,
          result_count: results.length,
          untrusted: true
        }
        if (results.length) return result
        emptyResult = result
      } catch (error) {
        lastError = error
      }
    }

    if (emptyResult) return emptyResult
    throw lastError ?? webError('web_search_invalid_response', 'No usable web search provider is configured.', {
      status: 502,
      retryable: true
    })
  }

  const fetchWebPage = async (input = {}, context = {}) => {
    const maximumCharacters = integer(
      input.max_characters ?? input.maxCharacters,
      40_000,
      1_000,
      WEB_SEARCH_LIMITS.maxPageCharacters,
      'max_characters'
    )
    const response = await fetchText(input.url, {
      signal: context.signal,
      timeoutMs: context.timeoutMs,
      maxBytes: WEB_SEARCH_LIMITS.maxPageBytes,
      maxRedirects: WEB_SEARCH_LIMITS.maxRedirects,
      lookup: options.lookup,
      httpRequest: options.httpRequest,
      httpsRequest: options.httpsRequest
    })
    const parsed = new URL(response.url)
    const accessedAt = now()
    const text = response.content_type === 'application/json'
      ? response.body.slice(0, maximumCharacters)
      : pageText(response.body, maximumCharacters)
    return {
      source_type: 'internet',
      title: pageTitle(response.body, parsed.hostname),
      url: response.url,
      accessed_at: accessedAt,
      content_type: response.content_type,
      text,
      text_truncated: text.length >= maximumCharacters || Buffer.byteLength(response.body, 'utf8') >= WEB_SEARCH_LIMITS.maxPageBytes,
      redirects: response.redirects,
      untrusted: true
    }
  }

  return {
    provider,
    endpoint,
    searchWeb,
    fetchWebPage
  }
}
