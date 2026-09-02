/**
 * Deploys a real bundle to the local network and checks what came out.
 *
 * Needs a running local network (`icp network start -d`) and funds the identity it
 * signs as via `icp cycles transfer`, exactly as a user would. Everything here goes
 * through the same modules the page uses, including the sync plugin, so a pass
 * means the deployment path works end to end and not just in parts.
 */

import { execFileSync } from 'node:child_process'
import { Ed25519KeyIdentity } from '@icp-sdk/core/identity'
import { Principal } from '@icp-sdk/core/principal'
import { HttpAgent } from '@icp-sdk/core/agent'
import {
  createDeployer,
  cyclesBalance,
  resolveEngineOperator,
  resolveSubnet,
  subnetOf,
  type DeployedCanister,
} from '../src/lib'
import { fullstackBundle } from './support/fixtures'
import { assert, assertEqual, assertRejects, group, run, test } from './support/harness'
import { canisterStatus } from './support/status'
import { loadModule } from './support/wasm'

await loadModule()

const HOST = 'http://localhost:8000'

// A fresh identity per run, so a failed run never leaves state that hides a bug.
const identity = Ed25519KeyIdentity.generate()
const principal = identity.getPrincipal()
const agent = await HttpAgent.create({ host: HOST, identity, shouldFetchRootKey: true })

console.log(`identity: ${principal.toText()}`)
execFileSync('icp', ['cycles', 'transfer', '20t', principal.toText()], { stdio: 'ignore' })

// The library, used exactly as its README shows.
const deployer = createDeployer({ agent })
const fixture = await fullstackBundle()
const bundle = await deployer.load(new File([fixture.bytes as BlobPart], 'e2e.icp'))

const result = await deployer.deploy(bundle, {
  onEvent: (event) => {
    if (event.type === 'failed') console.log(`    ! ${event.message}`)
  },
})

const deployed = (name: string): DeployedCanister => {
  const found = result.deployed.find((canister) => canister.name === name)
  if (!found) throw new Error(`"${name}" was not deployed`)
  return found
}

group('deployment')

test('deploys every canister in the bundle', () => {
  assertEqual(result.error, undefined, `deployment failed: ${result.error}`)
  assertEqual(result.deployed.length, 2, 'both canisters deployed')
  assertEqual(result.incomplete.length, 0, 'nothing left incomplete')
})

test('installs the wasm the manifest declared', async () => {
  const { moduleHash } = await canisterStatus(agent, deployed('plain').canisterId)
  const expected = bundle.canisters.find((canister) => canister.name === 'plain')!.sha256!
  assertEqual(moduleHash, expected, 'installed module hash')
})

// `update_settings` replaces a controller list rather than adding to it, so a
// handover that sent the manifest's list verbatim would hand the canister away
// and lock the deployer out of what it just paid for.
test('leaves the deploying identity in control', async () => {
  const { controllers } = await canisterStatus(agent, deployed('plain').canisterId)
  assert(controllers.includes(principal.toText()), `deployer should be a controller, got ${controllers}`)
})

test('hands over to the controllers the manifest names', async () => {
  const { controllers } = await canisterStatus(agent, deployed('plain').canisterId)
  const site = deployed('site').canisterId.toText()
  assert(controllers.includes(site), `site should have been added as a controller, got ${controllers}`)
})

test('charges the cycles ledger for what it created', async () => {
  const balance = await cyclesBalance(agent, principal)
  assert(balance < 20_000_000_000_000n, 'balance should have been spent down')
  assert(balance > 0n, 'balance should not be exhausted')
})

group('placement')

test('puts every canister on one subnet', async () => {
  const subnets = new Set(
    await Promise.all(result.deployed.map(async (c) => (await subnetOf(agent, c.canisterId))?.toText())),
  )
  assertEqual(subnets.size, 1, `expected one subnet, got ${[...subnets].join(', ')}`)
})

test('resolves a default subnet from the minting canister', async () => {
  const subnet = await resolveSubnet(agent)
  assert(subnet !== undefined, 'a local network should report default subnets')
})

test('honours an explicitly named subnet', async () => {
  const subnet = (await resolveSubnet(agent))!
  assertEqual((await resolveSubnet(agent, subnet))?.toText(), subnet.toText(), 'explicit wins')
})

group('cloud engine')

test('reads a missing engine registry as "no operator"', async () => {
  const subnet = (await resolveSubnet(agent))!
  const operator = await resolveEngineOperator(agent, subnet)
  assertEqual(operator, undefined, 'no engine is deployed locally')
})

test('reports a registry that answers with something else', async () => {
  const subnet = (await resolveSubnet(agent))!
  // The cycles ledger exists but has no such method: that is an error worth
  // surfacing, not a silent "this is an ordinary subnet".
  await assertRejects(
    () => resolveEngineOperator(agent, subnet, Principal.fromText('um5iw-rqaaa-aaaaq-qaaba-cai')),
    /could not ask/i,
    'registry without the method',
  )
})

group('canister discovery')

test('injects every canister id into every canister', async () => {
  const cookie = await envCookie(deployed('site').canisterId)
  for (const { name, canisterId } of result.deployed) {
    assertEqual(cookie[`PUBLIC_CANISTER_ID:${name}`], canisterId.toText(), `id for ${name}`)
  }
})

test("keeps the manifest's own variables", async () => {
  const cookie = await envCookie(deployed('site').canisterId)
  assertEqual(cookie.PUBLIC_APP_NAME, 'E2E fixture', 'declared variable')
})

test('does not publish variables without the PUBLIC_ prefix', async () => {
  const cookie = await envCookie(deployed('site').canisterId)
  assertEqual(cookie.PRIVATE_TOKEN, undefined, 'PRIVATE_TOKEN must stay canister-only')
})

group('asset sync')

test('serves the synced assets', async () => {
  const response = await fetch(gatewayUrl(deployed('site').canisterId))
  assertEqual(response.status, 200, 'index should be served')
  assert((await response.text()).includes('Deployed by the test suite'), 'served the fixture html')
})

test('applies the redirect rules the plugin derived', async () => {
  const response = await fetch(`${gatewayUrl(deployed('site').canisterId)}/old-page`, {
    redirect: 'manual',
  })
  assertEqual(response.status, 301, '_redirects rule should apply')
  assertEqual(response.headers.get('location'), '/about.html', 'redirect target')
})

test('serves clean URLs', async () => {
  const response = await fetch(`${gatewayUrl(deployed('site').canisterId)}/about`)
  assertEqual(response.status, 200, 'about.html should be reachable without its extension')
})

test('serves a 404 for an unknown path', async () => {
  const response = await fetch(`${gatewayUrl(deployed('site').canisterId)}/nope`)
  assertEqual(response.status, 404, 'unknown paths should 404')
})

function gatewayUrl(canisterId: Principal): string {
  return `http://${canisterId.toText()}.localhost:8000`
}

/** The `ic_env` cookie the asset canister certifies, parsed into a record. */
async function envCookie(canisterId: Principal): Promise<Record<string, string | undefined>> {
  const response = await fetch(gatewayUrl(canisterId))
  const raw = decodeURIComponent(response.headers.get('set-cookie') ?? '')
  const value = raw.replace(/^ic_env=/, '').split(';')[0]
  return Object.fromEntries(value.split('&').map((part) => part.split(/=(.*)/s).slice(0, 2)))
}

await run('e2e: deploying to the local network')
