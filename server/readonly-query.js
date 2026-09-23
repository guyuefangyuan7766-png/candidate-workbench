import { mkdirSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const READONLY_QUERY_LIMITS = Object.freeze({
  maxSqlLength: 50_000,
  maxRows: 100,
  maxResponseBytes: 1_000_000,
  maxPage: 1_000,
  maxPageSize: 100,
  maxFilters: 50,
  maxInValues: 100,
  maxSortFields: 8,
  maxParameters: 1_000,
  maxParameterBytes: 1_000_000,
  timeoutMs: 3_000,
  maxTimeoutMs: 60_000,
  maxExportRows: 50_000,
  maxExportBytes: 25_000_000
})

const WORKER_TERMINATION_GRACE_MS = 1_000

export class ReadonlyQueryError extends Error {
  constructor(code, message, { status = 400, details, audit, retryable = false, cause } = {}) {
    super(message, { cause })
    this.name = 'ReadonlyQueryError'
    this.code = code
    this.status = status
    this.retryable = retryable
    if (details !== undefined) this.details = details
    if (audit !== undefined) this.audit = audit
  }
}

function fail(code, message, options) {
  throw new ReadonlyQueryError(code, message, options)
}

function finiteInteger(value, fallback, minimum, maximum, name) {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail('invalid_query_option', `${name} must be an integer between ${minimum} and ${maximum}.`)
  }
  return parsed
}

function normalizeParameters(parameters = []) {
  let entries
  if (Array.isArray(parameters)) {
    entries = parameters.map((value, index) => [index, value])
  } else if (parameters && typeof parameters === 'object' && Object.getPrototypeOf(parameters) === Object.prototype) {
    entries = Object.entries(parameters)
    if (entries.some(([name]) => !/^[$:@][A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
      fail('invalid_parameters', 'Named parameter keys must include a $, :, or @ prefix and a simple identifier.')
    }
  } else {
    fail('invalid_parameters', 'Query parameters must be an array or a plain object.')
  }
  if (entries.length > READONLY_QUERY_LIMITS.maxParameters) {
    fail('invalid_parameters', `A query may bind at most ${READONLY_QUERY_LIMITS.maxParameters} parameters.`)
  }
  let totalBytes = 0
  for (const [, value] of entries) {
    if (value === null || typeof value === 'bigint') totalBytes += 8
    else if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('invalid_parameters', 'Numeric parameters must be finite.')
      totalBytes += 8
    }
    else if (typeof value === 'string') totalBytes += Buffer.byteLength(value, 'utf8')
    else if (value instanceof Uint8Array) totalBytes += value.byteLength
    else fail('invalid_parameters', 'Parameter values must be null, strings, numbers, BigInts, or byte arrays.')
    if (totalBytes > READONLY_QUERY_LIMITS.maxParameterBytes) {
      fail('invalid_parameters', `Query parameters exceed the ${READONLY_QUERY_LIMITS.maxParameterBytes} byte limit.`, { status: 413 })
    }
  }
  return parameters
}

// This lexer only establishes one-statement boundaries and the leading statement kind.
// SQLite's authorizer performs the actual operation, table, column, and function checks.
export function inspectSingleReadonlyStatement(sql) {
  if (typeof sql !== 'string' || !sql.trim()) fail('invalid_sql', 'SQL must be a non-empty string.')
  if (sql.length > READONLY_QUERY_LIMITS.maxSqlLength) fail('sql_too_long', 'SQL exceeds the 50000 character limit.', { status: 413 })
  if (sql.includes('\0')) fail('invalid_sql', 'SQL cannot contain NUL bytes.')

  let state = 'normal'
  let token = ''
  let leadingKeyword = null
  let statementEnded = false
  let sawContent = false
  const flushToken = () => {
    if (!token) return
    if (!leadingKeyword) leadingKeyword = token.toUpperCase()
    token = ''
  }

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    const next = sql[index + 1]
    if (state === 'line-comment') {
      if (char === '\n' || char === '\r') state = 'normal'
      continue
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'normal'
        index += 1
      }
      continue
    }
    if (state === 'single-quote') {
      if (char === "'" && next === "'") index += 1
      else if (char === "'") state = 'normal'
      continue
    }
    if (state === 'double-quote') {
      if (char === '"' && next === '"') index += 1
      else if (char === '"') state = 'normal'
      continue
    }
    if (state === 'backtick') {
      if (char === '`' && next === '`') index += 1
      else if (char === '`') state = 'normal'
      continue
    }
    if (state === 'bracket') {
      if (char === ']' && next === ']') index += 1
      else if (char === ']') state = 'normal'
      continue
    }

    if (char === '-' && next === '-') {
      flushToken()
      state = 'line-comment'
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      flushToken()
      state = 'block-comment'
      index += 1
      continue
    }
    if (char === "'") {
      flushToken()
      if (statementEnded) fail('multiple_statements', 'Only one SQL statement is permitted.')
      sawContent = true
      state = 'single-quote'
      continue
    }
    if (char === '"') {
      flushToken()
      if (statementEnded) fail('multiple_statements', 'Only one SQL statement is permitted.')
      sawContent = true
      state = 'double-quote'
      continue
    }
    if (char === '`') {
      flushToken()
      if (statementEnded) fail('multiple_statements', 'Only one SQL statement is permitted.')
      sawContent = true
      state = 'backtick'
      continue
    }
    if (char === '[') {
      flushToken()
      if (statementEnded) fail('multiple_statements', 'Only one SQL statement is permitted.')
      sawContent = true
      state = 'bracket'
      continue
    }
    if (char === ';') {
      flushToken()
      if (!sawContent || statementEnded) fail('multiple_statements', 'Only one SQL statement is permitted.')
      statementEnded = true
      continue
    }
    if (/\s/.test(char)) {
      flushToken()
      continue
    }
    if (statementEnded) fail('multiple_statements', 'Only one SQL statement is permitted.')
    sawContent = true
    if (/[A-Za-z_]/.test(char) || (token && /[0-9$]/.test(char))) token += char
    else flushToken()
  }
  flushToken()

  if (state === 'block-comment') fail('invalid_sql', 'SQL contains an unterminated block comment.')
  if (['single-quote', 'double-quote', 'backtick', 'bracket'].includes(state)) {
    fail('invalid_sql', 'SQL contains an unterminated quoted value or identifier.')
  }
  if (!sawContent || !leadingKeyword) fail('invalid_sql', 'SQL must contain a statement.')
  if (!['SELECT', 'WITH'].includes(leadingKeyword)) {
    fail('query_not_readonly', 'Only SELECT statements and read-only CTEs are permitted.', { status: 403 })
  }
  return { leading_keyword: leadingKeyword, terminated: statementEnded }
}

