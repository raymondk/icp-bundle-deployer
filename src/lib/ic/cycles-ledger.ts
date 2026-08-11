/**
 * The slice of the cycles ledger this deployer needs.
 *
 * An ingress message cannot carry cycles, so a browser can never call the
 * management canister's `create_canister` directly. On mainnet the cycles ledger
 * is the way in: it creates the canister and charges the caller's own balance.
 *
 * `@icp-sdk/canisters` ships a cycles-ledger client, but it only wraps `withdraw`
 * and does not export the generated IDL, so the two methods used here are declared
 * by hand.
 */

import { Actor, type HttpAgent } from '@icp-sdk/core/agent'
import { IDL } from '@icp-sdk/core/candid'
import { Principal } from '@icp-sdk/core/principal'

export const CYCLES_LEDGER_CANISTER_ID = Principal.fromText('um5iw-rqaaa-aaaaq-qaaba-cai')

const Account = IDL.Record({
  owner: IDL.Principal,
  subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
})

const SubnetSelection = IDL.Variant({
  Subnet: IDL.Record({ subnet: IDL.Principal }),
  Filter: IDL.Record({ subnet_type: IDL.Opt(IDL.Text) }),
})

const CmcCreateCanisterArgs = IDL.Record({
  // Always sent as absent: the manifest's settings are applied afterwards through
  // the management canister, whose typed client knows every settings field.
  settings: IDL.Opt(IDL.Null),
  subnet_selection: IDL.Opt(SubnetSelection),
})

const CreateCanisterArgs = IDL.Record({
  from_subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)),
  created_at_time: IDL.Opt(IDL.Nat64),
  amount: IDL.Nat,
  creation_args: IDL.Opt(CmcCreateCanisterArgs),
})

const CreateCanisterSuccess = IDL.Record({
  block_id: IDL.Nat,
  canister_id: IDL.Principal,
})

const CreateCanisterError = IDL.Variant({
  InsufficientFunds: IDL.Record({ balance: IDL.Nat }),
  TooOld: IDL.Null,
  CreatedInFuture: IDL.Record({ ledger_time: IDL.Nat64 }),
  TemporarilyUnavailable: IDL.Null,
  Duplicate: IDL.Record({
    duplicate_of: IDL.Nat,
    canister_id: IDL.Opt(IDL.Principal),
  }),
  FailedToCreate: IDL.Record({
    fee_block: IDL.Opt(IDL.Nat),
    refund_block: IDL.Opt(IDL.Nat),
    error: IDL.Text,
  }),
  GenericError: IDL.Record({ message: IDL.Text, error_code: IDL.Nat }),
})

const idlFactory: IDL.InterfaceFactory = () =>
  IDL.Service({
    create_canister: IDL.Func(
      [CreateCanisterArgs],
      [IDL.Variant({ Ok: CreateCanisterSuccess, Err: CreateCanisterError })],
      [],
    ),
    icrc1_balance_of: IDL.Func([Account], [IDL.Nat], ['query']),
  })

type CreateCanisterResult =
  | { Ok: { block_id: bigint; canister_id: Principal } }
  | { Err: CreateCanisterErrorValue }

export type CreateCanisterErrorValue =
  | { InsufficientFunds: { balance: bigint } }
  | { TooOld: null }
  | { CreatedInFuture: { ledger_time: bigint } }
  | { TemporarilyUnavailable: null }
  | { Duplicate: { duplicate_of: bigint; canister_id: [] | [Principal] } }
  | { FailedToCreate: { fee_block: [] | [bigint]; refund_block: [] | [bigint]; error: string } }
  | { GenericError: { message: string; error_code: bigint } }

type CreationArgs = {
  settings: []
  subnet_selection: [] | [{ Subnet: { subnet: Principal } }]
}

interface CyclesLedgerService {
  create_canister: (args: {
    from_subaccount: []
    created_at_time: []
    amount: bigint
    creation_args: [] | [CreationArgs]
  }) => Promise<CreateCanisterResult>
  icrc1_balance_of: (account: { owner: Principal; subaccount: [] }) => Promise<bigint>
}

function actor(agent: HttpAgent, canisterId: Principal) {
  return Actor.createActor<CyclesLedgerService>(idlFactory, { agent, canisterId })
}

export class CyclesLedgerError extends Error {}

export interface CreateCanisterOptions {
  /**
   * Pins the canister to one subnet. Left out, the ledger places it. Not meaningful
   * for an engine operator, which only ever creates on its own subnet.
   */
  subnet?: Principal
  /**
   * Who performs the creation. Defaults to the cycles ledger; a cloud engine's
   * operator exposes the same `create_canister`, so it slots in here unchanged.
   */
  target?: Principal
}

/** Creates a canister funded with `amount` cycles from the caller's balance. */
export async function createCanister(
  agent: HttpAgent,
  amount: bigint,
  { subnet, target = CYCLES_LEDGER_CANISTER_ID }: CreateCanisterOptions = {},
): Promise<Principal> {
  const result = await actor(agent, target).create_canister({
    from_subaccount: [],
    created_at_time: [],
    amount,
    creation_args: subnet
      ? [{ settings: [], subnet_selection: [{ Subnet: { subnet } }] }]
      : [],
  })

  if ('Ok' in result) return result.Ok.canister_id
  throw new CyclesLedgerError(describeError(result.Err, amount, subnet))
}

export async function cyclesBalance(agent: HttpAgent, owner: Principal): Promise<bigint> {
  return actor(agent, CYCLES_LEDGER_CANISTER_ID).icrc1_balance_of({ owner, subaccount: [] })
}

function describeError(
  error: CreateCanisterErrorValue,
  requested: bigint,
  subnet?: Principal,
): string {
  if ('InsufficientFunds' in error) {
    return (
      `Not enough cycles: creating this canister needs ${formatCycles(requested)} but the ` +
      `cycles ledger balance is ${formatCycles(error.InsufficientFunds.balance)}. ` +
      'Top up this principal and try again.'
    )
  }
  if ('FailedToCreate' in error) {
    // A subnet that will not take canisters from the cycles ledger reports the same
    // error as one that does not exist, and the difference matters: a cloud engine's
    // subnet is reached through its operator, not through the ledger.
    const hint = subnet
      ? ` The target subnet was ${subnet.toText()}. A subnet that exists may still refuse ` +
        'creation through the cycles ledger — a cloud engine, for one, is deployed to ' +
        'through its engine operator instead.'
      : ''
    return `The cycles ledger could not create the canister: ${error.FailedToCreate.error}${hint}`
  }
  if ('GenericError' in error) {
    return `The cycles ledger rejected the request: ${error.GenericError.message}`
  }
  if ('TemporarilyUnavailable' in error) {
    return 'The cycles ledger is temporarily unavailable. Try again in a moment.'
  }
  return `The cycles ledger rejected the request: ${JSON.stringify(error, replaceBigInt)}`
}

export function formatCycles(cycles: bigint): string {
  const units: [bigint, string][] = [
    [1_000_000_000_000n, 'T'],
    [1_000_000_000n, 'B'],
    [1_000_000n, 'M'],
    [1_000n, 'K'],
  ]
  for (const [scale, suffix] of units) {
    if (cycles >= scale) {
      // One decimal place, without floating point.
      const tenths = (cycles * 10n) / scale
      return `${tenths / 10n}.${tenths % 10n}${suffix} cycles`
    }
  }
  return `${cycles} cycles`
}

function replaceBigInt(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}
