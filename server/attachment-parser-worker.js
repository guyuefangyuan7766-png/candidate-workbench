import { parentPort, workerData } from 'node:worker_threads'
import { Readable } from 'node:stream'
import ExcelJS from 'exceljs'
import mammothModule from 'mammoth'
import { readFirstSheet, XlsError } from 'xls-reader'
import { getDocument, PasswordException, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  extractAttachmentAvatarResults,
  serializeAttachmentAvatarResult
} from './attachment-avatar.js'
import { inspectSecureZipBuffer } from './secure-zip-buffer.js'
import {
  ATTACHMENT_VISUAL_HARD_LIMITS,
  getRemainingVisualTimeoutMs
} from './attachment-parser.js'

const mammoth = mammothModule.default ?? mammothModule
let canvasFactory

async function loadCanvasFactory() {
  if (canvasFactory) return canvasFactory
  try {
    const canvasModule = await import('@napi-rs/canvas')
    canvasFactory = canvasModule.createCanvas
    return canvasFactory
  } catch {
    throw parserError('pdf_visual_renderer_unavailable', 'PDF 页面视觉渲染器暂时不可用')
  }
}

function verifyZipPayload(buffer, limits) {
  inspectSecureZipBuffer(buffer, limits, { verifyPayload: true })
}

function parserError(code, message, status = 422, details) {
  const error = new Error(message)
  error.code = code
  error.status = status
  if (details !== undefined) error.details = details
  return error
}

function cleanText(value, maximum) {
  const text = String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
  return text.length <= maximum ? { text, truncated: false } : { text: text.slice(0, maximum), truncated: true }
}

function boundedVisualNumber(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  return Number.isFinite(number) && number >= minimum
    ? Math.min(number, maximum)
    : fallback
}

function visualLimits(limits) {
  const hard = ATTACHMENT_VISUAL_HARD_LIMITS
  return {
    maxPages: Math.floor(boundedVisualNumber(limits.maxVisualPdfPages, hard.maxVisualPdfPages, 1, hard.maxVisualPdfPages)),
    scale: boundedVisualNumber(limits.visualRenderScale, hard.visualRenderScale, 0.1, hard.visualRenderScale),
    maxWidth: Math.floor(boundedVisualNumber(limits.maxVisualPageWidth, hard.maxVisualPageWidth, 1, hard.maxVisualPageWidth)),
    maxHeight: Math.floor(boundedVisualNumber(limits.maxVisualPageHeight, hard.maxVisualPageHeight, 1, hard.maxVisualPageHeight)),
    maxPagePixels: Math.floor(boundedVisualNumber(limits.maxVisualPagePixels, hard.maxVisualPagePixels, 1, hard.maxVisualPagePixels)),
    maxTotalPixels: Math.floor(boundedVisualNumber(limits.maxVisualTotalPixels, hard.maxVisualTotalPixels, 1, hard.maxVisualTotalPixels)),
    maxTotalRasterBytes: Math.floor(boundedVisualNumber(limits.maxVisualTotalRasterBytes, hard.maxVisualTotalRasterBytes, 1, hard.maxVisualTotalRasterBytes)),
    maxPagePngBytes: Math.floor(boundedVisualNumber(limits.maxVisualPagePngBytes, hard.maxVisualPagePngBytes, 1, hard.maxVisualPagePngBytes)),
    maxTotalPngBytes: Math.floor(boundedVisualNumber(limits.maxVisualTotalPngBytes, hard.maxVisualTotalPngBytes, 1, hard.maxVisualTotalPngBytes)),
    maxTextSpans: Math.floor(boundedVisualNumber(limits.maxVisualTextSpans, hard.maxVisualTextSpans, 1, hard.maxVisualTextSpans)),
    maxPageTextCharacters: Math.floor(boundedVisualNumber(limits.maxVisualPageTextCharacters, hard.maxVisualPageTextCharacters, 1, hard.maxVisualPageTextCharacters)),
    maxTextSpanCharacters: Math.floor(boundedVisualNumber(limits.maxVisualTextSpanCharacters, hard.maxVisualTextSpanCharacters, 1, hard.maxVisualTextSpanCharacters)),
    pageTimeoutMs: Math.floor(boundedVisualNumber(limits.visualRenderPageTimeoutMs, hard.visualRenderPageTimeoutMs, 1, hard.visualRenderPageTimeoutMs)),
    timeoutMs: Math.floor(boundedVisualNumber(limits.visualRenderTimeoutMs, hard.visualRenderTimeoutMs, 1, hard.visualRenderTimeoutMs))
  }
}

function contentStreamText(content, maximum = Number.MAX_SAFE_INTEGER) {
  let text = ''
  for (const item of content.items) {
    if (!item || typeof item.str !== 'string') continue
    if (text.length >= maximum) break
    const suffix = item.hasEOL ? '\n' : ' '
    const remaining = Math.max(0, maximum - text.length)
    text += `${item.str}${suffix}`.slice(0, remaining)
  }
  return text
}

