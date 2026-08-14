//! What the library around this module calls.
//!
//! Everything crossing into JavaScript is here, and nothing else is: the module
//! hands back plain objects and strings, so the library above can present its
//! own types without any of this showing through.

use std::rc::Rc;

use candid::Principal;
use js_sys::{Function, Promise};
use serde::Serialize;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;

use crate::{
    bundle::{self, BundleErrorKind, LoadedBundle},
    deploy,
    events::{Emitter, to_js},
    host::{DeployerHost, Host},
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

/// Deploy a bundle: create every canister it declares, give each the whole set
/// of ids, install their wasm, and run any sync plugin the bundle carries.
///
/// `environment` names the environment the manifest is read for — `ic` or
/// `local` — which decides which overrides apply and what a sync plugin is told
/// it is running against.
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
    on_event: Function,
) -> Result<Promise, JsValue> {
    let caller = Principal::from_text(&caller).map_err(|e| {
        JsValue::from(js_sys::Error::new(&format!(
            "'{caller}' is not a principal: {e}"
        )))
    })?;
    let bundle = Rc::clone(&bundle.inner);

    // A borrow cannot outlive an exported function, so the deployment is handed
    // back as a promise over owned state rather than written as an `async fn`.
    Ok(future_to_promise(async move {
        let host = Host::new(host, caller);
        let emitter = Emitter::new(on_event);
        let result = deploy::deploy(&bundle, &host, &environment, &emitter).await;
        to_js(&result).map_err(JsValue::from)
    }))
}

/// The SHA-256 of some bytes, lowercase hex — the form `icp.yaml` declares
/// digests in.
#[wasm_bindgen(js_name = sha256Hex)]
pub fn sha256_hex(bytes: &[u8]) -> String {
    bundle::sha256_hex(bytes)
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