function fromWorkerError(payload) {
  const busy = /(?:database(?:\s+table)?\s+(?:is\s+)?(?:busy|locked)|SQLITE_BUSY)/i.test(payload?.message || '')
  const code = busy ? 'database_busy' : payload?.code || 'readonly_query_failed'
  const status = code === 'query_timeout' ? 408
    : code === 'query_cancelled' ? 499
    : code === 'database_busy' ? 503
    : ['query_not_authorized', 'query_not_readonly'].includes(code) ? 403
      : code.includes('limit') || code.includes('too_large') ? 413
        : 400
  return new ReadonlyQueryError(code, payload?.message || 'Read-only query failed.', {
    status,
    retryable: code === 'query_timeout' || code === 'database_busy' || code === 'readonly_worker_failed',
    details: payload?.details,
    audit: payload?.audit
  })
}

function runWorker(workerData, timeoutMs, signal = undefined) {
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = fork(fileURLToPath(new URL('./readonly-query-worker.js', import.meta.url)), [], {
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true
    })
    let settled = false
    let timingOut = false
    let terminationTimer = null
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (terminationTimer) clearTimeout(terminationTimer)
      signal?.removeEventListener?.('abort', abort)
      callback(value)
    }
    const abort = () => {
      if (settled || timingOut) return
      timingOut = true
      const audit = {
        tool: workerData.request?.tool || (workerData.action === 'catalog' ? 'get_schema_catalog' : 'execute_readonly_query'),
        scope: { tables: [], columns: [], functions: [] },
        execution_ms: 0,
        returned_rows: 0,
        error: 'query_cancelled'
      }
      const error = new ReadonlyQueryError('query_cancelled', 'Read-only query was cancelled.', { status: 499, audit })
      let exited = false
      const complete = () => {
        if (exited) return
        exited = true
        if (workerData.request?.outputPath) {
          try { unlinkSync(workerData.request.outputPath) } catch {}
        }
        finish(rejectPromise, error)
      }
      worker.once('exit', complete)
      if (!worker.kill()) complete()
      else {
        terminationTimer = setTimeout(() => {
          try { worker.kill('SIGKILL') } catch {}
          complete()
        }, WORKER_TERMINATION_GRACE_MS)
        terminationTimer.unref?.()
      }
    }
    const timer = setTimeout(() => {
      timingOut = true
      const audit = {
        tool: workerData.request?.tool || (workerData.action === 'catalog' ? 'get_schema_catalog' : 'execute_readonly_query'),
        scope: { tables: [], columns: [], functions: [] },
        execution_ms: timeoutMs,
        returned_rows: 0,
        error: 'query_timeout'
      }
      const timeoutError = new ReadonlyQueryError('query_timeout', `Read-only query exceeded the ${timeoutMs} ms timeout.`, {
        status: 408,
        retryable: true,
        audit
      })
      let timeoutCompleted = false
      const completeTimeout = () => {
        if (timeoutCompleted) return
        timeoutCompleted = true
        if (workerData.request?.outputPath) {
          try { unlinkSync(workerData.request.outputPath) } catch {}
        }
        finish(rejectPromise, timeoutError)
      }
      worker.once('exit', completeTimeout)
      if (!worker.kill()) completeTimeout()
      else {
        terminationTimer = setTimeout(() => {
          try { worker.kill('SIGKILL') } catch {}
          completeTimeout()
        }, WORKER_TERMINATION_GRACE_MS)
        terminationTimer.unref?.()
      }
    }, timeoutMs)
    timer.unref?.()
    if (signal?.aborted) abort()
    else signal?.addEventListener?.('abort', abort, { once: true })

    worker.once('message', (message) => {
      if (message?.ok) finish(resolvePromise, message.result)
      else finish(rejectPromise, fromWorkerError(message?.error))
    })
    worker.once('error', (error) => {
      finish(rejectPromise, new ReadonlyQueryError('readonly_worker_failed', 'The read-only query worker failed.', {
        status: 500,
        retryable: true,
        cause: error
      }))
    })
    worker.once('exit', (code) => {
      if (!timingOut && !settled) {
        finish(rejectPromise, new ReadonlyQueryError('readonly_worker_failed', `The read-only query worker exited without a result (code ${code}).`, { status: 500, retryable: true }))
      }
    })
    worker.send(workerData)
  })
}

