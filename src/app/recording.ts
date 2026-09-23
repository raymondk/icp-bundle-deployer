/**
 * Recording a deployment as an application.
 *
 * The record is created before anything is deployed: `create` reserves the
 * name, so a clash is reported while the bundle is still bytes in a tab and
 * there is no late failure to handle. It is then updated after every canister
 * the run creates — every id reaches the registry the moment the canister
 * exists, and a closed tab loses nothing — and once more when the run settles,
 * with each canister's final state.
 *
 * None of this needs a DOM, so the page hands in the registry and the deploy
 * call and the offline suite hands in stand-ins.
 */

import type { DeployEvent, DeployResult } from '../lib'
import type { UpgradePlan } from './plan'
import {
  isValidApplicationName,
  type Application,
  type ApplicationCanister,
  type ApplicationInput,
  type Registry,
} from './registry'

/**
 * The name a bundle's file proposes for the application it installs: the file
 * name with its extension and a trailing version taken off, so `my-app-1.2.0.icp`
 * proposes `my-app`. Empty when there is no file name, or nothing usable is
 * left of it.
 */
export function proposeApplicationName(fileName: string | undefined): string {
  if (!fileName) return ''
  // `1.2.0`, `v2`, `1.2.0-beta.1`: an optional `v`, dotted digits, and whatever
  // pre-release tail follows them.
  const version = 'v?\\d+(?:\\.\\d+)*(?:[-+.][0-9a-z]+(?:\\.[0-9a-z]+)*)?'
  const stem = fileName.replace(/\.(icp|tar\.gz|tgz|tar)$/i, '')
  // A file named by its version alone proposes nothing.
  if (new RegExp(`^${version}$`, 'i').test(stem)) return ''
  const name = stem.replace(new RegExp(`[-_.]${version}$`, 'i'), '').trim()
  return isValidApplicationName(name) ? name : ''
}

export interface RecordedDeployment {
  registry: Registry
  /** The record without its canisters, which the run fills in. */
  application: Omit<ApplicationInput, 'canisters'>
  /**
   * Runs the deployment. `record` has to see every event the deployment
   * reports; the caller may handle them too, before or after.
   */
  deploy: (record: (event: DeployEvent) => void) => Promise<DeployResult>
}

export interface Recorded {
  result: DeployResult
  /** The record as the registry last acknowledged it, if any update reached it. */
  application?: Application
  /** Why the record is behind what happened, when an update failed. */
  recordingError?: string
}

/**
 * Reserves the application name, runs the deployment, and keeps the record up
 * to date with it. Throws what `create` throws — a `RegistryError` for a name
 * the caller already has — before anything is deployed; a failure to update
 * the record later is reported on the result rather than thrown, since by
 * then the canisters exist whatever the registry says.
 */
export async function deployRecorded({
  registry,
  application,
  deploy,
}: RecordedDeployment): Promise<Recorded> {
  await registry.create({ ...application, canisters: [] })
  return recordRun({ registry, application, canisters: [], deploy })
}

export interface RecordedUpgrade {
  registry: Registry
  /** The application as recorded, whose name and canisters the run reuses. */
  record: Application
  /** The new bundle's identity, which replaces the record's. */
  bundle: { sha256: string; fileName: string }
  plan: UpgradePlan
  deploy: RecordedDeployment['deploy']
}

/**
 * Runs an upgrade and keeps the record up to date with it: the bundle's
 * identity replaced, the canisters the plan orphans flagged as such, every
 * canister the run creates added as it exists, and every state refreshed when
 * the run settles. A canister the run did not reach keeps the state it had.
 */
export async function upgradeRecorded({
  registry,
  record,
  bundle,
  plan,
  deploy,
}: RecordedUpgrade): Promise<Recorded> {
  const orphaned = new Set(plan.orphaned.map((canister) => canister.name))
  const canisters = record.canisters.map((canister) => ({
    ...canister,
    state: orphaned.has(canister.name) ? ('orphaned' as const) : canister.state,
  }))
  return recordRun({
    registry,
    application: { name: record.name, bundleSha256: bundle.sha256, bundleFileName: bundle.fileName },
    canisters,
    deploy,
  })
}

/**
 * The part an install and an upgrade share: one update per canister the run
 * creates, and one when the run settles. `canisters` is what the record holds
 * going in; what the run creates is added to it.
 */
async function recordRun({
  registry,
  application,
  canisters,
  deploy,
}: {
  registry: Registry
  application: Omit<ApplicationInput, 'canisters'>
  canisters: ApplicationCanister[]
  deploy: RecordedDeployment['deploy']
}): Promise<Recorded> {
  let recorded: Application | undefined
  let recordingError: string | undefined

  // One update per event, each carrying what was known at that moment, and
  // queued so two canisters created back to back cannot land in the registry
  // out of order.
  let queue: Promise<void> = Promise.resolve()
  const record = (): Promise<void> => {
    const snapshot = canisters.map((canister) => ({ ...canister }))
    queue = queue.then(async () => {
      try {
        recorded = await registry.update({ ...application, canisters: snapshot })
      } catch (error) {
        recordingError = error instanceof Error ? error.message : String(error)
      }
    })
    return queue
  }

  const created = new Set<string>()
  const onEvent = (event: DeployEvent): void => {
    if (event.type !== 'created') return
    created.add(event.name)
    canisters.push({ name: event.name, canisterId: event.canisterId, state: 'unfinished' })
    void record()
  }

  let result: DeployResult
  try {
    result = await deploy(onEvent)
  } catch (error) {
    // Whatever was created before the run blew up is recorded as unfinished:
    // the canisters exist and the user controls them.
    await record()
    throw error
  }

  // What the run finished is deployed and what it left behind is unfinished;
  // a canister it never reached — an existing one, when the run failed before
  // its phase — keeps the state it had.
  const finished = new Set(result.deployed.map((canister) => canister.name))
  const left = new Set(result.incomplete.map((canister) => canister.name))
  for (const canister of canisters) {
    if (finished.has(canister.name)) canister.state = 'deployed'
    else if (left.has(canister.name) || created.has(canister.name)) canister.state = 'unfinished'
  }
  // A canister the result lists but the record did not know — one no event
  // announced — is recorded from the result.
  for (const canister of [...result.deployed, ...result.incomplete]) {
    if (!canisters.some((known) => known.name === canister.name)) {
      canisters.push({ ...canister, state: finished.has(canister.name) ? 'deployed' : 'unfinished' })
    }
  }
  await record()

  return { result, application: recorded, recordingError }
}
