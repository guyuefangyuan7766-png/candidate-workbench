import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, test } from 'node:test'
import {
  ATTACHMENT_LIMITS,
  getRemainingVisualTimeoutMs,
  normalizeAttachmentLimits,
  parseAttachment,
  validateAttachmentFile
} from '../../server/attachment-parser.js'
import { createAttachmentVisualParser } from '../../server/attachment-visual-parser.js'

const servers = []

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()
    try { server.closeAllConnections() } catch {}
    try { await new Promise((resolve) => server.close(resolve)) } catch {}
  }
})

function pdfLiteral(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
}

function textPdfPages(texts) {
  const pageObjectIds = texts.map((_, index) => 3 + index * 2)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${texts.length} >>`
  ]
  const fontObjectId = texts.length * 2 + 3
  for (const text of texts) {
    const content = `BT\n/F1 12 Tf\n72 720 Td\n(${pdfLiteral(text)}) Tj\nET`
    const pageObjectId = objects.length + 1
    const contentObjectId = pageObjectId + 1
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`)
    objects.push(`<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}\nendstream`)
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  let output = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output, 'ascii'))
    output += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(output, 'ascii')
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return {
    originalname: 'anonymous-visual-bounds.pdf',
    mimetype: 'application/pdf',
    buffer: Buffer.from(output, 'ascii')
  }
}

function textPdf(text) {
  return textPdfPages([text])
}

function visualPage() {
  return {
    page_number: 1,
    width: 1,
    height: 1,
    pixel_count: 1,
    mime_type: 'image/png',
    image: new Uint8Array(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+G7PqAAAAAElFTkSuQmCC',
      'base64'
    )),
    text: 'Anonymous visual evidence',
    text_spans: []
  }
}

function successfulVisualRequest(onLookup = () => {}) {
  return (endpoint, options, callback) => {
    const request = new EventEmitter()
    request.end = () => {
      options.lookup(endpoint.hostname, { all: false }, (error, address, family) => {
        if (error) return request.emit('error', error)
        onLookup({ address, family })
        const body = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ records: [] }) } }] })
        const response = Readable.from([Buffer.from(body)])
        response.statusCode = 200
        response.statusMessage = 'OK'
        response.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }
        callback(response)
      })
    }
    request.destroy = (error) => { if (error) request.emit('error', error) }
    return request
  }
}

async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  servers.push(server)
  return `http://127.0.0.1:${server.address().port}`
}

test('visual page text and individual spans are bounded before leaving the parser worker', async () => {
  const file = textPdf(`Anonymous evidence ${'x'.repeat(40_000)}`)
  const parsed = await parseAttachment(
    file,
    validateAttachmentFile(file),
    ATTACHMENT_LIMITS,
    { renderVisualPages: true }
  )

  assert.equal(ATTACHMENT_LIMITS.maxVisualPageTextCharacters, 8_000)
  assert.equal(ATTACHMENT_LIMITS.maxVisualTextSpanCharacters, 1_000)
  assert.ok(parsed.visual_pages[0].text.length <= ATTACHMENT_LIMITS.maxVisualPageTextCharacters)
  assert.ok(parsed.visual_pages[0].text_spans.every((span) => (
    span.text.length <= ATTACHMENT_LIMITS.maxVisualTextSpanCharacters
  )))
})

