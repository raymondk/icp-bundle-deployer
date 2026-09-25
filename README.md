# Bundle deployer

A frontend canister that deploys **application bundles** — entirely client side. Drop a
bundle onto the page and it creates the canisters the bundle declares and installs their
wasms, using the browser's own identity. There is no backend and no CLI in the loop.

## What a bundle is

An application bundle is a tar (optionally gzipped, conventionally `.icp`) whose root
holds a resolved `icp.yaml`, with every artifact it needs alongside it, referenced by a
path relative to the tar root:

```
backend-bundle.icp                 frontend-bundle.icp
├── icp.yaml                       ├── icp.yaml
└── canisters/                     ├── canisters/
    └── backend-example.wasm       │   ├── frontend-example.wasm.gz
                                   │   └── frontend-example/dist/…
                                   └── plugins/
                                       └── certified-assets-0.3.3.wasm
```

```yaml
canisters:
- name: backend-example
  settings:
    controllers: null
  build:
    steps:
    - type: pre-built
      path: canisters/backend-example.wasm
      sha256: 903fc05018e19bd44ea66dd7e74d9d9f55c622d86fbe453861ba64ee8c637847
dependencies: []
networks: []
environments: []
```

## Using it as a library

The deployment logic lives in [`src/lib/`](./src/lib) behind one entry point, with no
dependency on the page around it. Give it an agent and it does the rest — who to sign
as, and which network it is on, both come from the agent:

```ts
import { createDeployer } from './lib'

const deployer = createDeployer({ agent })

// Optional: unpack and verify without deploying, to show what a bundle contains.
const bundle = await deployer.load(file)

const result = await deployer.deploy(bundle, {
  subnet,                    // optional; omitted, one is resolved for the bundle
  onEvent: (e) => console.log(e),
})

for (const { name, canisterId } of result.deployed) {
  console.log(name, canisterId.toText())
}
```

A bundle can be a `File`, `Blob`, `Uint8Array`, `ArrayBuffer`, or an already-loaded
`Bundle`, so the same call works from a drop zone or from a file read off disk. A
subnet may be a `Principal` or its text form. A loaded `Bundle` carries its `fileName`,
when its source had one, and the `sha256` of its bytes — the identity of what is about to be
deployed, for whoever keeps a record of it.

`deploy` never throws for an unusable bundle or a rejected canister: it returns a
`DeployResult` carrying `deployed`, `incomplete` — created but unfinished — and
`error`. Loading throws instead, with `ArchiveError`, `ManifestError` or
`IntegrityError`, since there is nothing partial to report.

The library runs anywhere an agent does; the e2e suite drives it from Node. Only the
sync step is browser-shaped, needing WebAssembly JSPI — `supportsJspi()` says whether
this host has it.

Outside a browser or a bundler, `initialize` has to be handed the library's WebAssembly
module: it is otherwise resolved from alongside the library and fetched, and a plain Node
process cannot fetch a `file:` URL.

```ts
import { initialize } from './lib'
await initialize(await readFile('src/lib/wasm/deployer_bg.wasm'))
```

## What it does

1. **Reads the bundle** — gunzips and unpacks the tar, parses `icp.yaml`, and hashes every
   wasm against the `sha256` the manifest declares. A mismatch aborts before anything is
   created.
2. **Targets the network that serves it** — the asset canister hosting this page certifies
   an `ic_env` cookie carrying its network's root key. That key both verifies responses and
   distinguishes mainnet from a test network, so no network has to be chosen by hand.
3. **Creates every canister** — through the cycles ledger, funded with 2T cycles, the same
   default `icp deploy` uses. An ingress message cannot carry cycles, so the management
   canister's `create_canister` is out of reach from a browser; the cycles ledger is a
   canister like any other, and icp-cli deploys it on local networks at the same
   well-known address it has on mainnet. One path on every network, so a local deployment
   exercises exactly what mainnet will do.
