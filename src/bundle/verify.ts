/**
 * Integrity checks over a bundle's artifacts.
 *
 * Every wasm is hashed before anything is deployed, so a corrupt or tampered
 * bundle fails while it is still just bytes in a browser tab — not after some of
 * its canisters already exist on chain.
 */

import type { BundleManifest } from './manifest'

export class IntegrityError extends Error {}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Digest of each canister's wasm, keyed by canister name. */
export type BundleDigests = Map<string, string>

/**
 * Hashes every wasm and compares it against the digest the manifest declares.
 * Canisters whose manifest omits `sha256` are hashed for display but not enforced.
 */
export async function verifyBundle(manifest: BundleManifest): Promise<BundleDigests> {
  const digests: BundleDigests = new Map()

  for (const canister of manifest.canisters) {
    const digest = await sha256Hex(canister.wasm)
    digests.set(canister.name, digest)

    if (canister.sha256 !== undefined && canister.sha256 !== digest) {
      throw new IntegrityError(
        `"${canister.wasmPath}" does not match the digest declared for canister ` +
          `"${canister.name}".\n  expected ${canister.sha256}\n  actual   ${digest}`,
      )
    }
  }

  return digests
}
