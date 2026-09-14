import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import { createVectorStore, chunkResumeDocument, VECTOR_CHUNK_VERSION } from './search-vector-store.js'
import { readSearchDocuments } from './search-vector-source.js'
import { readSearchIdentities, redactSearchText, SEARCH_TEXT_POLICY_VERSION } from './search-data-minimization.js'
import { openEmbeddingCache } from './search-embedding-cache.js'

function checkSignal(signal) {
  if (signal?.aborted) { const error = new Error('Vector index build cancelled'); error.code = 'search_cancelled'; throw error }
}

export async function buildVectorIndex({ databasePath, directory, embedTexts, dimensions = 1024, model = 'text-embedding-v4', signal, limit = 200, concurrency = 4, retries = 3, onProgress }) {
  if (typeof embedTexts !== 'function' || !databasePath || !directory) throw new Error('Explicit database, directory and embedTexts are required')
  if (!Number.isInteger(limit) || limit < 1 || limit > 400) throw new Error('Source page must be between 1 and 400')
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8 || !Number.isInteger(retries) || retries < 0 || retries > 5) throw new Error('Invalid bounded maintenance configuration')
  checkSignal(signal)
  const source = new DatabaseSync(databasePath, { readOnly: true })
  source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2000')
  const sourceVersion = () => Number(source.prepare('PRAGMA data_version').get().data_version)
  const initialVersion = sourceVersion(); const runId = randomUUID(); const started = Date.now()
  let store; let cache; let after = ''
  const counters = { documents: 0, updated_documents: 0, embedded_chunks: 0, cached_chunks: 0, outbound_characters: 0, embedding_batches: 0, retries: 0, excluded_private_only_chunks: 0, removed_documents: 0 }
  const progress = () => onProgress?.({ ...counters, elapsed_ms: Date.now() - started, stage: 'building', peak_rss_bytes: process.memoryUsage().rss })
  async function embedMissing(missing, vectors) {
    let offset = 0; let failure
    const worker = async () => {
      while (offset < missing.length && !failure) {
        const start = offset; offset += 10; const batch = missing.slice(start, start + 10)
        try {
          checkSignal(signal); let response
          for (let attempt = 0;; attempt++) {
            try { response = await embedTexts(batch.map(([, text]) => text), { dimensions, signal }); break }
            catch (error) { checkSignal(signal); if (attempt >= retries) throw error; counters.retries++; await delay(Math.min(4000, 250 * 2 ** attempt), undefined, { signal }) }
          }
          checkSignal(signal)
          if (!Array.isArray(response) || response.length !== batch.length) throw new Error('Embedding response length mismatch')
          cache.write(batch.map(([key], n) => [key, response[n]]))
          response.forEach((vector, n) => vectors.set(batch[n][0], vector))
          counters.embedded_chunks += batch.length; counters.embedding_batches++; counters.outbound_characters += batch.reduce((sum, [, text]) => sum + text.length, 0)
          progress()
        } catch (error) { failure ??= error }
      }
    }
    const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, Math.ceil(missing.length / 10)) }, worker))
    for (const item of settled) if (item.status === 'rejected') failure ??= item.reason
    if (failure) throw failure
  }
  try {
    store = createVectorStore({ directory, dimensions, model, autoCommit: false })
    cache = openEmbeddingCache(directory, { space: `${model}:${dimensions}:${VECTOR_CHUNK_VERSION}:${SEARCH_TEXT_POLICY_VERSION}`, dimensions })
    // Every bounded SELECT ends before network I/O. Live source checks protect
    // queries while a subsequent pass catches concurrent local edits.
    for (;;) {
      checkSignal(signal)
      const page = readSearchDocuments(source, { after, limit }); if (!page.length) break
      const previous = store.getDocumentHashes(page.map(row => row.document_id))
      const changed = page.filter(row => previous.get(row.document_id) !== row.source_hash)
      const identities = readSearchIdentities(source, [...new Set(changed.map(row => row.candidate_id))])
      const chunks = []
      for (const document of changed) {
        // Mask the entire document before slicing; preserve offsets even when
        // a contact crosses a boundary. Only outbound text is transformed.
        const masked = redactSearchText(document.content, { identities: identities.get(document.candidate_id), preserveLength: true })
        for (const chunk of chunkResumeDocument(document)) {
          const outbound = masked.slice(chunk.start, chunk.end).replace(/[\t ]+/g, ' ').trim()
          if (!outbound) { counters.excluded_private_only_chunks++; continue }
          chunks.push({ chunk, outbound, key: cache.key(outbound) })
        }
      }
      const unique = [...new Map(chunks.map(item => [item.key, item.outbound])).entries()]
      const vectors = cache.read(unique.map(([key]) => key))
      counters.cached_chunks += unique.filter(([key]) => vectors.has(key)).length
      await embedMissing(unique.filter(([key]) => !vectors.has(key)), vectors)
      checkSignal(signal)
      store.removeDocuments(changed.map(row => row.document_id))
      for (let n = 0; n < chunks.length; n += 500) {
        const batch = chunks.slice(n, n + 500)
        store.upsertChunks(batch.map(item => item.chunk), batch.map(item => vectors.get(item.key)))
      }
      store.recordDocuments(changed.map(row => ({ document_id: row.document_id, source_hash: row.source_hash })))
      cache.recordDocuments(changed, chunks)
      cache.markSeen(page.map(row => row.document_id), runId)
      counters.documents += page.length; counters.updated_documents += changed.length; after = page.at(-1).document_id
      progress(); await setImmediate()
    }
    let previous = ''
    for (;;) {
      checkSignal(signal)
      const page = store.listDocuments({ after: previous, limit: 400 }); if (!page.length) break
      const seen = cache.seen(page.map(row => row.document_id), runId)
      const removed = page.filter(row => !seen.has(row.document_id)).map(row => row.document_id)
      store.removeDocuments(removed); counters.removed_documents += removed.length; previous = page.at(-1).document_id
    }
    checkSignal(signal)
    const sourceChanged = sourceVersion() !== initialVersion
    onProgress?.({ ...counters, stage: 'publishing', elapsed_ms: Date.now() - started, peak_rss_bytes: process.memoryUsage().rss })
    const status = store.commit(); cache.finish(runId)
    return { ...counters, chunks: status.chunks, status, source_changed_during_build: sourceChanged, source_read_only: true, text_policy: SEARCH_TEXT_POLICY_VERSION, elapsed_ms: Date.now() - started }
  } finally { try { store?.close() } finally { try { cache?.close() } finally { source.close() } } }
}