function normalizedTextSpans(content, viewport, maximum, maxCharacters, maxTotalCharacters = Number.MAX_SAFE_INTEGER) {
  const positioned = []
  const fallback = []
  let retainedCharacters = 0
  let retainedSpans = 0
  for (const [sourceOrder, item] of content.items.entries()) {
    if (!item || typeof item.str !== 'string' || !item.str.trim()) continue
    if (retainedSpans >= maximum) break
    const remainingCharacters = Math.max(0, maxTotalCharacters - retainedCharacters)
    if (remainingCharacters === 0) break
    const text = item.str.slice(0, Math.min(maxCharacters, remainingCharacters))
    const span = {
      text,
      source_order: sourceOrder,
      has_eol: item.hasEOL === true
    }
    retainedCharacters += text.length
    retainedSpans += 1
    if (!Array.isArray(item.transform) || item.transform.length !== 6 || !Number.isFinite(item.width)) {
      fallback.push(span)
      continue
    }
    let transform
    try {
      transform = Util.transform(viewport.transform, item.transform)
    } catch {
      fallback.push(span)
      continue
    }
    const x = transform[4]
    const baseline = transform[5]
    const width = Math.abs(item.width * viewport.scale)
    const height = Math.hypot(transform[2], transform[3])
    if (!Number.isFinite(x) || !Number.isFinite(baseline) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      fallback.push(span)
      continue
    }
    const y = baseline - height
    if (x < 0 || y < 0 || x + width > viewport.width || y + height > viewport.height) {
      fallback.push(span)
      continue
    }
    positioned.push({
      ...span,
      bbox: {
        x: Math.round((x / viewport.width) * 10_000) / 10_000,
        y: Math.round((y / viewport.height) * 10_000) / 10_000,
        width: Math.round((width / viewport.width) * 10_000) / 10_000,
        height: Math.round((height / viewport.height) * 10_000) / 10_000
      }
    })
  }
  return { positioned, fallback }
}

function visualLineGroups(spans) {
  const sorted = [...spans].sort((left, right) => {
    const leftCenter = left.bbox.y + left.bbox.height / 2
    const rightCenter = right.bbox.y + right.bbox.height / 2
    return leftCenter - rightCenter || left.bbox.x - right.bbox.x || left.source_order - right.source_order
  })
  const lines = []
  for (const span of sorted) {
    const center = span.bbox.y + span.bbox.height / 2
    let matching = null
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      const centerDistance = Math.abs(center - line.center)
      const tolerance = Math.max(0.002, Math.min(span.bbox.height, line.height) * 0.6)
      if (centerDistance <= tolerance) {
        matching = line
        break
      }
      // The input is sorted by center. Once the line is above the maximum
      // possible tolerance, earlier lines cannot match this span either.
      if (line.center < center - Math.max(0.002, span.bbox.height * 0.6)) break
    }
    if (!matching) {
      lines.push({ center, height: span.bbox.height, spans: [span] })
      continue
    }
    matching.spans.push(span)
    matching.center = matching.spans.reduce((sum, item) => sum + item.bbox.y + item.bbox.height / 2, 0) / matching.spans.length
    matching.height = Math.max(matching.height, span.bbox.height)
  }
  return lines
    .sort((left, right) => left.center - right.center)
    .map((line) => line.spans.sort((left, right) => (
      left.bbox.x - right.bbox.x || left.source_order - right.source_order
    )))
}

function distinctLineCount(spans) {
  return visualLineGroups(spans).length
}

function hasDenseRowAlignedCells(spans) {
  const lines = visualLineGroups(spans)
  if (lines.length < 3) return false
  const denseRows = lines.filter((line) => {
    if (line.length < 3) return false
    const gaps = line
      .slice(1)
      .map((span, index) => span.bbox.x - (line[index].bbox.x + line[index].bbox.width))
      .filter((gap) => Number.isFinite(gap) && gap > 0)
    if (gaps.length < 2) return false
    const smallestGap = Math.min(...gaps)
    const largestGap = Math.max(...gaps)
    return smallestGap >= 0.06 && smallestGap / largestGap >= 0.5
  })
  return denseRows.length >= 3 && denseRows.length / lines.length >= 0.5
}

function looksLikeTimelinePeriod(value) {
  const compact = String(value ?? '').replace(/\s+/g, '')
  const datePart = '(?:(?:19|20)\\d{2}(?:[./-]\\d{1,2}){0,2}|(?:19|20)\\d{2}年(?:\\d{1,2}月)?(?:\\d{1,2}日)?)'
  const rangeEnd = `(?:${datePart}|至今|现在|当前|present|current)`
  return new RegExp(`^(?:${datePart}(?:(?:[-–—~至]|到|to|through|until)${rangeEnd})?)$`, 'iu').test(compact)
}

function lineCenter(line) {
  return line.reduce((sum, span) => sum + span.bbox.y + span.bbox.height / 2, 0) / line.length
}

