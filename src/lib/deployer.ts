/**
 * The library's entry point: a deployer bound to one agent.
 *
 * Everything a deployment needs beyond the bundle itself comes from the agent —
 * who it signs as, which network it talks to, and therefore which environment
 * the manifest is read for. That leaves one decision at the call site: the
 * bundle, and optionally the subnet to put it on.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import { Principal } from '@icp-sdk/core/principal'
import { Bundle, loadBundle, type BundleSource } from './bundle'
import type { DeployEvent, DeployResult } from './events'
import { createHost } from './host'
import { DEFAULT_CREATION_CYCLES } from './ic/create'
import { isMainnetRootKey } from './ic/root-key'
import { initialize } from './init'
import { deployBundle } from './wasm/deployer'

export interface DeployerOptions {
  /** Signs every call. Its principal controls what the deployment creates. */
  agent: HttpAgent
  /** Cycles used to fund each canister. Defaults to the 2T `icp deploy` uses. */
  cycles?: bigint
  /**
   * The environment the manifest is read for, which decides which of its
   * overrides apply and what sync plugins are told they are running against.
   * Derived from the agent's root key when omitted — `ic` on mainnet, `local`
   * anywhere else.
   */
  environment?: string
}

export interface DeployOptions {
  /**
   * Put every canister on this subnet, as `icp deploy --subnet` does. Omitted,
   * one subnet is resolved for the whole bundle so its canisters stay together.
   */
  subnet?: Principal | string
  /** Progress as it happens: creation, settings, installs, plugin output. */
  onEvent?: (event: DeployEvent) => void
}

export interface Deployer {
  /**
   * Unpacks and verifies a bundle without deploying anything, for inspecting
   * what a bundle contains before committing to it. `deploy` accepts the result,
   * or the same sources directly.
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

    async deploy(source, { subnet, onEvent = () => {} } = {}) {
      const bundle = await loadBundle(source)
      await initialize()

      const identityPrincipal = await agent.getPrincipal()
      const host = createHost({
        agent,
        identityPrincipal,
        cycles,
        subnet: subnet === undefined ? undefined : toPrincipal(subnet),
        onEvent,
      })

      const result = await deployBundle(
        Bundle.core(bundle),
        host,
        identityPrincipal.toText(),
        environment ?? environmentOf(agent),
        (event: RawEvent) => onEvent(enrich(event)),
      )

      return enrichResult(result as RawResult)
    },
  }
}

/** The module reports canister ids as text; the library hands back principals. */
type RawEvent = Omit<DeployEvent, 'canisterId'> & { canisterId?: string }
type RawResult = {
  deployed: { name: string; canisterId: string }[]
  incomplete: { name: string; canisterId: string }[]
  error?: string
}

function enrich(event: RawEvent): DeployEvent {
  return (
    event.canisterId === undefined
      ? event
      : { ...event, canisterId: Principal.fromText(event.canisterId) }
  ) as DeployEvent
}

function enrichResult(result: RawResult): DeployResult {
  const canisters = (list: RawResult['deployed']) =>
    list.map(({ name, canisterId }) => ({ name, canisterId: Principal.fromText(canisterId) }))

  return {
    deployed: canisters(result.deployed),
    incomplete: canisters(result.incomplete),
    error: result.error,
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
