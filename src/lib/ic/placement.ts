/**
 * Where a deployment's canisters land.
 *
 * A deployment lands on exactly one subnet, resolved once before anything is
 * created, so canisters that call each other are never scattered. Everything
 * about that decision is here: the module asks only for canisters, in the order
 * the manifest declares them.
 *
 * Resolution mirrors icp-cli: an explicitly named subnet wins; otherwise the
 * cycles minting canister's default subnets decide; and on a network that has no
 * minting canister the run anchors to wherever its first canister lands and
 * keeps the rest with it.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import type { Principal } from '@icp-sdk/core/principal'
import type { DeployEvent } from '../events'
import { createCanister, DEFAULT_CREATION_CYCLES } from './create'
import { resolveEngineOperator } from './engine'
import { resolveSubnet, subnetOf } from './subnet'

export interface PlacementOptions {
  agent: HttpAgent
  /** Cycles used to fund each canister. */
  cycles?: bigint
  /**
   * Pin every canister to this subnet, as `icp deploy --subnet` does. A cloud
   * engine is a single subnet, so deploying to one means naming it here.
   */
  subnet?: Principal
  onEvent: (event: DeployEvent) => void
}

/** Creates canisters, all of them in the same place. */
export interface Placement {
  create(): Promise<Principal>
}

export function createPlacement({
  agent,
  cycles = DEFAULT_CREATION_CYCLES,
  subnet,
  onEvent,
}: PlacementOptions): Placement {
  let target = subnet
  let operator: Principal | undefined
  let resolved = false

  /**
   * Runs once, before the first canister exists. The engine lookup is
   * deliberately part of it: once a creation has been handed to an operator, a
   * failure may still have produced a canister, so falling back afterwards risks
   * creating — and paying for — a second one.
   */
  async function resolve(): Promise<void> {
    if (resolved) return
    resolved = true

    target = await resolveSubnet(agent, target)
    if (!target) return

    operator = await resolveEngineOperator(agent, target)
    onEvent({
      type: 'phase',
      message: operator
        ? `Subnet ${target.toText()} is a cloud engine; creating through its operator ${operator.toText()}`
        : `Creating canisters on subnet ${target.toText()}`,
    })
  }

  return {
    async create() {
      await resolve()
      const canisterId = await createCanister(agent, { subnet: target, operator, cycles })

      // The network could not name a subnet up front, so anchor to wherever the
      // first canister landed and keep the rest with it. No operator lookup
      // here: without a subnet there was nothing to look one up for, and an
      // engine is always reached through an explicitly chosen subnet.
      if (!target) {
        target = await subnetOf(agent, canisterId)
        if (target) {
          onEvent({ type: 'phase', message: `Colocating on subnet ${target.toText()}` })
        }
      }

      return canisterId
    },
  }
}