function lineHeight(line) {
  return Math.max(...line.map((span) => span.bbox.height))
}

function linesAreAligned(left, right) {
  return Math.abs(lineCenter(left) - lineCenter(right)) <= Math.max(
    0.003,
    Math.min(lineHeight(left), lineHeight(right)) * 0.7
  )
}

function alignedLinePairCountForLines(leftLines, rightLines) {
  const usedRightLines = new Set()
  let pairs = 0
  for (const leftLine of leftLines) {
    let bestIndex = -1
    let bestDistance = Number.POSITIVE_INFINITY
    for (const [rightIndex, rightLine] of rightLines.entries()) {
      if (usedRightLines.has(rightIndex) || !linesAreAligned(leftLine, rightLine)) continue
      const distance = Math.abs(lineCenter(leftLine) - lineCenter(rightLine))
      if (distance < bestDistance) {
        bestDistance = distance
        bestIndex = rightIndex
      }
    }
    if (bestIndex >= 0) {
      usedRightLines.add(bestIndex)
      pairs += 1
    }
  }
  return pairs
}

function alignedLinePairCount(left, right) {
  return alignedLinePairCountForLines(visualLineGroups(left), visualLineGroups(right))
}

function verticalRangeOverlapRatio(left, right) {
  const leftTop = Math.min(...left.map((span) => span.bbox.y))
  const leftBottom = Math.max(...left.map((span) => span.bbox.y + span.bbox.height))
  const rightTop = Math.min(...right.map((span) => span.bbox.y))
  const rightBottom = Math.max(...right.map((span) => span.bbox.y + span.bbox.height))
  const overlap = Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop)
  const extent = Math.max(leftBottom - leftTop, rightBottom - rightTop)
  return extent > 0 ? overlap / extent : 0
}

function hasTimelineRowPairs(left, right) {
  const leftLines = visualLineGroups(left)
  // A date-only sidebar is a legitimate independent column.  A timeline row
  // needs a second left-side label (normally a role or value) alongside the
  // period before it can suppress a column split.
  const periodLines = leftLines.filter((line) => (
    line.some((span) => looksLikeTimelinePeriod(span.text)) &&
    line.some((span) => !looksLikeTimelinePeriod(span.text))
  ))
  // A page can contain a single timeline entry (for example, the current
  // internship) alongside other detail rows. One row is enough when it has a
  // non-period label on the left; date-only sidebars still remain eligible for
  // an independent-column split because they do not satisfy that condition.
  if (!periodLines.length) return false

  const pairedPeriods = alignedLinePairCountForLines(periodLines, visualLineGroups(right))
  return pairedPeriods >= 1 && pairedPeriods / periodLines.length >= 0.75
}

function hasDateOnlyRowPairs(left, right) {
  const leftLines = visualLineGroups(left)
  const dateLines = leftLines.filter((line) => (
    line.length === 1 && looksLikeTimelinePeriod(line[0].text)
  ))
  // A date-only sidebar is still a valid independent column when the other
  // side contains ordinary one-cell rows. Require repeated, visibly split
  // cells on the aligned side before treating it as a timeline whose role and
  // organization were separated by a candidate gutter.
  if (dateLines.length < 2) return false
  const rightLines = visualLineGroups(right)
  const multiCellLines = rightLines.filter((line) => {
    if (line.length < 2) return false
    const gaps = line.slice(1).map((span, index) => (
      span.bbox.x - (line[index].bbox.x + line[index].bbox.width)
    )).filter((gap) => Number.isFinite(gap) && gap > 0)
    return gaps.length > 0 && Math.max(...gaps) >= 0.06
  })
  if (multiCellLines.length < 2) return false
  const pairedRows = alignedLinePairCountForLines(dateLines, multiCellLines)
  return pairedRows >= 2 && pairedRows / dateLines.length >= 0.75
}

