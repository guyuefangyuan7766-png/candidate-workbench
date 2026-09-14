import { parentPort, workerData } from 'node:worker_threads'
import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync, constants as sqlite } from 'node:sqlite'
import {
  isInternalSearchSchemaObject,
  isInternalSearchTool,
  isReadonlyBusinessColumn,
  isReadonlyBusinessTable,
  isRestrictedResultColumn
} from './business-search.js'

const SAFE_FUNCTIONS = new Set([
  'abs', 'avg', 'bm25', 'ceil', 'ceiling', 'char', 'coalesce', 'concat', 'concat_ws',
  'count', 'date', 'datetime', 'dense_rank', 'exp', 'first_value', 'floor', 'format',
  'glob', 'group_concat', 'hex', 'highlight', 'if', 'ifnull', 'iif', 'instr', 'json',
  'json_array', 'json_array_length', 'json_error_position', 'json_extract', 'json_group_array',
  'json_group_object', 'json_insert', 'json_object', 'json_patch', 'json_pretty', 'json_quote',
  'json_each', 'json_tree',
  'json_remove', 'json_replace', 'json_set', 'json_type', 'json_valid', 'julianday', 'lag',
  'last_value', 'lead', 'length', 'like', 'likelihood', 'likely', 'ln', 'log', 'log10',
  'log2', 'lower', 'ltrim', 'match', 'max', 'min', 'mod', 'nth_value', 'ntile', 'nullif',
  'percent_rank', 'pi', 'pow', 'power', 'printf', 'quote', 'rank', 'replace', 'round',
  'row_number', 'rtrim', 'sign', 'snippet', 'soundex', 'sqrt', 'strftime', 'string_agg',
  'substr', 'substring', 'sum', 'tan', 'time', 'timediff', 'total', 'trim', 'trunc',
  'typeof', 'unicode', 'unixepoch', 'unlikely', 'upper'
])
const INTERNAL_SCHEMA_ROW_COLUMNS = new Set(['rowid', '_rowid_', 'oid'])

// SQLite's authorizer reports reads from MATERIALIZED CTEs and derived
// subqueries as if they were table reads. They are safe to expose only when
// the statement itself declares the virtual name; the underlying physical
// tables still go through the normal catalog policy below.
function declaredVirtualNames(sql) {
  const masked = String(sql).replace(/'(?:''|[^'])*'|--[^\r\n]*|\/\*[\s\S]*?\*\//g, (value) => ' '.repeat(value.length))
  const names = new Set()
  const pattern = /\b([A-Za-z_][A-Za-z0-9_$]*)\s*(?:\([^)]*\))?\s+AS\s+(?:(?:NOT\s+)?MATERIALIZED\s+)?\(/gi
  for (const match of masked.matchAll(pattern)) names.add(String(match[1]).toLowerCase())
  return names
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function makeError(code, message, details = undefined) {
  const error = new Error(message)
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

function openReadonlyDatabase(databasePath) {
  if (databasePath === ':memory:') {
    throw makeError('unsupported_database_path', 'The read-only query service requires a file-backed SQLite database.')
  }
  const db = new DatabaseSync(databasePath, {
    readOnly: true,
    allowExtension: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false
  })
  db.enableLoadExtension(false)
  db.enableDefensive(true)
  db.exec(`
    PRAGMA busy_timeout=1000;
    PRAGMA trusted_schema=OFF;
    PRAGMA temp_store=MEMORY;
    PRAGMA mmap_size=0;
    PRAGMA hard_heap_limit=67108864;
    PRAGMA query_only=ON;
  `)
  return db
}

function isInternalCompatibilityColumn(tool, tableName, columnName) {
  const table = String(tableName ?? '').toLowerCase()
  const column = String(columnName ?? '').toLowerCase()
  if (table === 'candidate_attachments' && isRestrictedResultColumn(tool, column)) return true
  return tool === 'get_candidate_full_vectors' && table === 'candidate_resume_vectors' && column === 'vector'
}

function isCatalogTableAllowed(tableName, internal) {
  if (isReadonlyBusinessTable(tableName) && !isInternalSearchSchemaObject(tableName)) return true
  return internal && isInternalSearchSchemaObject(tableName)
}

function isCatalogColumnAllowed(tableName, column, internal, tool) {
  if (internal && isInternalSearchSchemaObject(tableName)) return true
  if (Number(column.hidden) !== 0) return false
  if (isReadonlyBusinessColumn(tableName, column.name, column.type)) return true
  return internal && isInternalCompatibilityColumn(tool, tableName, column.name)
}

function buildSchemaCatalog(db, { internal = false, tool = '' } = {}) {
  const schemaRows = db.prepare(`
    SELECT name, type, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
    ORDER BY type, name COLLATE NOCASE
  `).all().filter((schemaRow) => isCatalogTableAllowed(schemaRow.name, internal))

  const columnsByTable = new Map(schemaRows.map((schemaRow) => {
    const columns = db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(schemaRow.name)})`).all()
      .filter((column) => isCatalogColumnAllowed(schemaRow.name, column, internal, tool))
      .map((column) => ({
        name: column.name,
        type: column.type || null,
        not_null: Boolean(column.notnull),
        default_value: column.dflt_value ?? null,
        primary_key_position: Number(column.pk) || 0,
        hidden: Number(column.hidden) || 0
      }))
    return [schemaRow.name.toLowerCase(), columns]
  }))

  const allowedColumns = new Map([...columnsByTable].map(([table, columns]) => [
    table,
    new Set(columns.map((column) => column.name.toLowerCase()))
  ]))

  const tables = schemaRows.map((schemaRow) => {
    const quoted = quoteIdentifier(schemaRow.name)
    const columns = columnsByTable.get(schemaRow.name.toLowerCase()) || []
    const sourceColumns = allowedColumns.get(schemaRow.name.toLowerCase()) || new Set()
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoted})`).all()
      .filter((foreignKey) => {
        const targetColumns = allowedColumns.get(String(foreignKey.table).toLowerCase())
        return Boolean(
          targetColumns &&
          sourceColumns.has(String(foreignKey.from).toLowerCase()) &&
          targetColumns.has(String(foreignKey.to).toLowerCase())
        )
      })
      .map((foreignKey) => ({
        id: Number(foreignKey.id),
        sequence: Number(foreignKey.seq),
        table: foreignKey.table,
        from: foreignKey.from,
        to: foreignKey.to,
        on_update: foreignKey.on_update,
        on_delete: foreignKey.on_delete
      }))
    return {
      name: schemaRow.name,
      type: schemaRow.type,
      virtual: /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(schemaRow.sql || ''),
      columns,
      foreign_keys: foreignKeys
    }
  })

  return {
    database: 'main',
    tables
  }
}

