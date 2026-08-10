/**
 * Deploys a verified bundle: for each canister, create it, apply its settings, and
 * install its wasm.
 *
 * The whole bundle is validated and hashed before this runs, so a failure here means
 * the network rejected something. When that happens the run stops and reports the
 * canisters that already exist, so nothing is silently left behind.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import type { Principal } from '@icp-sdk/core/principal'
import type { Bundle } from './bundle'
import { applySettings, createCanister } from './ic/create'
import { installCode } from './ic/install'
import type { Network } from './ic/network'

export interface DeployedCanister {
  name: string
  canisterId: Principal
}

export type DeployEvent =
  | { type: 'started'; name: string }
  | { type: 'created'; name: string; canisterId: Principal }
  | { type: 'progress'; name: string; message: string }
  | { type: 'installed'; name: string; canisterId: Principal }
  | { type: 'failed'; name: string; message: string }

export interface DeployResult {
  /** Canisters fully deployed, in order. */
  deployed: DeployedCanister[]
  /** Canisters created before a failure but left without a working install. */
  incomplete: DeployedCanister[]
  error?: string
}

export interface DeployOptions {
  bundle: Bundle
  agent: HttpAgent
  network: Network
  onEvent?: (event: DeployEvent) => void
}

export async function deployBundle({
  bundle,
  agent,
  network,
  onEvent = () => {},
}: DeployOptions): Promise<DeployResult> {
  const deployed: DeployedCanister[] = []
  const incomplete: DeployedCanister[] = []

  for (const canister of bundle.manifest.canisters) {
    const { name } = canister
    onEvent({ type: 'started', name })

    let canisterId: Principal
    try {
      canisterId = await createCanister(agent, network)
    } catch (error) {
      const message = `Could not create canister "${name}": ${describe(error)}`
      onEvent({ type: 'failed', name, message })
      return { deployed, incomplete, error: message }
    }
    onEvent({ type: 'created', name, canisterId })

    try {
      // Controllers are applied last: dropping ourselves as controller before the
      // install would lock us out of the canister we are still setting up.
      const { controllers, ...resourceSettings } = canister.settings

      await applySettings(agent, canisterId, resourceSettings)

      onEvent({ type: 'progress', name, message: `Installing ${formatBytes(canister.wasm.length)}…` })
      await installCode(agent, canisterId, canister.wasm, canister.initArg, {
        onProgress: (uploaded, total) =>
          onEvent({ type: 'progress', name, message: `Uploading chunk ${uploaded} of ${total}…` }),
      })

      if (controllers) {
        await applySettings(agent, canisterId, { controllers })
      }
    } catch (error) {
      const message = `Could not install canister "${name}" (${canisterId.toText()}): ${describe(error)}`
      incomplete.push({ name, canisterId })
      onEvent({ type: 'failed', name, message })
      return { deployed, incomplete, error: message }
    }

    deployed.push({ name, canisterId })
    onEvent({ type: 'installed', name, canisterId })
  }

  return { deployed, incomplete }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
