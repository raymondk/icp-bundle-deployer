/**
 * The slice of the cycles ledger this library reads.
 *
 * Creating a canister goes through the cycles ledger too — an ingress message
 * cannot carry cycles, so the management canister's `create_canister` is out of
 * reach from a browser, and the ledger creates the canister and charges the
 * caller's balance instead — but that call is made by the deployment core, the
 * same way `icp deploy` makes it. What is left here is reading the balance the
 * page shows, and saying it in a way worth reading.
 *
 * `@icp-sdk/canisters` ships a cycles-ledger client, but it only wraps `withdraw`
 * and does not export the generated IDL, so the one method used here is declared
 * by hand.
 */

import { Actor, type HttpAgent } from '@icp-sdk/core/agent'
import { IDL } from '@icp-sdk/core/candid'
import { Principal } from '@icp-sdk/core/principal'

export const CYCLES_LEDGER_CANISTER_ID = Principal.fromText('um5iw-rqaaa-aaaaq-qaaba-cai')

const Account = IDL.Record({
  owner: IDL.Principal,
  subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
})

const idlFactory: IDL.InterfaceFactory = () =>
  IDL.Service({
    icrc1_balance_of: IDL.Func([Account], [IDL.Nat], ['query']),
  })

interface CyclesLedgerService {
  icrc1_balance_of: (account: { owner: Principal; subaccount: [] }) => Promise<bigint>
}

export async function cyclesBalance(agent: HttpAgent, owner: Principal): Promise<bigint> {
  const ledger = Actor.createActor<CyclesLedgerService>(idlFactory, {
    agent,
    canisterId: CYCLES_LEDGER_CANISTER_ID,
  })
  return ledger.icrc1_balance_of({ owner, subaccount: [] })
}

export function formatCycles(cycles: bigint): string {
  const units: [bigint, string][] = [
    [1_000_000_000_000n, 'T'],
    [1_000_000_000n, 'B'],
    [1_000_000n, 'M'],
    [1_000n, 'K'],
  ]
  for (const [scale, suffix] of units) {
    if (cycles >= scale) {
      // One decimal place, without floating point.
      const tenths = (cycles * 10n) / scale
      return `${tenths / 10n}.${tenths % 10n}${suffix} cycles`
    }
  }
  return `${cycles} cycles`
}