test('visual overrides cannot expand the reviewed worker resource envelope', async () => {
  const file = textPdfPages(Array.from({ length: 13 }, (_, index) => (
    `Anonymous hard ceiling page ${index + 1} remains searchable`
  )))
  const parsed = await parseAttachment(
    file,
    validateAttachmentFile(file),
    {
      ...ATTACHMENT_LIMITS,
      maxVisualPdfPages: 99,
      maxVisualPagePixels: Number.MAX_SAFE_INTEGER,
      maxVisualTotalPixels: Number.MAX_SAFE_INTEGER,
      maxVisualTotalRasterBytes: Number.MAX_SAFE_INTEGER,
      maxVisualPagePngBytes: Number.MAX_SAFE_INTEGER,
      maxVisualTotalPngBytes: Number.MAX_SAFE_INTEGER,
      maxVisualPageTextCharacters: Number.MAX_SAFE_INTEGER,
      maxVisualTextSpanCharacters: Number.MAX_SAFE_INTEGER,
      visualRenderPageTimeoutMs: 60_000,
      visualRenderTimeoutMs: 60_000
    },
    { renderVisualPages: true, allowTextlessPdf: true }
  )

  assert.deepEqual(parsed.metadata.visual, {
    status: 'fallback',
    error_code: 'pdf_visual_page_limit',
    rendered_page_count: 0
  })
  assert.equal(parsed.visual_pages.length, 0)
  assert.match(parsed.text, /page 13 remains searchable/u)
})

test('generic parser limits stay bounded and complete when visual overrides are supplied', () => {
  const normalized = normalizeAttachmentLimits({
    maxPdfPages: Number.MAX_SAFE_INTEGER,
    parseTimeoutMs: Number.MAX_SAFE_INTEGER,
    maxVisualPdfPages: Number.MAX_SAFE_INTEGER
  })

  assert.equal(normalized.maxPdfPages, ATTACHMENT_LIMITS.maxPdfPages)
  assert.equal(normalized.parseTimeoutMs, ATTACHMENT_LIMITS.parseTimeoutMs)
  assert.equal(normalized.maxVisualPdfPages, ATTACHMENT_LIMITS.maxVisualPdfPages)
  assert.equal(normalized.maxFileBytes, ATTACHMENT_LIMITS.maxFileBytes)
  assert.equal(normalized.maxExtractedText, ATTACHMENT_LIMITS.maxExtractedText)
})

test('PDF visual rendering enforces an independent cumulative raster memory budget', async () => {
  const file = textPdfPages([
    'Anonymous raster memory page one remains searchable',
    'Anonymous raster memory page two remains searchable'
  ])
  const parsed = await parseAttachment(
    file,
    validateAttachmentFile(file),
    {
      ...ATTACHMENT_LIMITS,
      // Each 918 x 1188 RGBA canvas fits, but both pages exceed this total.
      maxVisualTotalRasterBytes: 5 * 1024 * 1024
    },
    { renderVisualPages: true }
  )

  assert.match(parsed.text, /page one remains searchable/u)
  assert.match(parsed.text, /page two remains searchable/u)
  assert.deepEqual(parsed.metadata.visual, {
    status: 'fallback',
    error_code: 'pdf_visual_total_memory_limit',
    rendered_page_count: 0
  })
  assert.equal(parsed.visual_pages.length, 0)
})

test('visual page timeout never exceeds the remaining whole-document budget', () => {
  assert.equal(getRemainingVisualTimeoutMs(1_000, 5_000, 8_000, 12_900), 100)
  assert.equal(getRemainingVisualTimeoutMs(1_000, 5_000, 8_000, 13_000), 0)
  assert.equal(getRemainingVisualTimeoutMs(1_000, 5_000, 8_000, 11_000, 10_500), 500)
})

test('an exhausted visual deadline produces a stable fallback while deterministic PDF text remains available', async () => {
  const file = textPdf(`Anonymous deadline evidence ${'x'.repeat(20_000)}`)
  const parsed = await parseAttachment(
    file,
    validateAttachmentFile(file),
    {
      ...ATTACHMENT_LIMITS,
      visualRenderPageTimeoutMs: 1,
      visualRenderTimeoutMs: 1
    },
    { renderVisualPages: true }
  )

  assert.match(parsed.text, /^Anonymous deadline evidence/u)
  assert.deepEqual(parsed.metadata.visual, {
    status: 'fallback',
    error_code: 'pdf_visual_render_timeout',
    rendered_page_count: 0
  })
  assert.equal(parsed.visual_pages.length, 0)
})

