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
import { createCanisterImports } from './canister'
import { supportsJspi, transpilePlugin } from './transpile'
import { createSandbox, selectImports } from './wasi'

export { supportsJspi, TranspileError } from './transpile'
export { SandboxError } from './wasi'

export class SyncError extends Error {}

/** What both versions of the interface hand `exec`. */
interface CommonExecInput {
  canisterId: string
  environment: string
  identityPrincipal: string
  proxyCanisterId?: string
}

/**
 * The v0.1.0 shape: directories are bare paths, files carry no key, and there is
 * no field, canister table, or call target anywhere in it.
 */
interface SyncExecInputV1 extends CommonExecInput {
  dirs: string[]
  files: { name: string; content: string }[]
}

/**
 * The v0.2.0 shape: every declared path keeps the key it was written under, and
 * the plugin is additionally handed the step's fields and the names of every
 * canister the deployment created.
 */
interface SyncExecInputV2 extends CommonExecInput {
  dirs: { key?: string; path: string }[]
  files: { key?: string; name: string; content: string }[]
  fields: { name: string; value: string }[]
  canisterIds: { name: string; id: string }[]
}

interface PluginModule {
  instantiate: (
    getCoreModule: (path: string) => Promise<WebAssembly.Module>,
    imports: Record<string, unknown>,
  ) => Promise<{ exec: (input: SyncExecInputV1 | SyncExecInputV2) => Promise<void> }>
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
      mounts: request.mounts,
      canister: createCanisterImports({ agent, canisterId, callable: request.callable }),
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

      await instance.exec(execInput(request, identityPrincipal))
    } finally {
      sandbox.dispose()
    }
  }
}

/**
 * What `exec` is handed, in the shape the plugin's own interface version
 * declares. A v0.1.0 plugin is given the paths without their keys and told
 * nothing about the step's fields or the deployment's other canisters — it has
 * nowhere to put any of it, and this is the same reduction icp-cli makes.
 */
function execInput(
  request: PluginRequest,
  identityPrincipal: Principal,
): SyncExecInputV1 | SyncExecInputV2 {
  const common: CommonExecInput = {
    canisterId: request.canisterId,
    environment: request.environment,
    identityPrincipal: identityPrincipal.toText(),
    // A proxy is something the CLI is given on the command line; a browser
    // deployment has none, so every call the plugin makes goes direct.
    proxyCanisterId: undefined,
  }

  if (request.abi === 'v1') {
    return {
      ...common,
      dirs: request.dirs.map((dir) => dir.path),
      files: request.files.map(({ name, content }) => ({ name, content })),
    }
  }

  return {
    ...common,
    dirs: request.dirs,
    files: request.files,
    fields: request.fields,
    canisterIds: request.canisterIds,
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
