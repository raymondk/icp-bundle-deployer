/**
 * Choosing the subnet a deployment lands on.
 *
 * icp-cli resolves one subnet per deployment and pins every canister to it, so a
 * project's canisters stay together. Leaving each `create_canister` unpinned would
 * let the cycles ledger place them independently, and a frontend could end up on a
 * different subnet from the backend it calls.
 *
 * Resolution mirrors the CLI: an explicitly named subnet wins; otherwise ask the
 * cycles minting canister which subnets it creates on by default and take one.
 */

import { Actor, type HttpAgent } from '@icp-sdk/core/agent'
import { IDL } from '@icp-sdk/core/candid'
import { Principal } from '@icp-sdk/core/principal'

export const CYCLES_MINTING_CANISTER_ID = Principal.fromText('rkp4c-7iaaa-aaaaa-aaaca-cai')

const idlFactory: IDL.InterfaceFactory = () =>
  IDL.Service({
    get_default_subnets: IDL.Func([], [IDL.Vec(IDL.Principal)], ['query']),
  })

interface CyclesMintingService {
  get_default_subnets: () => Promise<Principal[]>
}

/**
 * The subnet to create on, or `undefined` when the network cannot say — a network
 * without a cycles minting canister, for instance. Callers that get `undefined`
 * should fall back to colocating on the first canister they create.
 */
export async function resolveSubnet(
  agent: HttpAgent,
  explicit?: Principal,
): Promise<Principal | undefined> {
  if (explicit) return explicit

  try {
    const cmc = Actor.createActor<CyclesMintingService>(idlFactory, {
      agent,
      canisterId: CYCLES_MINTING_CANISTER_ID,
    })
    const subnets = await cmc.get_default_subnets()
    if (subnets.length === 0) return undefined
    return subnets[Math.floor(Math.random() * subnets.length)]
  } catch {
    // Not fatal: the deployment can still colocate on its first canister.
    return undefined
  }
}

/** Which subnet a canister lives on, for colocating the ones created after it. */
export async function subnetOf(
  agent: HttpAgent,
  canisterId: Principal,
): Promise<Principal | undefined> {
  try {
    return await agent.getSubnetIdFromCanister(canisterId)
  } catch {
    return undefined
  }
}
