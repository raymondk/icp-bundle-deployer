/**
 * Creating canisters from the browser.
 *
 * Creation always goes through the cycles ledger, on every network. An ingress
 * message cannot carry cycles, so the management canister's `create_canister` is
 * out of reach from a browser — but the cycles ledger is a canister like any
 * other, and icp-cli deploys it on local networks at the same well-known address
 * it has on mainnet. One path, so a local deployment exercises exactly what
 * mainnet will do.
 *
 * Settings are not applied here. The canister comes into existence controlled by
 * its creator and is configured afterwards, which keeps the deployer in control
 * of it right through the install.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import type { Principal } from '@icp-sdk/core/principal'

import * as cyclesLedger from './cycles-ledger'

/** Matches the default `icp deploy` uses to fund a new canister. */
export const DEFAULT_CREATION_CYCLES = 2_000_000_000_000n

export interface CreateOptions {
  cycles?: bigint
  /** Pin the canister to one subnet. Omitted, the ledger chooses. */
  subnet?: Principal
  /**
   * A cloud engine's operator canister. When set, creation is delegated to it
   * instead of the cycles ledger, and `subnet` is dropped — an operator only
   * ever creates on its own subnet.
   */
  operator?: Principal
}

/**
 * Creates an empty canister controlled by the caller, paid for from the caller's
 * cycles ledger balance — or, on a cloud engine, by its operator.
 */
export async function createCanister(
  agent: HttpAgent,
  { cycles = DEFAULT_CREATION_CYCLES, subnet, operator }: CreateOptions = {},
): Promise<Principal> {
  return operator
    ? cyclesLedger.createCanister(agent, cycles, { target: operator })
    : cyclesLedger.createCanister(agent, cycles, { subnet })
}
