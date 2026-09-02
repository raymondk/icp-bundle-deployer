/**
 * Turning a file someone dropped into a bundle this library will deploy.
 *
 * Reading the archive, parsing `icp.yaml` and hashing every artifact all happen
 * in the module — the manifest is read by the same code icp-cli reads it with —
 * so what arrives here is either a bundle that can be deployed or an error
 * saying why it cannot.
 */

import { initialize } from './init'
import { loadBundle as loadCore, type Bundle as CoreBundle } from './wasm/deployer'

/** Anything a bundle's bytes can arrive as. */
export type BundleSource = Bundle | File | Blob | Uint8Array | ArrayBuffer

/** One canister's contribution to a bundle. */
export interface BundleCanister {
  name: string
  /** Path of the wasm inside the archive, relative to the bundle root. */
  wasmPath: string
  wasmSize: number
  /** The digest the manifest declared, when it declared one. */
  sha256?: string
  /** The digest the wasm actually has. */
  digest: string
  /** Directories the canister's sync steps upload. */
  syncDirs: string[]
}

/** A bundle refused before anything was deployed. */
export class BundleError extends Error {}
/** The archive would not open. */
export class ArchiveError extends BundleError {}
/** The manifest declares something this deployer cannot honour. */
export class ManifestError extends BundleError {}
/** An artifact does not match the digest declared for it. */
export class IntegrityError extends BundleError {}

/**
 * A bundle that has been read, validated and verified. Holds the unpacked
 * archive, so a large one is worth [`dispose`]ing once it is no longer needed.
 */
export class Bundle {
  readonly fileName?: string
  readonly canisters: readonly BundleCanister[]
  readonly #core: CoreBundle

  /** @internal Bundles come from {@link loadBundle}. */
  constructor(core: CoreBundle, fileName?: string) {
    this.#core = core
    this.fileName = fileName
    this.canisters = core.canisters as BundleCanister[]
  }

  /** @internal */
  static core(bundle: Bundle): CoreBundle {
    return bundle.#core
  }

  /** Releases the memory holding the bundle's contents. */
  dispose(): void {
    this.#core.free()
  }
}

export function isBundle(source: BundleSource): source is Bundle {
  return source instanceof Bundle
}

/**
 * Reads, validates and verifies a bundle. Throws `ArchiveError`,
 * `ManifestError` or `IntegrityError`, each with a message meant to be shown to
 * the user as it is.
 */
export async function loadBundle(source: BundleSource): Promise<Bundle> {
  if (isBundle(source)) return source
  await initialize()

  try {
    return new Bundle(await loadCore(await bytesOf(source)), nameOf(source))
  } catch (error) {
    throw refusal(error)
  }
}

/** The module tags a refusal with which of its three checks refused it. */
function refusal(error: unknown): Error {
  if (!(error instanceof Error)) return new BundleError(String(error))
  switch ((error as { kind?: string }).kind) {
    case 'archive':
      return new ArchiveError(error.message)
    case 'manifest':
      return new ManifestError(error.message)
    case 'integrity':
      return new IntegrityError(error.message)
    default:
      return error
  }
}

async function bytesOf(source: Exclude<BundleSource, Bundle>): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source
  if (source instanceof ArrayBuffer) return new Uint8Array(source)
  return new Uint8Array(await source.arrayBuffer())
}

function nameOf(source: Exclude<BundleSource, Bundle>): string | undefined {
  return source instanceof File ? source.name : undefined
}
