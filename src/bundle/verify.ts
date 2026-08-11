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
    check(canister.wasmPath, canister.sha256, digest, `canister "${canister.name}"`)

    // A sync plugin runs with the same reach as the deployment itself, so its wasm
    // is held to the same standard as the canister's.
    for (const step of canister.sync) {
      check(
        step.pluginPath,
        step.sha256,
        await sha256Hex(step.wasm),
        `the sync plugin of canister "${canister.name}"`,
      )
    }
  }

  return digests
}

function check(path: string, expected: string | undefined, actual: string, subject: string): void {
  if (expected !== undefined && expected !== actual) {
    throw new IntegrityError(
      `"${path}" does not match the digest declared for ${subject}.\n` +
        `  expected ${expected}\n  actual   ${actual}`,
    )
  }
}
