/**
 * Cloud engine support.
 *
 * A cloud engine is a user-owned subnet, and it does not create canisters through
 * the cycles ledger: creation is delegated to the subnet's **engine operator**, a
 * canister the engine's administrators authorize callers against. The operator's
 * `create_canister` is byte-compatible with the cycles ledger's, so the only thing
 * that changes is who the call is addressed to.
 *
 * Finding the operator means asking a registry — the **engine canister** — which
 * operator serves a given subnet. icp-cli decides by subnet type and then resolves
 * the operator; the browser agent cannot read a subnet's type, so the registry
 * answer is the test: an operator comes back, or the subnet is an ordinary one.
 */

import { Actor, type HttpAgent } from '@icp-sdk/core/agent'
import { IDL } from '@icp-sdk/core/candid'
import { Principal } from '@icp-sdk/core/principal'

/** The registry icp-cli ships with, mapping a subnet to its engine operator. */
export const ENGINE_CANISTER_ID = Principal.fromText('q6cfj-fyaaa-aaaar-qb77q-cai')

const GetEngineOperatorBySubnetArgs = IDL.Record({
  subnet_id: IDL.Opt(IDL.Principal),
})

const GetEngineOperatorBySubnetResult = IDL.Record({
  engine_operator_id: IDL.Opt(IDL.Principal),
})

const idlFactory: IDL.InterfaceFactory = () =>
  IDL.Service({
    getEngineOperatorBySubnet: IDL.Func(
      [GetEngineOperatorBySubnetArgs],
      [GetEngineOperatorBySubnetResult],
      ['query'],
    ),
  })

interface EngineRegistryService {
  getEngineOperatorBySubnet: (args: {
    subnet_id: [] | [Principal]
  }) => Promise<{ engine_operator_id: [] | [Principal] }>
}

/**
 * The engine operator serving `subnet`, or `undefined` when there is none — either
 * the subnet is not an engine, or the registry is not deployed on this network.
 *
 * A missing registry rejects with `DestinationInvalid`, which is indistinguishable
 * in effect from "no operator registered": both mean creation goes the ordinary
 * way. Every other failure is reported, because silently falling back could create
 * the canister somewhere the caller did not intend.
 */
export async function resolveEngineOperator(
  agent: HttpAgent,
  subnet: Principal,
  registry: Principal = ENGINE_CANISTER_ID,
): Promise<Principal | undefined> {
  const engine = Actor.createActor<EngineRegistryService>(idlFactory, {
    agent,
    canisterId: registry,
  })

  let result
  try {
    result = await engine.getEngineOperatorBySubnet({ subnet_id: [subnet] })
  } catch (error) {
    if (isCanisterNotFound(error)) return undefined
    throw new EngineError(
      `Could not ask ${registry.toText()} which engine operator serves subnet ` +
        `${subnet.toText()}: ${describe(error)}`,
    )
  }

  const [operator] = result.engine_operator_id
  return operator
}

export class EngineError extends Error {}

/**
 * Whether a rejection means "no such canister". The registry being absent is a
 * normal outcome on a network that has no engines, so it must be told apart from a
 * registry that answered with an error.
 */
function isCanisterNotFound(error: unknown): boolean {
  const message = describe(error)
  return (
    message.includes('DestinationInvalid') ||
    message.includes('IC0301') ||
    /canister .* not found/i.test(message)
  )
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
