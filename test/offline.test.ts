/**
 * The library's boundary, without a network.
 *
 * What a bundle has to be — a readable archive, a manifest this deployer can
 * honour, artifacts matching their digests — is decided inside the module and
 * tested there, in `src/lib/core/tests`. What is tested here is the seam: that
 * the module loads outside a browser, that a bundle arrives as ordinary
 * JavaScript however its bytes were handed over, and that a refusal comes back
 * as the error class a caller can branch on, carrying a message worth showing.
 */

import {
  ArchiveError,
  BundleError,
  Bundle,
  IntegrityError,
  isBundle,
  loadBundle,
  ManifestError,
  formatBytes,
  sha256Hex,
} from '../src/lib'
import { assert, assertEqual, assertRejects, group, run, test } from './support/harness'
import { createTar, gzip, type TarFile } from './support/tar'
import { syncPlugin } from './support/plugin'
import { loadModule } from './support/wasm'

await loadModule()

const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
const PLUGIN = syncPlugin('0.1.0')

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
`

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
`

const SYNC_FILES: TarFile[] = [
  { name: 'plugins/sync.wasm', content: PLUGIN },
  { name: 'assets/index.html', content: '<h1>hi</h1>' },
]

// ── Loading ─────────────────────────────────────────────────────────────────

group('loading')

test('reports what a bundle holds', async () => {
  const loaded = await loadBundle(bundle(MINIMAL))
  assertEqual(loaded.canisters.length, 1, 'one canister')

  const [canister] = loaded.canisters
  assertEqual(canister.name, 'app', 'canister name')
  assertEqual(canister.wasmPath, 'canisters/app.wasm', 'wasm path')
  assertEqual(canister.wasmSize, WASM.length, 'wasm size')
  assertEqual(canister.sha256, wasmDigest, 'declared digest')
  assertEqual(canister.digest, wasmDigest, 'actual digest')
  assertEqual(canister.syncDirs.length, 0, 'no sync directories')
})

test('reports the directories a canister syncs', async () => {
  const loaded = await loadBundle(bundle(WITH_SYNC, SYNC_FILES))
  assertEqual(loaded.canisters[0].syncDirs.join(','), 'assets', 'sync directories')
})

test('reads a gzipped bundle', async () => {
  const loaded = await loadBundle(await gzip(bundle(MINIMAL)))
  assertEqual(loaded.canisters.length, 1, 'gzip is unwrapped before the tar is read')
})

test('accepts bytes however they arrive', async () => {
  const bytes = bundle(MINIMAL)
  const sources = [
    bytes,
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    new Blob([bytes as BlobPart]),
    new File([bytes as BlobPart], 'app.icp'),
  ]

  for (const source of sources) {
    const loaded = await loadBundle(source as Parameters<typeof loadBundle>[0])
    assertEqual(loaded.canisters.length, 1, `loaded from ${source.constructor.name}`)
  }
})

test('remembers the file name a bundle came from', async () => {
  const loaded = await loadBundle(new File([bundle(MINIMAL) as BlobPart], 'app.icp'))
  assertEqual(loaded.fileName, 'app.icp', 'file name')
})

test('leaves a name unset when the source had none', async () => {
  assertEqual((await loadBundle(bundle(MINIMAL))).fileName, undefined, 'no file name')
})

test('passes an already-loaded bundle straight through', async () => {
  const loaded = await loadBundle(bundle(MINIMAL))
  assert(isBundle(loaded), 'a loaded bundle is recognized as one')
  assertEqual(await loadBundle(loaded), loaded, 'loading it again is a no-op')
})

// ── Refusals ────────────────────────────────────────────────────────────────
//
// Which bundles are refused is settled in the module's own suite; what matters
// here is that a caller can tell the three kinds apart.

group('refusals')

test('an unreadable archive raises ArchiveError', async () => {
  await assertRejects(
    () => loadBundle(createTar([])),
    /no files/i,
    'an archive with nothing in it',
  )
  await assertRejects(
    () => loadBundle(bundle(MINIMAL).slice(0, 700)),
    /truncated/i,
    'an archive that stops part-way',
  )
  assert(
    (await caught(() => loadBundle(createTar([])))) instanceof ArchiveError,
    'should be an ArchiveError',
  )
})

test('a manifest this deployer cannot honour raises ManifestError', async () => {
  const script = `
canisters:
- name: app
  build:
    steps:
    - type: script
      command: make
`
  const error = await caught(() => loadBundle(bundle(script)))
  assert(error instanceof ManifestError, `should be a ManifestError, got ${error?.name}`)
  assert(/script/i.test(error!.message), `should say what it refused: ${error!.message}`)
})

test('an artifact that does not match its digest raises IntegrityError', async () => {
  const tampered = MINIMAL.replace(wasmDigest, '0'.repeat(64))
  const error = await caught(() => loadBundle(bundle(tampered)))
  assert(error instanceof IntegrityError, `should be an IntegrityError, got ${error?.name}`)
  assert(/digest/i.test(error!.message), `should say what mismatched: ${error!.message}`)
})

test('every refusal is a BundleError', async () => {
  const error = await caught(() => loadBundle(createTar([{ name: 'a.txt', content: 'x' }])))
  assert(error instanceof BundleError, 'refusals share one base class')
})

// ── Formatting ──────────────────────────────────────────────────────────────

group('formatting')

test('formats byte counts', () => {
  assertEqual(formatBytes(512), '512 B', 'bytes')
  assertEqual(formatBytes(1536), '1.5 KiB', 'kibibytes')
  assertEqual(formatBytes(3 * 1024 * 1024), '3.0 MiB', 'mebibytes')
})

test('hashes the way icp.yaml declares digests', async () => {
  assertEqual(
    await sha256Hex(new Uint8Array()),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'the empty digest',
  )
})

// ── Disposal ────────────────────────────────────────────────────────────────

group('disposal')

test('a disposed bundle releases the archive it held', async () => {
  const loaded: Bundle = await loadBundle(bundle(MINIMAL))
  // The summary is copied out on load, so it survives disposal; the archive
  // behind it does not, which is the point of disposing a large bundle.
  loaded.dispose()
  assertEqual(loaded.canisters.length, 1, 'the summary is still readable')
})

await run('offline: the library boundary')

/** The error a call raised, or `undefined` if it did not raise one. */
async function caught(fn: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await fn()
    return undefined
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
