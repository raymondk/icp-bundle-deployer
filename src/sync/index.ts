/**
 * Running a bundle's sync step in the browser.
 *
 * The plugin the bundle carries is the same wasm `icp sync` would run, so what lands
 * on the canister — compression, clean URLs, redirect rules, the state hash — matches
 * a CLI deployment instead of approximating it.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import type { Principal } from '@icp-sdk/core/principal'
import type { ArchiveEntries } from '../bundle/archive'
import type { SyncStep } from '../bundle/manifest'
import { createCanisterCall } from './canister-call'
import { supportsJspi, transpilePlugin } from './transpile'
import { createSandbox, selectImports } from './wasi'

export { supportsJspi, TranspileError } from './transpile'
export { SandboxError } from './wasi'

export class SyncError extends Error {}

export interface RunSyncOptions {
  agent: HttpAgent
  canisterId: Principal
  step: SyncStep
  entries: ArchiveEntries
  /** Principal the calls are signed with; the plugin reports it to the canister. */
  identityPrincipal: Principal
  /** Environment name passed through to the plugin, purely informational. */
  environment: string
  onOutput: (line: string) => void
}

/** The shape the plugin's `exec` export expects. */
interface SyncExecInput {
  canisterId: string
  environment: string
  dirs: string[]
  files: { name: string; content: string }[]
  identityPrincipal: string
  proxyCanisterId?: string
}

interface PluginModule {
  instantiate: (
    getCoreModule: (path: string) => Promise<WebAssembly.Module>,
    imports: Record<string, unknown>,
  ) => Promise<{ exec: (input: SyncExecInput) => Promise<void> }>
}

export async function runSyncStep({
  agent,
  canisterId,
  step,
  entries,
  identityPrincipal,
  environment,
  onOutput,
}: RunSyncOptions): Promise<void> {
  if (!supportsJspi()) {
    throw new SyncError(
      'This browser cannot run sync plugins: it lacks WebAssembly JSPI, which lets the ' +
        'plugin wait for canister calls. Chrome 137+ and Edge support it today; in Firefox ' +
        'it is behind a flag. Canisters and wasm installs work in any browser.',
    )
  }

  const { js, cores, imports: required } = await transpilePlugin(step.wasm)
  const sandbox = await createSandbox({
    entries,
    dirs: step.dirs,
    canisterCall: createCanisterCall(agent, canisterId),
    onOutput,
  })

  try {
    const plugin = await loadModule(js)
    const instance = await plugin.instantiate(
      // Compiled asynchronously: these modules are megabytes, and synchronous
      // compilation of that size is not allowed on the main thread.
      async (path) => {
        const bytes = cores.get(path)
        if (!bytes) throw new SyncError(`The sync plugin is missing its core module ${path}.`)
        return WebAssembly.compile(bytes as BufferSource)
      },
      selectImports(sandbox, required),
    )

    await instance.exec({
      canisterId: canisterId.toText(),
      environment,
      dirs: step.dirs,
      files: step.files,
      identityPrincipal: identityPrincipal.toText(),
      proxyCanisterId: undefined,
    })
  } finally {
    sandbox.dispose()
  }
}

/**
 * Loads the generated glue as a module. It is self-contained — the bindgen inlines
 * everything and takes its imports as arguments — so a URL wrapping the source is
 * all it needs. A `data:` URL is the fallback for hosts that reject `blob:`.
 */
async function loadModule(source: string): Promise<PluginModule> {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  try {
    return (await import(/* @vite-ignore */ url)) as PluginModule
  } catch {
    const dataUrl = `data:text/javascript,${encodeURIComponent(source)}`
    return (await import(/* @vite-ignore */ dataUrl)) as PluginModule
  } finally {
    URL.revokeObjectURL(url)
  }
}
