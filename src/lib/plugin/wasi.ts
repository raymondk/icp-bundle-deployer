/**
 * The sandbox a sync plugin runs in.
 *
 * icp-cli gives a plugin a WASI world with the declared directories preopened
 * read-only and nothing else — no network, no writable filesystem. The browser
 * gets the same shape: `preview2-shim`'s in-memory filesystem, populated from
 * the files the module read out of the bundle, so the plugin sees exactly the
 * paths its manifest declared and nothing beyond them.
 *
 * Each directory is preopened at the path the manifest wrote it as, which is
 * also the only path the plugin will open it at — including one that rose out of
 * the canister directory with `..`. Nothing else is mounted, so a path the
 * manifest never declared resolves to no preopen at all and the open fails,
 * which is the sandbox doing its job rather than a missing file.
 */

import type { CanisterImports } from './canister'

/** A directory in the shim's virtual filesystem. */
interface VirtualDir {
  dir: Record<string, VirtualDir | VirtualFile>
}
interface VirtualFile {
  source: Uint8Array
}

export interface WasiSandbox {
  imports: Record<string, unknown>
  /** Releases the stdout/stderr hooks and mounts this sandbox installed. */
  dispose: () => void
}

export interface SandboxOptions {
  /**
   * What to mount and where: each entry is a directory the plugin opens at the
   * key's path, holding that tree's files by their path within it.
   */
  mounts: Map<string, Map<string, Uint8Array>>
  /** Implements the plugin's non-WASI imports. */
  canister: CanisterImports
  /** Receives whatever the plugin prints. */
  onOutput: (line: string) => void
}

export class SandboxError extends Error {}

export async function createSandbox({
  mounts,
  canister,
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

  // Resets the root the shim starts with, then replaces the preopen set
  // outright: the root is not among the mounts, so nothing outside them is
  // reachable even by absolute path.
  filesystem._setFileData({ dir: {} })
  filesystem._setPreopens(
    Object.fromEntries([...mounts].map(([path, tree]) => [path, buildFileTree(tree)])),
  )

  // The plugin narrates its progress on stdout/stderr; that commentary is the
  // most useful thing to show while a sync runs. A guest writes one printed line
  // in as many pieces as its formatting takes, so the bytes are buffered and
  // split on newlines rather than reported one write at a time — a line the
  // plugin printed arrives as a line, the way icp-cli shows it.
  const stdout = lineSink(onOutput)
  const stderr = lineSink(onOutput)
  const discard = { write() {} }
  cli._setStdout(stdout)
  cli._setStderr(stderr)

  const imports: Record<string, unknown> = {
    'canister-call': { default: canister.canisterCall },
    'canister-metadata-section': { default: canister.canisterMetadataSection },
    'canister-set-environment-variable': { default: canister.canisterSetEnvironmentVariable },
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
      // Whatever the plugin printed without a closing newline is still worth
      // showing; it is often the message explaining how the run ended.
      stdout.flush()
      stderr.flush()
      cli._setStdout(discard)
      cli._setStderr(discard)
      filesystem._setPreopens({})
      filesystem._setFileData({ dir: {} })
    },
  }
}

/**
 * A stream that reassembles the guest's writes into the lines it printed. Each
 * stream needs its own, so a half-written line on one does not swallow the
 * other's.
 */
function lineSink(onLine: (line: string) => void) {
  const decoder = new TextDecoder()
  let pending = ''

  return {
    write(contents: Uint8Array) {
      // Streaming, so a multi-byte character split across two writes is decoded
      // once both halves have arrived rather than as a replacement character.
      pending += decoder.decode(contents, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) if (line !== '') onLine(line)
    },
    flush() {
      pending += decoder.decode()
      if (pending !== '') onLine(pending)
      pending = ''
    },
  }
}

/**
 * Checks that every import the transpiled plugin asks for is one we can supply,
 * and returns just those. A plugin reaching for an interface we do not
 * implement — sockets, say — must fail loudly rather than at some random point
 * mid-sync.
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

/** Nests one mount's flat path → contents map into the tree the shim expects. */
function buildFileTree(tree: Map<string, Uint8Array>): VirtualDir {
  const root: VirtualDir = { dir: {} }

  for (const [path, contents] of tree) {
    const segments = path.split('/').filter((segment) => segment !== '')
    const fileName = segments.pop()
    if (fileName === undefined) continue

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

  return root
}