function detectedColumnGroups(spans) {
  if (spans.length < 4) return [spans]
  // A repeated three-or-more-cell row is stronger evidence of a table or
  // timeline than a page-level column break. Keep those cells together so
  // labels, values, and dates remain associated by row.
  if (hasDenseRowAlignedCells(spans)) return [spans]
  const byStart = [...spans].sort((left, right) => left.bbox.x - right.bbox.x || left.source_order - right.source_order)
  const prefixMaxEnd = []
  let maximumEnd = Number.NEGATIVE_INFINITY
  for (const span of byStart) {
    maximumEnd = Math.max(maximumEnd, span.bbox.x + span.bbox.width)
    prefixMaxEnd.push(maximumEnd)
  }
  const suffixMinStart = Array(byStart.length)
  let minimumStart = Number.POSITIVE_INFINITY
  for (let index = byStart.length - 1; index >= 0; index -= 1) {
    minimumStart = Math.min(minimumStart, byStart[index].bbox.x)
    suffixMinStart[index] = minimumStart
  }
  const candidates = []
  for (let splitIndex = 1; splitIndex < byStart.length; splitIndex += 1) {
    const previous = byStart[splitIndex - 1]
    const next = byStart[splitIndex]
    const startGap = next.bbox.x - previous.bbox.x
    const gap = suffixMinStart[splitIndex] - prefixMaxEnd[splitIndex - 1]
    // A start-position gap identifies a potential band break; the occupied
    // interval gap confirms that the candidate is an actual gutter rather than
    // an indentation inside a long line.
    if (startGap >= 0.18 && gap >= 0.04) candidates.push({
      gap,
      startGap,
      splitIndex,
      boundary: prefixMaxEnd[splitIndex - 1] + gap / 2
    })
  }
  candidates.sort((left, right) => right.gap - left.gap || right.startGap - left.startGap)
  for (const { boundary } of candidates.slice(0, 8)) {
    const left = spans.filter((span) => span.bbox.x < boundary)
    const right = spans.filter((span) => span.bbox.x >= boundary)
    if (!left.length || !right.length) continue
    const crossingCount = left.filter((span) => span.bbox.x + span.bbox.width > boundary).length
    if (crossingCount > Math.max(2, Math.ceil(spans.length * 0.25))) continue
    const leftLines = visualLineGroups(left)
    const rightLines = visualLineGroups(right)
    if (leftLines.length < 2 || rightLines.length < 2) continue
    const overlapRatio = verticalRangeOverlapRatio(left, right)
    if (overlapRatio < 0.35) continue
    // Independent columns usually share several baselines. If their line
    // baselines are consistently offset instead, require a broader vertical
    // overlap and at least three lines on each side before reordering. This
    // keeps a short indented block in a single-column page in visual order.
    const alignedPairs = alignedLinePairCountForLines(leftLines, rightLines)
    if (alignedPairs < 2 && (Math.min(leftLines.length, rightLines.length) < 3 || overlapRatio < 0.55)) continue
    if (hasTimelineRowPairs(left, right) || hasDateOnlyRowPairs(left, right)) continue
    return [left, right]
  }
  return [spans]
}

function orderedSpanLines(spans) {
  return detectedColumnGroups(spans).flatMap((column) => visualLineGroups(column))
}

function joinSpanLine(spans) {
  let line = ''
  for (const span of spans) {
    const text = span.text.trim()
    if (!text) continue
    const separator = line && !/\s$/u.test(line) && !/^[,.;:!?%)\]}]/u.test(text) ? ' ' : ''
    line += `${separator}${text}`
  }
  return line
}

function orderedSpanText(spans, maximum) {
  let text = ''
  for (const lineSpans of orderedSpanLines(spans)) {
    const line = joinSpanLine(lineSpans)
    if (!line) continue
    const separator = text ? '\n' : ''
    const remaining = maximum - text.length
    if (remaining <= 0) break
    text += `${separator}${line}`.slice(0, remaining)
  }
  return text
}

function fallbackSpanLines(spans) {
  const lines = []
  let current = []
  for (const span of [...spans].sort((left, right) => left.source_order - right.source_order)) {
    current.push(span)
    if (span.has_eol) {
      lines.push(current)
      current = []
    }
  }
  if (current.length) lines.push(current)
  return lines
}

function orderedTextWithFallback(positioned, fallback, maximum) {
  const positionedLines = orderedSpanLines(positioned)
  if (!fallback.length) return orderedSpanText(positioned, maximum)
  if (!positionedLines.length) {
    let text = ''
    for (const lineSpans of fallbackSpanLines(fallback)) {
      const line = joinSpanLine(lineSpans)
      if (!line) continue
      const separator = text ? '\n' : ''
      const remaining = maximum - text.length
      if (remaining <= 0) break
      text += `${separator}${line}`.slice(0, remaining)
    }
    return text
  }

  const sourceLocations = new Map()
  for (const [lineIndex, line] of positionedLines.entries()) {
    for (const span of line) sourceLocations.set(span.source_order, lineIndex)
  }
  const validOrders = [...sourceLocations.keys()].sort((left, right) => left - right)
  const insertions = new Map()
  for (const line of fallbackSpanLines(fallback)) {
    const firstOrder = line[0].source_order
    let previousOrder = null
    let nextOrder = null
    for (const order of validOrders) {
      if (order < firstOrder) previousOrder = order
      else {
        nextOrder = order
        break
      }
    }
    const previousLine = previousOrder === null ? null : sourceLocations.get(previousOrder)
    const nextLine = nextOrder === null ? null : sourceLocations.get(nextOrder)
    const insertionIndex = previousLine === null
      ? (nextLine ?? positionedLines.length)
      : previousLine + 1
    if (!insertions.has(insertionIndex)) insertions.set(insertionIndex, [])
    insertions.get(insertionIndex).push(line)
  }

  const lines = []
  for (let index = 0; index <= positionedLines.length; index += 1) {
    lines.push(...(insertions.get(index) ?? []))
    if (index < positionedLines.length) lines.push(positionedLines[index])
  }
  let text = ''
  for (const lineSpans of lines) {
    const line = joinSpanLine(lineSpans)
    if (!line) continue
    const separator = text ? '\n' : ''
    const remaining = maximum - text.length
    if (remaining <= 0) break
    text += `${separator}${line}`.slice(0, remaining)
  }
  return text
}