test('stalled expensive PDF visual stages are actively bounded without losing deterministic text', async (context) => {
  const stages = ['getPage', 'getTextContent', 'loadCanvas', 'render', 'encodePng']
  for (const stage of stages) {
    await context.test(stage, async () => {
      const file = textPdf(`Anonymous ${stage} deadline evidence`)
      const startedAt = Date.now()
      const parsed = await parseAttachment(
        file,
        validateAttachmentFile(file),
        {
          ...ATTACHMENT_LIMITS,
          visualRenderPageTimeoutMs: 500,
          visualRenderTimeoutMs: 5_000,
          parseTimeoutMs: 6_000
        },
        {
          renderVisualPages: true,
          testVisualStageDelays: { [stage]: 4_000 }
        }
      )

      assert.match(parsed.text, new RegExp(`^Anonymous ${stage} deadline evidence`, 'u'))
      assert.deepEqual(parsed.metadata.visual, {
        status: 'fallback',
        error_code: 'pdf_visual_render_timeout',
        rendered_page_count: 0
      })
      assert.equal(parsed.visual_pages.length, 0)
      assert.ok(Date.now() - startedAt < 2_500, `${stage} exceeded its active visual deadline`)
    })
  }
})

test('the optional native canvas renderer is loaded only when visual rendering runs', () => {
  const workerSource = readFileSync(new URL('../../server/attachment-parser-worker.js', import.meta.url), 'utf8')
  assert.doesNotMatch(workerSource, /^import .*['"]@napi-rs\/canvas['"]/mu)
  assert.match(workerSource, /import\(['"]@napi-rs\/canvas['"]\)/u)
})

test('visual gateway redirects are not followed with page images', async () => {
  let redirectedRequests = 0
  const redirectedTarget = await listen((_req, res) => {
    redirectedRequests += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ records: [] }) } }] }))
  })
  const redirectingGateway = await listen((_req, res) => {
    res.writeHead(307, { location: `${redirectedTarget}/unapproved-target` })
    res.end()
  })
  const parser = createAttachmentVisualParser({
    capability: 'image_input',
    baseUrl: `${redirectingGateway}/v1`,
    apiKey: 'anonymous-test-key',
    model: 'anonymous-vision-model',
    timeoutMs: 1_000
  })

  const result = await parser.suggest({
    format: 'pdf',
    document: { pdf_content_type: 'scanned', page_count: 1 },
    records: [{ record_id: 'anonymous-record' }],
    visual_pages: [visualPage()]
  })

  assert.equal(redirectedRequests, 0)
  assert.equal(result.status, 'fallback')
  assert.equal(result.error_code, 'visual_unavailable')
})

test('visual endpoint configuration rejects unsafe schemes, private targets, and production HTTP', () => {
  const base = {
    capability: 'image_input',
    apiKey: 'anonymous-test-key',
    model: 'anonymous-vision-model'
  }
  assert.equal(createAttachmentVisualParser({ ...base, baseUrl: 'file:///tmp/visual' }).status().error_code, 'visual_endpoint_invalid')
  assert.equal(createAttachmentVisualParser({ ...base, baseUrl: 'http://192.168.1.10/v1' }).status().error_code, 'visual_endpoint_blocked')
  assert.equal(createAttachmentVisualParser({ ...base, baseUrl: 'https://[::]/v1' }).status().error_code, 'visual_endpoint_blocked')
  assert.equal(createAttachmentVisualParser({ ...base, baseUrl: 'https://[ff02::1]/v1' }).status().error_code, 'visual_endpoint_blocked')
  assert.equal(createAttachmentVisualParser({ ...base, baseUrl: 'https://[::ffff:192.168.1.1]/v1' }).status().error_code, 'visual_endpoint_blocked')
  assert.equal(createAttachmentVisualParser({ ...base, baseUrl: 'https://[64:ff9b::c0a8:101]/v1' }).status().error_code, 'visual_endpoint_blocked')
  assert.equal(createAttachmentVisualParser({ ...base, baseUrl: 'https://[2002:c0a8:101::]/v1' }).status().error_code, 'visual_endpoint_blocked')
  assert.match(readFileSync(new URL('../../start.ps1', import.meta.url), 'utf8'), /"ATTACHMENT_VISUAL_ALLOWED_HOSTS"/u)

  const previous = process.env.NODE_ENV
  try {
    process.env.NODE_ENV = 'production'
    assert.equal(createAttachmentVisualParser({ ...base, baseUrl: 'http://127.0.0.1:4173/v1' }).status().error_code, 'visual_endpoint_insecure')
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  }
})