function catalogLookup(catalog) {
  const lookup = new Map()
  for (const table of catalog.tables) {
    lookup.set(table.name.toLowerCase(), {
      name: table.name,
      columns: new Map(table.columns.map((column) => [column.name.toLowerCase(), column]))
    })
  }
  return lookup
}

function installAuthorizer(db, catalog, scope, { internal = false, tool = '', virtualNames = new Set() } = {}) {
  const lookup = catalogLookup(catalog)
  db.setAuthorizer((action, argument1, argument2) => {
    if (action === sqlite.SQLITE_SELECT || action === sqlite.SQLITE_RECURSIVE) return sqlite.SQLITE_OK

    if (action === sqlite.SQLITE_READ) {
      const tableName = typeof argument1 === 'string' ? argument1.toLowerCase() : ''
      const columnName = typeof argument2 === 'string' ? argument2.toLowerCase() : ''
      const table = lookup.get(tableName)
      const column = table?.columns.get(columnName)
      if (!table && virtualNames.has(tableName)) {
        scope.tables.add(tableName)
        if (columnName) scope.columns.add(`${tableName}.${columnName}`)
        return sqlite.SQLITE_OK
      }
      const allowed = Boolean(
        table &&
        isCatalogTableAllowed(table.name, internal) &&
        (
          // SQLite reports an empty column for COUNT(*) and equivalent existence reads.
          columnName === '' ||
          (
            internal &&
            isInternalSearchSchemaObject(table.name) &&
            INTERNAL_SCHEMA_ROW_COLUMNS.has(columnName)
          ) ||
          (column && isCatalogColumnAllowed(table.name, column, internal, tool))
        )
      )
      if (!allowed) {
        scope.denied = { operation: 'read', table: argument1 ?? null, column: argument2 ?? null }
        return sqlite.SQLITE_DENY
      }
      scope.tables.add(table.name)
      if (column) scope.columns.add(`${table.name}.${column.name}`)
      return sqlite.SQLITE_OK
    }

    if (action === sqlite.SQLITE_FUNCTION) {
      const functionName = typeof argument2 === 'string' ? argument2.toLowerCase() : ''
      if (SAFE_FUNCTIONS.has(functionName)) {
        scope.functions.add(functionName)
        return sqlite.SQLITE_OK
      }
      scope.denied = { operation: 'function', function: argument2 ?? null }
      return sqlite.SQLITE_DENY
    }

    // FTS5 issues this read-only PRAGMA internally while evaluating MATCH.
    // User-supplied PRAGMA statements are still rejected by the statement lexer.
    if (action === sqlite.SQLITE_PRAGMA && String(argument1).toLowerCase() === 'data_version' && argument2 === null) {
      return sqlite.SQLITE_OK
    }

    scope.denied = { operation: 'sqlite_opcode', opcode: action }
    return sqlite.SQLITE_DENY
  })
}