function publicTextSpans(spans) {
  return orderedSpanLines(spans).flat().map(({ text, bbox }) => ({ text, bbox }))
}

function geometryPageText(content, viewport, maximum, maximumSpans) {
  if (maximum <= 0) return ''
  const spans = normalizedTextSpans(content, viewport, maximumSpans, maximum, maximum)
  if (!spans.positioned.length && !spans.fallback.length) return contentStreamText(content, maximum)
  return orderedTextWithFallback(spans.positioned, spans.fallback, maximum)
}

function visualTimeoutError() {
  return parserError('pdf_visual_render_timeout', 'PDF 页面视觉渲染超时', 504)
}

const TEST_VISUAL_STAGES = new Set(['getPage', 'getTextContent', 'loadCanvas', 'render', 'encodePng'])

function visualStageDelay(stage) {
  if (!process.env.NODE_TEST_CONTEXT || !TEST_VISUAL_STAGES.has(stage)) return 0
  const delay = Number(workerData.testVisualStageDelays?.[stage])
  return Number.isFinite(delay) && delay > 0 ? Math.min(Math.floor(delay), 10_000) : 0
}

async function runVisualStage(stage, operation, visual, renderStartedAt, pageStartedAt, onTimeout) {
  const timeoutMs = getRemainingVisualTimeoutMs(
    visual.pageTimeoutMs,
    visual.timeoutMs,
    renderStartedAt,
    Date.now(),
    pageStartedAt
  )
  if (timeoutMs <= 0) throw visualTimeoutError()

  let delayTimer
  let deadlineTimer
  const delayMs = visualStageDelay(stage)
  const operationPromise = (async () => {
    if (delayMs) {
      await new Promise((resolve) => {
        delayTimer = setTimeout(resolve, delayMs)
      })
    }
    return operation()
  })()
  try {
    return await Promise.race([
      operationPromise,
      new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => {
          if (delayTimer) clearTimeout(delayTimer)
          try { onTimeout?.() } catch {}
          reject(visualTimeoutError())
        }, timeoutMs)
      })
    ])
  } finally {
    if (delayTimer) clearTimeout(delayTimer)
    if (deadlineTimer) clearTimeout(deadlineTimer)
  }
}

function constrainedViewport(page, visual) {
  const base = page.getViewport({ scale: 1 })
  if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0) {
    throw parserError('pdf_visual_dimensions_invalid', 'PDF 页面尺寸无效，无法安全渲染')
  }
  const scale = Math.min(
    visual.scale,
    visual.maxWidth / base.width,
    visual.maxHeight / base.height,
    Math.sqrt(visual.maxPagePixels / (base.width * base.height))
  )
  if (!Number.isFinite(scale) || scale <= 0) {
    throw parserError('pdf_visual_dimensions_invalid', 'PDF 页面尺寸无效，无法安全渲染')
  }
  const viewport = page.getViewport({ scale })
  const width = Math.floor(viewport.width)
  const height = Math.floor(viewport.height)
  const pixelCount = width * height
  if (width < 1 || height < 1 || width > visual.maxWidth || height > visual.maxHeight || pixelCount > visual.maxPagePixels) {
    throw parserError('pdf_visual_pixel_limit', 'PDF 页面渲染超过安全像素限制', 413)
  }
  return { viewport, width, height, pixelCount }
}

async function renderPdfPage(page, pageNumber, content, visual, totals, renderStartedAt, pageStartedAt) {
  const { viewport, width, height, pixelCount } = constrainedViewport(page, visual)
  if (totals.pixels + pixelCount > visual.maxTotalPixels) {
    throw parserError('pdf_visual_total_pixel_limit', 'PDF 总渲染像素超过安全限制', 413)
  }
  const rasterBytes = pixelCount * 4
  if (totals.rasterBytes + rasterBytes > visual.maxTotalRasterBytes) {
    throw parserError('pdf_visual_total_memory_limit', 'PDF 总渲染内存超过安全限制', 413)
  }
  const createCanvas = await runVisualStage(
    'loadCanvas',
    loadCanvasFactory,
    visual,
    renderStartedAt,
    pageStartedAt
  )
  const canvas = createCanvas(width, height)
  let renderTask
  try {
    await runVisualStage(
      'render',
      () => {
        renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport, background: 'white' })
        return renderTask.promise
      },
      visual,
      renderStartedAt,
      pageStartedAt,
      () => renderTask?.cancel()
    )
    const png = Buffer.from(await runVisualStage(
      'encodePng',
      () => canvas.encode('png'),
      visual,
      renderStartedAt,
      pageStartedAt
    ))
    if (png.length > visual.maxPagePngBytes) {
      throw parserError('pdf_visual_png_limit', 'PDF 页面图像超过安全大小限制', 413)
    }
    if (totals.pngBytes + png.length > visual.maxTotalPngBytes) {
      throw parserError('pdf_visual_total_png_limit', 'PDF 总图像超过安全大小限制', 413)
    }
    totals.pixels += pixelCount
    totals.rasterBytes += rasterBytes
    totals.pngBytes += png.length
    const image = Uint8Array.from(png)
    const pageSpans = normalizedTextSpans(
      content,
      viewport,
      visual.maxTextSpans,
      visual.maxTextSpanCharacters,
      visual.maxPageTextCharacters
    )
    return {
      page_number: pageNumber,
      width,
      height,
      pixel_count: pixelCount,
      mime_type: 'image/png',
      image_buffer: image.buffer,
      text: cleanText(
        orderedTextWithFallback(pageSpans.positioned, pageSpans.fallback, visual.maxPageTextCharacters),
        visual.maxPageTextCharacters
      ).text,
      text_spans: publicTextSpans(pageSpans.positioned)
    }
  } finally {
    // Release the native surface promptly; this worker may render many pages.
    canvas.width = 0
    canvas.height = 0
  }
}

