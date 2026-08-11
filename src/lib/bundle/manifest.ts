/**
 * Parses and validates the `icp.yaml` manifest at the root of an application bundle.
 *
 * A bundle's manifest is already resolved: every artifact it needs is inside the
 * archive and referenced by a relative path. Anything that would require running a
 * build, fetching a URL, or executing a sync plugin is rejected here — before any
 * canister is created — rather than failing halfway through a deployment.
 */

import { parse as parseYaml } from 'yaml'
import { LogVisibility, type CanisterSettings } from '@icp-sdk/canisters/ic-management'
import type { ArchiveEntries } from './archive'

export const MANIFEST_PATH = 'icp.yaml'

export interface BundleCanister {
  name: string
  /** Path of the wasm inside the archive, for display and error messages. */
  wasmPath: string
  wasm: Uint8Array
  /** Lowercase hex digest declared by the manifest, if it declared one. */
  sha256?: string
  /** Candid-encoded init argument. `DIDL\0\0` (the empty tuple) when unspecified. */
  initArg: Uint8Array
  settings: CanisterSettings
  /** Plugin steps to run after the wasm is installed, in declaration order. */
  sync: SyncStep[]
}

/** A `type: plugin` sync step: a wasm component plus what it is allowed to read. */
export interface SyncStep {
  /** Path of the plugin wasm inside the archive. */
  pluginPath: string
  wasm: Uint8Array
  sha256?: string
  /** Directories preopened read-only for the plugin, relative to the bundle root. */
  dirs: string[]
  /** Files the host reads up front and passes inline. */
  files: { name: string; content: string }[]
}

export interface BundleManifest {
  canisters: BundleCanister[]
}

export class ManifestError extends Error {}

/** The Candid encoding of `()`. */
const EMPTY_CANDID_ARG = new Uint8Array([0x44, 0x49, 0x44, 0x4c, 0x00, 0x00])

export function parseManifest(entries: ArchiveEntries): BundleManifest {
  const source = entries.get(MANIFEST_PATH)
  if (!source) {
    throw new ManifestError(
      `The bundle has no ${MANIFEST_PATH} at its root, so it is not an application bundle.`,
    )
  }

  let doc: unknown
  try {
    doc = parseYaml(new TextDecoder().decode(source))
  } catch (error) {
    throw new ManifestError(`${MANIFEST_PATH} is not valid YAML: ${describe(error)}`)
  }
  const root = asRecord(doc, MANIFEST_PATH)

  if (asArray(root.dependencies, 'dependencies').length > 0) {
    throw new ManifestError(
      'This bundle declares project dependencies, which this deployer cannot resolve. ' +
        'Only self-contained bundles are supported.',
    )
  }

  const canisters = asArray(root.canisters, 'canisters')
  if (canisters.length === 0) {
    throw new ManifestError(`${MANIFEST_PATH} declares no canisters.`)
  }

  const parsed = canisters.map((canister, index) =>
    parseCanister(asRecord(canister, `canisters[${index}]`), entries),
  )

  const duplicate = findDuplicate(parsed.map((canister) => canister.name))
  if (duplicate) {
    throw new ManifestError(`${MANIFEST_PATH} declares two canisters named "${duplicate}".`)
  }

  return { canisters: parsed }
}

function parseCanister(canister: Record<string, unknown>, entries: ArchiveEntries): BundleCanister {
  const name = canister.name
  if (typeof name !== 'string' || name === '') {
    throw new ManifestError('Every canister in the manifest needs a name.')
  }

  const { wasmPath, sha256 } = parseBuild(name, canister.build)
  const wasm = entries.get(wasmPath)
  if (!wasm) {
    throw new ManifestError(
      `Canister "${name}" refers to "${wasmPath}", which is not in the bundle.`,
    )
  }

  return {
    name,
    wasmPath,
    wasm,
    sha256,
    initArg: parseInitArgs(name, canister.init_args, entries),
    settings: parseSettings(name, canister.settings),
    sync: parseSync(name, canister.sync, entries),
  }
}