function databaseFile(databasePath) {
  if (typeof databasePath !== 'string' || !databasePath.trim()) fail('invalid_database_path', 'A SQLite database path is required.')
  if (databasePath === ':memory:') {
    fail('unsupported_database_path', 'The isolated read-only service does not support :memory:. Use a temporary file-backed database in tests.')
  }
  if (databasePath.startsWith('file:')) {
    try {
      return resolve(fileURLToPath(databasePath))
    } catch (cause) {
      fail('invalid_database_path', 'The SQLite file URL is invalid.', { cause })
    }
  }
  return resolve(databasePath)
}

export async function getSchemaCatalog(databasePath, options = {}) {
  const timeoutMs = finiteInteger(options.timeoutMs, READONLY_QUERY_LIMITS.timeoutMs, 1, READONLY_QUERY_LIMITS.maxTimeoutMs, 'timeoutMs')
  return runWorker({ action: 'catalog', databasePath: databaseFile(databasePath) }, timeoutMs, options.signal)
}

export async function executeReadonlyQuery(databasePath, request, options = {}) {
  if (!request || typeof request !== 'object') fail('invalid_query', 'A query request is required.')
  inspectSingleReadonlyStatement(request.sql)
  const timeoutMs = finiteInteger(request.timeoutMs ?? options.timeoutMs, READONLY_QUERY_LIMITS.timeoutMs, 1, READONLY_QUERY_LIMITS.maxTimeoutMs, 'timeoutMs')
  const maxRows = finiteInteger(request.maxRows, READONLY_QUERY_LIMITS.maxRows, 1, READONLY_QUERY_LIMITS.maxRows, 'maxRows')
  const maxBytes = finiteInteger(request.maxBytes, READONLY_QUERY_LIMITS.maxResponseBytes, 1_024, READONLY_QUERY_LIMITS.maxResponseBytes, 'maxBytes')
  return runWorker({
    action: 'query',
    databasePath: databaseFile(databasePath),
    request: {
      sql: request.sql,
      parameters: normalizeParameters(request.parameters),
      maxRows,
      maxBytes,
      tool: typeof request.tool === 'string' ? request.tool.slice(0, 80) : 'execute_readonly_query'
    }
  }, timeoutMs, request.signal ?? options.signal)
}

