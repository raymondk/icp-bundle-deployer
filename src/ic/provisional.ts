/**
 * Free canister creation on a test network.
 *
 * `provisional_create_canister_with_cycles` needs an effective canister id, which
 * decides both the routing of the call and the subnet whose certificate must cover
 * it. The management canister's own id (`aaaaa-aa`) sits outside a local network's
 * canister ranges, so the reply's delegation carries no ranges for it and
 * certificate verification fails. Any canister on the target subnet works instead —
 * we use the one serving this page.
 *
 * The typed client in `@icp-sdk/canisters` derives the effective canister id from
 * `specified_id`, which would force an exact (and possibly taken) canister id, so
 * this call is declared by hand.
 */

import { Actor, type HttpAgent } from '@icp-sdk/core/agent'
import { IDL } from '@icp-sdk/core/candid'
import { Principal } from '@icp-sdk/core/principal'

export const MANAGEMENT_CANISTER_ID = Principal.fromText('aaaaa-aa')

const ProvisionalCreateArgs = IDL.Record({
  amount: IDL.Opt(IDL.Nat),
  // Always sent as absent: settings are applied afterwards through the typed
  // management-canister client, and the id is left to the replica to choose.
  settings: IDL.Opt(IDL.Null),
  specified_id: IDL.Opt(IDL.Principal),
  sender_canister_version: IDL.Opt(IDL.Nat64),
})

const idlFactory: IDL.InterfaceFactory = () =>
  IDL.Service({
    provisional_create_canister_with_cycles: IDL.Func(
      [ProvisionalCreateArgs],
      [IDL.Record({ canister_id: IDL.Principal })],
      [],
    ),
  })

interface ProvisionalService {
  provisional_create_canister_with_cycles: (args: {
    amount: [bigint]
    settings: []
    specified_id: []
    sender_canister_version: []
  }) => Promise<{ canister_id: Principal }>
}

export async function provisionalCreateCanister(
  agent: HttpAgent,
  amount: bigint,
  effectiveCanisterId: Principal,
): Promise<Principal> {
  const actor = Actor.createActor<ProvisionalService>(idlFactory, {
    agent,
    canisterId: MANAGEMENT_CANISTER_ID,
    callTransform: () => ({ effectiveCanisterId }),
  })

  const { canister_id } = await actor.provisional_create_canister_with_cycles({
    amount: [amount],
    settings: [],
    specified_id: [],
    sender_canister_version: [],
  })
  return canister_id
}
