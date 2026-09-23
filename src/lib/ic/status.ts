/**
 * Reading a canister's status.
 *
 * `canister_status` is what an upgrade's pre-flight reads for every canister an
 * application recorded: whether a module is installed decides between upgrading
 * and installing, and the read itself is the controller check, since only a
 * controller may make it. A canister that is gone, or that the caller no longer
 * controls, fails here — before anything is created.
 *
 * The management canister has no routing of its own, so the call is addressed
 * to it and routed to the canister it is about.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import { IDL } from '@icp-sdk/core/candid'
import { Principal } from '@icp-sdk/core/principal'

const CanisterIdRecord = IDL.Record({ canister_id: IDL.Principal })

// A subset of `canister_status`: candid lets a reader ignore record fields it
// does not ask for, so this stays valid as the reply grows fields.
const CanisterStatusResult = IDL.Record({
  status: IDL.Variant({ running: IDL.Null, stopping: IDL.Null, stopped: IDL.Null }),
  module_hash: IDL.Opt(IDL.Vec(IDL.Nat8)),
  settings: IDL.Record({ controllers: IDL.Vec(IDL.Principal) }),
})

export type CanisterRunState = 'running' | 'stopping' | 'stopped'

export interface CanisterStatus {
  /** Lowercase hex digest of the installed module, or `undefined` if the canister is empty. */
  moduleHash?: string
  status: CanisterRunState
  controllers: Principal[]
}

/**
 * Reads a canister's status as its controller. Rejects when the canister does
 * not exist or the agent's principal does not control it.
 */
export async function canisterStatus(
  agent: HttpAgent,
  canisterId: Principal,
): Promise<CanisterStatus> {
  const { reply } = await agent.update(Principal.managementCanister(), {
    methodName: 'canister_status',
    arg: new Uint8Array(IDL.encode([CanisterIdRecord], [{ canister_id: canisterId }])),
    effectiveCanisterId: canisterId,
  })

  const [status] = IDL.decode([CanisterStatusResult], reply) as unknown as [
    {
      status: Record<CanisterRunState, null>
      module_hash: [] | [Uint8Array | number[]]
      settings: { controllers: Principal[] }
    },
  ]

  return {
    moduleHash: status.module_hash[0] === undefined ? undefined : hex(status.module_hash[0]),
    status: Object.keys(status.status)[0] as CanisterRunState,
    controllers: status.settings.controllers,
  }
}

function hex(bytes: Uint8Array | number[]): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