4. **Injects the canister IDs** — see below.
5. **Applies the manifest's settings** — controllers included. Whoever the manifest names is
   *added* to the canister's current controllers rather than replacing them, and nothing is
   ever removed, so the identity that paid for a canister never loses access to it — the
   same thing `icp deploy` leaves behind.
6. **Installs each wasm** — in one `install_code` call, or through the chunk store for wasms
   above the ingress limit. The mode is read off the canister: install when it is empty,
   upgrade when a module is already there.
7. **Runs the bundle's sync plugin** — see below. Assets are uploaded by the same wasm
   `icp sync` runs.

Those are phases, not a per-canister loop, and the order matters: every canister is created
before any wasm is installed, and every wasm is installed before any sync runs. The second
separation is there because a sync plugin may call the canisters its step lists, and one
that ran between installs would be calling a canister with nothing in it yet. They are
`icp deploy`'s own phases, because they are run by `icp-project`'s own `deploy` operation —
the same code, not a copy of its order. The deployer supplies what that operation needs
from its surroundings: the bundle as a filesystem, the ids of this run in a store that
lives as long as the run, the browser's agent as the way to call canisters, jco as the
plugin runtime. The operation decides everything else, including which canisters to create
at all — one whose id is already in the store is left alone and upgraded, which is what an
application upgrade will build on. If a phase fails the run stops and the page reports
which canisters exist but are unfinished, so nothing is silently abandoned — they exist and
you control them.

One thing that operation does not have in a browser is a clock: it waits a moment after
starting a canister before its sync plugin's first query, and it reaches the clock through
tokio's timers, which have nothing to run on in wasm. Until that wait goes through a seam
upstream, the core builds against a branch of a fork that is upstream plus that one change
([`Cargo.toml`](./src/lib/core/Cargo.toml) says which).

## Your applications

Signed in, the page lists the applications you have deployed with it, newest deployment
first. The list sits beside the install flow, in a column that stays put while you work on
a bundle, so it is in view when a deployment lands; on a narrow screen it stacks above the
drop zone. Each entry shows its name, how many canisters it has and when it was last
deployed, and opens to the canisters it consists of — the manifest name and the canister
id — with a badge on any canister that is unfinished or orphaned. The entry being upgraded
is outlined while the drop panel is bound to it. The list is per principal: signing in as
someone else shows their applications, not yours.

The records live in a **registry canister** that ships with the page, one per network,
written in Motoko (`src/registry/`). It is caller-scoped throughout: every method operates
on the caller's own records, anonymous calls are refused, and nobody can read another
principal's list. The page finds it the same way the bundles it deploys find their own
canisters — through `PUBLIC_CANISTER_ID:registry` in the certified `ic_env` cookie the
asset canister serves.

Installing a bundle records it. The install form asks for an **application name**,
proposed from the bundle's file name with its extension and version taken off (so
`my-app-1.2.0.icp` proposes `my-app`) and editable; 1 to 64 printable characters. The name is
reserved in the registry *before* anything is deployed, so a name you already have is
refused while the bundle is still bytes in the tab, with a hint that the existing application
can be upgraded instead. The record is then updated after every canister the run creates —
each id reaches the registry the moment the canister exists, so a closed tab loses nothing —
and once more when the run settles: every canister as `deployed` on success, the ones a
partial failure left behind as `unfinished`. A run that fails before creating anything
leaves a record with no canisters, listed like any other. The result panel names the
application the deployment was recorded under.

The record holds the name, the SHA-256 and file name of the bundle it was last deployed
from, and for every canister its manifest name, id and state. The manifest name is the key
the deployer injects as `PUBLIC_CANISTER_ID:<name>`, which is what an upgrade uses to map
the recorded ids back onto the new bundle.

