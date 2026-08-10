/** Turning a file the user dropped into a validated, verified bundle. */

import { readArchive } from './archive'
import { parseManifest, type BundleManifest } from './manifest'
import { verifyBundle, type BundleDigests } from './verify'

export { ArchiveError } from './archive'
export { ManifestError, type BundleCanister, type BundleManifest } from './manifest'
export { IntegrityError, sha256Hex } from './verify'

export interface Bundle {
  fileName: string
  manifest: BundleManifest
  digests: BundleDigests
}

/**
 * Reads, validates, and verifies a bundle. Throws `ArchiveError`, `ManifestError`,
 * or `IntegrityError` with a message meant to be shown to the user as-is.
 */
export async function loadBundle(file: File): Promise<Bundle> {
  const entries = await readArchive(new Uint8Array(await file.arrayBuffer()))
  const manifest = parseManifest(entries)
  const digests = await verifyBundle(manifest)
  return { fileName: file.name, manifest, digests }
}
