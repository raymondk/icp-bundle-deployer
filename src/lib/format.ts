/** Turning bytes and digests into something worth reading. */

import { initialize } from './init'
import { sha256Hex as digest } from './wasm/deployer'

/** A byte count, for showing how big a wasm is. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/**
 * The SHA-256 of some bytes, lowercase hex — the form `icp.yaml` declares
 * digests in.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  await initialize()
  return digest(bytes)
}
