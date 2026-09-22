/**
 * Loading the WebAssembly module the library is built on.
 *
 * Every entry point does this for you, so the module being WebAssembly is not
 * something a caller has to know. The one case that needs a word is Node: the
 * generated loader resolves the module relative to its own URL and fetches it,
 * which a browser and a bundler both do and a plain Node process does not. Hand
 * the bytes to `initialize` there and everything after it is the same.
 */

import init, { type InitInput } from './wasm/deployer'

let started: Promise<void> | undefined

/**
 * Loads the module, at most once. Safe to call repeatedly; later calls return
 * the same promise and ignore their argument.
 *
 * @param source Where the module comes from. Omitted, it is fetched from
 * alongside the library, which is what a bundler and a browser want.
 */
export function initialize(source?: InitInput): Promise<void> {
  // Only success is remembered. The failure worth planning for is a Node process
  // that reached the library before handing over the bytes, and the call that
  // does hand them over has to be able to succeed.
  started ??= init(source === undefined ? undefined : { module_or_path: source })
    .then(() => {})
    .catch((error: unknown) => {
      started = undefined
      throw error
    })
  return started
}