function cellValue(value) {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== 'object') return value
  if ('result' in value) return cellValue(value.result)
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text ?? '').join('')
  if ('text' in value) return value.text
  if ('hyperlink' in value) return value.text ?? null
  return null
}

function uniqueHeaders(values, maximumColumns) {
  if (values.length > maximumColumns) {
    throw parserError('spreadsheet_column_limit', `工作表最多支持 ${maximumColumns} 列`, 413)
  }
  const seen = new Map()
  return values.map((value, index) => {
    const base = String(cellValue(value) ?? '').trim() || `未命名列${index + 1}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}_${count + 1}`
  })
}

function rowsFromWorksheet(worksheet, limits) {
  if (!worksheet || worksheet.rowCount < 1) {
    throw parserError('spreadsheet_empty', '文件中没有可读取的工作表或表头')
  }
  if (worksheet.rowCount - 1 > limits.maxSpreadsheetRows) {
    throw parserError('spreadsheet_row_limit', `简历附件单个工作表最多支持 ${limits.maxSpreadsheetRows} 行`, 413)
  }
  const headerRow = worksheet.getRow(1)
  const headers = uniqueHeaders(
    Array.from({ length: headerRow.cellCount }, (_, index) => headerRow.getCell(index + 1).value),
    limits.maxSpreadsheetColumns
  )
  const rows = []
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return
    const values = {}
    let populated = false
    for (let index = 0; index < headers.length; index += 1) {
      const value = cellValue(row.getCell(index + 1).value)
      if (value != null && String(value).trim()) populated = true
      values[headers[index]] = value
    }
    if (populated) rows.push({ row_number: rowNumber, values })
  })
  if (rows.length === 0) throw parserError('spreadsheet_empty', '文件只有表头，没有候选人数据行')
  return { headers, rows, sheetName: worksheet.name }
}

function rowsFromLegacyXls(buffer, limits) {
  let sheet
  try {
    sheet = readFirstSheet(buffer)
  } catch (cause) {
    throw parserError(
      cause instanceof XlsError ? 'xls_encrypted_or_invalid' : 'xls_parse_failed',
      cause instanceof XlsError
        ? '无法读取该 .xls；仅支持未加密的 Excel 97-2003 BIFF8 工作簿'
        : '解析 .xls 时发生错误'
    )
  }
  if (!sheet || sheet.rows.length < 1) throw parserError('spreadsheet_empty', '文件中没有可读取的工作表或表头')
  if (sheet.rows.length - 1 > limits.maxSpreadsheetRows) {
    throw parserError('spreadsheet_row_limit', `简历附件最多支持 ${limits.maxSpreadsheetRows} 行`, 413)
  }
  const headers = uniqueHeaders(sheet.rows[0] ?? [], limits.maxSpreadsheetColumns)
  const rows = []
  for (let rowIndex = 1; rowIndex < sheet.rows.length; rowIndex += 1) {
    const source = sheet.rows[rowIndex] ?? []
    const values = {}
    let populated = false
    for (let index = 0; index < headers.length; index += 1) {
      const value = cellValue(source[index])
      if (value != null && String(value).trim()) populated = true
      values[headers[index]] = value
    }
    if (populated) rows.push({ row_number: rowIndex + 1, values })
  }
  if (rows.length === 0) throw parserError('spreadsheet_empty', '文件只有表头，没有候选人数据行')
  return { headers, rows, sheetName: sheet.name }
}

function spreadsheetText(parsed, maximum) {
  let output = ''
  let truncated = false
  for (const row of parsed.rows) {
    const line = parsed.headers
      .map((header) => `${header}: ${String(row.values[header] ?? '').trim()}`)
      .filter((entry) => !entry.endsWith(': '))
      .join(' | ')
    if (!line) continue
    if (output.length + line.length + 1 > maximum) {
      output += line.slice(0, Math.max(0, maximum - output.length))
      truncated = true
      break
    }
    output += `${line}\n`
  }
  return { text: output.trim(), truncated }
}

