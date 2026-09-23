//! Progress, as it happens, and the result at the end.
//!
//! A deployment is a sequence of calls that can each take seconds, so the caller
//! is told what is happening while it happens rather than at the end. The core
//! reports on the deploy operation's own event stream (see [`crate::progress`]);
//! what leaves this module is the smaller vocabulary the library around it
//! shows, as plain JavaScript objects.

use serde::Serialize;

/// What a run does to a canister. A name not yet in the id store is created;
/// one already there is installed into if it is empty and upgraded if a module
/// is installed — the mode `icp deploy` resolves from the canister's live
/// status, which the caller read ahead of the run to say which it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Create,
    Install,
    Upgrade,
}

/// What a deployment reports as it goes. This is the whole `DeployEvent` a
/// caller of the library sees; the library adds nothing of its own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DeployEvent {
    /// Something that concerns the whole deployment: a phase beginning, or a
    /// notice about the run as a whole.
    Phase { message: String },
    /// Work on a canister begins: it is about to be created, or — for one that
    /// already exists, whose id is given — installed into or upgraded.
    Started {
        name: String,
        action: Action,
        #[serde(skip_serializing_if = "Option::is_none")]
        canister_id: Option<String>,
    },
    /// A canister exists. Reported the moment its id is known, so a caller that
    /// records ids loses nothing if the run is cut short after this.
    Created {
        name: String,
        canister_id: String,
        action: Action,
    },
    /// A line about one canister: what is being done to it, or what its sync
    /// plugin printed.
    Progress { name: String, message: String },
    /// A canister's wasm is installed and running.
    Installed {
        name: String,
        canister_id: String,
        action: Action,
    },
    /// Something about one canister failed. The run stops after the phase it
    /// was in; the result says what that left behind.
    Failed { name: String, message: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployedCanister {
    pub name: String,
    pub canister_id: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct DeployResult {
    /// Canisters that are fully deployed, in the order the environment declares
    /// them.
    pub deployed: Vec<DeployedCanister>,
    /// Canisters this run created but did not finish. They exist and the
    /// caller controls them, so they are reported rather than lost.
    pub incomplete: Vec<DeployedCanister>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl DeployResult {
    /// A run that stopped before it created anything.
    pub fn failed(error: impl Into<String>) -> Self {
        Self {
            error: Some(error.into()),
            ..Self::default()
        }
    }
}

#[cfg(target_family = "wasm")]
pub use js::{Emitter, to_js};

#[cfg(target_family = "wasm")]
mod js {
    use js_sys::Function;
    use serde::Serialize;
    use wasm_bindgen::prelude::*;

    use super::DeployEvent;

    /// Where events go: the callback the library passed in.
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

    /// Serialize to plain JavaScript objects rather than `Map`s, which is what
    /// the library around this module expects to receive.
    pub fn to_js<T: Serialize>(value: &T) -> Result<JsValue, serde_wasm_bindgen::Error> {
        value.serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
    }
}
