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
import { Bundle, isBundle, loadBundle, type BundleSource } from './bundle'
import type { DeployEvent, DeployResult } from './events'
import { createHost } from './host'
import { isMainnetRootKey } from './ic/root-key'
import { initialize } from './init'
import { deployBundle } from './wasm/deployer'

/** What each created canister is funded with — the default `icp deploy` uses. */
export const DEFAULT_CREATION_CYCLES = 2_000_000_000_000n

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
  /**
   * Where the network serves canisters over HTTP. Sync plugins are told it, so
   * one can say where the site it uploaded is reachable. Omitted, the manifest's
   * own declaration for the network is used when it has one — the default `ic`
   * network names mainnet's gateway — and a plugin is otherwise told there is
   * none.
   */
  gatewayUrl?: string
}

/**
 * A canister that exists before a deployment: an application's recorded
 * canister, to be upgraded or installed into rather than created. `installed`
 * is what the caller read off its status, and decides how the run describes
 * what it does to the canister; the deployment reads the live status again to
 * decide what it actually does.
 */
export interface ExistingCanister {
  canisterId: Principal | string
  installed: boolean
}

export interface DeployOptions {
  /**
   * Put every canister on this subnet, as `icp deploy --subnet` does. Omitted,
   * one subnet is resolved for the whole bundle so its canisters stay together —
   * beside a canister that already exists, when there is one.
   */
  subnet?: Principal | string
  /**
   * Canisters that already exist, by manifest name. A name in here is not
   * created: its canister is upgraded, or installed into if it is empty, and
   * every other canister is created beside it. Omitted, everything is created.
   */
  existing?: Record<string, ExistingCanister>
  /** Progress as it happens: phases, creation, installs, plugin output. */
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
  gatewayUrl,
}: DeployerOptions): Deployer {
  return {
    load: (source) => loadBundle(source),

    async deploy(source, { subnet, existing = {}, onEvent = () => {} } = {}) {
      const bundle = await loadBundle(source)
      // A bundle the caller passed in stays theirs to dispose of. One loaded here
      // has no other owner, and holds the whole uncompressed archive.
      const owned = !isBundle(source)
      await initialize()

      try {
        const identityPrincipal = await agent.getPrincipal()
        const host = createHost({ agent, identityPrincipal, gatewayUrl })

        const result = await deployBundle(
          Bundle.core(bundle),
          host,
          identityPrincipal.toText(),
          environment ?? environmentOf(agent),
          subnet === undefined ? undefined : toPrincipal(subnet).toText(),
          cycles.toString(),
          Object.fromEntries(
            Object.entries(existing).map(([name, canister]) => [
              name,
              { canisterId: toPrincipal(canister.canisterId).toText(), installed: canister.installed },
            ]),
          ),
          (event: RawEvent) => onEvent(enrich(event)),
        )

        return enrichResult(result as RawResult)
      } finally {
        if (owned) bundle.dispose()
      }
    },
  }
}

/** The module reports canister ids as text; the library hands back principals. */
type WithTextIds<Event> = Event extends { canisterId: Principal }
  ? Omit<Event, 'canisterId'> & { canisterId: string }
  : Event extends { canisterId?: Principal }
    ? Omit<Event, 'canisterId'> & { canisterId?: string }
    : Event
/**
 * An event as the module serializes it. Distributed over the union one member at
 * a time on purpose: `Omit` over a union keeps only the keys its members share,
 * which here is `type` alone, so a single `Omit` would check none of the rest.
 */
type RawEvent = WithTextIds<DeployEvent>
type RawResult = {
  deployed: { name: string; canisterId: string }[]
  incomplete: { name: string; canisterId: string }[]
  error?: string
}

function enrich(event: RawEvent): DeployEvent {
  return 'canisterId' in event && event.canisterId !== undefined
    ? ({ ...event, canisterId: Principal.fromText(event.canisterId) } as DeployEvent)
    : (event as DeployEvent)
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
