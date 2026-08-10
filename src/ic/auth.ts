/**
 * Who the deployment runs as.
 *
 * Internet Identity works on every network we target: the icp-cli local network
 * trusts mainnet subnet signatures, so `https://id.ai/authorize` is the identity
 * provider whether this page is served from a local replica or from the IC.
 *
 * Off mainnet we also offer a throwaway key kept in `localStorage`, so testing a
 * bundle locally doesn't require a passkey — creating a canister there is free.
 */

import { AuthClient } from '@icp-sdk/auth/client'
import type { Identity } from '@icp-sdk/core/agent'
import { Ed25519KeyIdentity } from '@icp-sdk/core/identity'
import type { Principal } from '@icp-sdk/core/principal'

const IDENTITY_PROVIDER = 'https://id.ai/authorize'
const TEMPORARY_IDENTITY_KEY = 'bundle-deployer:temporary-identity'

export type IdentitySource = 'internet-identity' | 'temporary'

export interface Session {
  identity: Identity
  principal: Principal
  source: IdentitySource
}

let authClient: AuthClient | undefined

function client(): AuthClient {
  authClient ??= new AuthClient({
    identityProvider: IDENTITY_PROVIDER,
    // A deploy can easily outlast the default idle timeout, whose default callback
    // signs the user out and reloads the page mid-run.
    idleOptions: { disableIdle: true },
  })
  return authClient
}

/** Returns the session left over from a previous visit, if there still is one. */
export async function restoreSession(): Promise<Session | undefined> {
  const auth = client()
  if (auth.isAuthenticated()) {
    return session(await auth.getIdentity(), 'internet-identity')
  }

  const stored = localStorage.getItem(TEMPORARY_IDENTITY_KEY)
  if (stored) {
    try {
      return session(Ed25519KeyIdentity.fromJSON(stored), 'temporary')
    } catch {
      // A key we can no longer read is worth nothing; start over.
      localStorage.removeItem(TEMPORARY_IDENTITY_KEY)
    }
  }

  return undefined
}

export async function signInWithInternetIdentity(): Promise<Session> {
  // No `targets`: the delegation has to be usable against the management canister
  // and the cycles ledger, not just this app's own canisters.
  const identity = await client().signIn()
  localStorage.removeItem(TEMPORARY_IDENTITY_KEY)
  return session(identity, 'internet-identity')
}

/** Creates (or reuses) a throwaway identity held only by this browser. */
export function useTemporaryIdentity(): Session {
  const stored = localStorage.getItem(TEMPORARY_IDENTITY_KEY)
  if (stored) {
    try {
      return session(Ed25519KeyIdentity.fromJSON(stored), 'temporary')
    } catch {
      localStorage.removeItem(TEMPORARY_IDENTITY_KEY)
    }
  }

  const identity = Ed25519KeyIdentity.generate()
  localStorage.setItem(TEMPORARY_IDENTITY_KEY, JSON.stringify(identity.toJSON()))
  return session(identity, 'temporary')
}

export async function signOut(): Promise<void> {
  localStorage.removeItem(TEMPORARY_IDENTITY_KEY)
  await client().signOut()
}

function session(identity: Identity, source: IdentitySource): Session {
  return { identity, principal: identity.getPrincipal(), source }
}
