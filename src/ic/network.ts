/**
 * Works out which network is serving this page, so bundles deploy to that same
 * network without anyone having to pick one.
 *
 * The asset canister hosting this frontend certifies an `ic_env` cookie carrying
 * the root key of its own network. That key is both what the agent needs to verify
 * responses and how we tell mainnet from a local replica — no host allow-list, and
 * no `fetchRootKey` on a network where fetching it would be unsafe.
 */

import { HttpAgent, IC_ROOT_KEY, type Identity } from '@icp-sdk/core/agent'
import { safeGetCanisterEnv } from '@icp-sdk/core/agent/canister-env'
import { Principal } from '@icp-sdk/core/principal'

export type NetworkKind = 'mainnet' | 'other'

export interface Network {
  kind: NetworkKind
  /** Base URL for the agent's `/api/v2` calls. */
  host: string
  /** Root key of the serving network, or `undefined` when it has to be fetched. */
  rootKey?: Uint8Array
  /**
   * The canister serving this page, as reported by the HTTP gateway. Off mainnet it
   * is the effective canister id for provisional creation — see `./provisional`.
   */
  servingCanisterId?: Principal
}

/** Where the dev server (`npm run dev`) points when there is no `ic_env` cookie. */
const DEV_HOST = 'http://localhost:8000'

/** Set by the IC HTTP gateway on every response it serves. */
const CANISTER_ID_HEADER = 'x-ic-canister-id'

export async function detectNetwork(): Promise<Network> {
  const env = safeGetCanisterEnv()

  if (!env) {
    // Served by the Vite dev server rather than by an asset canister: there is no
    // certified environment to read, so talk to a local replica and fetch its key.
    return { kind: 'other', host: DEV_HOST }
  }

  const kind = isMainnetRootKey(env.IC_ROOT_KEY) ? 'mainnet' : 'other'
  return {
    kind,
    // Same origin as the page, so `/api/v2` calls stay same-origin on both the
    // local gateway and mainnet.
    host: window.location.origin,
    rootKey: env.IC_ROOT_KEY,
    servingCanisterId: kind === 'mainnet' ? undefined : await fetchServingCanisterId(),
  }
}

export async function createAgent(network: Network, identity: Identity): Promise<HttpAgent> {
  return HttpAgent.create({
    host: network.host,
    identity,
    rootKey: network.rootKey,
    shouldFetchRootKey: network.rootKey === undefined,
  })
}

/** Asks the gateway which canister is behind this origin. */
async function fetchServingCanisterId(): Promise<Principal | undefined> {
  try {
    const response = await fetch(window.location.origin, { method: 'HEAD' })
    const header = response.headers.get(CANISTER_ID_HEADER)
    return header ? Principal.fromText(header) : undefined
  } catch {
    return undefined
  }
}

function isMainnetRootKey(rootKey: Uint8Array): boolean {
  return bytesToHex(rootKey) === IC_ROOT_KEY.toLowerCase()
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function describeNetwork(network: Network): string {
  return network.kind === 'mainnet' ? 'ICP mainnet' : `test network (${network.host})`
}