async function parseSpreadsheet(buffer, format, limits) {
  let parsed
  if (format === 'xls') {
    parsed = rowsFromLegacyXls(buffer, limits)
  } else {
    const workbook = new ExcelJS.Workbook()
    if (format === 'csv') {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      } catch {
        throw parserError('invalid_csv_encoding', 'CSV 必须使用有效的 UTF-8 编码')
      }
      const worksheet = await workbook.csv.read(Readable.from([buffer]))
      parsed = rowsFromWorksheet(worksheet, limits)
    } else {
      try {
        await workbook.xlsx.load(buffer)
      } catch {
        throw parserError('office_encrypted_or_invalid', '无法读取工作簿；请确认文件未加密、未损坏且格式正确')
      }
      if (workbook.worksheets.length > limits.maxWorksheets) {
        throw parserError('worksheet_limit', `工作簿最多支持 ${limits.maxWorksheets} 个工作表`, 413)
      }
      parsed = rowsFromWorksheet(workbook.worksheets[0], limits)
    }
  }
  const extracted = spreadsheetText(parsed, limits.maxExtractedText)
  return {
    text: extracted.text,
    text_truncated: extracted.truncated,
    records: parsed.rows,
    metadata: {
      sheet_name: parsed.sheetName,
      row_count: parsed.rows.length,
      column_count: parsed.headers.length,
      headers: parsed.headers
    }
  }
}

function clearVisualPageTransfers(pages) {
  for (const page of pages) {
    try {
      if (page?.image_buffer instanceof ArrayBuffer) new Uint8Array(page.image_buffer).fill(0)
    } catch {}
  }
  pages.length = 0
}

async function parsePdf(buffer, limits, { renderVisualPages = false, allowTextlessPdf = false } = {}) {
  let loadingTask
  let pdf
  try {
    loadingTask = getDocument({
      data: new Uint8Array(buffer),
      enableScripting: false,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      verbosity: 0
    })
    pdf = await loadingTask.promise
    if (pdf.numPages === 0) {
      throw parserError('pdf_empty', 'PDF 中没有可解析的页面')
    }
    if (pdf.numPages > limits.maxPdfPages) {
      throw parserError('pdf_page_limit', `PDF 最多支持 ${limits.maxPdfPages} 页`, 413)
    }
    let visual = renderVisualPages ? visualLimits(limits) : null
    let visualErrorCode = null
    if (visual && pdf.numPages > visual.maxPages) {
      visualErrorCode = 'pdf_visual_page_limit'
      visual = null
    }
    let combined = ''
    let truncated = false
    const visualPages = []
    const pageKinds = []
    const totals = { pixels: 0, rasterBytes: 0, pngBytes: 0 }
    const disableVisual = (cause) => {
      visualErrorCode = String(cause?.code ?? '').startsWith('pdf_visual_')
        ? cause.code
        : 'pdf_visual_render_failed'
      clearVisualPageTransfers(visualPages)
      visual = null
    }
    const renderStartedAt = Date.now()
    const visualPromise = visual
      ? (async () => {
          for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            const pageStartedAt = Date.now()
            const activeVisual = visual
            try {
              const page = await runVisualStage(
                'getPage',
                () => pdf.getPage(pageNumber),
                activeVisual,
                renderStartedAt,
                pageStartedAt
              )
              const content = await runVisualStage(
                'getTextContent',
                () => page.getTextContent({ includeMarkedContent: false, disableNormalization: false }),
                activeVisual,
                renderStartedAt,
                pageStartedAt
              )
              visualPages.push(await renderPdfPage(
                page,
                pageNumber,
                content,
                activeVisual,
                totals,
                renderStartedAt,
                pageStartedAt
              ))
            } catch (cause) {
              disableVisual(cause)
              break
            }
          }
        })()
      : Promise.resolve()
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false })
      const usableItems = content.items.filter((item) => item && typeof item.str === 'string' && item.str.trim())
      const hasUsableText = usableItems.length > 0
      // Page routing is based on whether a text layer exists. The higher
      // document-level threshold below remains the legacy text-only guard.
      pageKinds.push(hasUsableText ? 'text' : 'scanned')
      const separator = combined && hasUsableText ? '\n' : ''
      const remaining = Math.max(0, limits.maxExtractedText - combined.length)
      if (hasUsableText && remaining <= separator.length) {
        truncated = true
        continue
      }
      const availableTextCharacters = Math.max(0, remaining - separator.length)
      const extractionViewport = page.getViewport({ scale: 1 })
      const extractedPageText = geometryPageText(
        content,
        extractionViewport,
        availableTextCharacters,
        Math.floor(boundedVisualNumber(
          limits.maxVisualTextSpans,
          ATTACHMENT_VISUAL_HARD_LIMITS.maxVisualTextSpans,
          1,
          ATTACHMENT_VISUAL_HARD_LIMITS.maxVisualTextSpans
        ))
      )
      if (extractedPageText) combined += `${separator}${extractedPageText}`
      const sourceTextCharacters = usableItems.reduce(
        (sum, item) => Math.min(availableTextCharacters + 1, sum + item.str.length),
        0
      )
      if (sourceTextCharacters > availableTextCharacters) truncated = true
    }
    await visualPromise
    const cleaned = cleanText(combined, limits.maxExtractedText)
    const pdfContentType = pageKinds.every((kind) => kind === 'text')
      ? 'text'
      : pageKinds.every((kind) => kind === 'scanned') ? 'scanned' : 'mixed'
    if (cleaned.text.replace(/\s/g, '').length < 20 && !renderVisualPages && !allowTextlessPdf) {
      throw parserError('pdf_no_text', 'PDF 中没有可提取文本；扫描件和需要 OCR 的文件暂不支持')
    }
    const parsed = {
      text: cleaned.text,
      text_truncated: truncated || cleaned.truncated,
      records: [{ row_number: 1, values: { raw_text: cleaned.text } }],
      metadata: {
        page_count: pdf.numPages,
        pdf_content_type: pdfContentType,
        visual: renderVisualPages
          ? visualErrorCode
            ? { status: 'fallback', error_code: visualErrorCode, rendered_page_count: 0 }
            : { status: 'ready', rendered_page_count: visualPages.length }
          : { status: 'not_requested', rendered_page_count: 0 }
      }
    }
    if (visual) parsed.visual_page_transfers = visualPages
    return parsed
  } catch (cause) {
    if (cause instanceof PasswordException || cause?.name === 'PasswordException') {
      throw parserError('encrypted_pdf_unsupported', '不支持加密或带密码的 PDF')
    }
    if (cause?.code && cause?.status) throw cause
    throw parserError('pdf_parse_failed', 'PDF 已损坏或无法安全提取文本')
  } finally {
    try { await pdf?.destroy() } catch {}
    try { await loadingTask?.destroy() } catch {}
  }
}