test('an explicitly trusted private HTTPS hostname proceeds through DNS and pinned lookup', async () => {
  let requestOptions
  let resolvedAddress
  const parser = createAttachmentVisualParser({
    capability: 'image_input',
    baseUrl: 'https://vision.corp.example/v1',
    trustedPrivateHosts: ['vision.corp.example'],
    apiKey: 'anonymous-test-key',
    model: 'anonymous-vision-model',
    dnsLookup: async (hostname, options) => {
      assert.equal(hostname, 'vision.corp.example')
      assert.deepEqual(options, { all: true, verbatim: true })
      return [{ address: '10.24.8.19', family: 4 }]
    },
    request: (endpoint, options, callback) => {
      requestOptions = { endpoint, options }
      const request = new EventEmitter()
      request.end = () => {
        options.lookup(endpoint.hostname, { all: false }, (error, address, family) => {
          if (error) return request.emit('error', error)
          resolvedAddress = { address, family }
          const body = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ records: [] }) } }] })
          const response = Readable.from([Buffer.from(body)])
          response.statusCode = 200
          response.statusMessage = 'OK'
          response.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }
          callback(response)
        })
      }
      request.destroy = (error) => { if (error) request.emit('error', error) }
      return request
    }
  })

  const result = await parser.suggest({
    format: 'pdf',
    document: { pdf_content_type: 'scanned', page_count: 1 },
    records: [{ record_id: 'anonymous-record' }],
    visual_pages: [visualPage()]
  })

  assert.equal(result.status, 'ready')
  assert.equal(requestOptions.endpoint.hostname, 'vision.corp.example')
  assert.equal(requestOptions.options.servername, 'vision.corp.example')
  assert.deepEqual(resolvedAddress, { address: '10.24.8.19', family: 4 })
})

test('a private HTTPS hostname remains blocked when trusted private hosts are not configured', async () => {
  let requests = 0
  const parser = createAttachmentVisualParser({
    capability: 'image_input',
    baseUrl: 'https://vision.unapproved.example/v1',
    apiKey: 'anonymous-test-key',
    model: 'anonymous-vision-model',
    dnsLookup: async () => [{ address: '10.24.8.19', family: 4 }],
    request: () => { requests += 1; throw new Error('request must not start') }
  })
  const result = await parser.suggest({
    format: 'pdf',
    document: { pdf_content_type: 'scanned', page_count: 1 },
    records: [{ record_id: 'anonymous-record' }],
    visual_pages: [visualPage()]
  })
  assert.equal(result.error_code, 'visual_endpoint_blocked')
  assert.equal(result.retryable, false)
  assert.equal(requests, 0)
})

test('a trusted private hostname is still rejected when the endpoint is not HTTPS', async () => {
  const parser = createAttachmentVisualParser({
    capability: 'image_input',
    baseUrl: 'http://vision.corp.example/v1',
    trustedPrivateHosts: ['vision.corp.example'],
    apiKey: 'anonymous-test-key',
    model: 'anonymous-vision-model',
    dnsLookup: async () => [{ address: '10.24.8.19', family: 4 }]
  })

  const result = await parser.suggest({
    format: 'pdf',
    document: { pdf_content_type: 'scanned', page_count: 1 },
    records: [{ record_id: 'anonymous-record' }],
    visual_pages: [visualPage()]
  })

  assert.equal(result.error_code, 'visual_endpoint_insecure')
  assert.equal(result.retryable, false)
})

