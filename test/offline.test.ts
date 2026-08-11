/**
 * Everything that can be checked without a network: unpacking a bundle, validating
 * its manifest, and verifying its artifacts.
 *
 * These are the paths that decide whether a deployment starts at all, so the point
 * of most of these cases is that a bad bundle is refused *before* any canister
 * exists — and refused with a message that says what to fix.
 */

import { readArchive } from '../src/bundle/archive'
import { parseManifest } from '../src/bundle/manifest'
import { verifyBundle, sha256Hex } from '../src/bundle/verify'
import { assert, assertEqual, assertRejects, group, run, test } from './support/harness'
import { createTar, gzip, type TarFile } from './support/tar'

const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
const PLUGIN = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x01])

const wasmDigest = await sha256Hex(WASM)
const pluginDigest = await sha256Hex(PLUGIN)

/** A minimal well-formed bundle, with `manifest` overriding the default icp.yaml. */
function bundle(manifest: string, extra: TarFile[] = []): Uint8Array {
  return createTar([
    { name: 'icp.yaml', content: manifest },
    { name: 'canisters/app.wasm', content: WASM },
    ...extra,
  ])
}

const MINIMAL = `
canisters:
- name: app
  build:
    steps:
    - type: pre-built
      path: canisters/app.wasm
      sha256: ${wasmDigest}
dependencies: []
`

// ── Archive ─────────────────────────────────────────────────────────────────

group('archive')

test('reads a plain tar', async () => {
  const entries = await readArchive(bundle(MINIMAL))
  assertEqual(entries.size, 2, 'expected two entries')
  assertEqual(entries.get('canisters/app.wasm')!.length, WASM.length, 'wasm length')
})

test('reads a gzipped tar', async () => {
  const entries = await readArchive(await gzip(bundle(MINIMAL)))
  assert(entries.has('icp.yaml'), 'gzipped archive should contain icp.yaml')
})

test('treats a NUL typeflag as a regular file', async () => {
  // The sample bundles mark regular files with NUL rather than '0'; reading them as
  // anything else silently yields an empty archive.
  const entries = await readArchive(createTar([{ name: 'a.txt', content: 'x', typeflag: '\0' }]))
  assertEqual(entries.size, 1, 'NUL-typeflag file should be read')
})

test("reads a '0' typeflag too", async () => {
  const entries = await readArchive(createTar([{ name: 'a.txt', content: 'x', typeflag: '0' }]))
  assertEqual(entries.size, 1, "'0'-typeflag file should be read")
})

test('skips directory entries', async () => {
  const entries = await readArchive(
    createTar([
      { name: 'dir/', content: '', typeflag: '5' },
      { name: 'dir/a.txt', content: 'x' },
    ]),
  )
  assertEqual(entries.size, 1, 'directory entries carry nothing to keep')
})

test('honours a GNU long name', async () => {
  const long = `canisters/${'nested/'.repeat(20)}app.wasm`
  const entries = await readArchive(
    createTar([
      { name: '././@LongLink', content: long, typeflag: 'L' },
      { name: long.slice(0, 100), content: WASM },
    ]),
  )
  assert(entries.has(long), `expected the full name, got ${[...entries.keys()]}`)
})

test('rejects an empty archive', async () => {
  await assertRejects(() => readArchive(createTar([])), /no files/i, 'empty archive')
})

test('rejects a truncated archive', async () => {
  const full = bundle(MINIMAL)
  await assertRejects(() => readArchive(full.slice(0, 700)), /truncated/i, 'truncated archive')
})

// ── Manifest ────────────────────────────────────────────────────────────────

group('manifest')

test('parses a minimal bundle', async () => {
  const { canisters } = parseManifest(await readArchive(bundle(MINIMAL)))
  assertEqual(canisters.length, 1, 'one canister')
  assertEqual(canisters[0].name, 'app', 'canister name')
  assertEqual(canisters[0].sha256, wasmDigest, 'declared digest')
  assertEqual(canisters[0].sync.length, 0, 'no sync steps')
  // The empty Candid tuple, which is what a canister with no init args expects.
  assertEqual([...canisters[0].initArg].join(','), '68,73,68,76,0,0', 'empty candid arg')
})

