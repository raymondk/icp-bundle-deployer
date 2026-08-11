/**
 * Builds a real two-canister bundle for the e2e suite: a plain canister and one
 * that syncs assets through the certified-assets plugin.
 *
 * The wasms are the published certified-assets release, cached under `.cache/` on
 * first run so the suite does not re-download on every invocation. Using the same
 * canister wasm for both entries keeps the fixture self-contained while still
 * exercising discovery and colocation across two canisters.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { sha256Hex } from '../../src/bundle/verify'
import { createTar, gzip } from './tar'

const RELEASE = 'https://github.com/dfinity/certified-assets/releases/download/v0.3.3'
const CACHE = '.cache'

async function cached(name: string, url: string): Promise<Uint8Array> {
  const path = `${CACHE}/${name}`
  try {
    return new Uint8Array(await readFile(path))
  } catch {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`could not download ${url}: ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    await mkdir(CACHE, { recursive: true })
    await writeFile(path, bytes)
    return bytes
  }
}

export interface Fixture {
  bytes: Uint8Array
  /** Files the sync step will upload, for asserting on what gets served. */
  assets: Record<string, string>
}

export async function fullstackBundle(): Promise<Fixture> {
  const canister = await cached('certified-assets.wasm.gz', `${RELEASE}/canister-release.wasm.gz`)
  const plugin = await cached('certified-assets-plugin.wasm', `${RELEASE}/plugin-release.wasm`)

  const assets = {
    'index.html': '<!doctype html><title>E2E</title><h1>Deployed by the test suite</h1>',
    'about.html': '<!doctype html><title>About</title><p>About</p>',
    '_redirects': '/old-page /about.html 301\n',
  }

  const manifest = `
canisters:
- name: plain
  settings:
    controllers: null
  build:
    steps:
    - type: pre-built
      path: canisters/plain.wasm.gz
      sha256: ${await sha256Hex(canister)}
- name: site
  settings:
    controllers: null
    environment_variables:
      PUBLIC_APP_NAME: "E2E fixture"
      PRIVATE_TOKEN: "must-not-reach-the-cookie"
  build:
    steps:
    - type: pre-built
      path: canisters/site.wasm.gz
      sha256: ${await sha256Hex(canister)}
  sync:
    steps:
    - type: plugin
      path: plugins/certified-assets.wasm
      sha256: ${await sha256Hex(plugin)}
      dirs:
      - canisters/site/dist
dependencies: []
networks: []
environments: []
`

  const bytes = await gzip(
    createTar([
      { name: 'icp.yaml', content: manifest },
      { name: 'canisters/plain.wasm.gz', content: canister },
      { name: 'canisters/site.wasm.gz', content: canister },
      { name: 'plugins/certified-assets.wasm', content: plugin },
      ...Object.entries(assets).map(([name, content]) => ({
        name: `canisters/site/dist/${name}`,
        content,
      })),
    ]),
  )

  return { bytes, assets }
}
