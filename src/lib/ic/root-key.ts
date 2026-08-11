/**
 * Telling mainnet apart from every other network, by its root key.
 *
 * The key is the only thing that identifies a network from inside an agent — there
 * is no host allow-list to consult, and a canister URL says nothing about which IC
 * it belongs to.
 */

import { IC_ROOT_KEY } from '@icp-sdk/core/agent'

export function isMainnetRootKey(rootKey: Uint8Array): boolean {
  return bytesToHex(rootKey) === IC_ROOT_KEY.toLowerCase()
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