test('requires an icp.yaml at the root', async () => {
  const entries = await readArchive(createTar([{ name: 'canisters/app.wasm', content: WASM }]))
  await assertRejects(() => parseManifest(entries), /not an application bundle/i, 'no manifest')
})

test('rejects a script build step', async () => {
  const entries = await readArchive(
    bundle(`
canisters:
- name: app
  build:
    steps:
    - type: script
      commands: [npm run build]
`),
  )
  await assertRejects(() => parseManifest(entries), /cannot be built in the browser/i, 'script step')
})

test('rejects a wasm referenced by url', async () => {
  const entries = await readArchive(
    bundle(`
canisters:
- name: app
  build:
    steps:
    - type: pre-built
      url: https://example.com/app.wasm
      sha256: ${wasmDigest}
`),
  )
  await assertRejects(() => parseManifest(entries), /points at a URL/i, 'url build step')
})

test('rejects a wasm missing from the bundle', async () => {
  const entries = await readArchive(
    bundle(`
canisters:
- name: app
  build:
    steps:
    - type: pre-built
      path: canisters/missing.wasm
`),
  )
  await assertRejects(() => parseManifest(entries), /not in the bundle/i, 'missing wasm')
})

test('rejects project dependencies', async () => {
  const entries = await readArchive(bundle(`${MINIMAL}\ndependencies: [../other]\n`.replace('dependencies: []\n', '')))
  await assertRejects(() => parseManifest(entries), /dependencies/i, 'dependencies')
})

test('rejects duplicate canister names', async () => {
  const entries = await readArchive(
    bundle(`
canisters:
- name: app
  build:
    steps:
    - type: pre-built
      path: canisters/app.wasm
- name: app
  build:
    steps:
    - type: pre-built
      path: canisters/app.wasm
`),
  )
  await assertRejects(() => parseManifest(entries), /two canisters named/i, 'duplicates')
})

test('rejects Candid text init args but accepts the empty tuple', async () => {
  const withArgs = (args: string) =>
    readArchive(
      bundle(`
canisters:
- name: app
  init_args: ${args}
  build:
    steps:
    - type: pre-built
      path: canisters/app.wasm
`),
    )

  await assertRejects(
    async () => parseManifest(await withArgs('"(record { owner = principal \\"aaaaa-aa\\" })"')),
    /cannot encode in the browser/i,
    'candid text',
  )
  const empty = parseManifest(await withArgs('"()"'))
  assertEqual([...empty.canisters[0].initArg].join(','), '68,73,68,76,0,0', 'empty tuple')
})

test('decodes hex init args', async () => {
  const entries = await readArchive(
    bundle(`
canisters:
- name: app
  init_args:
    value: "0x4449444c0000"
    format: hex
  build:
    steps:
    - type: pre-built
      path: canisters/app.wasm
`),
  )
  const { canisters } = parseManifest(entries)
  assertEqual([...canisters[0].initArg].join(','), '68,73,68,76,0,0', 'hex init arg')
})

test('converts settings units', async () => {
  const entries = await readArchive(
    bundle(`
canisters:
- name: app
  settings:
    memory_allocation: 2gib
    freezing_threshold: 30d
    reserved_cycles_limit: 1t
    compute_allocation: 5
    log_visibility: public
    environment_variables:
      LOG_LEVEL: "info"
  build:
    steps:
    - type: pre-built
      path: canisters/app.wasm
`),
  )
  const { settings } = parseManifest(entries).canisters[0]
  assertEqual(settings.memoryAllocation, 2n * 1024n ** 3n, '2gib')
  assertEqual(settings.freezingThreshold, 2_592_000n, '30d in seconds')
  assertEqual(settings.reservedCyclesLimit, 1_000_000_000_000n, '1t')
  assertEqual(settings.computeAllocation, 5n, 'compute allocation')
  assertEqual(settings.environmentVariables?.[0].value, 'info', 'environment variable')
})

