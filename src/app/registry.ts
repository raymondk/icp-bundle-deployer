/**
 * The application registry, as the page talks to it.
 *
 * The registry is a canister deployed beside this page, one per network, that
 * records the applications each principal deployed with it: the name, the
 * bundle it was last deployed from, and the canisters it consists of. Every
 * method is about the caller's own records, so signing in as another principal
 * shows that principal's applications and nobody else's.
 *
 * The page finds the canister the way the deployer's own canisters find each
 * other: through `PUBLIC_CANISTER_ID:registry` in the certified `ic_env` cookie
 * the asset canister serves, which `icp deploy` writes there.
 */

import { Actor, type HttpAgent } from '@icp-sdk/core/agent'
import type { CanisterEnv } from '@icp-sdk/core/agent/canister-env'
import { IDL } from '@icp-sdk/core/candid'
import { Principal } from '@icp-sdk/core/principal'

/** The name the registry is filed under in `icp.yaml`, and therefore in the cookie. */
export const REGISTRY_CANISTER_NAME = 'registry'

/**
 * What the deployment left a canister as. `unfinished` is created but not
 * fully deployed; `orphaned` is recorded under the application but no longer
 * named by its bundle.
 */
export type CanisterState = 'unfinished' | 'deployed' | 'orphaned'

export interface ApplicationCanister {
  /** The manifest name, the key the deployer injects as `PUBLIC_CANISTER_ID:<name>`. */
  name: string
  canisterId: Principal
  state: CanisterState
}

/** What the page sends. The timestamps are the registry's to set. */
export interface ApplicationInput {
  /** Trimmed, 1 to 64 printable characters; see {@link isValidApplicationName}. */
  name: string
  /** The identity of the bundle last deployed. */
  bundleSha256: string
  bundleFileName: string
  canisters: ApplicationCanister[]
}

export interface Application extends ApplicationInput {
  created: Date
  updated: Date
}

/** Why the registry refused a write, as the canister reports it. */
export type RegistryRefusal =
  | { kind: 'anonymous' }
  | { kind: 'invalidName'; name: string }
  | { kind: 'alreadyExists'; name: string }
  | { kind: 'notFound'; name: string }

export class RegistryError extends Error {
  readonly refusal: RegistryRefusal

  constructor(refusal: RegistryRefusal) {
    super(describe(refusal))
    this.refusal = refusal
  }
}

export interface Registry {
  /** The caller's applications, newest deployment first. */
  list(): Promise<Application[]>
  get(name: string): Promise<Application | undefined>
  /** Reserves the name; throws `RegistryError` with `alreadyExists` when the caller has it. */
  create(input: ApplicationInput): Promise<Application>
  /** Replaces what is recorded under a name the caller has; `notFound` otherwise. */
  update(input: ApplicationInput): Promise<Application>
}

export const APPLICATION_NAME_MAX_LENGTH = 64

/**
 * The rule the registry enforces, applied here first so a bad name is refused
 * before a call is made: trimmed, 1 to 64 characters, none of them control
 * characters. Length is counted in code points, as the canister counts it.
 */
export function isValidApplicationName(name: string): boolean {
  const length = [...name].length
  if (length === 0 || length > APPLICATION_NAME_MAX_LENGTH) return false
  if (name.trim() !== name) return false
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(name)
}

/**
 * The registry's id, from the environment the asset canister certifies, or
 * `undefined` when the page is served without one.
 */
export function registryCanisterId(env: CanisterEnv | undefined): Principal | undefined {
  const id = (env as Record<string, unknown> | undefined)?.[
    `PUBLIC_CANISTER_ID:${REGISTRY_CANISTER_NAME}`
  ]
  return typeof id === 'string' ? Principal.fromText(id) : undefined
}

// ── The interface, as the canister declares it ──────────────────────────────

const CanisterStateIdl = IDL.Variant({
  unfinished: IDL.Null,
  deployed: IDL.Null,
  orphaned: IDL.Null,
})

const CanisterEntryIdl = IDL.Record({
  name: IDL.Text,
  canisterId: IDL.Principal,
  state: CanisterStateIdl,
})

const ApplicationInputIdl = IDL.Record({
  name: IDL.Text,
  bundleSha256: IDL.Text,
  bundleFileName: IDL.Text,
  canisters: IDL.Vec(CanisterEntryIdl),
})

