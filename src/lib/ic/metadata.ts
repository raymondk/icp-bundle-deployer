/**
 * Reading a canister's custom-section metadata, certified.
 *
 * `read_state` is not a canister method, so this is the only route to a
 * canister's metadata and there is nothing to route through a proxy. The reply
 * is checked against the network's root key, so what comes back is what the
 * subnet attested to rather than what a boundary node said.
 *
 * Absence is an answer, not a failure — "does this canister declare it?" is a
 * question with a `no`. But only a certificate can give that answer: a tree that
 * says nothing about the path proves nothing, and a canister that does not exist
 * has no answer to give. Both are errors here, so a caller that sees `undefined`
 * knows the section is genuinely absent.
 */

import { Certificate, LookupPathStatus, type HttpAgent } from '@icp-sdk/core/agent'
import type { Principal } from '@icp-sdk/core/principal'

export class MetadataError extends Error {}

export async function readMetadata(
  agent: HttpAgent,
  canisterId: Principal,
  name: string,
): Promise<Uint8Array | undefined> {
  const encoder = new TextEncoder()
  const metadataPath = [
    encoder.encode('canister'),
    canisterId.toUint8Array(),
    encoder.encode('metadata'),
    encoder.encode(name),
  ]
  // Asked for alongside the section: a canister with no module has no sections
  // at all, and one that does not exist has no controllers either — which is
  // what tells those two apart.
  const controllersPath = [
    encoder.encode('canister'),
    canisterId.toUint8Array(),
    encoder.encode('controllers'),
  ]

  const { certificate } = await agent.readState(canisterId, {
    paths: [metadataPath, controllersPath],
  })
  const verified = await Certificate.create({
    certificate,
    rootKey: agent.rootKey!,
    principal: { canisterId },
    agent,
  })

  const section = verified.lookup_path(metadataPath)
  if (section.status === LookupPathStatus.Found) return section.value
  if (section.status !== LookupPathStatus.Absent) {
    throw new MetadataError(
      `the certificate proves nothing about section "${name}" of canister ${canisterId.toText()}`,
    )
  }
  if (verified.lookup_path(controllersPath).status !== LookupPathStatus.Found) {
    throw new MetadataError(`canister ${canisterId.toText()} does not exist`)
  }
  return undefined
}