function normalizeValue(value) {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString(10)
  }
  if (value instanceof Uint8Array) return `base64:${Buffer.from(value).toString('base64')}`
  return value
}

function bindParameters(statement, parameters) {
  statement.setAllowBareNamedParameters(false)
  statement.setAllowUnknownNamedParameters(false)
  statement.setReadBigInts(true)
  if (Array.isArray(parameters)) return parameters
  if (parameters && typeof parameters === 'object' && Object.getPrototypeOf(parameters) === Object.prototype) {
    return parameters
  }
  throw makeError('invalid_parameters', 'Query parameters must be an array or a plain object.')
}

function iterateRows(statement, parameters) {
  return Array.isArray(parameters) ? statement.iterate(...parameters) : statement.iterate(parameters)
}

function isRestrictedOutputColumn(tool, column) {
  const sourceTable = String(column.table ?? '').toLowerCase()
  const sourceColumn = String(column.column ?? column.name ?? '').toLowerCase()
  if (
    sourceTable === 'candidate_attachments' &&
    isRestrictedResultColumn(tool, sourceColumn)
  ) return true
  if (
    tool === 'get_candidate_full_vectors' &&
    sourceTable === 'candidate_resume_vectors' &&
    sourceColumn === 'vector'
  ) return true
  return isRestrictedResultColumn(tool, column.name)
}

function resultColumns(statement, tool) {
  const counts = new Map()
  const used = new Set()
  const result = []
  for (const [index, column] of statement.columns().entries()) {
    if (isRestrictedOutputColumn(tool, column)) continue
    const base = column.name || `column_${index + 1}`
    const key = base.toLowerCase()
    let count = (counts.get(key) || 0) + 1
    let candidate = count === 1 ? base : `${base}_${count}`
    while (used.has(candidate.toLowerCase())) {
      count += 1
      candidate = `${base}_${count}`
    }
    counts.set(key, count)
    used.add(candidate.toLowerCase())
    result.push({ index, name: candidate })
  }
  return result
}

function auditRecord(tool, scope, startedAt, returnedRows, errorCode = null) {
  return {
    tool,
    scope: {
      tables: [...scope.tables].sort(),
      columns: [...scope.columns].sort(),
      functions: [...scope.functions].sort()
    },
    execution_ms: Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000),
    returned_rows: returnedRows,
    error: errorCode
  }
}

function prepareAuthorizedStatement(db, catalog, sql, scope, policyContext) {
  installAuthorizer(db, catalog, scope, {
    ...policyContext,
    virtualNames: declaredVirtualNames(sql)
  })
  try {
    return db.prepare(sql)
  } catch (error) {
    if (scope.denied) {
      throw makeError('query_not_authorized', 'The query contains an operation, table, column, or function that is not allowed.', scope.denied)
    }
    if (error?.code === 'ERR_SQLITE_ERROR' && /no such function/i.test(error.message || '')) {
      throw makeError('query_not_authorized', 'The query references a function that is not in the server allowlist.', {
        operation: 'function',
        function: null
      })
    }
    throw error
  }
}

function executeQuery(db, catalog, request) {
  const startedAt = performance.now()
  let peakRssBytes = process.memoryUsage().rss
  const sampleRss = () => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss)
  }
  const scope = { tables: new Set(), columns: new Set(), functions: new Set(), denied: null }
  let returnedRows = 0
  try {
    const tool = request.tool || 'execute_readonly_query'
    const policyContext = { internal: isInternalSearchTool(tool), tool }
    const statement = prepareAuthorizedStatement(db, catalog, request.sql, scope, policyContext)
    const parameters = bindParameters(statement, request.parameters)
    const selections = resultColumns(statement, tool)
    const columns = selections.map((selection) => selection.name)
    statement.setReturnArrays(true)
    const rows = []
    let responseBytes = Buffer.byteLength(JSON.stringify({ columns, rows: [] }), 'utf8')
    let hasMore = false
    let limitedBy = null
    let scannedRows = 0

    for (const rawRow of iterateRows(statement, parameters)) {
      scannedRows += 1
      if ((scannedRows & 0x3ff) === 0) sampleRss()
      if (rows.length >= request.maxRows) {
        hasMore = true
        limitedBy = 'rows'
        break
      }
      const row = {}
      for (const selection of selections) {
        Object.defineProperty(row, selection.name, {
          value: normalizeValue(rawRow[selection.index]),
          enumerable: true,
          configurable: true,
          writable: true
        })
      }
      const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1
      if (responseBytes + rowBytes > request.maxBytes) {
        hasMore = true
        limitedBy = 'bytes'
        break
      }
      responseBytes += rowBytes
      rows.push(row)
    }
    returnedRows = rows.length
    sampleRss()
    return {
      columns,
      rows,
      row_count: rows.length,
      has_more: hasMore,
      limited_by: limitedBy,
      limits: { max_rows: request.maxRows, max_bytes: request.maxBytes },
      worker_peak_rss_bytes: peakRssBytes,
      audit: auditRecord(request.tool || 'execute_readonly_query', scope, startedAt, returnedRows)
    }
  } catch (error) {
    if (scope.denied) {
      const denied = makeError('query_not_authorized', 'The query contains an operation, table, column, or function that is not allowed.', scope.denied)
      denied.audit = auditRecord(request.tool || 'execute_readonly_query', scope, startedAt, returnedRows, denied.code)
      throw denied
    }
    error.audit = auditRecord(request.tool || 'execute_readonly_query', scope, startedAt, returnedRows, error.code || 'query_failed')
    throw error
  }
}