test('trusted private approval never permits a private IP literal', () => {
  const base = {
    capability: 'image_input',
    trustedPrivateHosts: ['vision.corp.example'],
    apiKey: 'anonymous-test-key',
    model: 'anonymous-vision-model'
  }
  assert.equal(createAttachmentVisualParser({ ...base, baseUrl: 'https://10.24.8.19/v1' }).status().error_code, 'visual_endpoint_blocked')
})

test('a private DNS result for a non-exact hostname remains blocked', async () => {
  const parser = createAttachmentVisualParser({
    capability: 'image_input',
    baseUrl: 'https://sub.vision.corp.example/v1',
    trustedPrivateHosts: ['vision.corp.example'],
    apiKey: 'anonymous-test-key',
    model: 'anonymous-vision-model',
    dnsLookup: async () => [{ address: '10.24.8.19', family: 4 }]
  })
  const result = await parser.suggest({
    format: 'pdf',
    document: { pdf_content_type: 'scanned', page_count: 1 },
    records: [{ record_id: 'anonymous-record' }],
    visual_pages: [visualPage()]
  })
  assert.equal(result.error_code, 'visual_endpoint_blocked')
})

test('trusted private host approval is loaded from the explicit environment variable', async () => {
  const previous = process.env.ATTACHMENT_VISUAL_TRUSTED_PRIVATE_HOSTS
  try {
    process.env.ATTACHMENT_VISUAL_TRUSTED_PRIVATE_HOSTS = 'vision.env.example'
    let pinned
    const parser = createAttachmentVisualParser({
      capability: 'image_input',
      baseUrl: 'https://vision.env.example/v1',
      apiKey: 'anonymous-test-key',
      model: 'anonymous-vision-model',
      dnsLookup: async () => [{ address: '172.20.4.12', family: 4 }],
      request: successfulVisualRequest((value) => { pinned = value })
    })
    const result = await parser.suggest({
      format: 'pdf',
      document: { pdf_content_type: 'scanned', page_count: 1 },
      records: [{ record_id: 'anonymous-record' }],
      visual_pages: [visualPage()]
    })
    assert.equal(result.status, 'ready')
    assert.deepEqual(pinned, { address: '172.20.4.12', family: 4 })
  } finally {
    if (previous === undefined) delete process.env.ATTACHMENT_VISUAL_TRUSTED_PRIVATE_HOSTS
    else process.env.ATTACHMENT_VISUAL_TRUSTED_PRIVATE_HOSTS = previous
  }
})

test('trusted private DNS accepts IPv6 ULA but rejects dangerous or non-private answers', async (context) => {
  const cases = [
    ['IPv6 ULA', 'fd12:3456:789a::10', true],
    ['loopback', '127.0.0.1', false],
    ['link-local', '169.254.169.10', false],
    ['metadata', '169.254.169.254', false],
    ['multicast', '224.0.0.1', false],
    ['IPv4-mapped', '::ffff:c0a8:101', false],
    ['NAT64', '64:ff9b::c0a8:101', false],
    ['6to4', '2002:c0a8:101::', false],
    ['public', '93.184.216.34', false],
    ['CGNAT', '100.64.0.1', false]
  ]
  for (const [label, address, shouldProceed] of cases) {
    await context.test(label, async () => {
      const parser = createAttachmentVisualParser({
        capability: 'image_input',
        baseUrl: 'https://vision.boundary.example/v1',
        trustedPrivateHosts: ['vision.boundary.example'],
        apiKey: 'anonymous-test-key',
        model: 'anonymous-vision-model',
        dnsLookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
        request: successfulVisualRequest()
      })
      const result = await parser.suggest({
        format: 'pdf',
        document: { pdf_content_type: 'scanned', page_count: 1 },
        records: [{ record_id: 'anonymous-record' }],
        visual_pages: [visualPage()]
      })
      assert.equal(result.status === 'ready', shouldProceed)
      if (!shouldProceed) assert.equal(result.error_code, 'visual_endpoint_blocked')
    })
  }
})

