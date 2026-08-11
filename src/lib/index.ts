/**
 * Deploy an application bundle to the Internet Computer from anywhere an agent
 * works, browser included.
 *
 * ```ts
 * const deployer = createDeployer({ agent })
 * const result = await deployer.deploy(file, { subnet, onEvent: console.log })
 * ```
 *
 * A bundle is a tar — optionally gzipped, conventionally `.icp` — holding a resolved
 * `icp.yaml` and the artifacts it names. Deploying one creates every canister the
 * manifest declares, gives each the whole set of canister IDs so they can find one
 * another, installs their wasm, and runs any sync plugin the bundle carries.
 */

export { createDeployer } from './deployer'
export type { Deployer, DeployerOptions, DeployOptions } from './deployer'

export { loadBundle, isBundle } from './bundle'
export type { Bundle, BundleSource, BundleCanister, BundleManifest, SyncStep } from './bundle'

export { deployBundle, formatBytes } from './deploy'
export type { DeployBundleOptions, DeployEvent, DeployResult, DeployedCanister } from './deploy'

// Errors are exported so callers can tell a bad bundle from a network failure; each
// carries a message meant to be shown to a user unchanged.
export { ArchiveError, ManifestError, IntegrityError, sha256Hex } from './bundle'
export { CyclesLedgerError, cyclesBalance, formatCycles } from './ic/cycles-ledger'
export { EngineError, resolveEngineOperator, ENGINE_CANISTER_ID } from './ic/engine'
export { SyncError, TranspileError, SandboxError, supportsJspi } from './sync'

export { createCanister, applySettings, DEFAULT_CREATION_CYCLES } from './ic/create'
export { installCode } from './ic/install'
export { resolveSubnet, subnetOf, CYCLES_MINTING_CANISTER_ID } from './ic/subnet'
export { isMainnetRootKey } from './ic/root-key'
