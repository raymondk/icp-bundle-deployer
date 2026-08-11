/**
 * The sandbox the plugin runs in.
 *
 * icp-cli gives a sync plugin a WASI world with the declared directories preopened
 * read-only and nothing else — no network, no writable filesystem. The browser gets
 * the same shape: `preview2-shim`'s in-memory filesystem, populated from the files
 * already unpacked out of the bundle, so the plugin sees exactly the paths its
 * manifest declared and nothing beyond them.
 */

import type { ArchiveEntries } from '../bundle/archive'

/** A directory in the shim's virtual filesystem. */
interface VirtualDir {
  dir: Record<string, VirtualDir | VirtualFile>
}
interface VirtualFile {
  source: Uint8Array
}

export interface WasiSandbox {
  imports: Record<string, unknown>
  /** Releases the stdout/stderr hooks this sandbox installed. */
  dispose: () => void
}

export interface SandboxOptions {
  /** Everything unpacked from the bundle; only the declared dirs are exposed. */
  entries: ArchiveEntries
  /** Directory paths the sync step declared, relative to the bundle root. */
  dirs: string[]
  /** Implements the plugin's one non-WASI import. */
  canisterCall: (request: CanisterCallRequest) => Promise<Uint8Array>
  /** Receives whatever the plugin prints. */
  onOutput: (line: string) => void
}

export interface CanisterCallRequest {
  method: string
  arg: Uint8Array
  callType: 'update' | 'query'
  direct: boolean
  cycles: bigint
}

export class SandboxError extends Error {}

export async function createSandbox({
  entries,
  dirs,
  canisterCall,
  onOutput,
}: SandboxOptions): Promise<WasiSandbox> {
  // The browser builds of these shims hold module-level state, so a sandbox is
  // effectively a singleton — syncs run one at a time, which they do anyway.
  const [cli, clocks, filesystem, io, random] = await Promise.all([
    import('@bytecodealliance/preview2-shim/cli'),
    import('@bytecodealliance/preview2-shim/clocks'),
    import('@bytecodealliance/preview2-shim/filesystem'),
    import('@bytecodealliance/preview2-shim/io'),
    import('@bytecodealliance/preview2-shim/random'),
  ])

  filesystem._setFileData(buildFileTree(entries, dirs))

  // The plugin narrates its progress on stdout/stderr; that commentary is the most
  // useful thing to show while a sync runs.
  const sink = {
    write(contents: Uint8Array) {
      const text = new TextDecoder().decode(contents).replace(/\n+$/, '')
      if (text !== '') onOutput(text)
    },
  }
  const discard = { write() {} }
  cli._setStdout(sink)
  cli._setStderr(sink)

  const imports: Record<string, unknown> = {
    'canister-call': { default: canisterCall },
    'wasi:cli/environment': cli.environment,
    'wasi:cli/exit': cli.exit,
    'wasi:cli/stdin': cli.stdin,
    'wasi:cli/stdout': cli.stdout,
    'wasi:cli/stderr': cli.stderr,
    'wasi:cli/terminal-input': cli.terminalInput,
    'wasi:cli/terminal-output': cli.terminalOutput,
    'wasi:cli/terminal-stdin': cli.terminalStdin,
    'wasi:cli/terminal-stdout': cli.terminalStdout,
    'wasi:cli/terminal-stderr': cli.terminalStderr,
    'wasi:clocks/wall-clock': clocks.wallClock,
    'wasi:clocks/monotonic-clock': clocks.monotonicClock,
    'wasi:filesystem/preopens': filesystem.preopens,
    'wasi:filesystem/types': filesystem.types,
    'wasi:io/error': io.error,
    'wasi:io/poll': io.poll,
    'wasi:io/streams': io.streams,
    'wasi:random/insecure-seed': random.insecureSeed,
    'wasi:random/random': random.random,
  }

  return {
    imports,
    dispose: () => {
      cli._setStdout(discard)
      cli._setStderr(discard)
      filesystem._setFileData({ dir: {} })
    },
  }
}

/**
 * Checks that every import the transpiled plugin asks for is one we can supply,
 * and returns just those. A plugin reaching for an interface we do not implement —
 * sockets, say — must fail loudly rather than at some random point mid-sync.
 */
export function selectImports(
  sandbox: WasiSandbox,
  required: string[],
): Record<string, unknown> {
  const selected: Record<string, unknown> = {}
  const missing: string[] = []

  for (const name of required) {
    const value = sandbox.imports[name]
    if (value === undefined) missing.push(name)
    else selected[name] = value
  }

  if (missing.length > 0) {
    throw new SandboxError(
      `This sync plugin needs capabilities this deployer cannot provide in a browser: ` +
        `${missing.join(', ')}.`,
    )
  }
  return selected
}

/**
 * Mirrors the declared directories into a virtual filesystem rooted at `/`, at the
 * same relative paths the manifest used — the plugin resolves `dirs` entries against
 * the working directory exactly as it would under icp-cli.
 */
function buildFileTree(entries: ArchiveEntries, dirs: string[]): VirtualDir {
  const root: VirtualDir = { dir: {} }
  const prefixes = dirs.map((dir) => (dir.endsWith('/') ? dir : `${dir}/`))
  let matched = 0

  for (const [path, contents] of entries) {
    if (!prefixes.some((prefix) => path.startsWith(prefix))) continue
    matched++

    const segments = path.split('/')
    const fileName = segments.pop()!
    let directory = root
    for (const segment of segments) {
      const existing = directory.dir[segment]
      if (existing && 'dir' in existing) {
        directory = existing
      } else {
        const created: VirtualDir = { dir: {} }
        directory.dir[segment] = created
        directory = created
      }
    }
    directory.dir[fileName] = { source: contents }
  }

  if (matched === 0) {
    throw new SandboxError(
      `The bundle declares ${dirs.map((dir) => `"${dir}"`).join(', ')} for syncing, but it ` +
        'contains no files under those paths.',
    )
  }
  return root
}