function parseSync(name: string, sync: unknown, entries: ArchiveEntries): SyncStep[] {
  const steps = asArray(asRecord(sync ?? {}, `${name}.sync`).steps, `${name}.sync.steps`)

  return steps.map((raw, index) => {
    const step = asRecord(raw, `${name}.sync.steps[${index}]`)

    if (step.type !== 'plugin') {
      throw new ManifestError(
        `Canister "${name}" has a \`${String(step.type)}\` sync step. A browser cannot run ` +
          'shell commands, so only `plugin` sync steps are supported.',
      )
    }
    if (typeof step.path !== 'string' || step.path === '') {
      const reason =
        typeof step.url === 'string'
          ? 'it points at a URL instead of a file inside the bundle'
          : 'it has no `path`'
      throw new ManifestError(
        `A sync step of canister "${name}" cannot be used because ${reason}. ` +
          'A bundle must carry every plugin it runs.',
      )
    }

    const wasm = entries.get(step.path)
    if (!wasm) {
      throw new ManifestError(
        `Canister "${name}" refers to the sync plugin "${step.path}", which is not in the bundle.`,
      )
    }

    const sha256 = step.sha256
    if (sha256 !== undefined && typeof sha256 !== 'string') {
      throw new ManifestError(`The \`sha256\` of a sync step of canister "${name}" must be a hex string.`)
    }

    const dirs = asArray(step.dirs, `${name}.sync.steps[${index}].dirs`).map((dir) => {
      if (typeof dir !== 'string' || dir === '') {
        throw new ManifestError(`Every entry in the \`dirs\` of canister "${name}" must be a path.`)
      }
      return dir
    })

    const files = asArray(step.files, `${name}.sync.steps[${index}].files`).map((path) => {
      if (typeof path !== 'string') {
        throw new ManifestError(`Every entry in the \`files\` of canister "${name}" must be a path.`)
      }
      const content = entries.get(path)
      if (!content) {
        throw new ManifestError(
          `Canister "${name}" declares the sync file "${path}", which is not in the bundle.`,
        )
      }
      return { name: path, content: new TextDecoder().decode(content) }
    })

    if (dirs.length === 0 && files.length === 0) {
      throw new ManifestError(
        `A sync step of canister "${name}" declares neither \`dirs\` nor \`files\`, so it has ` +
          'nothing to sync.',
      )
    }

    return { pluginPath: step.path, wasm, sha256: sha256?.toLowerCase(), dirs, files }
  })
}

function parseBuild(
  name: string,
  build: unknown,
): { wasmPath: string; sha256?: string } {
  const steps = asArray(asRecord(build ?? {}, `${name}.build`).steps, `${name}.build.steps`)
  if (steps.length !== 1) {
    throw new ManifestError(
      `Canister "${name}" has ${steps.length} build steps. A bundle is already built, so each ` +
        'canister must have exactly one `pre-built` step pointing at its wasm.',
    )
  }

  const step = asRecord(steps[0], `${name}.build.steps[0]`)
  if (step.type !== 'pre-built') {
    throw new ManifestError(
      `Canister "${name}" has a \`${String(step.type)}\` build step. Bundles cannot be built ` +
        'in the browser, so only `pre-built` steps are supported.',
    )
  }
  if (typeof step.path !== 'string' || step.path === '') {
    const reason =
      typeof step.url === 'string'
        ? 'it points at a URL instead of a file inside the bundle'
        : 'it has no `path`'
    throw new ManifestError(
      `The build step of canister "${name}" cannot be used because ${reason}. ` +
        'A bundle must carry every wasm it installs.',
    )
  }

  const sha256 = step.sha256
  if (sha256 !== undefined && typeof sha256 !== 'string') {
    throw new ManifestError(`The \`sha256\` of canister "${name}" must be a hex string.`)
  }

  return { wasmPath: step.path, sha256: sha256?.toLowerCase() }
}