function catalogMap(catalog) {
  return new Map(catalog.tables.map((table) => [table.name.toLowerCase(), {
    ...table,
    columnMap: new Map(table.columns.map((column) => [column.name.toLowerCase(), column]))
  }]))
}

function knownTable(lookup, value) {
  if (typeof value !== 'string') fail('unknown_table', 'A table name from the schema catalog is required.')
  const table = lookup.get(value.toLowerCase())
  if (!table) fail('unknown_table', `Unknown table: ${value}`)
  return table
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function fieldReference(lookup, baseTable, joinedTables, value) {
  let tableName = baseTable.name
  let columnName = value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    tableName = value.table || tableName
    columnName = value.column
  } else if (typeof value === 'string' && value.includes('.')) {
    const parts = value.split('.')
    if (parts.length !== 2) fail('unknown_field', `Invalid field reference: ${value}`)
    ;[tableName, columnName] = parts
  }
  const table = knownTable(lookup, tableName)
  if (!joinedTables.has(table.name.toLowerCase())) fail('unknown_field', `Table is not part of this query: ${table.name}`)
  if (typeof columnName !== 'string' || !table.columnMap.has(columnName.toLowerCase())) {
    fail('unknown_field', `Unknown field: ${table.name}.${String(columnName)}`)
  }
  const column = table.columnMap.get(columnName.toLowerCase())
  return {
    table: table.name,
    column: column.name,
    sql: `${quoteIdentifier(table.name)}.${quoteIdentifier(column.name)}`
  }
}

function buildJoins(lookup, baseTable, joins) {
  if (joins === undefined) return { sql: '', tables: new Set([baseTable.name.toLowerCase()]) }
  if (!Array.isArray(joins) || joins.length > 12) fail('invalid_joins', 'joins must be an array with at most 12 entries.')
  const joinedTables = new Set([baseTable.name.toLowerCase()])
  let sql = ''
  for (const join of joins) {
    if (!join || typeof join !== 'object') fail('invalid_joins', 'Each join must be an object.')
    const table = knownTable(lookup, join.table)
    if (joinedTables.has(table.name.toLowerCase())) fail('invalid_joins', `Table is already joined: ${table.name}`)
    const type = (join.type || 'inner').toLowerCase()
    if (!['inner', 'left'].includes(type)) fail('invalid_joins', 'Join type must be inner or left.')
    const prospectiveTables = new Set(joinedTables).add(table.name.toLowerCase())
    const left = fieldReference(lookup, baseTable, prospectiveTables, join.left)
    const right = fieldReference(lookup, baseTable, prospectiveTables, join.right)
    const leftIsNew = left.table.toLowerCase() === table.name.toLowerCase()
    const rightIsNew = right.table.toLowerCase() === table.name.toLowerCase()
    if (leftIsNew === rightIsNew) {
      fail('invalid_joins', `Join condition must connect ${table.name} to a table already in the query.`)
    }
    sql += ` ${type.toUpperCase()} JOIN ${quoteIdentifier(table.name)} ON ${left.sql} = ${right.sql}`
    joinedTables.add(table.name.toLowerCase())
  }
  return { sql, tables: joinedTables }
}

