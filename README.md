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
5. **Installs each wasm** — in one `install_code` call, or through the chunk store for wasms
   above the ingress limit.
6. **Runs the bundle's sync plugin** — see below. Assets are uploaded by the same wasm
   `icp sync` runs.
7. **Hands over control** — controllers are applied last, so the deployer keeps control of
   each canister while it is still setting it up.

Those are phases, not a per-canister loop, and the order matters: every canister is created
before any wasm is installed. If a phase fails the run stops and the page reports which
canisters exist but are unfinished, so nothing is silently abandoned — they exist and you
control them.

## Choosing a subnet

A deployment lands on exactly one subnet, resolved once before anything is created, so
canisters that call each other are never scattered. The optional **target subnet** field
names it — the equivalent of `icp deploy --subnet`. Left empty, the cycles minting
canister's default subnets decide, as in icp-cli; on a network with no minting canister
the run anchors to wherever its first canister lands and keeps the rest with it.

## Cloud engines

A **cloud engine** is a user-owned subnet, and it does not create canisters through the
cycles ledger — creation is delegated to the subnet's **engine operator**, which the
engine's administrators authorize callers against. Name the engine's subnet (its id is on
the console's Applications page) and the deployer follows the same route icp-cli does:

- ask the engine registry (`q6cfj-fyaaa-aaaar-qb77q-cai`) which operator serves that
  subnet;
- if one answers, address `create_canister` to the operator instead of the ledger — the
  two are byte-compatible, so nothing else changes;
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
- **`preview2-shim` provides the WASI world** with an in-memory filesystem holding only the
  directories the manifest declared, mirroring the read-only preopen sandbox icp-cli gives
  a plugin. There is no network and no writable filesystem inside it.
- **`canister-call`, the plugin's one non-WASI import, is backed by agent-js** and fixed to
  the canister being synced, exactly as the CLI host fixes it.
- The plugin's own progress output is piped into the deployment log.

That last import is declared *synchronous*, and a browser cannot block on a network round
trip. The bridge is **WebAssembly JSPI**, which suspends the wasm stack until the call
settles — shipped in Chrome 137+ and Edge, behind a flag in Firefox, in progress in Safari.
On a browser without it the page says so up front; creating canisters and installing wasms
are unaffected.

## Scope

Rejected before anything is deployed, each with a specific message: build steps that are
not `pre-built`, wasms or plugins referenced by URL instead of by path, `script` sync steps
(a browser has no shell), project dependencies, and init args in Candid *text* format
(which needs an encoder the browser doesn't have — use `format: hex` or `format: bin`).

## Run it

Requires [icp-cli](https://cli.internetcomputer.org/) 1.x and Node.js.

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

Open the deployer from its canister URL rather than the Vite dev server: it learns the
network's root key from the asset canister's `ic_env` cookie, which the dev server does not
serve. `npm run dev` is fine for working on the page itself.

For the same reason, [`icp.yaml`](./icp.yaml) pins `@dfinity/static-site` at `v0.3.3` or
later — earlier releases do not serve the `ic_env` cookie that network detection reads.

## Tests

```bash
npm test         # offline: unpacking, manifest validation, integrity
npm run test:e2e # deploys a real bundle to the local network
```

The offline suite builds tar archives in memory, so it needs no fixtures and no
network. Most of its cases assert a *refusal* — a script build step, a wasm or plugin
referenced by URL, a tampered digest, Candid-text init args — because those decide
whether a deployment starts at all, and the point is that a bad bundle is rejected
before any canister exists.

The e2e suite needs a running local network (`icp network start -d`). It builds a
two-canister bundle from the published certified-assets release (cached under
`.cache/` after the first run), funds a fresh identity with `icp cycles transfer`,
deploys through the same modules the page uses, and then checks the result from
outside: module hashes, controllers, colocation on one subnet, the injected canister
IDs in the `ic_env` cookie, and the synced site's redirects, clean URLs and 404.

## Layout

| Path | Role |
|---|---|
| `src/bundle/` | archive reader, manifest parsing and validation, integrity checks |
| `src/ic/` | network detection, identity, canister creation, wasm install |
| `src/sync/` | plugin transpilation, the WASI sandbox, the `canister-call` bridge |
| `src/deploy.ts` | per-canister orchestration with progress events |
| `src/ui/` | the page |
| `test/` | the offline and e2e suites |

## Deploying to mainnet

```bash
icp deploy -e ic
```

Sign in with Internet Identity. Nothing else differs — creation is charged to that
principal's cycles ledger account exactly as it is locally, so the only thing to check is
that the balance shown in the identity panel covers 2T per canister.
