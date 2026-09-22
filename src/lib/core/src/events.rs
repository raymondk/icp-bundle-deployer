//! Progress, as it happens.
//!
//! A deployment is a sequence of calls that can each take seconds, so the caller
//! is told what is happening while it happens rather than at the end. Events are
//! plain JavaScript objects; the library around this module turns them into
//! whatever the page shows.

use icp_deploy_canister::sync_exec::StepProgress;
use js_sys::Function;
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// What the core reports as it goes. The library around it adds events of its
/// own — canister placement, which it decides — so this is a subset of the
/// `DeployEvent` a caller sees.
#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DeployEvent {
    Started { name: String },
    Created { name: String, canister_id: String },
    Progress { name: String, message: String },
    Installed { name: String, canister_id: String },
    Failed { name: String, message: String },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployedCanister {
    pub name: String,
    pub canister_id: String,
}

#[derive(Debug, Serialize)]
pub struct DeployResult {
    pub deployed: Vec<DeployedCanister>,
    pub incomplete: Vec<DeployedCanister>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Where events go. Cloneable so a sync step can keep one for its own output.
#[derive(Clone)]
pub struct Emitter(Function);

// Single-threaded by construction; see the note on `Host`.
unsafe impl Send for Emitter {}
unsafe impl Sync for Emitter {}

impl Emitter {
    pub fn new(callback: Function) -> Self {
        Self(callback)
    }

    /// Reporting progress is never worth failing a deployment over, so a
    /// callback that throws is ignored.
    pub fn emit(&self, event: DeployEvent) {
        if let Ok(value) = to_js(&event) {
            let _ = self.0.call1(&JsValue::NULL, &value);
        }
    }
}

/// Serialize to plain JavaScript objects rather than `Map`s, which is what the
/// library around this module expects to receive.
pub fn to_js<T: Serialize>(value: &T) -> Result<JsValue, serde_wasm_bindgen::Error> {
    value.serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
}

/// An emitter bound to one canister, for the lines its sync plugin prints.
#[derive(Clone)]
pub struct ProgressSink {
    emitter: Emitter,
    canister: String,
}

impl ProgressSink {
    pub fn new(emitter: Emitter, canister: String) -> Self {
        Self { emitter, canister }
    }

    pub fn line(&self, message: String) {
        self.emitter.emit(DeployEvent::Progress {
            name: self.canister.clone(),
            message,
        });
    }
}

impl StepProgress for ProgressSink {
    fn line(&self, line: String) {
        ProgressSink::line(self, line);
    }
}
