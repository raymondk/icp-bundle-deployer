/**
 * Turns the sync plugin a bundle carries into something a browser can run.
 *
 * The plugin is a WebAssembly component (`wasm32-wasip2`), which browsers cannot
 * instantiate directly. jco's bindgen lowers it to plain JS plus core modules, and
 * we do that here at runtime rather than shipping a pre-transpiled copy — so a
 * bundle built against any plugin release deploys without changing this app.
 *
 * The plugin's host imports are declared synchronous in its world, but talking to
 * a replica is asynchronous. JSPI bridges that: those imports are marked async,
 * and the generated glue suspends the wasm stack while the promise settles.
 *
 * Every version of the interface names its host functions the same way, so the
 * lowering here is the same for all of them. What differs is the shape of what
 * `exec` is handed, and the module has already read that off the component and
 * says so in the request.
 */

import { sha256Hex } from '../wasm/deployer'

/** The host functions the plugin's world may import, all of them async. */
const HOST_IMPORTS = [
  'canister-call',
  'canister-metadata-section',
  'canister-set-environment-variable',
]

export interface TranspiledPlugin {
  /** Self-contained ES module source exporting `instantiate`. */
  js: string
  /** Core wasm modules, keyed by the name the glue asks for. */
  cores: Map<string, Uint8Array>
  /** Import keys the glue expects to be supplied. */
  imports: string[]
}

/** Transpiling the same plugin twice per deployment is pure waste. */
const cache = new Map<string, Promise<TranspiledPlugin>>()

export class TranspileError extends Error {}

/**
 * Whether this browser can suspend a wasm stack on a promise. Without it the
 * plugin cannot make canister calls, so there is no point starting a sync.
 */
export function supportsJspi(): boolean {
  return typeof (WebAssembly as { Suspending?: unknown }).Suspending === 'function'
}

export async function transpilePlugin(wasm: Uint8Array): Promise<TranspiledPlugin> {
  const key = sha256Hex(wasm)
  const cached = cache.get(key)
  if (cached) return cached

  const pending = generate(wasm)
  cache.set(key, pending)
  try {
    return await pending
  } catch (error) {
    cache.delete(key)
    throw error
  }
}

async function generate(wasm: Uint8Array): Promise<TranspiledPlugin> {
  // Loaded on demand: the bindgen carries a few MB of wasm that a bundle without
  // sync steps never needs.
  const bindgen = await import('@bytecodealliance/jco-transpile/component')
  await bindgen.$init

  let generated
  try {
    generated = bindgen.generate(wasm, {
      name: 'plugin',
      map: [],
      // Hand every import in at instantiation instead of letting the glue import
      // modules by name — there is no module resolver for them in the browser.
      instantiation: { tag: 'async' },
      asyncMode: { tag: 'jspi', val: { imports: HOST_IMPORTS, exports: ['exec'] } },
      validLiftingOptimization: false,
      tracing: false,
      noNodejsCompat: true,
      noTypescript: true,
      tlaCompat: false,
      // Keep core modules as separate files rather than base64 in the JS, so they
      // can be compiled asynchronously.
      base64Cutoff: 0,
      noNamespacedExports: true,
      multiMemory: false,
      bindgenEnableWasmExnref: false,
      strict: false,
      asmjs: false,
    })
  } catch (error) {
    throw new TranspileError(
      `This bundle's sync plugin could not be prepared for the browser: ${describe(error)}`,
    )
  }

  const cores = new Map<string, Uint8Array>()
  let js: string | undefined
  for (const [name, contents] of generated.files) {
    if (name.endsWith('.js')) js = new TextDecoder().decode(contents)
    else if (name.endsWith('.wasm')) cores.set(name, contents)
  }
  if (!js) {
    throw new TranspileError("The sync plugin produced no JavaScript module; it may not be a plugin.")
  }

  return { js, cores, imports: generated.imports }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
