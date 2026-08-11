/** Turning a file the user dropped into a validated, verified bundle. */

import { readArchive, type ArchiveEntries } from './archive'
import { parseManifest, type BundleManifest } from './manifest'
import { verifyBundle, type BundleDigests } from './verify'

export { ArchiveError, type ArchiveEntries } from './archive'
export { ManifestError, type BundleCanister, type BundleManifest, type SyncStep } from './manifest'
export { IntegrityError, sha256Hex } from './verify'

export interface Bundle {
  /** Where the bundle came from, when the source carried a name. */
  fileName?: string
  manifest: BundleManifest
  digests: BundleDigests
  /** Everything unpacked from the archive; sync steps read their files from here. */
  entries: ArchiveEntries
}

/** Anything a bundle's bytes can arrive as. */
export type BundleSource = Bundle | File | Blob | Uint8Array | ArrayBuffer

export function isBundle(source: BundleSource): source is Bundle {
  return typeof source === 'object' && source !== null && 'manifest' in source
}

/**
 * Reads, validates, and verifies a bundle. Throws `ArchiveError`, `ManifestError`,
 * or `IntegrityError` with a message meant to be shown to the user as-is.
 */
export async function loadBundle(source: BundleSource): Promise<Bundle> {
  if (isBundle(source)) return source

  const entries = await readArchive(await bytesOf(source))
  const manifest = parseManifest(entries)
  const digests = await verifyBundle(manifest)
  return { fileName: nameOf(source), manifest, digests, entries }
}

async function bytesOf(source: Exclude<BundleSource, Bundle>): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source
  if (source instanceof ArrayBuffer) return new Uint8Array(source)
  return new Uint8Array(await source.arrayBuffer())
}

function nameOf(source: Exclude<BundleSource, Bundle>): string | undefined {
  return source instanceof File ? source.name : undefined
}
