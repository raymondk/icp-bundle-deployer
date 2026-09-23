/**
 * Deploys a real bundle to the local network and checks what came out.
 *
 * Needs a running local network (`icp network start -d`) and funds the identity it
 * signs as via `icp cycles transfer`, exactly as a user would. Everything here goes
 * through the same modules the page uses, both sync plugins included, so a pass
 * means the deployment path works end to end and not just in parts.
 */

import { execFileSync } from 'node:child_process'
import { Ed25519KeyIdentity } from '@icp-sdk/core/identity'
import { Principal } from '@icp-sdk/core/principal'
import { HttpAgent } from '@icp-sdk/core/agent'
import {
  canisterStatus,
  createDeployer,
  cyclesBalance,
  resolveSubnet,
  subnetOf,
  type DeployedCanister,
} from '../src/lib'
import { planUpgrade, readStatuses } from '../src/app/plan'
import { upgradeRecorded } from '../src/app/recording'
import { createRegistry, RegistryError, type ApplicationInput } from '../src/app/registry'
import { fullstackBundle } from './support/fixtures'
import { assert, assertEqual, assertRejects, group, run, test } from './support/harness'
import { loadModule } from './support/wasm'

await loadModule()

const HOST = 'http://localhost:8000'

// A fresh identity per run, so a failed run never leaves state that hides a bug.
const identity = Ed25519KeyIdentity.generate()
const principal = identity.getPrincipal()
const agent = await HttpAgent.create({ host: HOST, identity, shouldFetchRootKey: true })

console.log(`identity: ${principal.toText()}`)
execFileSync('icp', ['cycles', 'transfer', '20t', principal.toText()], { stdio: 'ignore' })

// The registry the page records applications in, deployed the way the project
// deploys it. Its records outlive a run; the identity above is fresh, so nothing
// from an earlier run is under its name.
execFileSync('icp', ['deploy', 'registry'], { stdio: 'ignore' })
const registryId = Principal.fromText(
  execFileSync('icp', ['canister', 'status', 'registry', '-i'], { encoding: 'utf-8' }).trim(),
)

// The library, used exactly as its README shows. The gateway is named so a sync
// plugin is told one: on a local network nothing else could tell it.
const deployer = createDeployer({ agent, gatewayUrl: HOST })
const fixture = await fullstackBundle()
const bundle = await deployer.load(new File([fixture.bytes as BlobPart], 'e2e.icp'))

// What the script plugin printed while it ran, as the deployment reported it,
// and the phases the run went through.
const scriptOutput: string[] = []
const phases: string[] = []

