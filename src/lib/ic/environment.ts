/**
 * Setting a single environment variable on a canister.
 *
 * The management canister has no per-variable update — `update_settings`
 * replaces a canister's environment variables wholesale — so this is a
 * read-modify-write: read the target's current variables, overlay the one being
 * set, write the whole list back. It is not atomic, so a settings update by
 * another party landing between the two calls is overwritten. That is the same
 * arrangement `icp sync` makes, and during a deployment there is no other party:
 * the canisters were created moments ago and are still ours.
 *
 * Only the two fields this needs are declared, in the same spirit as
 * `cycles-ledger.ts`: Candid ignores record fields the reader does not ask for,
 * and reads an absent `opt` field as "leave it alone", so a partial
 * `update_settings` touches nothing but the variables.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import { IDL } from '@icp-sdk/core/candid'
import { Principal } from '@icp-sdk/core/principal'

const MANAGEMENT_CANISTER_ID = Principal.fromText('aaaaa-aa')

const EnvironmentVariable = IDL.Record({ name: IDL.Text, value: IDL.Text })

const CanisterIdRecord = IDL.Record({ canister_id: IDL.Principal })

const CanisterStatusResult = IDL.Record({
  settings: IDL.Record({ environment_variables: IDL.Vec(EnvironmentVariable) }),
})

const UpdateSettingsArgs = IDL.Record({
  canister_id: IDL.Principal,
  settings: IDL.Record({
    environment_variables: IDL.Opt(IDL.Vec(EnvironmentVariable)),
  }),
})

interface Variable {
  name: string
  value: string
}

export class EnvironmentVariableError extends Error {}

export async function setEnvironmentVariable(
  agent: HttpAgent,
  canisterId: Principal,
  name: string,
  value: string,
): Promise<void> {
  const status = await call(
    agent,
    canisterId,
    'canister_status',
    IDL.encode([CanisterIdRecord], [{ canister_id: canisterId }]),
    'reading the target’s environment variables',
  )
  const [current] = IDL.decode([CanisterStatusResult], status) as unknown as [
    { settings: { environment_variables: Variable[] } },
  ]

  // Replaced in place when it is already there, so the rest keep their order.
  const variables = current.settings.environment_variables
  const existing = variables.find((variable) => variable.name === name)
  if (existing) existing.value = value
  else variables.push({ name, value })

  await call(
    agent,
    canisterId,
    'update_settings',
    IDL.encode([UpdateSettingsArgs], [{ canister_id: canisterId, settings: { environment_variables: [variables] } }]),
    'setting the environment variable',
  )
}

/**
 * A management-canister call about `canisterId`. The management canister has no
 * routing of its own, so the call is addressed to it and routed to the canister
 * it is about.
 */
async function call(
  agent: HttpAgent,
  canisterId: Principal,
  methodName: string,
  arg: Uint8Array,
  doing: string,
): Promise<Uint8Array> {
  try {
    const { reply } = await agent.update(MANAGEMENT_CANISTER_ID, {
      methodName,
      arg,
      effectiveCanisterId: canisterId,
    })
    return new Uint8Array(reply)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new EnvironmentVariableError(`${doing} failed: ${message}`)
  }
}
