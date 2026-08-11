/**
 * The library's entry point: a deployer bound to one agent.
 *
 * Everything a deployment needs beyond the bundle itself comes from the agent — who
 * it signs as, which network it talks to, and therefore which environment name sync
 * plugins are told about. That leaves one decision at the call site: the bundle, and
 * optionally the subnet to put it on.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import { Principal } from '@icp-sdk/core/principal'
import { loadBundle, type Bundle, type BundleSource } from './bundle'
import { deployBundle, type DeployEvent, type DeployResult } from './deploy'
import { DEFAULT_CREATION_CYCLES } from './ic/create'
import { isMainnetRootKey } from './ic/root-key'

export interface DeployerOptions {
  /** Signs every call. Its principal controls what the deployment creates. */
  agent: HttpAgent
  /** Cycles used to fund each canister. Defaults to the 2T `icp deploy` uses. */
  cycles?: bigint
  /**
   * Environment name passed to sync plugins. Derived from the agent's root key when
   * omitted — `ic` on mainnet, `local` anywhere else — which is informational to the
   * plugin either way.
   */
  environment?: string
}

export interface DeployOptions {
  /**
   * Put every canister on this subnet, as `icp deploy --subnet` does. Omitted, one
   * subnet is resolved for the whole bundle so its canisters stay together.
   */
  subnet?: Principal | string
  /** Progress as it happens: creation, settings, installs, plugin output. */
  onEvent?: (event: DeployEvent) => void
}

export interface Deployer {
  /**
   * Unpacks and verifies a bundle without deploying anything, for inspecting what a
   * bundle contains before committing to it. `deploy` accepts the result, or the
   * same sources directly.
   */
  load(source: BundleSource): Promise<Bundle>
  deploy(source: BundleSource, options?: DeployOptions): Promise<DeployResult>
}

export function createDeployer({
  agent,
  cycles = DEFAULT_CREATION_CYCLES,
  environment,
}: DeployerOptions): Deployer {
  return {
    load: (source) => loadBundle(source),

    async deploy(source, { subnet, onEvent } = {}) {
      const bundle = await loadBundle(source)

      return deployBundle({
        bundle,
        agent,
        identityPrincipal: await agent.getPrincipal(),
        subnet: subnet === undefined ? undefined : toPrincipal(subnet),
        cycles,
        environment: environment ?? environmentOf(agent),
        onEvent,
      })
    },
  }
}

function toPrincipal(subnet: Principal | string): Principal {
  return typeof subnet === 'string' ? Principal.fromText(subnet) : subnet
}

/**
 * An agent that has not been told its root key cannot be mainnet — it would be
 * using the built-in one — so treat the unknown case as a test network.
 */
function environmentOf(agent: HttpAgent): string {
  return agent.rootKey && isMainnetRootKey(agent.rootKey) ? 'ic' : 'local'
}