const result = await deployer.deploy(bundle, {
  onEvent: (event) => {
    if (event.type === 'failed') console.log(`    ! ${event.message}`)
    if (event.type === 'phase') phases.push(event.message)
    if (event.type === 'progress' && event.name === 'plain') scriptOutput.push(event.message)
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

// The phases are `icp deploy`'s own, reported as the run enters them — the
// same operation, so the same order: every canister created before any wasm is
// installed, and every wasm installed before any sync plugin runs.
test('runs the phases icp deploy runs, in its order', () => {
  const expected = [
    'Creating canisters',
    'Setting environment variables',
    'Applying canister settings',
    'Installing canisters',
    'Syncing canisters',
  ]
  assertEqual(phases.join(' > '), expected.join(' > '), 'phases in order')
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
  const controllers = (await canisterStatus(agent, deployed('plain').canisterId)).controllers.map((c) => c.toText())
  assert(controllers.includes(principal.toText()), `deployer should be a controller, got ${controllers}`)
})

test('hands over to the controllers the manifest names', async () => {
  const controllers = (await canisterStatus(agent, deployed('plain').canisterId)).controllers.map((c) => c.toText())
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

group('script sync')

// The script plugin speaks `icp:sync-plugin@0.2`, so this is the path that hands a
// plugin named entries, the network URLs, the step's fields and the canister
// table — none of which the asset plugin above takes. The page it uploaded is
// where each of those becomes visible from outside.
const scriptPage = async (): Promise<Record<string, string>> => {
  // Asked for by its key: serving `/` as the index is a rewrite rule the asset
  // plugin installs, and the script uploaded one asset and no rules.
  const response = await fetch(`${gatewayUrl(deployed('plain').canisterId)}/index.html`)
  assertEqual(response.status, 200, 'the script should have uploaded an index page')
  const pre = /<pre>\n([\s\S]*?)<\/pre>/.exec(await response.text())
  assert(pre, 'the page should carry the values the script read')
  return Object.fromEntries(
    pre[1]
      .trim()
      .split('\n')
      .map((line) => line.split(/: (.*)/s).slice(0, 2)),
  )
}

test('runs the script the step declared and serves what it uploaded', async () => {
  const page = await scriptPage()
  assertEqual(page.greeting, fixture.script.greeting, 'a `fields:` entry reaches the script')
  assertEqual(page.config, fixture.script.config, 'a declared file reaches the script inline')
  assertEqual(page.dirs, 'canisters/plain/pages', 'a declared directory is mounted where it was written')
})

test('tells the script about the network and the environment', async () => {
  const page = await scriptPage()
  assertEqual(page.environment, 'local', 'environment name')
  assertEqual(page.apiUrl, `${HOST}/`, "the agent's host is the API URL")
  assertEqual(page.gatewayUrl, `${HOST}/`, 'the gateway the deployer was given')
  assertEqual(page.identity, principal.toText(), 'the identity the deployment signs as')
})

test('resolves the canisters the script may reach', async () => {
  const page = await scriptPage()
  assertEqual(page.self, deployed('plain').canisterId.toText(), 'the canister being synced')
  assertEqual(page.site, deployed('site').canisterId.toText(), 'the canister table names the sibling')
  assert(/^\d+\.\d+\.\d+$/.test(page.siteVersion), `a typed call to the sibling answered: ${page.siteVersion}`)
})

test("streams the script's output as progress", () => {
  assert(
    scriptOutput.some((line) => line.startsWith('uploaded /index.html')),
    `the line the script printed should have been reported, got: ${scriptOutput.join(' | ')}`,
  )
})

group('registry')

// Driven through the same client module the page uses, against the canister
// `icp deploy` put up: every method is scoped to the caller, so a second
// identity sees nothing of the first's, and an anonymous one nothing at all.
const registry = createRegistry(agent, registryId)

const record = (name: string): ApplicationInput => ({
  name,
  bundleSha256: 'a'.repeat(64),
  bundleFileName: `${name}-1.0.0.icp`,
  canisters: [
    { name: 'plain', canisterId: deployed('plain').canisterId, state: 'deployed' },
    { name: 'site', canisterId: deployed('site').canisterId, state: 'unfinished' },
  ],
})

test('creates an application and stamps it', async () => {
  const created = await registry.create(record('shop'))
  assertEqual(created.name, 'shop', 'name')
  assertEqual(created.created.getTime(), created.updated.getTime(), 'a new record has one time')
  assert(Math.abs(Date.now() - created.created.getTime()) < 5 * 60_000, 'stamped by the registry, now')
  assertEqual(created.canisters[1]?.state, 'unfinished', 'canister states round-trip')
})

test('lists newest deployment first', async () => {
  await registry.create(record('blog'))
  await registry.update(record('shop'))
  // The upgrade group below records `fixture` too; only the two made here are ordered.
  const names = (await registry.list())
    .map((application) => application.name)
    .filter((name) => name === 'shop' || name === 'blog')
  assertEqual(names.join(','), 'shop,blog', 'the updated one comes first')
})

test('updates in place, keeping when it was created', async () => {
  const before = (await registry.get('shop'))!
  const after = await registry.update({ ...record('shop'), bundleFileName: 'shop-2.0.0.icp' })
  assertEqual(after.created.getTime(), before.created.getTime(), 'created is kept')
  assert(after.updated.getTime() >= before.updated.getTime(), 'updated moves forward')
  assertEqual((await registry.get('shop'))?.bundleFileName, 'shop-2.0.0.icp', 'the record changed')
})

test('refuses a second application with the same name', async () => {
  await assertRejects(() => registry.create(record('shop')), /already have an application named "shop"/, 'duplicate')
  try {
    await registry.create(record('shop'))
  } catch (error) {
    assert(error instanceof RegistryError && error.refusal.kind === 'alreadyExists', 'typed refusal')
  }
})

test('refuses updating an application the caller does not have', async () => {
  await assertRejects(() => registry.update(record('nope')), /no application named "nope"/, 'not found')
  assertEqual(await registry.get('nope'), undefined, 'and get says so')
})

test('shows another principal nothing of these', async () => {
  const other = await HttpAgent.create({
    host: HOST,
    identity: Ed25519KeyIdentity.generate(),
    shouldFetchRootKey: true,
  })
  assertEqual((await createRegistry(other, registryId).list()).length, 0, 'records are per caller')
})

test('refuses an anonymous caller', async () => {
  const anonymous = createRegistry(await HttpAgent.create({ host: HOST, shouldFetchRootKey: true }), registryId)
  await assertRejects(() => anonymous.create(record('anon')), /sign in first/i, 'anonymous create')
  await assertRejects(() => anonymous.list(), /anonymous/i, 'anonymous list')
})

group('upgrade')

// The fixture deployed a second time, with the first run's canisters recorded
// under an application: the ids are reused, the modules replaced, the record
// brought up to date — through the same plan and recorder the page uses.
const before = {
  plain: deployed('plain').canisterId,
  site: deployed('site').canisterId,
}
const upgradeEvents: string[] = []
const firstRecord = await registry.create({
  ...record('fixture'),
  canisters: [
    { name: 'plain', canisterId: before.plain, state: 'deployed' },
    { name: 'site', canisterId: before.site, state: 'deployed' },
  ],
})
const plan = planUpgrade(firstRecord, bundle, await readStatuses(agent, firstRecord))
const upgraded = await upgradeRecorded({
  registry,
  record: firstRecord,
  bundle: { sha256: bundle.sha256, fileName: 'e2e-2.icp' },
  plan,
  deploy: (recordEvent) =>
    deployer.deploy(bundle, {
      existing: plan.existing,
      onEvent: (event) => {
        recordEvent(event)
        if (event.type === 'started' || event.type === 'installed') {
          upgradeEvents.push(`${event.type}:${event.name}:${event.action}`)
        }
        if (event.type === 'failed') console.log(`    ! ${event.message}`)
      },
    }),
})

test('plans an upgrade of every recorded canister', () => {
  assertEqual(plan.blocked.length, 0, 'both statuses read as their controller')
  assertEqual(plan.canisters.map((c) => `${c.name}:${c.action}`).join(','), 'plain:upgrade,site:upgrade', 'both installed, both upgraded')
  assertEqual(plan.orphaned.length, 0, 'the bundle still names both')
})

test('reuses the recorded canisters instead of creating new ones', () => {
  assertEqual(upgraded.result.error, undefined, `upgrade failed: ${upgraded.result.error}`)
  assertEqual(upgraded.result.deployed.length, 2, 'both canisters deployed')
  const after = Object.fromEntries(upgraded.result.deployed.map((c) => [c.name, c.canisterId.toText()]))
  assertEqual(after.plain, before.plain.toText(), 'plain keeps its id')
  assertEqual(after.site, before.site.toText(), 'site keeps its id')
})

test('says it is upgrading, not creating', () => {
  assert(upgradeEvents.includes('started:plain:upgrade'), `got ${upgradeEvents.join(' ')}`)
  assert(upgradeEvents.includes('installed:site:upgrade'), `got ${upgradeEvents.join(' ')}`)
  assert(!upgradeEvents.some((e) => e.endsWith(':create')), 'nothing was created')
})

test('leaves both modules installed and the site serving', async () => {
  for (const name of ['plain', 'site'] as const) {
    const { moduleHash } = await canisterStatus(agent, before[name])
    assert(moduleHash !== undefined, `${name} has a module after the upgrade`)
  }
  const response = await fetch(gatewayUrl(before.site))
  assertEqual(response.status, 200, 'the synced site still serves')
})

test('brings the record up to date', async () => {
  const stored = (await registry.get('fixture'))!
  assertEqual(stored.bundleFileName, 'e2e-2.icp', 'the new bundle is recorded')
  assertEqual(stored.canisters.map((c) => `${c.name}:${c.state}`).join(','), 'plain:deployed,site:deployed', 'states')
  assert(stored.updated.getTime() > firstRecord.updated.getTime(), 'updated moved forward')
  assertEqual(stored.created.getTime(), firstRecord.created.getTime(), 'created is kept')
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
