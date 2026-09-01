/**
 * The plugin's windows onto the network.
 *
 * A plugin can call a canister, read a metadata section off one, and set one of
 * its environment variables. Which canister each of those reaches is not the
 * plugin's to decide freely: `host` is the canister being synced, and a name has
 * to be one the sync step listed in `canisters:`. That list is resolved to ids by
 * the module, so what arrives here is already the whole set of permitted targets
 * and anything outside it is refused without a call — the same rule icp-cli's
 * host applies.
 *
 * Candid encoding happens inside the plugin for `canister-call`: this only moves
 * already-encoded bytes and returns the raw reply.
 *
 * The `direct` flag every request carries chooses between going straight to the
 * target and going through a proxy canister. There is no proxy in a browser —
 * nothing configures one — so every request already takes the direct route and
 * the flag has nothing left to select.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import { Principal } from '@icp-sdk/core/principal'
import { setEnvironmentVariable } from '../ic/environment'
import { readMetadata } from '../ic/metadata'

/**
 * A failure the plugin is meant to see rather than be killed by.
 *
 * All three imports are declared `result<…, string>`, so a failure is a value
 * the plugin receives and decides what to do about. The generated bindings turn
 * a thrown error into that error case only when it carries a `payload` — an
 * ordinary `Error` is re-thrown and escapes the component instead, taking the
 * plugin's own error handling out of the picture. The payload is the message,
 * because the `string` half of the result is what the plugin is handed.
 */
export class CanisterCallError extends Error {
  readonly payload: string

  constructor(message: string) {
    super(message)
    this.payload = message
  }
}

/**
 * Which canister a request targets. The v0.1.0 interface has no such field; a
 * request from a plugin built against it is always about the canister being
 * synced, which is what `undefined` means here.
 */
export type CallTarget = { tag: 'host' } | { tag: 'name'; val: string } | undefined

export interface CanisterCallRequest {
  target?: CallTarget
  method: string
  arg: Uint8Array
  callType: 'update' | 'query'
  direct: boolean
  cycles: bigint
}

export interface MetadataSectionRequest {
  target?: CallTarget
  name: string
  direct: boolean
}

export interface SetEnvironmentVariableRequest {
  target?: CallTarget
  name: string
  value: string
  direct: boolean
}

/** Everything the plugin's non-WASI imports need, bound to one sync step. */
export interface CanisterOptions {
  agent: HttpAgent
  /** The canister being synced: the `host` target, always reachable. */
  canisterId: Principal
  /** The canisters the step listed, by the name the plugin will ask for. */
  callable: Map<string, string>
}

export interface CanisterImports {
  canisterCall: (request: CanisterCallRequest) => Promise<Uint8Array>
  canisterMetadataSection: (request: MetadataSectionRequest) => Promise<Uint8Array | undefined>
  canisterSetEnvironmentVariable: (request: SetEnvironmentVariableRequest) => Promise<void>
}

export function createCanisterImports({
  agent,
  canisterId,
  callable,
}: CanisterOptions): CanisterImports {
  const resolve = (target: CallTarget): Principal => {
    if (target === undefined || target.tag === 'host') return canisterId
    const resolved = callable.get(target.val)
    if (resolved === undefined) {
      throw new CanisterCallError(
        `this plugin is not permitted to reach canister "${target.val}": list it in the sync ` +
          `step's \`canisters\` to allow it`,
      )
    }
    return Principal.fromText(resolved)
  }

  return {
    async canisterCall(request) {
      const target = resolve(request.target)
      try {
        if (request.callType === 'query') {
          const response = await agent.query(target, {
            methodName: request.method,
            arg: request.arg,
          })
          if (response.status !== 'replied') {
            throw new CanisterCallError(
              `${response.reject_message} (code ${response.reject_code})`,
            )
          }
          return new Uint8Array(response.reply.arg)
        }

        const { reply } = await agent.update(target, {
          methodName: request.method,
          arg: request.arg,
          effectiveCanisterId: target,
        })
        return new Uint8Array(reply)
      } catch (error) {
        // The plugin turns this into its own error message, prefixed with the method.
        throw new CanisterCallError(describe(error))
      }
    },

    async canisterMetadataSection(request) {
      const target = resolve(request.target)
      try {
        return await readMetadata(agent, target, request.name)
      } catch (error) {
        throw new CanisterCallError(`metadata read failed: ${describe(error)}`)
      }
    },

    async canisterSetEnvironmentVariable(request) {
      const target = resolve(request.target)
      try {
        await setEnvironmentVariable(agent, target, request.name, request.value)
      } catch (error) {
        throw new CanisterCallError(describe(error))
      }
    },
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
