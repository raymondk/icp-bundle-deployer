/** What a deployment reports while it runs, and what it reports at the end. */

import type { Principal } from '@icp-sdk/core/principal'

export type DeployEvent =
  /** Something that concerns the whole deployment, such as where it will land. */
  | { type: 'phase'; message: string }
  | { type: 'started'; name: string }
  | { type: 'created'; name: string; canisterId: Principal }
  | { type: 'progress'; name: string; message: string }
  | { type: 'installed'; name: string; canisterId: Principal }
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
