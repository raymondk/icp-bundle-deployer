/**
 * What the module calls out to.
 *
 * The module decides what to call and in what order; this is the part that
 * actually reaches the network. Everything here is bound to one agent, so who
 * the deployment signs as and which network it talks to are settled before a
 * deployment starts and cannot change during one.
 */

import { Certificate, lookupResultToBuffer, type HttpAgent } from '@icp-sdk/core/agent'
import { Principal } from '@icp-sdk/core/principal'
import type { DeployEvent } from './events'
import { createPlacement } from './ic/placement'
import { createPluginRunner } from './plugin'
import type { DeployerHost } from './wasm/deployer'

export interface HostOptions {
  agent: HttpAgent
  /** The principal the agent signs as; sync plugins are told who is calling. */
  identityPrincipal: Principal
  /** Cycles used to fund each canister. */
  cycles?: bigint
  /** Pin every canister to this subnet. */
  subnet?: Principal
  onEvent: (event: DeployEvent) => void
}

export function createHost({
  agent,
  identityPrincipal,
  cycles,
  subnet,
  onEvent,
}: HostOptions): DeployerHost {
  const placement = createPlacement({ agent, cycles, subnet, onEvent })
  const runPlugin = createPluginRunner(agent, identityPrincipal)

  return {
    async update(canisterId, method, arg, effectiveCanisterId, cycles) {
      // Every call the module makes is an ingress message, and an ingress
      // message cannot carry cycles. Nothing it does needs them — canisters are
      // funded at creation — so a request for them is a bug worth surfacing.
      if (BigInt(cycles) !== 0n) {
        throw new Error(
          `Cannot attach ${cycles} cycles to \`${method}\`: an ingress message cannot carry cycles.`,
        )
      }
      const { reply } = await agent.update(Principal.fromText(canisterId), {
        methodName: method,
        arg,
        effectiveCanisterId: Principal.fromText(effectiveCanisterId),
      })
      return new Uint8Array(reply)
    },

    async readCanisterMetadata(canisterId, name) {
      return readMetadata(agent, Principal.fromText(canisterId), name)
    },

    async createCanister() {
      return (await placement.create()).toText()
    },

    runPlugin,
  }
}

/**
 * A canister's custom-section metadata, read through `read_state` and checked
 * against the network's root key. Absent metadata is `undefined` rather than an
 * error — that is the answer to "does this canister declare it?".
 */
async function readMetadata(
  agent: HttpAgent,
  canisterId: Principal,
  name: string,
): Promise<Uint8Array | undefined> {
  const encoder = new TextEncoder()
  const path = [
    encoder.encode('canister'),
    canisterId.toUint8Array(),
    encoder.encode('metadata'),
    encoder.encode(name),
  ]

  const { certificate } = await agent.readState(canisterId, { paths: [path] })
  const verified = await Certificate.create({
    certificate,
    rootKey: agent.rootKey!,
    principal: { canisterId },
    agent,
  })
  return lookupResultToBuffer(verified.lookup_path(path))
}
