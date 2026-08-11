/**
 * Deploys a verified bundle, in the phases `icp deploy` uses.
 *
 * The phases exist for one reason: canisters have to discover each other. Every
 * canister is created first so all the IDs are known, then each is given the whole
 * set as `PUBLIC_CANISTER_ID:*` environment variables, and only then is any wasm
 * installed. Deploying one canister at a time would leave the first one unable to
 * learn the second one's ID.
 *
 * The whole bundle is validated and hashed before this runs, so a failure here means
 * the network rejected something. When that happens the run stops and reports which
 * canisters exist but are not finished, so nothing is silently left behind.
 */

import type { HttpAgent } from '@icp-sdk/core/agent'
import type { Principal } from '@icp-sdk/core/principal'
import type { Bundle, BundleCanister } from './bundle'
import { applySettings, createCanister } from './ic/create'
import { resolveEngineOperator } from './ic/engine'
import { installCode } from './ic/install'
import type { Network } from './ic/network'
import { resolveSubnet, subnetOf } from './ic/subnet'
import { runSyncStep } from './sync'

export interface DeployedCanister {
  name: string
  canisterId: Principal
}

export type DeployEvent =
  | { type: 'phase'; message: string }
  | { type: 'started'; name: string }
  | { type: 'created'; name: string; canisterId: Principal }
  | { type: 'progress'; name: string; message: string }
  | { type: 'installed'; name: string; canisterId: Principal }
  | { type: 'failed'; name: string; message: string }

export interface DeployResult {
  /** Canisters fully deployed, in order. */
  deployed: DeployedCanister[]
  /** Canisters created before a failure but not finished. */
  incomplete: DeployedCanister[]
  error?: string
}

export interface DeployOptions {
  bundle: Bundle
  agent: HttpAgent
  network: Network
  /** Principal the deployment signs as; sync plugins are told who is calling. */
  identityPrincipal: Principal
  /**
   * Pin every canister to one subnet, as `icp deploy --subnet` does. Left out, the
   * cycles ledger places them. A cloud engine is a single subnet, so deploying to
   * one means naming it here.
   */
  subnet?: Principal
  onEvent?: (event: DeployEvent) => void
}

/**
 * Prefix icp-cli uses for injected canister IDs. The `PUBLIC_` part is a security
 * boundary, not decoration: the asset canister only republishes `PUBLIC_`-prefixed
 * variables in its `ic_env` cookie, keeping everything else canister-only.
 */
const CANISTER_ID_VARIABLE = 'PUBLIC_CANISTER_ID:'