**Upgrading.** Each application has an **Upgrade** action that binds the drop panel to it:
drop the new version of its bundle and the page runs a pre-flight, reading `canister_status`
for every recorded canister. That read is also the controller check, since only a controller
may make it, so a canister that is gone or no longer yours blocks the upgrade there — nothing
is created. Otherwise a plan replaces the bundle table: each canister the new bundle names is
**upgraded** if a module is installed, **installed** into if it is empty (a run that failed
after creating it), or **created** if it is new; a recorded canister the bundle no longer
names is **orphaned** — left alone, not deleted, and kept in the record flagged as such, so a
later bundle that names it again reuses it. Confirm, and the deployment runs as an install
does, except that the recorded canisters are handed to the deployer as already existing:
`icp deploy`'s own operation skips creating them, resolves each one's install mode from its
live status, passes `upgrade_args` (falling back to `init_args`) on an upgrade, re-applies
settings and the `PUBLIC_CANISTER_ID` variables, merges controllers with the current ones,
and places any new canister beside the existing ones. The record is updated as for an
install, with the new bundle's identity and every state refreshed; an application with no
recorded canisters upgrades as a plain install under its name.

The canister builds with `mops build` through the `@dfinity/motoko` recipe, so the Motoko
toolchain is pinned in [`mops.toml`](./mops.toml) rather than in `icp.yaml`.

## Choosing a subnet

A deployment lands on exactly one subnet, resolved once before anything is created, so
canisters that call each other are never scattered. The optional **target subnet** field
names it — the equivalent of `icp deploy --subnet`. Left empty, the resolution is icp-cli's:
a canister that already exists decides, and new ones are placed beside it; otherwise one of
the cycles minting canister's default subnets is picked.

## Cloud engines

