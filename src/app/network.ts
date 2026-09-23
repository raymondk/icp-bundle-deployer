/**
 * Works out which network is serving this page, so bundles deploy to that same
 * network without anyone having to pick one.
 *
 * The asset canister hosting this frontend certifies an `ic_env` cookie carrying
 * the root key of its own network. That key is both what the agent needs to verify
 * responses and how we tell mainnet from a local replica — no host allow-list, and
 * no `fetchRootKey` anywhere. The same cookie names the registry canister the page
 * records applications in. The dev server sets the cookie too (see
 * `vite.config.ts`), so the page has a root key and a registry everywhere it is
 * served from.
 */

import { HttpAgent, type Identity } from '@icp-sdk/core/agent'
import { safeGetCanisterEnv } from '@icp-sdk/core/agent/canister-env'
import type { Principal } from '@icp-sdk/core/principal'
import { isMainnetRootKey } from '../lib'
import { registryCanisterId } from './registry'

export type NetworkKind = 'mainnet' | 'other'

export interface Network {
  /** Only affects how the network is described and labelled, never how it is used. */
  kind: NetworkKind
  /** Base URL for the agent's `/api/v2` calls. */
  host: string
  /** Root key of the serving network. */
  rootKey: Uint8Array
  /** The registry canister on this network, when the page was told of one. */
  registry?: Principal
}

/** The page was served without the environment it needs. */
export class NetworkError extends Error {}

export function detectNetwork(): Network {
  const env = safeGetCanisterEnv()
  if (!env) {
    throw new NetworkError(
      'This page was served without an ic_env cookie, so it cannot tell which network it is ' +
        'on. Open it through its canister URL, or start the dev server with `npm run dev`.',
    )
  }

  return {
    kind: isMainnetRootKey(env.IC_ROOT_KEY) ? 'mainnet' : 'other',
    // Same origin as the page, so `/api/v2` calls stay same-origin on both the
    // local gateway and mainnet — and on the dev server, which proxies them.
    host: window.location.origin,
    rootKey: env.IC_ROOT_KEY,
    registry: registryCanisterId(env),
  }
}

export async function createAgent(network: Network, identity: Identity): Promise<HttpAgent> {
  return HttpAgent.create({
    host: network.host,
    identity,
    rootKey: network.rootKey,
    shouldFetchRootKey: false,
  })
}

export function describeNetwork(network: Network): string {
  return network.kind === 'mainnet' ? 'ICP mainnet' : `test network (${network.host})`
}
