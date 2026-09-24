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
  if (mimeType === 'text/html') { text = htmlToText(buffer.toString('utf8')); method = 'html_strip' }
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