A **cloud engine** is a user-owned subnet, and it does not create canisters through the
cycles ledger — creation is delegated to the subnet's **engine operator**, which the
engine's administrators authorize callers against. Name the engine's subnet (its id is on
the console's Applications page) and it is icp-cli's own create operation that takes the
engine route:

- the deployer is asked whether the subnet is an engine. icp-cli reads the subnet's type
  off the network's registry, which a browser agent cannot; the deployer asks the engine
  registry (`q6cfj-fyaaa-aaaar-qb77q-cai`) instead, and an operator registered for the
  subnet is what makes it an engine;
- if it is, the operation asks the same registry which operator and addresses
  `create_canister` to it instead of the ledger — the two are byte-compatible, so nothing
  else changes;
- if the registry is absent or has no operator for the subnet, it is an ordinary subnet
  and creation goes through the ledger as usual.

The lookup happens *before* the first canister is created, deliberately: once a creation
has been handed to an operator, a failure may still have produced a canister, so falling
back afterwards risks creating and paying for a second one.

One thing this cannot do for you: an engine authorizes a **principal**, and the principal
it knows is the one you sign in to the console with. Internet Identity derives a different
principal per origin, so a deployer served from its own canister signs as someone the
engine has not authorized. Aligning them needs the console to list this origin in its
`/.well-known/ii-alternative-origins`. Failing that, the console's App Center accepts a
built `.icp` bundle directly via **Upload a custom app**.

## Canister discovery

Canister IDs are assigned at deployment time, so a frontend cannot hardcode the backend it
calls. icp-cli solves this by injecting IDs as canister environment variables, and this
deployer does the same thing in the same order:

- once every canister exists, each one is given the whole set as
  `PUBLIC_CANISTER_ID:<name>` variables — including its own — merged over any variables the
  manifest declared;
- the variables live in canister settings, not in the wasm, so the same build runs in any
  environment;
- the asset canister republishes them, plus the network's root key, in its certified
  `ic_env` cookie, which a frontend reads with `getCanisterEnv()` from
  `@icp-sdk/core/agent/canister-env`.

The `PUBLIC_` prefix is a security boundary rather than a convention: the asset canister
publishes only `PUBLIC_`-prefixed variables to the browser, so anything else in a
manifest's `environment_variables` stays canister-only.

## Syncing assets

A frontend canister's bundle carries a sync plugin — a `wasm32-wasip2` component — and the
directory it should upload. Rather than reimplementing what that plugin does, the deployer
**runs it**, so compression, clean URLs, redirect rules and the resulting state hash match
a CLI deployment instead of approximating it:

- **jco's bindgen lowers the component to JavaScript at runtime**, in the page. Nothing is
  pinned to a plugin version — a bundle built against any release deploys as-is.
- **Both versions of the `icp:sync-plugin` interface are driven**, 0.1.0 and 0.2.0, chosen
  by reading the version off the component's own declared imports. That is how icp-cli
  chooses too, and it is the only reliable signal: a component declares just the host
  functions it calls, so which ones it asks for says nothing about which interface it
  speaks.
- **`preview2-shim` provides the WASI world**, with each declared directory preopened
  read-only at the path the manifest wrote it as — the same paths, and the same read-only
  preopen sandbox, icp-cli gives a plugin. There is no network and no writable filesystem
  inside it.
- **The plugin's non-WASI imports are backed by agent-js**: calling a canister, reading a
  metadata section off one, and setting one of its environment variables. Which canister
  each reaches is not the plugin's to choose freely — the canister being synced, or one the
  sync step listed in `canisters:`, and anything else is refused without a call.
- The plugin's own progress output is piped into the deployment log, a line at a time.

Those imports are declared *synchronous*, and a browser cannot block on a network round
trip. The bridge is **WebAssembly JSPI**, which suspends the wasm stack until the call
settles — shipped in Chrome 137+ and Edge, behind a flag in Firefox, in progress in Safari.
On a browser without it the page says so up front; creating canisters and installing wasms
are unaffected.

A `dirs:`/`files:` entry is written relative to the canister's own directory but resolved
inside the whole project, so it may rise out of that directory with `..` and name anything
else the bundle carries. What it may not do is leave the bundle: nothing outside one exists
to hand the plugin, and such an entry is refused at load time. How the entries are written
depends on the interface the plugin was built against, and a mismatch is refused at load
time too, as icp-cli refuses it when it loads the plugin: an `icp:sync-plugin@0.1` plugin
takes `dirs:` and `files:` as plain lists, while an `@0.2` plugin takes everything under
`files:` as a map of name → path, and a directory is told from a file by what the bundle
carries.

There is no proxy canister in a browser — that is something the CLI is given on the command
line — so every request a plugin makes takes the direct route, and the `direct` flag each
one carries has nothing left to select.

## Scope

Rejected before anything is deployed, each with a specific message: build steps that are
not `pre-built`, wasms or plugins referenced by URL instead of by path, `script` sync steps
(a browser has no shell), and sync plugins built against an interface version this deployer
has no bindings for.

A bundle built from a workspace carries its dependencies too — the root project at the
archive root and each dependency at the directory it sits in relative to that root — and
the whole workspace deploys, because a dependency's canisters may call each other. Those
canisters are keyed by where the dependency sits, so `vendor/lib:backend` is a different
canister from the root's own `backend`.

## Run it

Requires [icp-cli](https://cli.internetcomputer.org/) 1.x and Node.js, plus a Rust
toolchain with the `wasm32-unknown-unknown` target and
[`wasm-pack`](https://drager.github.io/wasm-pack/) to build the library's Rust core, and
[`mops`](https://mops.one/docs/install) and [`ic-wasm`](https://github.com/dfinity/ic-wasm)
to build the registry canister (`mops` fetches the Motoko compiler itself).

```bash
npm install
icp network start -d
icp deploy
# open the printed frontend URL, e.g. http://frontend.local.localhost:8000/
```

Sign in with Internet Identity, or on a test network choose **Use a temporary identity** to
skip the passkey. Either way the principal pays for what it creates, so fund it first —
locally that is one command:

```bash
icp cycles transfer 10t <the principal the page shows>
```

Deploying with too small a balance fails before anything is created, reporting the
shortfall.

The page learns the network's root key, and where the registry is, from the `ic_env`
cookie the asset canister certifies. `npm run dev` serves the same cookie itself: at start
it reads the running local network's root key and API URL and the registry's id, sets the
cookie on every response, and proxies `/api` to the network — so deploy the registry first
(`icp deploy registry`), then work on the page against the dev server as it would behave
from its canister URL.

[`icp.yaml`](./icp.yaml) pins `@dfinity/static-site` at `v0.3.3` or later — earlier
releases do not serve the `ic_env` cookie that network detection reads.

## Tests

```bash
npm test         # offline: unpacking, manifest validation, integrity, the registry's rules
npm run test:e2e # deploys a real bundle, and the registry, to the local network
```

The offline suite builds tar archives in memory, so it needs no fixtures and no
network. Most of its cases assert a *refusal* — a script build step, a wasm or plugin
referenced by URL, a tampered digest — because those decide whether a deployment starts
at all, and the point is that a bad bundle is rejected before any canister exists. Those
cases live in `src/lib/core`, which `npm test` runs with `cargo test` before the
TypeScript suite checks that a refusal reaches a caller as the error class it can branch
on. The core also drives the deploy operation against a stand-in network there, to check
the one thing this deployer adds around it: a canister whose id is already in the store is
not created again and is installed in the mode its status calls for.

The registry's rules — what a name may be, that a name is reserved per caller, that an
update keeps `created` and bumps `updated`, that callers see only their own records and an
anonymous caller none — are Motoko unit tests under `test/*.test.mo`, run with `mops test`
(`npm test` includes them). The caller and the clock are parameters of the module the
actor delegates to, which is what lets them run without a replica.

Both suites run in CI on every pull request and on `main`
([`.github/workflows/test.yml`](./.github/workflows/test.yml)), after a build of the page,
with the toolchains at the versions pinned in [`rust-toolchain.toml`](./rust-toolchain.toml),
[`.nvmrc`](./.nvmrc), [`mops.toml`](./mops.toml) and the workflow itself.

The e2e suite needs a running local network (`icp network start -d`). It builds a
two-canister bundle from the published certified-assets release (cached under
`.cache/` after the first run), funds a fresh identity with `icp cycles transfer`,
deploys through the same modules the page uses, and then checks the result from
outside: module hashes, controllers, colocation on one subnet, the injected canister
IDs in the `ic_env` cookie, and the synced site's redirects, clean URLs and 404. It also
deploys the registry with `icp deploy registry` and drives create, list, update and the
refusals through the same client module the page uses.

## Layout

| Path | Role |
|---|---|
| `src/lib/index.ts` | the library's public API — everything below is reached through it |
| `src/lib/deployer.ts` | `createDeployer`: binds an agent, resolves what the caller left out |
| `src/lib/bundle.ts` | loading a bundle, and the errors a bad one raises |
| `src/lib/host.ts` | what the core calls out to: agent-js, plugins |
| `src/lib/ic/` | the cycles balance, subnet lookups, canister status, metadata and settings reads |
| `src/lib/plugin/` | plugin transpilation, the WASI sandbox, the plugin's canister imports |
| `src/lib/core/` | the Rust core: the archive, the manifest, the seams the deploy operation runs against |
| `src/lib/wasm/` | the compiled core, generated by `npm run build:lib` |
| `src/app/` | the page: network detection, Internet Identity, the registry client, recording, the upgrade plan, UI |
| `src/registry/` | the registry canister, in Motoko: types, rules, interface |
| `test/` | the offline, Motoko and e2e suites |

## Deploying to mainnet

```bash
icp deploy -e ic
```

Sign in with Internet Identity. Nothing else differs — creation is charged to that
principal's cycles ledger account exactly as it is locally, so the only thing to check is
that the balance shown in the identity panel covers 2T per canister.
