/**
 * Creating canisters from the browser, and applying the settings a manifest declares.
 *
 * Creation always goes through the cycles ledger, on every network. An ingress
 * message cannot carry cycles, so the management canister's `create_canister` is out
 * of reach from a browser — but the cycles ledger is a canister like any other, and
 * icp-cli deploys it on local networks at the same well-known address it has on
 * mainnet. One path, so a local deployment exercises exactly what mainnet will do.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import type { Principal } from '@icp-sdk/core/principal'
import { IcManagementCanister, type CanisterSettings } from '@icp-sdk/canisters/ic-management'

import * as cyclesLedger from './cycles-ledger'

/** Matches the default `icp deploy` uses to fund a new canister. */
export const DEFAULT_CREATION_CYCLES = 2_000_000_000_000n

export interface CreateOptions {
  cycles?: bigint
  /** Pin the canister to one subnet. Omitted, the ledger chooses. */
  subnet?: Principal
  /**
   * A cloud engine's operator canister. When set, creation is delegated to it
   * instead of the cycles ledger, and `subnet` is dropped — an operator only ever
   * creates on its own subnet.
   */
  operator?: Principal
}

/**
 * Creates an empty canister controlled by the caller, paid for from the caller's
 * cycles ledger balance — or, on a cloud engine, by its operator.
 *
 * Manifest settings are applied afterwards rather than at creation: that keeps the
 * caller in control through the install, and routes every settings change through
 * the management canister's typed client.
 */
export async function createCanister(
  agent: HttpAgent,
  { cycles = DEFAULT_CREATION_CYCLES, subnet, operator }: CreateOptions = {},
): Promise<Principal> {
  return operator
    ? cyclesLedger.createCanister(agent, cycles, { target: operator })
    : cyclesLedger.createCanister(agent, cycles, { subnet })
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