function escapeContains(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function buildFilters(lookup, baseTable, joinedTables, filters, parameters) {
  if (filters === undefined || (Array.isArray(filters) && filters.length === 0)) return ''
  if (!Array.isArray(filters) || filters.length > READONLY_QUERY_LIMITS.maxFilters) {
    fail('invalid_filters', `filters must be an array with at most ${READONLY_QUERY_LIMITS.maxFilters} entries.`)
  }
  const clauses = filters.map((filter) => {
    if (!filter || typeof filter !== 'object') fail('invalid_filters', 'Each filter must be an object.')
    const field = fieldReference(lookup, baseTable, joinedTables, filter.field)
    const operator = String(filter.operator || '').toLowerCase()
    if (operator === 'is_null') return `${field.sql} IS ${filter.value === false ? 'NOT ' : ''}NULL`
    if (operator === 'in') {
      if (!Array.isArray(filter.value) || filter.value.length < 1 || filter.value.length > READONLY_QUERY_LIMITS.maxInValues) {
        fail('invalid_filters', `in requires between 1 and ${READONLY_QUERY_LIMITS.maxInValues} values.`)
      }
      parameters.push(...filter.value)
      return `${field.sql} IN (${filter.value.map(() => '?').join(', ')})`
    }
    const operators = { eq: '=', ne: '<>', gte: '>=', lte: '<=' }
    if (operator === 'contains') {
      parameters.push(`%${escapeContains(filter.value ?? '')}%`)
      return `${field.sql} LIKE ? ESCAPE '\\'`
    }
    if (!operators[operator]) fail('invalid_filters', `Unsupported filter operator: ${operator}`)
    parameters.push(filter.value ?? null)
    return `${field.sql} ${operators[operator]} ?`
  })
  return ` WHERE ${clauses.join(' AND ')}`
}

function buildSort(lookup, baseTable, joinedTables, sort, selectableAliases = new Map()) {
  if (sort === undefined || (Array.isArray(sort) && sort.length === 0)) return ''
  if (!Array.isArray(sort) || sort.length > READONLY_QUERY_LIMITS.maxSortFields) {
    fail('invalid_sort', `sort must be an array with at most ${READONLY_QUERY_LIMITS.maxSortFields} entries.`)
  }
  const entries = sort.map((entry) => {
    if (!entry || typeof entry !== 'object') fail('invalid_sort', 'Each sort entry must be an object.')
    const direction = String(entry.direction || 'asc').toLowerCase()
    if (!['asc', 'desc'].includes(direction)) fail('invalid_sort', 'Sort direction must be asc or desc.')
    if (typeof entry.field === 'string' && selectableAliases.has(entry.field)) {
      return `${quoteIdentifier(selectableAliases.get(entry.field))} ${direction.toUpperCase()}`
    }
    return `${fieldReference(lookup, baseTable, joinedTables, entry.field).sql} ${direction.toUpperCase()}`
  })
  return ` ORDER BY ${entries.join(', ')}`
}

function pagination(spec) {
  const page = finiteInteger(spec.page, 1, 1, READONLY_QUERY_LIMITS.maxPage, 'page')
  const pageSize = finiteInteger(spec.pageSize ?? spec.page_size, 50, 1, READONLY_QUERY_LIMITS.maxPageSize, 'pageSize')
  return { page, pageSize, offset: (page - 1) * pageSize }
}

export function buildStructuredQuery(catalog, spec) {
  if (!spec || typeof spec !== 'object') fail('invalid_structured_query', 'A structured query is required.')
  const lookup = catalogMap(catalog)
  const baseTable = knownTable(lookup, spec.table)
  const joined = buildJoins(lookup, baseTable, spec.joins)
  const requestedFields = spec.fields ?? spec.columns ?? baseTable.columns.map((column) => column.name)
  if (!Array.isArray(requestedFields) || requestedFields.length < 1 || requestedFields.length > 200) {
    fail('invalid_fields', 'fields must contain between 1 and 200 schema fields.')
  }
  const seenNames = new Map()
  const selections = requestedFields.map((value) => {
    const field = fieldReference(lookup, baseTable, joined.tables, value)
    const baseName = field.table.toLowerCase() === baseTable.name.toLowerCase() ? field.column : `${field.table}__${field.column}`
    const key = baseName.toLowerCase()
    const count = (seenNames.get(key) || 0) + 1
    seenNames.set(key, count)
    const outputName = count === 1 ? baseName : `${baseName}_${count}`
    return `${field.sql} AS ${quoteIdentifier(outputName)}`
  })
  const parameters = []
  const where = buildFilters(lookup, baseTable, joined.tables, spec.filters, parameters)
  const order = buildSort(lookup, baseTable, joined.tables, spec.sort)
  const { page, pageSize, offset } = pagination(spec)
  const distinct = spec.distinct === true ? 'DISTINCT ' : ''
  return {
    sql: `SELECT ${distinct}${selections.join(', ')} FROM ${quoteIdentifier(baseTable.name)}${joined.sql}${where}${order} LIMIT ${pageSize + 1} OFFSET ${offset}`,
    parameters,
    page,
    page_size: pageSize
  }
}

export function buildAggregateQuery(catalog, spec) {
  if (!spec || typeof spec !== 'object') fail('invalid_aggregate_query', 'An aggregate query is required.')
  const lookup = catalogMap(catalog)
  const baseTable = knownTable(lookup, spec.table)
  const joined = buildJoins(lookup, baseTable, spec.joins)
  const groupBy = spec.groupBy ?? spec.group_by ?? []
  if (!Array.isArray(groupBy) || groupBy.length > 12) fail('invalid_group_by', 'groupBy must contain at most 12 fields.')
  const groups = groupBy.map((field) => fieldReference(lookup, baseTable, joined.tables, field))
  const metrics = spec.metrics ?? [{ operation: 'count' }]
  if (!Array.isArray(metrics) || metrics.length < 1 || metrics.length > 20) {
    fail('invalid_metrics', 'metrics must contain between 1 and 20 entries.')
  }
  const aliases = new Map()
  const metricSql = metrics.map((metric, index) => {
    const operation = String(metric?.operation || metric?.op || '').toLowerCase()
    if (!['count', 'sum', 'avg', 'min', 'max'].includes(operation)) fail('invalid_metrics', `Unsupported aggregate: ${operation}`)
    const field = metric.field === undefined || metric.field === null
      ? null
      : fieldReference(lookup, baseTable, joined.tables, metric.field)
    if (!field && operation !== 'count') fail('invalid_metrics', `${operation} requires a field.`)
    const outputName = `metric_${index + 1}_${operation}`
    aliases.set(outputName, outputName)
    return `${operation.toUpperCase()}(${field ? field.sql : '*'}) AS ${quoteIdentifier(outputName)}`
  })
  const groupSql = groups.map((field, index) => {
    const outputName = `group_${index + 1}_${field.column}`
    aliases.set(outputName, outputName)
    return `${field.sql} AS ${quoteIdentifier(outputName)}`
  })
  const parameters = []
  const where = buildFilters(lookup, baseTable, joined.tables, spec.filters, parameters)
  const grouping = groups.length ? ` GROUP BY ${groups.map((field) => field.sql).join(', ')}` : ''
  const order = buildSort(lookup, baseTable, joined.tables, spec.sort, aliases)
  const { page, pageSize, offset } = pagination(spec)
  return {
    sql: `SELECT ${[...groupSql, ...metricSql].join(', ')} FROM ${quoteIdentifier(baseTable.name)}${joined.sql}${where}${grouping}${order} LIMIT ${pageSize + 1} OFFSET ${offset}`,
    parameters,
    page,
    page_size: pageSize
  }
}

async function deliverAudit(recorder, audit) {
  if (typeof recorder !== 'function' || !audit) return
  await recorder(audit)
}

export function createReadonlyQueryService({
  databasePath,
  exportRoot,
  timeoutMs = READONLY_QUERY_LIMITS.timeoutMs,
  recordAudit
} = {}) {
  const path = databaseFile(databasePath)
  let catalogValue
  const catalog = async (signal = undefined, attemptTimeoutMs = timeoutMs) => {
    if (catalogValue) return catalogValue
    // Do not cache an abort-bound in-flight Promise. Concurrent cold calls may
    // briefly build the same small catalog, but one cancelled request cannot
    // cancel every other caller and a retry can inherit its expanded budget.
    const result = await getSchemaCatalog(path, { timeoutMs: attemptTimeoutMs, signal })
    catalogValue ??= result
    return catalogValue
  }
  const withAuditContext = (audit, context = {}) => audit ? {
    ...audit,
    trace_id: context.trace_id ?? context.traceId ?? null,
    task_id: context.task_id ?? context.taskId ?? null,
    phase: context.phase ?? null
  } : audit
  const runAndAudit = async (operation, tool, context = {}) => {
    let result
    try {
      result = await operation()
    } catch (error) {
      error.audit ??= {
        tool,
        scope: { tables: [], columns: [], functions: [] },
        execution_ms: 0,
        returned_rows: 0,
        error: error.code || 'query_failed'
      }
      error.audit = withAuditContext(error.audit, context)
      await deliverAudit(recordAudit, error.audit)
      throw error
    }
    result.audit = withAuditContext(result.audit, context)
    await deliverAudit(recordAudit, result.audit)
    return result
  }

  const catalogForTool = async (refresh = false, options = {}) => runAndAudit(async () => {
    if (refresh) catalogValue = undefined
    const startedAt = performance.now()
    const result = await catalog(options.signal, options.timeoutMs ?? timeoutMs)
    return {
      ...result,
      audit: {
        tool: 'get_schema_catalog',
        scope: {
          tables: result.tables.map((table) => table.name),
          columns: result.tables.flatMap((table) => table.columns.map((column) => `${table.name}.${column.name}`)),
          functions: []
        },
        execution_ms: Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000),
        returned_rows: result.tables.length,
        error: null
      }
    }
  }, 'get_schema_catalog', options)

  return {
    async getSchemaCatalog(options = {}) {
      const { audit, ...result } = await catalogForTool(false, options)
      return result
    },

    async refreshSchemaCatalog(options = {}) {
      const { audit, ...result } = await catalogForTool(true, options)
      return result
    },

    executeReadonlyQuery(request) {
    return runAndAudit(
      () => executeReadonlyQuery(path, request, { timeoutMs, signal: request?.signal }),
      request?.tool || 'execute_readonly_query',
      request
    )
    },

    async queryTable(spec) {
      return runAndAudit(async () => {
        const built = buildStructuredQuery(await catalog(spec?.signal, spec?.timeoutMs ?? timeoutMs), spec)
        const result = await executeReadonlyQuery(path, {
          ...built,
          maxRows: built.page_size,
          tool: 'query_table',
          timeoutMs: spec?.timeoutMs ?? timeoutMs,
          signal: spec?.signal
        })
        return { ...result, pagination: { page: built.page, page_size: built.page_size, has_more: result.has_more } }
      }, 'query_table', spec)
    },

    async aggregate(spec) {
      return runAndAudit(async () => {
        const built = buildAggregateQuery(await catalog(spec?.signal, spec?.timeoutMs ?? timeoutMs), spec)
        const result = await executeReadonlyQuery(path, {
          ...built,
          maxRows: built.page_size,
          tool: 'aggregate_recruitment_data',
          timeoutMs: spec?.timeoutMs ?? timeoutMs,
          signal: spec?.signal
        })
        return { ...result, pagination: { page: built.page, page_size: built.page_size, has_more: result.has_more } }
      }, 'aggregate_recruitment_data', spec)
    },

    async exportQueryResults(request) {
      return runAndAudit(async () => {
        if (!exportRoot) fail('export_root_not_configured', 'A controlled export root is required for CSV export.', { status: 500 })
        inspectSingleReadonlyStatement(request?.sql)
        const root = resolve(exportRoot)
        mkdirSync(root, { recursive: true })
        const filename = `agent-query-${randomUUID()}.csv`
        const outputPath = resolve(root, filename)
        const exportTimeout = finiteInteger(request.timeoutMs, Math.min(READONLY_QUERY_LIMITS.maxTimeoutMs, timeoutMs * 3), 1, READONLY_QUERY_LIMITS.maxTimeoutMs, 'timeoutMs')
        const maxRows = finiteInteger(request.maxRows, READONLY_QUERY_LIMITS.maxExportRows, 1, READONLY_QUERY_LIMITS.maxExportRows, 'maxRows')
        const maxBytes = finiteInteger(request.maxBytes, READONLY_QUERY_LIMITS.maxExportBytes, 1_024, READONLY_QUERY_LIMITS.maxExportBytes, 'maxBytes')
        return runWorker({
          action: 'export',
          databasePath: path,
          request: {
            sql: request.sql,
            parameters: normalizeParameters(request.parameters),
            outputPath,
            filename,
            maxRows,
            maxBytes,
            tool: 'export_query_results'
          }
        }, exportTimeout, request?.signal)
      }, 'export_query_results', request)
    }
  }
}
