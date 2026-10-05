#!/usr/bin/env node
// 单文件正文提取器：给主解析脚本用，跑在独立进程里。
//
//   node scripts/extract-origin-text.mjs <storagePath> <mimeType>
//
// 为什么单独起进程：PDF 解析是在原生扩展 + worker 里跑的，畸形 PDF 可能让
// 进程直接崩溃（0xC0000005），JS 的 try/catch 拦不住。逐份隔离后，坏文档只会
// 让这一个子进程退出，主循环把该候选人标记为 text_failed 并继续。
//
// 输出：stdout 一行 JSON { ok, text } / { ok: false, error }。
import { readFileSync } from 'node:fs'
import { parseAttachment, validateAttachmentFile } from '../server/attachment-parser.js'

// 简历 HTML 里有相当一部分是 GBK/GB18030 编码（老门户模板），
// 统一按 UTF-8 解会产出乱码字段（实测出现「������ţ�」这类标签）。
// 这里先读 <meta charset>，再决定用哪种解码器。
function decodeHtmlBuffer(buffer) {
  const head = buffer.subarray(0, 8192).toString('latin1')
  const declared = head.match(/charset\s*=\s*["']?\s*([a-z0-9_-]+)/i)?.[1]?.toLowerCase() ?? ''
  const charset = declared === 'gb2312' ? 'gbk' : declared
  if (['gbk', 'gb18030', 'big5'].includes(charset)) {
    try {
      return new TextDecoder(charset).decode(buffer)
    } catch {
      // 运行时不支持该编码时回退到 UTF-8
    }
  }
  return buffer.toString('utf8')
}

function htmlToText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(td|th|div|p|li|tr|h[1-6]|table)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((line) => line.trim()).filter(Boolean).join('\n')
    .trim()
}

const [, , storagePath, mimeType] = process.argv
try {
  const buffer = readFileSync(storagePath)
  let text = ''
  let method = ''
  if (mimeType === 'text/html') { text = htmlToText(decodeHtmlBuffer(buffer)); method = 'html_strip' }
  else if (mimeType === 'text/plain') { text = buffer.toString('utf8'); method = 'plain' }
  else {
    const file = { buffer, originalname: storagePath.split(/[\\/]/).pop(), mimetype: mimeType }
    const parsed = await parseAttachment(file, validateAttachmentFile(file))
    text = parsed?.records?.map((record) => record?.values?.raw_text ?? '').filter(Boolean).join('\n') ?? ''
    method = `attachment_parser:${parsed?.format ?? 'pdf'}`
  }
  process.stdout.write(JSON.stringify({ ok: true, text, method }))
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error?.code ?? error?.message ?? error).slice(0, 200) }))
}
