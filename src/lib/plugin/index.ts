/**
 * Running a bundle's sync plugin, through jco.
 *
 * A plugin is a WebAssembly component (`wasm32-wasip2`), which browsers cannot
 * instantiate. This is the adapter that makes one runnable: jco's bindgen lowers
 * it to JavaScript, `preview2-shim` supplies the WASI world, and agent-js backs
 * its one non-WASI import. The step is resolved before it gets here — which
 * wasm, which directories, which canister — so all that is left is to run it.
 *
 * Because it is the same wasm `icp sync` runs, what lands on the canister —
 * compression, clean URLs, redirect rules, the resulting state hash — matches a
 * CLI deployment rather than approximating it.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import { Principal } from '@icp-sdk/core/principal'
import type { PluginRequest } from '../wasm/deployer'
import { createCanisterCall } from './canister-call'
import { supportsJspi, transpilePlugin } from './transpile'
import { createSandbox, selectImports } from './wasi'

export { supportsJspi, TranspileError } from './transpile'
export { SandboxError } from './wasi'

export class SyncError extends Error {}

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

/**
 * Builds the plugin runner the module calls, bound to the agent whose identity
 * the deployment signs as.
 */
export function createPluginRunner(
  agent: HttpAgent,
  identityPrincipal: Principal,
): (request: PluginRequest) => Promise<void> {
  return async (request) => {
    if (!supportsJspi()) {
      throw new SyncError(
        'This browser cannot run sync plugins: it lacks WebAssembly JSPI, which lets the ' +
          'plugin wait for canister calls. Chrome 137+ and Edge support it today; in Firefox ' +
          'it is behind a flag. Canisters and wasm installs work in any browser.',
      )
    }

    const canisterId = Principal.fromText(request.canisterId)
    const { js, cores, imports: required } = await transpilePlugin(request.wasm)
    const sandbox = await createSandbox({
      tree: request.tree,
      canisterCall: createCanisterCall(agent, canisterId),
      onOutput: request.onOutput,
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
        canisterId: request.canisterId,
        environment: request.environment,
        dirs: request.dirs,
        files: request.files,
        identityPrincipal: identityPrincipal.toText(),
        proxyCanisterId: undefined,
      })
    } finally {
      sandbox.dispose()
    }
  }
}

/**
 * Loads the generated glue as a module. It is self-contained — the bindgen
 * inlines everything and takes its imports as arguments — so a URL wrapping the
 * source is all it needs. A `data:` URL is the fallback for hosts that reject
 * `blob:`.
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
