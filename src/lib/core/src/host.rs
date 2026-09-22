//! The page's side of a deployment.
//!
//! Three things cannot be done from inside this module: signing and sending
//! calls to a replica, creating a canister, and running a sync plugin. They are
//! supplied by the host as a single JavaScript object — the calls backed by
//! agent-js, creation by the cycles ledger client, plugins by jco — and
//! everything else (what to call, in what order, with which arguments) is
//! decided here and in `icp-project`. The host also says where the network is,
//! which nothing here needs but a sync plugin is told.
//!
//! `icp-project` reaches canisters through its [`CanisterCalls`] seam, and this
//! is the browser's implementation of it: every call becomes an ingress message
//! signed by whichever agent backs the host.

use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};

use async_trait::async_trait;
use candid::Principal;
use icp_project::{
    calls::{Authority, Call, CallError, CanisterCalls, RouteTo},
    network::NetworkUrls,
};
use js_sys::{Promise, Reflect, Uint8Array};
use snafu::Snafu;
use url::Url;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen(typescript_custom_section)]
const DEPLOYER_HOST: &'static str = r#"
/** Progress lines a sync plugin prints while it runs. */
export type PluginOutput = (line: string) => void

/**
 * A directory the sync step declared. `key` is the name it was written under
 * when the setting is a map, and `undefined` when it is a plain list.
 */
export interface PluginDir {
  key?: string
  /** Written relative to the canister directory; the path the plugin opens it at. */
  path: string
}

/** A file the sync step declared, read up front and passed to the plugin inline. */
export interface PluginFile {
  key?: string
  name: string
  content: string
}

/** A `fields:` entry, passed to the plugin verbatim. */
export interface PluginField {
  name: string
  value: string
}

/** A canister the plugin can resolve by name. */
export interface PluginCanisterId {
  name: string
  id: string
}

/** Where the network a deployment talks to is reached. */
export interface NetworkUrls {
  /** The API endpoint calls are submitted to. */
  apiUrl: string
  /** The HTTP gateway canisters are served through, when the network has one. */
  gatewayUrl?: string
}

/** A fully-resolved sync-plugin step, ready for the jco adapter to run. */
export interface PluginRequest {
  /** The plugin component, verified against the digest the manifest declared. */
  wasm: Uint8Array
  /**
   * Which version of the `icp:sync-plugin` interface this plugin was built
   * against, read off the instance its component declares. The two differ in
   * what `exec` is handed, so the adapter has to be told rather than guess: a
   * component declares only the host functions it calls, which says nothing
   * about the interface it speaks.
   */
  abi: 'v1' | 'v2'
  /** The canister being synced, which the plugin may always reach. */
  canisterId: string
  /** Environment name the plugin is told about; informational to it. */
  environment: string
  /** Where the network is reached, as the plugin is told it. */
  network: NetworkUrls
  /**
   * The directories the plugin may read, in written order, keys and all. For
   * a v2 plugin these are the `files:` entries that name a directory in the
   * bundle; a v1 plugin has a `dirs:` setting of its own.
   */
  dirs: PluginDir[]
  /** Files the host read up front and passes inline. */
  files: PluginFile[]
  /** Key-value fields the step declared. */
  fields: PluginField[]
  /** Every canister this deployment named, for the plugin to resolve against. */
  canisterIds: PluginCanisterId[]
  /**
   * The canisters the step's `canisters:` list named, by name. These, plus
   * `canisterId`, are the only ones a plugin may call; anything else must be
   * refused rather than reached.
   */
  callable: Map<string, string>
  /**
   * What to mount read-only, and where. Keyed by the path the plugin opens the
   * directory at — the spelling the manifest used — and holding that tree's
   * files by their path within it. A directory already covered by another entry
   * has no mount of its own and is read through the one covering it.
   */
  mounts: Map<string, Map<string, Uint8Array>>
  onOutput: PluginOutput
}

/**
 * Everything the deployer needs from the page. Calls are signed by whichever
 * agent backs this host, so who the deployment runs as and which network it
 * talks to are both decided there.
 */
