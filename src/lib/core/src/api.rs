//! What the library around this module calls.
//!
//! Everything crossing into JavaScript is here, and nothing else is: the module
//! hands back plain objects and strings, so the library above can present its
//! own types without any of this showing through.

use std::{collections::BTreeMap, rc::Rc, sync::Arc};

use candid::Principal;
use icp_project::canister::sync::Syncer;
use js_sys::{Function, Promise};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;

use crate::{
    bundle::{self, BundleErrorKind, LoadedBundle},
    deploy::{self, Existing, Options, Runtime},
    events::{DeployResult, Emitter, to_js},
    host::{DeployerHost, Host},
    plugin::JsPluginRunner,
    progress::Sink,
    runtime::{JsRandom, JsTimer},
    seams::{BundleWasm, NoScripts},
};

#[wasm_bindgen(start)]
fn start() {
    // A panic in here would otherwise surface as an unreadable "unreachable
    // executed"; this makes it a stack trace in the console.
    console_error_panic_hook::set_once();
}

/// A bundle that has been read, validated and verified: every artifact the
/// manifest names is in the archive and hashes to what was declared for it.
#[wasm_bindgen]
pub struct Bundle {
    inner: Rc<LoadedBundle>,
}

#[wasm_bindgen]
impl Bundle {
    /// What the bundle holds, in the order the manifest declares it: one
    /// `BundleCanister` per canister, as the library types it.
    #[wasm_bindgen(getter)]
    pub fn canisters(&self) -> Result<JsValue, JsValue> {
        let summaries: Vec<CanisterSummary> = self
            .inner
            .canisters
            .iter()
            .map(CanisterSummary::from)
            .collect();
        to_js(&summaries).map_err(JsValue::from)
    }
}

/// One canister's contribution to a bundle, for showing what is about to be
/// deployed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanisterSummary {
    name: String,
    wasm_path: String,
    wasm_size: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
    digest: String,
    sync_dirs: Vec<String>,
}

impl From<&bundle::CanisterSummary> for CanisterSummary {
    fn from(summary: &bundle::CanisterSummary) -> Self {
        Self {
            name: summary.name.clone(),
            wasm_path: summary.wasm_path.clone(),
            wasm_size: summary.wasm_size,
            sha256: summary.declared_sha256.clone(),
            digest: summary.digest.clone(),
            sync_dirs: summary.sync_dirs.clone(),
        }
    }
}

/// Read, validate and verify a bundle: a tar, optionally gzipped, holding a
/// resolved `icp.yaml` and every artifact it names.
///
/// Throws when the bundle cannot be deployed, with a `kind` of `archive`,
/// `manifest` or `integrity` on the error. There is nothing partial to report at
/// this stage — nothing has been created — so this is the one entry point that
/// throws rather than returning a result.
#[wasm_bindgen(js_name = loadBundle)]
pub async fn load_bundle(data: Vec<u8>) -> Result<Bundle, JsValue> {
    match bundle::load_bundle(&data).await {
        Ok(loaded) => Ok(Bundle {
            inner: Rc::new(loaded),
        }),
        Err(error) => Err(bundle_error(&error)),
    }
}

#[wasm_bindgen(typescript_custom_section)]
const EXISTING_CANISTER: &'static str = r#"
/**
 * A canister that exists before a deployment, to be upgraded or installed into
 * rather than created. `installed` says whether a module is on it, which
 * decides how the run describes what it does to the canister.
 */
export interface ExistingCanister {
  canisterId: string
  installed: boolean
}
"#;

/// An entry of the `existing` map, as the library passes it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExistingCanister {
    canister_id: String,
    installed: bool,
}