test('trusted private DNS rejects a mixed private and public answer set', async () => {
  const parser = createAttachmentVisualParser({
    capability: 'image_input',
    baseUrl: 'https://vision.mixed.example/v1',
    trustedPrivateHosts: ['vision.mixed.example'],
    apiKey: 'anonymous-test-key',
    model: 'anonymous-vision-model',
    dnsLookup: async () => [
      { address: '10.24.8.19', family: 4 },
      { address: '93.184.216.34', family: 4 }
    ],
    request: successfulVisualRequest()
  })
  const result = await parser.suggest({
    format: 'pdf',
    document: { pdf_content_type: 'scanned', page_count: 1 },
    records: [{ record_id: 'anonymous-record' }],
    visual_pages: [visualPage()]
  })
  assert.equal(result.error_code, 'visual_endpoint_blocked')
})

test('trusted private approval does not bypass an explicitly configured hostname allowlist', async () => {
  let dnsCalls = 0
  const parser = createAttachmentVisualParser({
    capability: 'image_input',
    baseUrl: 'https://vision.allowlist.example/v1',
    allowedHosts: ['another.gateway.example'],
    trustedPrivateHosts: ['vision.allowlist.example'],
    apiKey: 'anonymous-test-key',
    model: 'anonymous-vision-model',
    dnsLookup: async () => { dnsCalls += 1; return [{ address: '10.24.8.19', family: 4 }] }
  })
  const result = await parser.suggest({
    format: 'pdf',
    document: { pdf_content_type: 'scanned', page_count: 1 },
    records: [{ record_id: 'anonymous-record' }],
    visual_pages: [visualPage()]
  })
  assert.equal(result.error_code, 'visual_endpoint_unapproved')
  assert.equal(dnsCalls, 0)
})

test('trusted private approval still rejects reserved or metadata hostname suffixes', async (context) => {
  const hostnames = [
    'vision.localhost',
    'vision.corp.internal',
    'vision.corp.local',
    'vision.metadata.google.internal'
  ]
  for (const hostname of hostnames) {
    await context.test(hostname, async () => {
      let dnsCalls = 0
      const parser = createAttachmentVisualParser({
        capability: 'image_input',
        baseUrl: `https://${hostname}/v1`,
        trustedPrivateHosts: [hostname],
        apiKey: 'anonymous-test-key',
        model: 'anonymous-vision-model',
        dnsLookup: async () => { dnsCalls += 1; return [{ address: '10.24.8.19', family: 4 }] }
      })
      const result = await parser.suggest({
        format: 'pdf',
        document: { pdf_content_type: 'scanned', page_count: 1 },
        records: [{ record_id: 'anonymous-record' }],
        visual_pages: [visualPage()]
      })
      assert.equal(result.error_code, 'visual_endpoint_blocked')
      assert.equal(dnsCalls, 0)
    })
  }
})

test('visual adapter rejects a public hostname whose DNS answer embeds a private IPv4 address', async () => {
  const parser = createAttachmentVisualParser({
    capability: 'image_input',
    baseUrl: 'https://public-gateway.example/v1',
    apiKey: 'anonymous-test-key',
    model: 'anonymous-vision-model',
    dnsLookup: async () => [{ address: '::ffff:c0a8:101', family: 6 }]
  })
  const result = await parser.suggest({
    format: 'pdf',
    document: { pdf_content_type: 'scanned', page_count: 1 },
    records: [{ record_id: 'anonymous-record' }],
    visual_pages: [visualPage()]
  })

  assert.equal(result.error_code, 'visual_endpoint_blocked')
})

test('visual adapter rejects public IPv4-mapped, NAT64, and 6to4 DNS answers', async (context) => {
  const cases = [
    ['public IPv4-mapped', '::ffff:5db8:d822'],
    ['public NAT64', '64:ff9b::5db8:d822'],
    ['public 6to4', '2002:5db8:d822::']
  ]
  for (const [label, address] of cases) {
    await context.test(label, async () => {
      const parser = createAttachmentVisualParser({
        capability: 'image_input',
        baseUrl: 'https://public-tunnel.example/v1',
        apiKey: 'anonymous-test-key',
        model: 'anonymous-vision-model',
        dnsLookup: async () => [{ address, family: 6 }],
        request: successfulVisualRequest()
      })
      const result = await parser.suggest({
        format: 'pdf',
        document: { pdf_content_type: 'scanned', page_count: 1 },
        records: [{ record_id: 'anonymous-record' }],
        visual_pages: [visualPage()]
      })
      assert.equal(result.error_code, 'visual_endpoint_blocked')
    })
  }
})