async function parseDocx(buffer, limits) {
  let result
  try {
    result = await mammoth.extractRawText({ buffer }, { externalFileAccess: false })
  } catch {
    throw parserError('docx_parse_failed', 'DOCX 已损坏、加密或无法安全提取文本')
  }
  const cleaned = cleanText(result?.value, limits.maxExtractedText)
  if (cleaned.text.replace(/\s/g, '').length < 20) {
    throw parserError('docx_no_text', 'DOCX 中没有可提取的简历文本')
  }
  return {
    text: cleaned.text,
    text_truncated: cleaned.truncated,
    records: [{ row_number: 1, values: { raw_text: cleaned.text } }],
    metadata: { parser_messages: Array.isArray(result?.messages) ? result.messages.length : 0 }
  }
}

function parsePlainText(buffer, limits) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw parserError('invalid_text_encoding', 'TXT 必须使用有效的 UTF-8 编码')
  }
  const cleaned = cleanText(text, limits.maxExtractedText)
  if (!cleaned.text) throw parserError('attachment_empty', 'TXT 中没有可提取的简历文本')
  return {
    text: cleaned.text,
    text_truncated: cleaned.truncated,
    records: [{ row_number: 1, values: { raw_text: cleaned.text } }],
    metadata: {}
  }
}

async function main() {
  const buffer = Buffer.from(workerData.buffer)
  const { format, limits } = workerData
  if (['docx', 'xlsx', 'xlsm'].includes(format)) verifyZipPayload(buffer, limits)
  let parsed
  if (format === 'pdf') {
    parsed = await parsePdf(buffer, limits, {
      renderVisualPages: workerData.renderVisualPages === true,
      allowTextlessPdf: workerData.allowTextlessPdf === true
    })
  }
  else if (format === 'docx') parsed = await parseDocx(buffer, limits)
  else if (format === 'txt') parsed = parsePlainText(buffer, limits)
  else if (['xlsx', 'xlsm', 'xls', 'csv'].includes(format)) parsed = await parseSpreadsheet(buffer, format, limits)
  else throw parserError('unsupported_attachment_type', '不支持该附件格式', 415)

  try {
    const avatarResults = await extractAttachmentAvatarResults(buffer, format, parsed)
    parsed.avatar_transfers = avatarResults.map(serializeAttachmentAvatarResult)
  } catch {
    // Avatar extraction is optional and must not hide otherwise valid resume text.
    parsed.avatar_transfers = []
  }
  return parsed
}

try {
  const result = await main()
  const transferList = Array.isArray(result.visual_page_transfers)
    ? result.visual_page_transfers.map((page) => page.image_buffer).filter((buffer) => buffer instanceof ArrayBuffer)
    : []
  parentPort.postMessage({ ok: true, result }, transferList)
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      status: Number.isInteger(error?.status) ? error.status : 422,
      code: error?.code ?? 'attachment_parse_failed',
      message: error?.message ?? '附件解析失败',
      details: error?.details
    }
  })
}