export interface DeployerHost {
  /** Raw update call. `cycles` is a decimal string, since a u128 is not a JS number. */
  update(
    canisterId: string,
    method: string,
    arg: Uint8Array,
    effectiveCanisterId: string,
    cycles: string,
  ): Promise<Uint8Array>
  /** A canister's custom-section metadata, or `undefined` when it has none. */
  readCanisterMetadata(canisterId: string, path: string): Promise<Uint8Array | undefined>
  /**
   * Creates one empty canister and returns its id. Where it lands — the subnet,
   * and whether a cloud engine's operator creates it — is the host's decision;
   * the deployment only asks for canisters, one per canister the manifest
   * declares, in declaration order.
   */
  createCanister(): Promise<string>
  /** Runs one sync plugin to completion. */
  runPlugin(request: PluginRequest): Promise<void>
  /**
   * Where the network the agent talks to is reached. The deployment itself
   * calls through `update` and needs neither URL; sync plugins are told both,
   * so one can say where the canister it synced is served.
   */
  network(): NetworkUrls
}
"#;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(typescript_type = "DeployerHost")]
    pub type DeployerHost;

    #[wasm_bindgen(method, catch)]
    fn update(
        this: &DeployerHost,
        canister_id: &str,
        method: &str,
        arg: &[u8],
        effective_canister_id: &str,
        cycles: &str,
    ) -> Result<Promise, JsValue>;

    #[wasm_bindgen(method, catch, js_name = readCanisterMetadata)]
    fn read_canister_metadata(
        this: &DeployerHost,
        canister_id: &str,
        path: &str,
    ) -> Result<Promise, JsValue>;

    #[wasm_bindgen(method, catch, js_name = createCanister)]
    fn create_canister(this: &DeployerHost) -> Result<Promise, JsValue>;

    #[wasm_bindgen(method, catch, js_name = runPlugin)]
    fn run_plugin(this: &DeployerHost, request: &JsValue) -> Result<Promise, JsValue>;

    #[wasm_bindgen(method, catch)]
    fn network(this: &DeployerHost) -> Result<JsValue, JsValue>;
}

/// The host, plus the principal it signs as.
pub struct Host {
    js: DeployerHost,
    caller: Principal,
}

// The generated module is single-threaded, so the JavaScript handles held here
// can never be reached from another thread. The seams in `icp-project` require
// `Send + Sync` because the CLI shares its implementations across tokio tasks;
// in a browser there is nothing to share with.
unsafe impl Send for Host {}
unsafe impl Sync for Host {}

impl Host {
    pub fn new(js: DeployerHost, caller: Principal) -> Self {
        Self { js, caller }
    }

    /// The principal every call is signed as, and therefore the controller of
    /// every canister this deployment creates.
    pub fn caller(&self) -> Principal {
        self.caller
    }

    pub async fn update_call(
        &self,
        canister: Principal,
        method: &str,
        arg: Vec<u8>,
        effective_canister_id: Principal,
        cycles: u128,
    ) -> Result<Vec<u8>, String> {
        let promise = self
            .js
            .update(
                &canister.to_text(),
                method,
                &arg,
                &effective_canister_id.to_text(),
                &cycles.to_string(),
            )
            .map_err(|e| describe(&e))?;
        bytes(await_js(promise).await?)
    }

    pub async fn metadata(
        &self,
        canister: Principal,
        path: &str,
    ) -> Result<Option<Vec<u8>>, String> {
        let promise = self
            .js
            .read_canister_metadata(&canister.to_text(), path)
            .map_err(|e| describe(&e))?;
        let value = await_js(promise).await?;
        if value.is_undefined() || value.is_null() {
            return Ok(None);
        }
        bytes(value).map(Some)
    }

    pub async fn create_canister(&self) -> Result<Principal, String> {
        let promise = self.js.create_canister().map_err(|e| describe(&e))?;
        let value = await_js(promise).await?;
        let text = value
            .as_string()
            .ok_or_else(|| "the host returned something other than a canister id".to_owned())?;
        Principal::from_text(&text)
            .map_err(|e| format!("the host returned '{text}', which is not a canister id: {e}"))
    }

    pub async fn run_plugin(&self, request: &JsValue) -> Result<(), String> {
        let promise = self.js.run_plugin(request).map_err(|e| describe(&e))?;
        await_js(promise).await.map(|_| ())
    }

    /// Where the network is reached, as the host knows it.
    pub fn network(&self) -> Result<NetworkUrls, String> {
        let urls = self.js.network().map_err(|e| describe(&e))?;
        let api_url = string_property(&urls, "apiUrl")?
            .ok_or_else(|| "the host named no API URL for the network".to_owned())?;
        let api_url = Url::parse(&api_url)
            .map_err(|e| format!("the host's API URL '{api_url}' is not a URL: {e}"))?;
        let http_gateway_url = match string_property(&urls, "gatewayUrl")? {
            Some(gateway) => Some(
                Url::parse(&gateway)
                    .map_err(|e| format!("the host's gateway URL '{gateway}' is not a URL: {e}"))?,
            ),
            None => None,
        };
        Ok(NetworkUrls {
            api_url,
            http_gateway_url,
        })
    }
}

/// A call the host could not complete, as it described it.
#[derive(Debug, Snafu)]
#[snafu(display("{message}"))]
pub struct HostError {
    message: String,
}

