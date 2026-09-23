/** What a deployment reports while it runs, and what it reports at the end. */

import type { Principal } from '@icp-sdk/core/principal'

/**
 * What a run does to a canister. A name not among the existing canisters is
 * created; one that is gets installed into if it is empty and upgraded if a
 * module is on it — the mode `icp deploy` resolves from the live status.
 */
export type DeployAction = 'create' | 'install' | 'upgrade'

export type DeployEvent =
  /** Something that concerns the whole deployment, such as a phase beginning. */
  | { type: 'phase'; message: string }
  /**
   * Work on a canister begins. `canisterId` is set for a canister that already
   * exists, whose action is then `install` or `upgrade`.
   */
  | { type: 'started'; name: string; action: DeployAction; canisterId?: Principal }
  /** A canister exists. Reported the moment its id is known. */
  | { type: 'created'; name: string; canisterId: Principal; action: DeployAction }
  | { type: 'progress'; name: string; message: string }
  /** A canister's wasm is installed and running. */
  | { type: 'installed'; name: string; canisterId: Principal; action: DeployAction }
  | { type: 'failed'; name: string; message: string }

export interface DeployedCanister {
  name: string
  canisterId: Principal
}

export interface DeployResult {
  /** Canisters fully deployed, in order. */
  deployed: DeployedCanister[]
  /** Canisters created before a failure but not finished. */
  incomplete: DeployedCanister[]
  error?: string
}