test('visual request pins the low-level connection lookup to the verified public address', async () => {
  let requestOptions
  let resolvedAddress
  const parser = createAttachmentVisualParser({
    capability: 'image_input',
    baseUrl: 'https://visual-gateway.invalid/v1',
    apiKey: 'anonymous-test-key',
    model: 'anonymous-vision-model',
    dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: (endpoint, options, callback) => {
      requestOptions = { endpoint, options }
      const request = new EventEmitter()
      request.end = () => {
        options.lookup(endpoint.hostname, { all: false }, (error, address, family) => {
          if (error) return request.emit('error', error)
          resolvedAddress = { address, family }
          const body = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ records: [] }) } }] })
          const response = Readable.from([Buffer.from(body)])
          response.statusCode = 200
          response.statusMessage = 'OK'
          response.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }
          callback(response)
        })
      }
      request.destroy = (error) => { if (error) request.emit('error', error) }
      return request
    }
  })

  const result = await parser.suggest({
    format: 'pdf',
    document: { pdf_content_type: 'scanned', page_count: 1 },
    records: [{ record_id: 'anonymous-record' }],
    visual_pages: [visualPage()]
  })

  assert.equal(result.status, 'ready')
  assert.equal(requestOptions.endpoint.hostname, 'visual-gateway.invalid')
  assert.equal(requestOptions.options.servername, 'visual-gateway.invalid')
  assert.equal(requestOptions.options.headers.host, 'visual-gateway.invalid')
  assert.deepEqual(resolvedAddress, { address: '93.184.216.34', family: 4 })
})

test('visual adapter aborts a caller signal while endpoint DNS lookup is pending', async () => {
  let lookupStarted = false
  const parser = createAttachmentVisualParser({
    capability: 'image_input',
    baseUrl: 'https://dns-test.invalid/v1',
    apiKey: 'anonymous-test-key',
    model: 'anonymous-vision-model',
    timeoutMs: 1_000,
    dnsLookup: async () => {
      lookupStarted = true
      return new Promise(() => {})
    }
  })
  const controller = new AbortController()
  const startedAt = Date.now()
  const pending = parser.suggest({
    format: 'pdf',
    document: { pdf_content_type: 'scanned', page_count: 1 },
    records: [{ record_id: 'anonymous-record' }],
    visual_pages: [visualPage()],
    signal: controller.signal
  })
  setTimeout(() => controller.abort(), 10).unref()
  const result = await pending
  assert.equal(lookupStarted, true)
  assert.equal(result.error_code, 'visual_aborted')
  assert.ok(Date.now() - startedAt < 500)
})

test('visual adapter rejects non-PNG bytes before sending an image request', async () => {
  let requests = 0
  const baseUrl = await listen((_req, res) => {
    requests += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ records: [] }) } }] }))
  })
  const parser = createAttachmentVisualParser({
    capability: 'image_input',
    baseUrl: `${baseUrl}/v1`,
    apiKey: 'anonymous-test-key',
    model: 'anonymous-vision-model'
  })
  const page = visualPage()
  page.image = new Uint8Array(Buffer.from('not-a-png'))
  const result = await parser.suggest({
    format: 'pdf',
    document: { pdf_content_type: 'scanned', page_count: 1 },
    records: [{ record_id: 'anonymous-record' }],
    visual_pages: [page]
  })
  assert.equal(requests, 0)
  assert.deepEqual(result, {
    records: [],
    status: 'fallback',
    schema_mode: 'strict',
    error_code: 'visual_invalid_schema',
    retryable: false
  })
})

