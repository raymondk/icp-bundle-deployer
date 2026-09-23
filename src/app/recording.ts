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
import {
  isValidApplicationName,
  type Application,
  type ApplicationCanister,
  type ApplicationInput,
  type CanisterState,
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

  const canisters: ApplicationCanister[] = []
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

  const onEvent = (event: DeployEvent): void => {
    if (event.type !== 'created') return
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

  const states = new Map<string, CanisterState>()
  for (const canister of result.deployed) states.set(canister.name, 'deployed')
  for (const canister of result.incomplete) states.set(canister.name, 'unfinished')
  for (const canister of canisters) canister.state = states.get(canister.name) ?? 'unfinished'
  // A canister the result lists but no event announced — one that existed
  // before the run, say — is recorded from the result.
  for (const canister of [...result.deployed, ...result.incomplete]) {
    if (!canisters.some((known) => known.name === canister.name)) {
      canisters.push({ ...canister, state: states.get(canister.name)! })
    }
  }
  await record()

  return { result, application: recorded, recordingError }
}
