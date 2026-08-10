/**
 * Creating canisters from the browser, and applying the settings a manifest declares.
 *
 * Which creation path is available depends on the network, not on a preference:
 * ingress messages carry no cycles, so mainnet has to go through the cycles ledger,
 * while a local replica exposes free provisional creation.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import type { Principal } from '@icp-sdk/core/principal'
import { IcManagementCanister, type CanisterSettings } from '@icp-sdk/canisters/ic-management'

import * as cyclesLedger from './cycles-ledger'
import type { Network } from './network'
import { provisionalCreateCanister } from './provisional'

/** Matches the default `icp deploy` uses to fund a new canister. */
export const DEFAULT_CREATION_CYCLES = 2_000_000_000_000n

/**
 * Creates an empty canister controlled by the caller.
 *
 * Manifest settings are applied afterwards rather than at creation: that keeps the
 * caller in control for the install, and lets both networks share one settings path
 * through the management canister's typed client.
 */
export async function createCanister(
  agent: HttpAgent,
  network: Network,
  cycles: bigint = DEFAULT_CREATION_CYCLES,
): Promise<Principal> {
  if (network.kind === 'mainnet') {
    return cyclesLedger.createCanister(agent, cycles)
  }

  if (!network.servingCanisterId) {
    throw new Error(
      'Cannot create canisters on this network: the HTTP gateway did not say which canister ' +
        'serves this page, so there is no effective canister id to route creation through. ' +
        'Open the deployer from its canister URL rather than a dev server.',
    )
  }
  return provisionalCreateCanister(agent, cycles, network.servingCanisterId)
}

export async function applySettings(
  agent: HttpAgent,
  canisterId: Principal,
  settings: CanisterSettings,
): Promise<void> {
  if (Object.keys(settings).length === 0) return
  const management = IcManagementCanister.create({ agent })
  await management.updateSettings({ canisterId, settings })
}