test('visual adapter rejects PNG dimensions that do not match the page envelope', async () => {
  let requests = 0
  const baseUrl = await listen((_req, res) => {
    requests += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ records: [] }) } }] }))
  })
  const parser = createAttachmentVisualParser({
    capability: 'image_input',
    baseUrl: `${baseUrl}/v1`,
    apiKey: 'anonymous-test-key',
    model: 'anonymous-vision-model'
  })
  const page = visualPage()
  const png = Buffer.from(page.image)
  png.writeUInt32BE(2, 16)
  page.image = new Uint8Array(png)
  const result = await parser.suggest({
    format: 'pdf',
    document: { pdf_content_type: 'scanned', page_count: 1 },
    records: [{ record_id: 'anonymous-record' }],
    visual_pages: [page]
  })
  assert.equal(requests, 0)
  assert.deepEqual(result, {
    records: [],
    status: 'fallback',
    schema_mode: 'strict',
    error_code: 'visual_invalid_schema',
    retryable: false
  })
})

test('visual adapter rejects records beyond its configured envelope instead of truncating them', async () => {
  let requests = 0
  const baseUrl = await listen((_req, res) => {
    requests += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ records: [] }) } }] }))
  })
  const parser = createAttachmentVisualParser({
    capability: 'image_input',
    baseUrl: `${baseUrl}/v1`,
    apiKey: 'anonymous-test-key',
    model: 'anonymous-vision-model',
    maxRecords: 1
  })
  const result = await parser.suggest({
    format: 'pdf',
    document: { pdf_content_type: 'scanned', page_count: 1 },
    records: [{ record_id: 'anonymous-record-1' }, { record_id: 'anonymous-record-2' }],
    visual_pages: [visualPage()]
  })
  assert.equal(requests, 0)
  assert.deepEqual(result, {
    records: [],
    status: 'fallback',
    schema_mode: 'strict',
    error_code: 'visual_invalid_schema',
    retryable: false
  })
})

test('visual adapter clamps oversized overrides and environment budgets', () => {
  const expected = {
    maxPages: 12,
    maxPagePixels: 4_000_000,
    maxPageBytes: 3 * 1024 * 1024,
    maxTotalImageBytes: 12 * 1024 * 1024,
    maxTextCharacters: 8_000,
    maxRecords: 100,
    maxResponseBytes: 512 * 1024,
    timeoutMs: 15_000
  }
  const credentials = {
    capability: 'image_input',
    baseUrl: 'https://visual-gateway.invalid/v1',
    apiKey: 'anonymous-test-key',
    model: 'anonymous-vision-model'
  }
  const oversized = Object.fromEntries(Object.keys(expected).map((key) => [key, Number.MAX_SAFE_INTEGER]))
  const explicit = createAttachmentVisualParser({ ...credentials, ...oversized })
  assert.deepEqual(explicit.limits, expected)

  const names = {
    maxPages: 'ATTACHMENT_VISUAL_MAX_PAGES',
    maxPagePixels: 'ATTACHMENT_VISUAL_MAX_PAGE_PIXELS',
    maxPageBytes: 'ATTACHMENT_VISUAL_MAX_PAGE_BYTES',
    maxTotalImageBytes: 'ATTACHMENT_VISUAL_MAX_TOTAL_IMAGE_BYTES',
    maxTextCharacters: 'ATTACHMENT_VISUAL_MAX_TEXT_CHARACTERS',
    maxRecords: 'ATTACHMENT_VISUAL_MAX_RECORDS',
    maxResponseBytes: 'ATTACHMENT_VISUAL_MAX_RESPONSE_BYTES',
    timeoutMs: 'ATTACHMENT_VISUAL_TIMEOUT_MS'
  }
  const previous = Object.fromEntries(Object.values(names).map((name) => [name, process.env[name]]))
  try {
    for (const name of Object.values(names)) process.env[name] = String(Number.MAX_SAFE_INTEGER)
    const fromEnvironment = createAttachmentVisualParser(credentials)
    assert.deepEqual(fromEnvironment.limits, expected)
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