/// Deploy a bundle: create every canister it declares that does not exist yet,
/// give each the whole set of ids, install or upgrade their wasm, and run any
/// sync plugin the bundle carries.
///
/// `environment` names the environment the manifest is read for — `ic` or
/// `local` — which decides which overrides apply and what a sync plugin is told
/// it is running against. `subnet`, when given, is where every canister is
/// created; `cycles` is what each is funded with, as a decimal string.
/// `existing` maps manifest names to canisters that already exist, which are
/// not created: an upgrade seeds it from the application's record, an install
/// passes an empty object.
///
/// Resolves rather than rejecting when a deployment fails part-way: the result
/// carries what was deployed, what was created but left unfinished, and why it
/// stopped.
#[wasm_bindgen(js_name = deployBundle)]
pub fn deploy_bundle(
    bundle: &Bundle,
    host: DeployerHost,
    caller: String,
    environment: String,
    subnet: Option<String>,
    cycles: String,
    #[wasm_bindgen(unchecked_param_type = "Record<string, ExistingCanister>")] existing: JsValue,
    on_event: Function,
) -> Result<Promise, JsValue> {
    let caller = Principal::from_text(&caller)
        .map_err(|e| invalid(format!("'{caller}' is not a principal: {e}")))?;
    let subnet = subnet
        .map(|subnet| {
            Principal::from_text(&subnet)
                .map_err(|e| invalid(format!("'{subnet}' is not a subnet id: {e}")))
        })
        .transpose()?;
    let cycles: u128 = cycles
        .parse()
        .map_err(|e| invalid(format!("'{cycles}' is not a number of cycles: {e}")))?;
    let existing: BTreeMap<String, ExistingCanister> = serde_wasm_bindgen::from_value(existing)
        .map_err(|e| {
            invalid(format!(
                "the existing canisters are not a map of name to canister: {e}"
            ))
        })?;
    let existing = existing
        .into_iter()
        .map(|(name, canister)| {
            let canister_id = Principal::from_text(&canister.canister_id).map_err(|e| {
                invalid(format!(
                    "existing canister '{name}' has id '{}', which is not a canister id: {e}",
                    canister.canister_id
                ))
            })?;
            Ok((
                name,
                Existing {
                    canister_id,
                    installed: canister.installed,
                },
            ))
        })
        .collect::<Result<BTreeMap<_, _>, JsValue>>()?;
    let bundle = Rc::clone(&bundle.inner);

    // A borrow cannot outlive an exported function, so the deployment is handed
    // back as a promise over owned state rather than written as an `async fn`.
    Ok(future_to_promise(async move {
        // Shared rather than borrowed: the crate's seams are held as `Arc`s, and
        // the host is what implements them.
        let host = Arc::new(Host::new(host, caller));
        let emitter = Emitter::new(on_event);
        let sink: Sink = Arc::new(move |event| emitter.emit(event));

        // Asked for up front: a sync plugin is told where the network is, and a
        // host that cannot say so should fail the run before it has created
        // anything.
        let network = match host.network() {
            Ok(network) => network,
            Err(message) => return to_js(&DeployResult::failed(message)).map_err(JsValue::from),
        };

        // The crate's own syncer, with the browser behind each of its seams: no
        // scripts, wasms out of the bundle, plugins through jco.
        let files = bundle.files.clone();
        let runtime = Runtime {
            syncer: Arc::new(Syncer::new(
                Arc::new(NoScripts),
                Arc::new(BundleWasm(files.clone())),
                Arc::new(JsPluginRunner::new(Arc::clone(&host), files)),
            )),
            random: Arc::new(JsRandom),
            timer: Arc::new(JsTimer),
        };
        let options = Options {
            environment,
            subnet,
            cycles,
            existing,
            network,
        };

        let result = deploy::deploy(&bundle, host, runtime, options, sink).await;
        to_js(&result).map_err(JsValue::from)
    }))
}

/// The SHA-256 of some bytes, lowercase hex — the form `icp.yaml` declares
/// digests in.
#[wasm_bindgen(js_name = sha256Hex)]
pub fn sha256_hex(bytes: &[u8]) -> String {
    bundle::sha256_hex(bytes)
}

/// An argument the library should never have passed.
fn invalid(message: String) -> JsValue {
    JsValue::from(js_sys::Error::new(&message))
}

/// A refused bundle, as an `Error` carrying which of the three checks refused
/// it, so the library can raise the error class the caller expects.
fn bundle_error(error: &bundle::BundleError) -> JsValue {
    let kind = match error.kind {
        BundleErrorKind::Archive => "archive",
        BundleErrorKind::Manifest => "manifest",
        BundleErrorKind::Integrity => "integrity",
    };
    let js = js_sys::Error::new(&error.message);
    let _ = js_sys::Reflect::set(&js, &JsValue::from_str("kind"), &JsValue::from_str(kind));
    js.into()
}