function csvCell(value) {
  if (value === null || value === undefined) return ''
  let text = String(normalizeValue(value))
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function writeAll(descriptor, text) {
  const buffer = Buffer.from(text, 'utf8')
  let offset = 0
  while (offset < buffer.length) {
    offset += writeSync(descriptor, buffer, offset, buffer.length - offset)
  }
  return buffer.length
}

function exportQuery(db, catalog, request) {
  const startedAt = performance.now()
  const scope = { tables: new Set(), columns: new Set(), functions: new Set(), denied: null }
  let returnedRows = 0
  let descriptor
  try {
    const tool = request.tool || 'export_query_results'
    const policyContext = { internal: isInternalSearchTool(tool), tool }
    const statement = prepareAuthorizedStatement(db, catalog, request.sql, scope, policyContext)
    const parameters = bindParameters(statement, request.parameters)
    const selections = resultColumns(statement, tool)
    const columns = selections.map((selection) => selection.name)
    statement.setReturnArrays(true)
    mkdirSync(dirname(request.outputPath), { recursive: true })
    descriptor = openSync(request.outputPath, 'wx', 0o600)
    let bytes = writeAll(descriptor, `\uFEFF${columns.map(csvCell).join(',')}\r\n`)
    if (bytes > request.maxBytes) throw makeError('export_too_large', 'The CSV header exceeds the export byte limit.')

    for (const rawRow of iterateRows(statement, parameters)) {
      if (returnedRows >= request.maxRows) {
        throw makeError('export_row_limit_exceeded', `The export exceeds the ${request.maxRows} row limit. Refine the query or export in pages.`)
      }
      const line = `${selections.map((selection) => csvCell(rawRow[selection.index])).join(',')}\r\n`
      const lineBytes = Buffer.byteLength(line, 'utf8')
      if (bytes + lineBytes > request.maxBytes) {
        throw makeError('export_byte_limit_exceeded', `The export exceeds the ${request.maxBytes} byte limit. Refine the query or export in pages.`)
      }
      bytes += writeAll(descriptor, line)
      returnedRows += 1
    }
    closeSync(descriptor)
    descriptor = undefined
    return {
      path: request.outputPath,
      filename: request.filename,
      mime_type: 'text/csv; charset=utf-8',
      row_count: returnedRows,
      bytes,
      audit: auditRecord(request.tool || 'export_query_results', scope, startedAt, returnedRows)
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch {}
    }
    try { unlinkSync(request.outputPath) } catch {}
    error.audit = auditRecord(request.tool || 'export_query_results', scope, startedAt, returnedRows, error.code || 'export_failed')
    throw error
  }
}

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || 'Read-only query failed.',
    code: error?.code || 'readonly_query_failed',
    details: error?.details,
    audit: error?.audit
  }
}

function sendMessage(message) {
  if (parentPort) parentPort.postMessage(message)
  else if (process.send) process.send(message)
}

function receiveWork() {
  if (parentPort) return Promise.resolve(workerData)
  return new Promise((resolvePromise) => process.once('message', resolvePromise))
}

async function main() {
  const work = await receiveWork()
  let db
  try {
    db = openReadonlyDatabase(work.databasePath)
    const tool = work.request?.tool || ''
    const catalog = buildSchemaCatalog(db, {
      internal: work.action !== 'catalog' && isInternalSearchTool(tool),
      tool
    })
    let result
    if (work.action === 'catalog') {
      result = catalog
    } else if (work.action === 'query') {
      result = executeQuery(db, catalog, work.request)
    } else if (work.action === 'export') {
      result = exportQuery(db, catalog, work.request)
    } else {
      throw makeError('invalid_worker_action', 'Unknown read-only query worker action.')
    }
    sendMessage({ ok: true, result })
  } catch (error) {
    sendMessage({ ok: false, error: serializeError(error) })
  } finally {
    try { db?.close() } catch {}
    if (!parentPort && process.connected) process.disconnect()
  }
}

await main()