export async function deployBundle({
  bundle,
  agent,
  network,
  identityPrincipal,
  subnet,
  onEvent = () => {},
}: DeployOptions): Promise<DeployResult> {
  const canisters = bundle.manifest.canisters
  const created = new Map<string, Principal>()
  const finished: DeployedCanister[] = []

  const outcome = (error: string): DeployResult => ({
    deployed: finished,
    incomplete: [...created]
      .filter(([name]) => !finished.some((done) => done.name === name))
      .map(([name, canisterId]) => ({ name, canisterId })),
    error,
  })

  // ── Create ────────────────────────────────────────────────────────────────
  // One subnet for the whole bundle. Resolved once, before anything is created, so
  // canisters that call each other are not scattered across subnets.
  let target = await resolveSubnet(agent, subnet)
  let operator: Principal | undefined

  if (target) {
    // A cloud engine creates through its own operator rather than the cycles
    // ledger. Resolved before the first creation, deliberately: once a create has
    // been handed to an operator, a failure may still have produced a canister, so
    // falling back afterwards risks creating — and paying for — a second one.
    try {
      operator = await resolveEngineOperator(agent, target)
    } catch (error) {
      const message = describe(error)
      onEvent({ type: 'failed', name: canisters[0]?.name ?? '', message })
      return outcome(message)
    }

    onEvent({
      type: 'phase',
      message: operator
        ? `Subnet ${target.toText()} is a cloud engine; creating through its operator ${operator.toText()}`
        : `Creating canisters on subnet ${target.toText()}`,
    })
  }

  for (const canister of canisters) {
    onEvent({ type: 'started', name: canister.name })
    try {
      const canisterId = await createCanister(agent, { subnet: target, operator })
      created.set(canister.name, canisterId)
      onEvent({ type: 'created', name: canister.name, canisterId })

      // The network could not name a subnet up front, so anchor to wherever the
      // first canister landed and keep the rest with it. No operator lookup here:
      // without a subnet there was nothing to look one up for, and an engine is
      // always reached through an explicitly chosen subnet.
      if (!target) {
        target = await subnetOf(agent, canisterId)
        if (target) {
          onEvent({ type: 'phase', message: `Colocating on subnet ${target.toText()}` })
        }
      }
    } catch (error) {
      const message = `Could not create canister "${canister.name}": ${describe(error)}`
      onEvent({ type: 'failed', name: canister.name, message })
      return outcome(message)
    }
  }

  // ── Settings, including the canister IDs every canister needs ─────────────
  const discovery = [...created].map(([name, canisterId]) => ({
    name: `${CANISTER_ID_VARIABLE}${name}`,
    value: canisterId.toText(),
  }))

  for (const canister of canisters) {
    const canisterId = created.get(canister.name)!
    // Controllers are applied at the very end: dropping ourselves as controller now
    // would lock us out of the canister we are still setting up.
    const { controllers: _controllers, ...settings } = canister.settings
    const environmentVariables = mergeEnvironment(canister, discovery)

    try {
      onEvent({
        type: 'progress',
        name: canister.name,
        message: `Setting ${environmentVariables.length} environment variable(s)…`,
      })
      await applySettings(agent, canisterId, { ...settings, environmentVariables })
    } catch (error) {
      const message = `Could not configure canister "${canister.name}" (${canisterId.toText()}): ${describe(error)}`
      onEvent({ type: 'failed', name: canister.name, message })
      return outcome(message)
    }
  }

  // ── Install, then sync ────────────────────────────────────────────────────
  for (const canister of canisters) {
    const canisterId = created.get(canister.name)!
    try {
      onEvent({
        type: 'progress',
        name: canister.name,
        message: `Installing ${formatBytes(canister.wasm.length)}…`,
      })
      await installCode(agent, canisterId, canister.wasm, canister.initArg, {
        onProgress: (uploaded, total) =>
          onEvent({
            type: 'progress',
            name: canister.name,
            message: `Uploading chunk ${uploaded} of ${total}…`,
          }),
      })

      // Sync runs while we are still a controller — a plugin must be authorized on
      // the canister it syncs — and after the environment variables are in place,
      // since the asset canister captures them when a sync starts.
      for (const step of canister.sync) {
        onEvent({
          type: 'progress',
          name: canister.name,
          message: `Syncing ${step.dirs.join(', ')}…`,
        })
        await runSyncStep({
          agent,
          canisterId,
          step,
          entries: bundle.entries,
          identityPrincipal,
          environment: network.kind === 'mainnet' ? 'ic' : 'local',
          onOutput: (line) => onEvent({ type: 'progress', name: canister.name, message: line }),
        })
      }
    } catch (error) {
      const message = `Could not install canister "${canister.name}" (${canisterId.toText()}): ${describe(error)}`
      onEvent({ type: 'failed', name: canister.name, message })
      return outcome(message)
    }

    finished.push({ name: canister.name, canisterId })
    onEvent({ type: 'installed', name: canister.name, canisterId })
  }

  // ── Hand over control, if the bundle asked for it ─────────────────────────
  for (const canister of canisters) {
    if (!canister.settings.controllers) continue
    const canisterId = created.get(canister.name)!
    try {
      await applySettings(agent, canisterId, { controllers: canister.settings.controllers })
    } catch (error) {
      const message = `Deployed canister "${canister.name}" (${canisterId.toText()}) but could not set its controllers: ${describe(error)}`
      onEvent({ type: 'failed', name: canister.name, message })
      return { deployed: finished, incomplete: [], error: message }
    }
  }

  return { deployed: finished, incomplete: [] }
}

/**
 * The bundle's own variables plus the discovered canister IDs. A bundle may name a
 * canister outside itself (an external ledger, say) and that entry is preserved;
 * for names the bundle deploys, the ID from this deployment is the true one.
 */
function mergeEnvironment(
  canister: BundleCanister,
  discovery: { name: string; value: string }[],
): { name: string; value: string }[] {
  const merged = new Map<string, string>()
  for (const { name, value } of canister.settings.environmentVariables ?? []) {
    merged.set(name, value)
  }
  for (const { name, value } of discovery) {
    merged.set(name, value)
  }
  return [...merged].map(([name, value]) => ({ name, value }))
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
