/**
 * The plugin's one window onto the network.
 *
 * icp-cli fixes the target canister on the host side so a plugin cannot choose a
 * different one; the same restriction applies here. Candid encoding happens inside
 * the plugin — this only moves already-encoded bytes and returns the raw reply.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import type { Principal } from '@icp-sdk/core/principal'
import type { CanisterCallRequest } from './wasi'

export class CanisterCallError extends Error {}

/**
 * Builds the `canister-call` implementation for one canister. Returns a promise, so
 * the wasm stack suspends (via JSPI) until the replica answers.
 */
export function createCanisterCall(agent: HttpAgent, canisterId: Principal) {
  return async (request: CanisterCallRequest): Promise<Uint8Array> => {
    try {
      if (request.callType === 'query') {
        const response = await agent.query(canisterId, {
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

      const { reply } = await agent.update(canisterId, {
        methodName: request.method,
        arg: request.arg,
        effectiveCanisterId: canisterId,
      })
      return new Uint8Array(reply)
    } catch (error) {
      // The plugin turns this into its own error message, prefixed with the method.
      throw new CanisterCallError(describe(error))
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
