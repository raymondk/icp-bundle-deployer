/**
 * Builds a real two-canister bundle for the e2e suite: one canister synced by a
 * JavaScript script through the icp-js plugin, and one that syncs assets through
 * the certified-assets plugin.
 *
 * The two plugins speak different versions of the sync-plugin interface, which is
 * the point of having both: certified-assets v0.3.3 is built against
 * `icp:sync-plugin@0.1`, with `dirs:` and `files:` as plain lists, and the script
 * plugin against `@0.2`, where everything is a named entry under `files:` and the
 * script is handed the network URLs, the step's fields and the canister table.
 *
 * The wasms are published releases, cached under `.cache/` on first run so the
 * suite does not re-download on every invocation. Using the same canister wasm
 * for both entries keeps the fixture self-contained while still exercising
 * discovery and colocation across two canisters.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { sha256Hex } from '../../src/lib'
import { createTar, gzip } from './tar'

const RELEASE = 'https://github.com/dfinity/certified-assets/releases/download/v0.3.3'
const JS_PLUGIN =
  'https://github.com/dfinity/icp-cli-quickjs-plugin/releases/download/0.1.0/icp_js_plugin.wasm'
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
  /** Files the asset sync step will upload, for asserting on what gets served. */
  assets: Record<string, string>
  /** What the script step is given through the manifest, for asserting it arrived. */
  script: { greeting: string; config: string }
}

/**
 * What the script step is given. The greeting travels as a `fields:` entry, the
 * config as a declared file, and the page template as a file inside a declared
 * directory — the three ways a v0.2 step hands a plugin its inputs.
 */
const GREETING = 'Hello from the sync script'
const CONFIG = 'read from config.json'

/**
 * The page template the script fills in and uploads. Every line under the
 * heading is `name: value`, which is what the suite parses back out; each value
 * is something the plugin was told by the deployer and could not have made up.
 */
const PAGE_TEMPLATE = `<!doctype html>
<title>Script sync</title>
<h1>{{greeting}}</h1>
<pre>
greeting: {{greeting}}
environment: {{environment}}
apiUrl: {{apiUrl}}
gatewayUrl: {{gatewayUrl}}
self: {{self}}
site: {{site}}
siteVersion: {{siteVersion}}
identity: {{identity}}
config: {{config}}
dirs: {{dirs}}
</pre>
`

/**
 * The script the icp-js plugin runs against `plain`. It reads everything the
 * step declared — a file inline, a directory through the filesystem, a field —
 * plus what the deployer told it about the network and the other canisters,
 * calls the sibling canister the step named, and uploads the result as the
 * canister's index page through the asset canister's own sync protocol. Each of
 * those is a seam between the deployer and the plugin, and the page is where
 * they all become observable from outside.
 */
const SYNC_SCRIPT = `
const template = readFile(joinPath(dirKeys.pages[0], "index.html"));
const config = JSON.parse(files[fileKeys.config[0]]);

// A typed call to a canister the step named, decoded against its own interface.
const version = callTyped("site", "version");

const values = {
  greeting: fields.greeting,
  environment,
  apiUrl,
  gatewayUrl: gatewayUrl === null ? "none" : gatewayUrl,
  self: canisterId,
  site: canisterIds.site,
  siteVersion: version.major + "." + version.minor + "." + version.patch,
  identity: identityId,
  config: config.message,
  dirs: dirs.join(","),
};
let html = template;
for (const name of Object.keys(values)) {
  html = html.split("{{" + name + "}}").join(String(values[name]));
}

// The asset canister only changes through a sync session: start one, stage the
// content, then apply the operations that create the asset and point it at the
// staged chunk, finalizing in the same call.
const body = encodeUtf8(html);
const started = callTyped(self, "start_sync");
if (!("Started" in started)) {
  throw new Error("could not start a sync: " + Object.keys(started)[0]);
}
const session_id = started.Started.session_id;
const [chunk] = callTyped(self, "upload_chunks", { session_id, chunks: [body] });
const hash = sha256(body);
callTyped(self, "execute_operations", {
  session_id,
  is_final: true,
  operations: [
    { CreateAsset: { key: "/index.html", content_type: "text/html", headers: [] } },
    {
      SetAssetContent: {
        key: "/index.html",
        encoding: "Identity",
        chunk_ids: [chunk],
        sha256: hash,
        chunk_sha256: [hash],
      },
    },
  ],
});
print("uploaded /index.html (" + body.length + " bytes) to " + canisterId);
`

export async function fullstackBundle(): Promise<Fixture> {
  const canister = await cached('certified-assets.wasm.gz', `${RELEASE}/canister-release.wasm.gz`)
  const plugin = await cached('certified-assets-plugin.wasm', `${RELEASE}/plugin-release.wasm`)
  const jsPlugin = await cached('icp-js-plugin.wasm', JS_PLUGIN)

  const assets = {
    'index.html': '<!doctype html><title>E2E</title><h1>Deployed by the test suite</h1>',
    'about.html': '<!doctype html><title>About</title><p>About</p>',
    '_redirects': '/old-page /about.html 301\n',
  }

  const manifest = `
canisters:
- name: plain
  settings:
    # A canister name, resolved against the ids this deployment creates — and the
    # deployer has to survive the handover alongside it.
    controllers:
    - site
  build:
    steps:
    - type: pre-built
      path: canisters/plain.wasm.gz
      sha256: ${await sha256Hex(canister)}
  sync:
    steps:
    # A v0.2 plugin: everything it reads is a named entry under files, and a
    # directory is told from a file by what the bundle carries.
    - type: plugin
      path: plugins/icp-js.wasm
      sha256: ${await sha256Hex(jsPlugin)}
      canisters: [site]
      fields:
        greeting: ${GREETING}
      files:
        script: canisters/plain/sync.js
        config: canisters/plain/config.json
        pages: canisters/plain/pages
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
    # A v0.1 plugin: dirs and files are separate, and plain lists.
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
      { name: 'plugins/icp-js.wasm', content: jsPlugin },
      { name: 'canisters/plain/sync.js', content: SYNC_SCRIPT },
      { name: 'canisters/plain/config.json', content: JSON.stringify({ message: CONFIG }) },
      { name: 'canisters/plain/pages/index.html', content: PAGE_TEMPLATE },
      ...Object.entries(assets).map(([name, content]) => ({
        name: `canisters/site/dist/${name}`,
        content,
      })),
    ]),
  )

  return { bytes, assets, script: { greeting: GREETING, config: CONFIG } }
}
