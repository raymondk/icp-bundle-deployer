/**
 * What upgrading an application will do, canister by canister, before any of
 * it is done.
 *
 * The plan is computed from three things: the application's record, the new
 * bundle, and the live status of every canister the record names. The status
 * read is also the controller check — only a controller may make it — so a
 * canister that is gone, or that the caller no longer controls, blocks the
 * upgrade here, while nothing has been created.
 *
 * There is no "kept as is": a canister the new bundle names is always
 * upgraded, as `icp deploy` upgrades it. A canister the record has and the
 * bundle no longer names is orphaned — left alone, not deleted, and kept in
 * the record flagged as such, so a later bundle that names it again reuses it.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import type { Principal } from '@icp-sdk/core/principal'
import { canisterStatus, type Bundle, type CanisterStatus, type DeployAction, type ExistingCanister } from '../lib'
import type { Application, ApplicationCanister } from './registry'

/** A recorded canister's status, or why it could not be read. */
export type StatusReading = { status: CanisterStatus } | { error: string }

export interface PlannedCanister {
  /** The manifest name. */
  name: string
  action: DeployAction
  /** The canister's id when it already exists; `undefined` for one to be created. */
  canisterId?: Principal
}

export interface BlockedCanister {
  name: string
  canisterId: Principal
  reason: string
}

export interface UpgradePlan {
  /** One entry per canister the new bundle declares, in the bundle's order. */
  canisters: PlannedCanister[]
  /** Recorded canisters the new bundle no longer names. Left alone. */
  orphaned: ApplicationCanister[]
  /** Recorded canisters whose status could not be read. Non-empty blocks the upgrade. */
  blocked: BlockedCanister[]
  /** What the deployer is handed, so the recorded canisters are reused rather than created. */
  existing: Record<string, ExistingCanister>
}

/** Reads the status of every canister the record names, as the pre-flight does. */
export async function readStatuses(
  agent: HttpAgent,
  record: Application,
): Promise<Map<string, StatusReading>> {
  const readings = await Promise.all(
    record.canisters.map(async (canister): Promise<[string, StatusReading]> => {
      try {
        return [canister.name, { status: await canisterStatus(agent, canister.canisterId) }]
      } catch (error) {
        return [canister.name, { error: error instanceof Error ? error.message : String(error) }]
      }
    }),
  )
  return new Map(readings)
}

/**
 * The plan: a pure function of the record, the bundle and the statuses, so
 * it is tested directly.
 */
export function planUpgrade(
  record: Application,
  bundle: Pick<Bundle, 'canisters'>,
  statuses: Map<string, StatusReading>,
): UpgradePlan {
  const recorded = new Map(record.canisters.map((canister) => [canister.name, canister]))
  const inBundle = new Set(bundle.canisters.map((canister) => canister.name))

  const blocked: BlockedCanister[] = []
  for (const canister of record.canisters) {
    const reading = statuses.get(canister.name)
    const reason =
      reading === undefined
        ? 'its status was not read'
        : 'error' in reading
          ? reading.error
          : undefined
    if (reason !== undefined) blocked.push({ name: canister.name, canisterId: canister.canisterId, reason })
  }

  const canisters: PlannedCanister[] = []
  const existing: Record<string, ExistingCanister> = {}
  for (const { name } of bundle.canisters) {
    const known = recorded.get(name)
    const reading = statuses.get(name)
    if (!known || !reading || 'error' in reading) {
      canisters.push({ name, action: 'create' })
      continue
    }
    const installed = reading.status.moduleHash !== undefined
    canisters.push({ name, action: installed ? 'upgrade' : 'install', canisterId: known.canisterId })
    existing[name] = { canisterId: known.canisterId, installed }
  }

  const orphaned = record.canisters.filter((canister) => !inBundle.has(canister.name))

  return { canisters, orphaned, blocked, existing }
}
