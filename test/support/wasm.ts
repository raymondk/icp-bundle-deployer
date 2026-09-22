/**
 * Loading the library's WebAssembly module under Node.
 *
 * A browser and a bundler both resolve the module from alongside the library and
 * fetch it; Node cannot fetch a `file:` URL, so the bytes are handed over
 * explicitly. This is the whole of what `initialize` exists for.
 */

import { readFile } from 'node:fs/promises'
import { initialize } from '../../src/lib'

const MODULE = new URL('../../src/lib/wasm/deployer_bg.wasm', import.meta.url)

export async function loadModule(): Promise<void> {
  await initialize(await readFile(MODULE))
}
