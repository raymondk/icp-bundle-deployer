/**
 * Deploy an application bundle to the Internet Computer from anywhere an agent
 * works, browser included.
 *
 * ```ts
 * const deployer = createDeployer({ agent })
 * const result = await deployer.deploy(file, { subnet, onEvent: console.log })
 * ```
 *
 * A bundle is a tar — optionally gzipped, conventionally `.icp` — holding a
 * resolved `icp.yaml` and the artifacts it names. Deploying one creates every
 * canister the manifest declares, gives each the whole set of canister IDs so
 * they can find one another, installs their wasm, and runs any sync plugin the
 * bundle carries.
 *
 * Reading the manifest, installing and syncing are done by
 * [`icp-deploy-canister`](https://github.com/dfinity/icp-cli) — the crate
 * icp-cli itself deploys with — compiled to WebAssembly and wrapped by this
 * library. Nothing about that shows through: the module is loaded for you, and
 * everything below takes and returns ordinary JavaScript.
 */

export { createDeployer } from './deployer'
export type { Deployer, DeployerOptions, DeployOptions } from './deployer'

export { loadBundle, isBundle, Bundle } from './bundle'
export type { BundleSource, BundleCanister } from './bundle'

export type { DeployEvent, DeployResult, DeployedCanister } from './events'

// Loading the module is automatic; this is only needed where it cannot be
// fetched from alongside the library, such as a plain Node process.
export { initialize } from './init'

// Errors are exported so callers can tell a bad bundle from a network failure;
// each carries a message meant to be shown to a user unchanged.
export { BundleError, ArchiveError, ManifestError, IntegrityError } from './bundle'
export { CyclesLedgerError } from './ic/cycles-ledger'
export { EngineError } from './ic/engine'
export { SyncError, TranspileError, SandboxError } from './plugin'

export { sha256Hex, formatBytes } from './format'
export { cyclesBalance, formatCycles, CYCLES_LEDGER_CANISTER_ID } from './ic/cycles-ledger'
export { createCanister, DEFAULT_CREATION_CYCLES } from './ic/create'
export { createPlacement } from './ic/placement'
export type { Placement, PlacementOptions } from './ic/placement'
export { resolveSubnet, subnetOf, CYCLES_MINTING_CANISTER_ID } from './ic/subnet'
export { resolveEngineOperator, ENGINE_CANISTER_ID } from './ic/engine'
export { isMainnetRootKey } from './ic/root-key'
export { supportsJspi } from './plugin'
