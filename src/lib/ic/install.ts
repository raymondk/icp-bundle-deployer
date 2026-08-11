/**
 * Installing a wasm into a canister.
 *
 * Ingress messages are capped at 2 MiB, which a wasm can easily exceed, so anything
 * large goes up through the management canister's chunk store first and is installed
 * by hash.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import type { Principal } from '@icp-sdk/core/principal'
import { IcManagementCanister } from '@icp-sdk/canisters/ic-management'
import { sha256Hex } from '../bundle'

/**
 * Largest wasm sent in a single `install_code`. Well under the 2 MiB ingress limit,
 * leaving room for the init argument and the envelope around them.
 */
const MAX_SINGLE_MESSAGE_WASM = 1_500_000

/** The management canister accepts at most 1 MiB per `upload_chunk` call. */
const CHUNK_SIZE = 1_000_000

export interface InstallOptions {
  /** Reports progress while a large wasm is uploaded chunk by chunk. */
  onProgress?: (uploadedChunks: number, totalChunks: number) => void
}

export async function installCode(
  agent: HttpAgent,
  canisterId: Principal,
  wasm: Uint8Array,
  arg: Uint8Array,
  options: InstallOptions = {},
): Promise<void> {
  const management = IcManagementCanister.create({ agent })
  const mode = { install: null }

  if (wasm.length <= MAX_SINGLE_MESSAGE_WASM) {
    await management.installCode({ mode, canisterId, wasmModule: wasm, arg })
    return
  }

  // The chunk store is per canister and persists between installs; clear it so a
  // retry never mixes chunks from an earlier attempt.
  await management.clearChunkStore({ canisterId })

  const chunks = splitIntoChunks(wasm)
  const chunkHashesList = []
  for (const [index, chunk] of chunks.entries()) {
    chunkHashesList.push(await management.uploadChunk({ canisterId, chunk }))
    options.onProgress?.(index + 1, chunks.length)
  }

  await management.installChunkedCode({
    mode,
    arg,
    targetCanisterId: canisterId,
    chunkHashesList,
    wasmModuleHash: await sha256Hex(wasm),
  })
}

function splitIntoChunks(wasm: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < wasm.length; offset += CHUNK_SIZE) {
    chunks.push(wasm.subarray(offset, Math.min(offset + CHUNK_SIZE, wasm.length)))
  }
  return chunks
}
