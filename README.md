# Bundle deployer

A frontend canister that deploys **application bundles** — entirely client side. Drop a
bundle onto the page and it creates the canisters the bundle declares and installs their
wasms, using the browser's own identity. There is no backend and no CLI in the loop.

## What a bundle is

An application bundle is a tar (optionally gzipped, conventionally `.icp`) whose root
holds a resolved `icp.yaml`, with every artifact it needs alongside it, referenced by a
path relative to the tar root:

```
backend-bundle.icp
├── icp.yaml
└── canisters/backend-example.wasm
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
3. **Creates each canister** — funded with 2T cycles, the same default `icp deploy` uses.
   On mainnet that goes through the cycles ledger, charged to the signed-in principal's
   balance; an ingress message cannot carry cycles, so this is the only client-side path.
   On a test network it uses free provisional creation.
4. **Installs each wasm** — in one `install_code` call, or through the chunk store for wasms
   above the ingress limit.
5. **Applies the manifest's settings** — resource settings before the install, controllers
   after it, so the deployer keeps control of the canister while it is still setting it up.

Canisters deploy one at a time. If one fails, the run stops and the page reports which
canisters were created but left without a working install, so nothing is silently
abandoned — they exist and you control them.

## Scope

This deploys canisters and installs wasms. It does **not** sync frontend assets: a bundle
that declares a `sync:` step is rejected with an explanation rather than half-deployed.
Also rejected, each with a specific message: build steps that are not `pre-built`, wasms
referenced by URL instead of by path, project dependencies, and init args in Candid *text*
format (which needs an encoder the browser doesn't have — use `format: hex` or
`format: bin`).

## Run it

Requires [icp-cli](https://cli.internetcomputer.org/) 1.x and Node.js.

```bash
npm install
icp network start -d
icp deploy
# open the printed frontend URL, e.g. http://frontend.local.localhost:8000/
```

On a test network, choose **Use a temporary identity** — creation is free and needs no
passkey. On mainnet, sign in with Internet Identity; the principal you sign in as needs a
cycles ledger balance.

Note that the deployer must be opened from its canister URL, not the Vite dev server: it
learns the network's root key from the asset canister's cookie, and the canister to route
creation through from the gateway's `x-ic-canister-id` header. `npm run dev` is fine for
working on the page itself, but deploying from it is refused with that explanation.

For the same reason, [`icp.yaml`](./icp.yaml) pins `@dfinity/static-site` at `v0.3.3` or
later — earlier releases do not serve the `ic_env` cookie that network detection reads.

## Layout

| Path | Role |
|---|---|
| `src/bundle/` | archive reader, manifest parsing and validation, integrity checks |
| `src/ic/` | network detection, identity, canister creation, wasm install |
| `src/deploy.ts` | per-canister orchestration with progress events |
| `src/ui/` | the page |

## Deploying to mainnet

```bash
icp deploy -e ic
```

Sign in with Internet Identity, then check the cycles balance shown in the identity panel.
Creation is charged to that principal's cycles ledger account, and a balance too low for
the 2T funding fails with the shortfall and the principal to top up.