function parseInitArgs(name: string, initArgs: unknown, entries: ArchiveEntries): Uint8Array {
  if (initArgs === undefined || initArgs === null) return EMPTY_CANDID_ARG

  const spec = typeof initArgs === 'string' ? { value: initArgs } : asRecord(initArgs, `${name}.init_args`)
  const format = spec.format ?? 'candid'
  const hasPath = typeof spec.path === 'string'
  const hasValue = typeof spec.value === 'string'
  if (hasPath === hasValue) {
    throw new ManifestError(
      `The init args of canister "${name}" must specify exactly one of \`path\` or \`value\`.`,
    )
  }

  if (format === 'bin') {
    if (!hasPath) {
      throw new ManifestError(
        `The init args of canister "${name}" use \`bin\` format, which requires a \`path\`.`,
      )
    }
    return readEntry(name, spec.path as string, entries)
  }

  const text = hasValue
    ? (spec.value as string)
    : new TextDecoder().decode(readEntry(name, spec.path as string, entries))

  if (format === 'hex') return decodeHex(name, text)

  if (format === 'candid') {
    // Encoding Candid *text* needs a parser we do not have in the browser. The
    // empty tuple is the one case we can honour, and it is by far the common one.
    if (text.trim() === '()') return EMPTY_CANDID_ARG
    throw new ManifestError(
      `Canister "${name}" has init args in Candid text format, which this deployer cannot ` +
        'encode in the browser. Rebuild the bundle with pre-encoded args (`format: hex` or ' +
        '`format: bin`).',
    )
  }

  throw new ManifestError(
    `Canister "${name}" has init args in unknown format \`${String(format)}\`.`,
  )
}

function readEntry(name: string, path: string, entries: ArchiveEntries): Uint8Array {
  const content = entries.get(path)
  if (!content) {
    throw new ManifestError(
      `The init args of canister "${name}" refer to "${path}", which is not in the bundle.`,
    )
  }
  return content
}

function parseSettings(name: string, settings: unknown): CanisterSettings {
  if (settings === undefined || settings === null) return {}
  const record = asRecord(settings, `${name}.settings`)
  const at = (field: string) => `${field} of canister "${name}"`

  const parsed: CanisterSettings = {}

  if (record.controllers !== undefined && record.controllers !== null) {
    parsed.controllers = asArray(record.controllers, at('controllers')).map((controller) => {
      if (typeof controller !== 'string') {
        throw new ManifestError(`Every entry in ${at('controllers')} must be a principal.`)
      }
      return controller
    })
  }

  assign(parsed, 'computeAllocation', record.compute_allocation, (value) =>
    parsePlain(value, at('compute_allocation')),
  )
  assign(parsed, 'memoryAllocation', record.memory_allocation, (value) =>
    parseScaled(value, at('memory_allocation'), BYTE_UNITS),
  )
  assign(parsed, 'wasmMemoryLimit', record.wasm_memory_limit, (value) =>
    parseScaled(value, at('wasm_memory_limit'), BYTE_UNITS),
  )
  assign(parsed, 'wasmMemoryThreshold', record.wasm_memory_threshold, (value) =>
    parseScaled(value, at('wasm_memory_threshold'), BYTE_UNITS),
  )
  assign(parsed, 'freezingThreshold', record.freezing_threshold, (value) =>
    parseScaled(value, at('freezing_threshold'), DURATION_UNITS),
  )
  assign(parsed, 'reservedCyclesLimit', record.reserved_cycles_limit, (value) =>
    parseScaled(value, at('reserved_cycles_limit'), CYCLE_UNITS),
  )

  if (record.log_visibility !== undefined && record.log_visibility !== null) {
    if (record.log_visibility === 'controllers') parsed.logVisibility = LogVisibility.Controllers
    else if (record.log_visibility === 'public') parsed.logVisibility = LogVisibility.Public
    else {
      throw new ManifestError(
        `${at('log_visibility')} must be \`controllers\` or \`public\`; ` +
          `\`${JSON.stringify(record.log_visibility)}\` is not supported.`,
      )
    }
  }

  if (record.environment_variables !== undefined && record.environment_variables !== null) {
    parsed.environmentVariables = Object.entries(
      asRecord(record.environment_variables, at('environment_variables')),
    ).map(([key, value]) => {
      if (typeof value !== 'string') {
        throw new ManifestError(
          `The environment variable "${key}" of canister "${name}" must be an inline string. ` +
            'Values read from a file must be resolved when the bundle is built.',
        )
      }
      return { name: key, value }
    })
  }

  return parsed
}

