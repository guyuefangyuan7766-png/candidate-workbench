import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const WORKBOOK_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const DEFAULT_SOURCE_DIR = 'C:/Users/cboy/Desktop/应聘者数据-8b201f07-bb01-433b-a206-3244454ee67c'
export const DEFAULT_OUTPUT_DIR = join(WORKBOOK_ROOT, 'outputs/2026-08-21-hire-status-cleaned')
export const DEFAULT_WORK_DIR = join(WORKBOOK_ROOT, '.tmp-hire-status-artifact')
export const DEFAULT_LOADER_NODE_ROOT = 'C:/Users/cboy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node'

function pathValue(value, fallback) {
  const candidate = String(value ?? '').trim()
  if (!candidate) return fallback
  return isAbsolute(candidate) ? candidate : resolve(WORKBOOK_ROOT, candidate)
}

function parseFlagValue(argv, index, flag, inlineValue) {
  const value = inlineValue ?? argv[index + 1]
  if (!value || String(value).startsWith('--')) throw new Error(`${flag} requires a path value`)
  return { value: String(value), nextIndex: inlineValue == null ? index + 1 : index }
}

export function parseWorkbookCli(argv = []) {
  const values = {}
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index])
    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }
    const separator = argument.indexOf('=')
    const flag = separator === -1 ? argument : argument.slice(0, separator)
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1)
    const key = {
      '--source-dir': 'sourceDir',
      '--output-dir': 'outputDir',
      '--work-dir': 'workDir',
      '--loader-node-root': 'loaderNodeRoot',
      '--loader-node-modules': 'loaderNodeModules'
    }[flag]
    if (!key) throw new Error(`Unknown option: ${argument}`)
    const parsed = parseFlagValue(argv, index, flag, inlineValue)
    values[key] = parsed.value
    index = parsed.nextIndex
  }
  return { ...values, help }
}

export function resolveWorkbookConfig({ argv = process.argv.slice(2), env = process.env } = {}) {
  const cli = parseWorkbookCli(argv)
  const sourceDir = pathValue(cli.sourceDir ?? env.HIRE_STATUS_SOURCE_DIR, DEFAULT_SOURCE_DIR)
  const outputDir = pathValue(cli.outputDir ?? env.HIRE_STATUS_OUTPUT_DIR, DEFAULT_OUTPUT_DIR)
  const workDir = pathValue(cli.workDir ?? env.HIRE_STATUS_WORK_DIR, DEFAULT_WORK_DIR)
  const loaderNodeRoot = pathValue(
    cli.loaderNodeRoot ?? env.HIRE_STATUS_LOADER_NODE_ROOT,
    DEFAULT_LOADER_NODE_ROOT
  )
  const loaderNodeModules = pathValue(
    cli.loaderNodeModules ?? env.HIRE_STATUS_LOADER_NODE_MODULES,
    join(loaderNodeRoot, 'node_modules')
  )
  return { sourceDir, outputDir, workDir, loaderNodeRoot, loaderNodeModules, help: cli.help }
}

export async function checkWorkbookPrerequisites(config, {
  required = /^(1|true|yes)$/i.test(process.env.HIRE_STATUS_WORKBOOKS_REQUIRED ?? '')
} = {}) {
  try {
    await access(config.sourceDir)
    await access(config.loaderNodeModules)
    const require = createRequire(join(config.loaderNodeModules, '..', 'artifact-prerequisite-loader.cjs'))
    return { available: true, artifactEntry: require.resolve('@oai/artifact-tool') }
  } catch (error) {
    const reason =
      `real source workbooks or the loader-provided artifact runtime are unavailable (${error?.code ?? 'unknown'})`
    if (required) {
      throw new Error(
        `${reason}; HIRE_STATUS_WORKBOOKS_REQUIRED=1 requires valid configured source and loader paths`,
        { cause: error }
      )
    }
    return {
      available: false,
      skipReason: `${reason}. Set HIRE_STATUS_WORKBOOKS_REQUIRED=1 to make this a failure.`
    }
  }
}

export const WORKBOOK_CONFIG_HELP = `
Usage: node scripts/clean-hire-status-workbooks.mjs [options]

Options:
  --source-dir <path>          Source .xls directory
  --output-dir <path>          Dedicated output directory
  --work-dir <path>            Render and staging directory
  --loader-node-root <path>    Loader Node root containing node_modules
  --loader-node-modules <path> Loader-provided node_modules directory

Equivalent environment variables:
  HIRE_STATUS_SOURCE_DIR, HIRE_STATUS_OUTPUT_DIR, HIRE_STATUS_WORK_DIR,
  HIRE_STATUS_LOADER_NODE_ROOT, HIRE_STATUS_LOADER_NODE_MODULES
`