/// A read this host has no way to make. None of them is on a deployment's path;
/// the seam has them for what icp-cli does besides deploying.
#[derive(Debug, Snafu)]
#[snafu(display("a browser deployment cannot {what}"))]
struct Unsupported {
    what: &'static str,
}

#[async_trait]
impl CanisterCalls for Host {
    fn caller(&self) -> Principal {
        self.caller
    }

    async fn update(&self, call: Call) -> Result<Vec<u8>, CallError> {
        let Call {
            canister,
            method,
            arg,
            route,
            cycles,
            ..
        } = call;
        // The management canister has no routing of its own, so a call to it is
        // routed to the canister — or subnet — it acts on.
        let effective = match route {
            RouteTo::Callee => canister,
            RouteTo::Canister(target) | RouteTo::Subnet(target) => target,
        };
        assume_send(self.update_call(canister, &method, arg, effective, cycles))
            .await
            .map_err(|message| CallError::failed(canister, &method, HostError { message }))
    }

    /// An update call reaches a query method just as well, and the reply is the
    /// same; the host signs ingress messages and has no separate query path.
    async fn query(&self, call: Call) -> Result<Vec<u8>, CallError> {
        self.update(call).await
    }

    /// Who is reading makes no difference here: the host reads with the one
    /// identity it has, which is the deployer's own.
    async fn metadata_section(
        &self,
        canister: Principal,
        path: &str,
        _authority: Authority,
    ) -> Result<Option<Vec<u8>>, CallError> {
        assume_send(self.metadata(canister, path))
            .await
            .map_err(|message| CallError::failed(canister, "read_state", HostError { message }))
    }

    async fn controllers(&self, canister: Principal) -> Result<Option<Vec<Principal>>, CallError> {
        Err(CallError::failed(
            canister,
            "read_state",
            Unsupported {
                what: "read a canister's controllers",
            },
        ))
    }

    async fn module_hash(&self, canister: Principal) -> Result<Option<Vec<u8>>, CallError> {
        Err(CallError::failed(
            canister,
            "read_state",
            Unsupported {
                what: "read a canister's module hash",
            },
        ))
    }

    async fn subnet_of(&self, canister: Principal) -> Result<Principal, CallError> {
        Err(CallError::failed(
            canister,
            "read_state",
            Unsupported {
                what: "look up a canister's subnet",
            },
        ))
    }

    async fn subnet_uses_engine_operator(&self, subnet: Principal) -> Result<bool, CallError> {
        Err(CallError::failed(
            subnet,
            "read_state",
            Unsupported {
                what: "consult the engine registry",
            },
        ))
    }
}

/// A future the single-threaded module may treat as `Send`.
///
/// `icp-project`'s seams are `async_trait` methods, whose futures have to be
/// `Send` because the CLI drives them from a multi-threaded runtime. A JavaScript
/// promise is not — nothing from JavaScript is — but the generated module runs
/// on one thread, so there is no other thread for the future to be sent to.
/// Saying so is what lets a browser implement the same seams the CLI does.
pub struct AssumeSend<F>(F);

unsafe impl<F> Send for AssumeSend<F> {}

impl<F: Future> Future for AssumeSend<F> {
    type Output = F::Output;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<F::Output> {
        // The wrapped future is never moved out of the wrapper, so pinning the
        // wrapper pins it.
        unsafe { self.map_unchecked_mut(|wrapper| &mut wrapper.0) }.poll(cx)
    }
}

pub fn assume_send<F: Future>(future: F) -> AssumeSend<F> {
    AssumeSend(future)
}

async fn await_js(promise: Promise) -> Result<JsValue, String> {
    JsFuture::from(promise).await.map_err(|e| describe(&e))
}

fn bytes(value: JsValue) -> Result<Vec<u8>, String> {
    value
        .dyn_ref::<Uint8Array>()
        .map(Uint8Array::to_vec)
        .ok_or_else(|| "the host returned something other than bytes".to_owned())
}

/// A string property of a plain object, `None` when it is absent or `undefined`.
fn string_property(object: &JsValue, key: &str) -> Result<Option<String>, String> {
    let value = Reflect::get(object, &JsValue::from_str(key)).map_err(|e| describe(&e))?;
    if value.is_undefined() || value.is_null() {
        return Ok(None);
    }
    value
        .as_string()
        .map(Some)
        .ok_or_else(|| format!("the host's '{key}' is not a string"))
}

/// A JavaScript rejection, as a message worth showing. An `Error` carries the
/// message the agent wrote; anything else is stringified as-is.
pub fn describe(value: &JsValue) -> String {
    if let Some(error) = value.dyn_ref::<js_sys::Error>() {
        return error.message().into();
    }
    if let Some(text) = value.as_string() {
        return text;
    }
    js_sys::JSON::stringify(value)
        .map(String::from)
        .unwrap_or_else(|_| "unknown error".to_owned())
}