const ApplicationIdl = IDL.Record({
  name: IDL.Text,
  bundleSha256: IDL.Text,
  bundleFileName: IDL.Text,
  created: IDL.Int,
  updated: IDL.Int,
  canisters: IDL.Vec(CanisterEntryIdl),
})

const ErrorIdl = IDL.Variant({
  anonymous: IDL.Null,
  invalidName: IDL.Text,
  alreadyExists: IDL.Text,
  notFound: IDL.Text,
})

const ResultIdl = IDL.Variant({ ok: ApplicationIdl, err: ErrorIdl })

const idlFactory: IDL.InterfaceFactory = () =>
  IDL.Service({
    list: IDL.Func([], [IDL.Vec(ApplicationIdl)], ['query']),
    get: IDL.Func([IDL.Text], [IDL.Opt(ApplicationIdl)], ['query']),
    create: IDL.Func([ApplicationInputIdl], [ResultIdl], []),
    update: IDL.Func([ApplicationInputIdl], [ResultIdl], []),
  })

type RawState = { unfinished: null } | { deployed: null } | { orphaned: null }
type RawEntry = { name: string; canisterId: Principal; state: RawState }
type RawInput = { name: string; bundleSha256: string; bundleFileName: string; canisters: RawEntry[] }
type RawApplication = RawInput & { created: bigint; updated: bigint }
type RawError =
  | { anonymous: null }
  | { invalidName: string }
  | { alreadyExists: string }
  | { notFound: string }
type RawResult = { ok: RawApplication } | { err: RawError }

interface RegistryService {
  list: () => Promise<RawApplication[]>
  get: (name: string) => Promise<[] | [RawApplication]>
  create: (input: RawInput) => Promise<RawResult>
  update: (input: RawInput) => Promise<RawResult>
}

export function createRegistry(agent: HttpAgent, canisterId: Principal): Registry {
  const actor = Actor.createActor<RegistryService>(idlFactory, { agent, canisterId })

  return {
    async list() {
      return (await actor.list()).map(fromRaw)
    },
    async get(name) {
      const [found] = await actor.get(name)
      return found === undefined ? undefined : fromRaw(found)
    },
    async create(input) {
      return unwrap(await actor.create(toRaw(input)))
    },
    async update(input) {
      return unwrap(await actor.update(toRaw(input)))
    },
  }
}

function unwrap(result: RawResult): Application {
  if ('ok' in result) return fromRaw(result.ok)
  const error = result.err
  if ('anonymous' in error) throw new RegistryError({ kind: 'anonymous' })
  if ('invalidName' in error) throw new RegistryError({ kind: 'invalidName', name: error.invalidName })
  if ('alreadyExists' in error) {
    throw new RegistryError({ kind: 'alreadyExists', name: error.alreadyExists })
  }
  throw new RegistryError({ kind: 'notFound', name: error.notFound })
}

function toRaw(input: ApplicationInput): RawInput {
  return {
    name: input.name,
    bundleSha256: input.bundleSha256,
    bundleFileName: input.bundleFileName,
    canisters: input.canisters.map((canister) => ({
      name: canister.name,
      canisterId: canister.canisterId,
      state: { [canister.state]: null } as RawState,
    })),
  }
}

function fromRaw(raw: RawApplication): Application {
  return {
    name: raw.name,
    bundleSha256: raw.bundleSha256,
    bundleFileName: raw.bundleFileName,
    created: fromNanoseconds(raw.created),
    updated: fromNanoseconds(raw.updated),
    canisters: raw.canisters.map((canister) => ({
      name: canister.name,
      canisterId: canister.canisterId,
      state: Object.keys(canister.state)[0] as CanisterState,
    })),
  }
}

/** The IC keeps time in nanoseconds since the epoch; a `Date` holds milliseconds. */
function fromNanoseconds(time: bigint): Date {
  return new Date(Number(time / 1_000_000n))
}

function describe(refusal: RegistryRefusal): string {
  switch (refusal.kind) {
    case 'anonymous':
      return 'The registry keeps no applications for an anonymous caller. Sign in first.'
    case 'invalidName':
      return `"${refusal.name}" is not a valid application name: use 1 to ${APPLICATION_NAME_MAX_LENGTH} printable characters with no surrounding whitespace.`
    case 'alreadyExists':
      return `You already have an application named "${refusal.name}". Upgrade it instead, or choose another name.`
    case 'notFound':
      return `You have no application named "${refusal.name}".`
  }
}