test('rejects an unknown unit suffix', async () => {
  const entries = await readArchive(
    bundle(`
canisters:
- name: app
  settings:
    memory_allocation: 2furlongs
  build:
    steps:
    - type: pre-built
      path: canisters/app.wasm
`),
  )
  await assertRejects(() => parseManifest(entries), /unknown suffix/i, 'bad suffix')
})

// ── Sync steps ──────────────────────────────────────────────────────────────

group('sync steps')

const WITH_SYNC = `
canisters:
- name: app
  build:
    steps:
    - type: pre-built
      path: canisters/app.wasm
      sha256: ${wasmDigest}
  sync:
    steps:
    - type: plugin
      path: plugins/sync.wasm
      sha256: ${pluginDigest}
      dirs:
      - assets
dependencies: []
`

const syncExtras: TarFile[] = [
  { name: 'plugins/sync.wasm', content: PLUGIN },
  { name: 'assets/index.html', content: '<h1>hi</h1>' },
]

test('parses a plugin sync step', async () => {
  const { canisters } = parseManifest(await readArchive(bundle(WITH_SYNC, syncExtras)))
  const [step] = canisters[0].sync
  assertEqual(step.pluginPath, 'plugins/sync.wasm', 'plugin path')
  assertEqual(step.dirs.join(','), 'assets', 'declared dirs')
  assertEqual(step.sha256, pluginDigest, 'plugin digest')
})

test('rejects a script sync step', async () => {
  const entries = await readArchive(
    bundle(WITH_SYNC.replace(/- type: plugin[\s\S]*?- assets/, '- type: script\n      commands: [echo hi]'), syncExtras),
  )
  await assertRejects(() => parseManifest(entries), /cannot run shell commands/i, 'script sync')
})

test('rejects a plugin referenced by url', async () => {
  const entries = await readArchive(
    bundle(WITH_SYNC.replace('path: plugins/sync.wasm', 'url: https://example.com/sync.wasm'), syncExtras),
  )
  await assertRejects(() => parseManifest(entries), /points at a URL/i, 'url plugin')
})

test('rejects a plugin missing from the bundle', async () => {
  const entries = await readArchive(bundle(WITH_SYNC.replace('plugins/sync.wasm', 'plugins/gone.wasm'), syncExtras))
  await assertRejects(() => parseManifest(entries), /not in the bundle/i, 'missing plugin')
})

test('rejects a sync step with nothing to sync', async () => {
  const entries = await readArchive(bundle(WITH_SYNC.replace(/      dirs:\n      - assets\n/, ''), syncExtras))
  await assertRejects(() => parseManifest(entries), /nothing to sync/i, 'no dirs or files')
})

// ── Integrity ───────────────────────────────────────────────────────────────

group('integrity')

test('accepts artifacts matching their digests', async () => {
  const manifest = parseManifest(await readArchive(bundle(WITH_SYNC, syncExtras)))
  const digests = await verifyBundle(manifest)
  assertEqual(digests.get('app'), wasmDigest, 'reported digest')
})

test('rejects a tampered wasm', async () => {
  const tampered = new Uint8Array(WASM)
  tampered[0] ^= 0xff
  const manifest = parseManifest(
    await readArchive(
      createTar([
        { name: 'icp.yaml', content: MINIMAL },
        { name: 'canisters/app.wasm', content: tampered },
      ]),
    ),
  )
  await assertRejects(() => verifyBundle(manifest), /does not match the digest/i, 'tampered wasm')
})

test('rejects a tampered sync plugin', async () => {
  const tampered = new Uint8Array(PLUGIN)
  tampered[tampered.length - 1] ^= 0xff
  const manifest = parseManifest(
    await readArchive(
      bundle(WITH_SYNC, [
        { name: 'plugins/sync.wasm', content: tampered },
        { name: 'assets/index.html', content: '<h1>hi</h1>' },
      ]),
    ),
  )
  await assertRejects(() => verifyBundle(manifest), /sync plugin/i, 'tampered plugin')
})

await run('offline: bundle reading, validation and integrity')
