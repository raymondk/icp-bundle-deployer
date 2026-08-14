/**
 * Reading a canister's status from outside the library.
 *
 * Only a controller may read it, and the suite's own agent is one — the CLI on
 * the machine running the tests signs as somebody else entirely, so asking it
 * would test whose identity is configured rather than what was deployed.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import { IDL } from '@icp-sdk/core/candid'
import { Principal } from '@icp-sdk/core/principal'

const CanisterIdRecord = IDL.Record({ canister_id: IDL.Principal })

// A subset of `canister_status`: candid lets a reader ignore record fields it
// does not ask for, so this stays valid as the reply grows fields.
const CanisterStatus = IDL.Record({
  module_hash: IDL.Opt(IDL.Vec(IDL.Nat8)),
  settings: IDL.Record({ controllers: IDL.Vec(IDL.Principal) }),
})

export interface CanisterStatus {
  /** Lowercase hex digest of the installed module, or `undefined` if empty. */
  moduleHash?: string
  controllers: string[]
}

export async function canisterStatus(
  agent: HttpAgent,
  canisterId: Principal,
): Promise<CanisterStatus> {
  const { reply } = await agent.update(Principal.managementCanister(), {
    methodName: 'canister_status',
    arg: new Uint8Array(IDL.encode([CanisterIdRecord], [{ canister_id: canisterId }])),
    // The management canister has no routing of its own, so the call is routed
    // to the canister it is about.
    effectiveCanisterId: canisterId,
  })

  const [status] = IDL.decode([CanisterStatus], reply) as unknown as [
    {
      module_hash: [] | [Uint8Array | number[]]
      settings: { controllers: Principal[] }
    },
  ]

  return {
    moduleHash: status.module_hash[0] === undefined ? undefined : hex(status.module_hash[0]),
    controllers: status.settings.controllers.map((controller) => controller.toText()),
  }
}

function hex(bytes: Uint8Array | number[]): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