function assign<K extends keyof CanisterSettings>(
  settings: CanisterSettings,
  key: K,
  raw: unknown,
  parse: (value: unknown) => bigint,
): void {
  if (raw === undefined || raw === null) return
  settings[key] = parse(raw) as CanisterSettings[K]
}

// Suffixes accepted by icp.yaml. `m` means "million" for cycles but "minutes" for
// durations, so each field is parsed against exactly one of these tables.
const BYTE_UNITS: Record<string, bigint> = {
  kb: 1000n,
  kib: 1024n,
  mb: 1000n ** 2n,
  mib: 1024n ** 2n,
  gb: 1000n ** 3n,
  gib: 1024n ** 3n,
  tb: 1000n ** 4n,
  tib: 1024n ** 4n,
}

const CYCLE_UNITS: Record<string, bigint> = {
  k: 1000n,
  m: 1000n ** 2n,
  b: 1000n ** 3n,
  t: 1000n ** 4n,
}

/** Durations are expressed to the management canister in seconds. */
const DURATION_UNITS: Record<string, bigint> = {
  s: 1n,
  m: 60n,
  h: 3600n,
  d: 86400n,
  w: 604800n,
}

function parsePlain(value: unknown, field: string): bigint {
  return parseScaled(value, field, {})
}

function parseScaled(value: unknown, field: string, units: Record<string, bigint>): bigint {
  if (typeof value === 'number' || typeof value === 'bigint') return BigInt(value)
  if (typeof value !== 'string') {
    throw new ManifestError(`${field} must be a number or a string with a unit suffix.`)
  }

  const text = value.trim().toLowerCase().replaceAll('_', '')
  const match = /^(\d+(?:\.\d+)?)([a-z]*)$/.exec(text)
  if (!match) {
    throw new ManifestError(`${field} is not a valid value: ${JSON.stringify(value)}.`)
  }
  const [, amount, suffix] = match

  if (suffix === '') return scale(amount, 1n, field, value)
  const unit = units[suffix]
  if (unit === undefined) {
    const accepted = Object.keys(units).join(', ')
    throw new ManifestError(
      `${field} uses the unknown suffix \`${suffix}\`. Accepted suffixes: ${accepted || 'none'}.`,
    )
  }
  return scale(amount, unit, field, value)
}

/** Multiplies a possibly-fractional amount by a unit, refusing fractional results. */
function scale(amount: string, unit: bigint, field: string, original: string): bigint {
  const [whole, fraction = ''] = amount.split('.')
  const scaled = BigInt(whole + fraction) * unit
  const divisor = 10n ** BigInt(fraction.length)
  if (scaled % divisor !== 0n) {
    throw new ManifestError(`${field} is not a whole number of units: ${JSON.stringify(original)}.`)
  }
  return scaled / divisor
}

function decodeHex(name: string, text: string): Uint8Array {
  const hex = text.trim().replace(/^0x/i, '')
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new ManifestError(`The init args of canister "${name}" are not valid hex.`)
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ManifestError(`${field} must be a mapping.`)
  }
  return value as Record<string, unknown>
}

function asArray(value: unknown, field: string): unknown[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new ManifestError(`${field} must be a list.`)
  }
  return value
}

function findDuplicate(names: string[]): string | undefined {
  const seen = new Set<string>()
  return names.find((name) => (seen.has(name) ? true : (seen.add(name), false)))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
