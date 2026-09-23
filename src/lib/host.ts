/**
 * What the module calls out to.
 *
 * The module decides what to call and in what order; this is the part that
 * actually reaches the network. Everything here is bound to one agent, so who
 * the deployment signs as and which network it talks to are settled before a
 * deployment starts and cannot change during one.
 */

import { AgentError, type HttpAgent } from '@icp-sdk/core/agent'
import { Principal } from '@icp-sdk/core/principal'
import { readMetadata } from './ic/metadata'
import { createPluginRunner } from './plugin'
import type { CallRejection, DeployerHost } from './wasm/deployer'

export interface HostOptions {
  agent: HttpAgent
  /** The principal the agent signs as; sync plugins are told who is calling. */
  identityPrincipal: Principal
  /**
   * Where the network serves canisters over HTTP, as sync plugins are told it.
   * Omitted, the module falls back to what the bundle's manifest declares for
   * the network, if anything.
   */
  gatewayUrl?: string
}

export function createHost({ agent, identityPrincipal, gatewayUrl }: HostOptions): DeployerHost {
  const runPlugin = createPluginRunner(agent, identityPrincipal)

  return {
    async update(canisterId, method, arg, effectiveCanisterId, cycles) {
      // Every call the module makes is an ingress message, and an ingress
      // message cannot carry cycles. Nothing it does needs them — canisters are
      // funded at creation, by the cycles ledger — so a request for them is a
      // bug worth surfacing.
      if (BigInt(cycles) !== 0n) {
        throw new Error(
          `Cannot attach ${cycles} cycles to \`${method}\`: an ingress message cannot carry cycles.`,
        )
      }
      try {
        const { reply } = await agent.update(Principal.fromText(canisterId), {
          methodName: method,
          arg,
          effectiveCanisterId: Principal.fromText(effectiveCanisterId),
        })
        return new Uint8Array(reply)
      } catch (error) {
        throw withRejection(error)
      }
    },

    async readCanisterMetadata(canisterId, name) {
      return readMetadata(agent, Principal.fromText(canisterId), name)
    },

    async subnetOf(canisterId) {
      return (await agent.getSubnetIdFromCanister(Principal.fromText(canisterId))).toText()
    },

    runPlugin,

    network() {
      // The agent's host is where every call this deployment makes is sent, so
      // it is the API endpoint whatever the manifest may say about the network.
      return { apiUrl: agent.host.href, gatewayUrl }
    },
  }
}

/**
 * A failed call, with the replica's rejection attached when that is what it
 * was. The module branches on rejections — a canister reported as not found,
 * or as stopped — and cannot tell one from a dropped connection by the message
 * alone; agent-js knows, and says so on the error's code.
 */
function withRejection(error: unknown): unknown {
  if (!(error instanceof AgentError)) return error
  const code: unknown = error.cause.code
  if (typeof code !== 'object' || code === null || !('rejectMessage' in code)) return error

  const { rejectMessage, rejectErrorCode } = code as {
    rejectMessage: unknown
    rejectErrorCode?: unknown
  }
  if (typeof rejectMessage !== 'string') return error
  const reject: CallRejection = {
    message: rejectMessage,
    ...(typeof rejectErrorCode === 'string' ? { code: rejectErrorCode } : {}),
  }
  return Object.assign(error, { reject })
}
