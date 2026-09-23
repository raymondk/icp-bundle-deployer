//! Running a bundle's sync plugin.
//!
//! A sync plugin is a `wasm32-wasip2` component, which this module cannot run
//! and does not try to: `icp-project` resolves the step into an [`Invocation`]
//! — which wasm, which declared paths, which canister — and the host runs it
//! through jco. What is done here is what icp-cli's own runtime does around the
//! component: find the wasm, tell a declared directory from a declared file, and
//! lay out what the plugin is allowed to see.
//!
//! The plugin is the same wasm `icp sync` runs, so what lands on the canister —
//! compression, clean URLs, redirect rules, the resulting state hash — matches a
//! CLI deployment rather than approximating it. What it prints goes out on the
//! step reporter the invocation carries, as icp-cli's runtime reports it, and
//! reaches the page from there.

use std::sync::Arc;

use async_trait::async_trait;
use icp_project::{
    canister::sync::plugin::{Invocation, KeyedPath, Run, RunError},
    prelude::*,
};
use js_sys::{Array, Function, Map, Object, Reflect, Uint8Array};
use snafu::Snafu;
use url::Url;
use wasm_bindgen::prelude::*;

use crate::{
    abi::{PluginAbi, plugin_abi},
    files::{BundleFiles, normalize},
    host::{Host, assume_send},
    sandbox::{covering_dirs, resolve},
};

#[derive(Debug, Snafu)]
pub enum PluginError {
    #[snafu(display("the plugin wasm '{path}' is not in the bundle"))]
    MissingWasm { path: PathBuf },

    #[snafu(display("the file '{path}' the step passes to the plugin is not in the bundle"))]
    MissingFile { path: PathBuf },

    #[snafu(display("the file '{path}' the step passes to the plugin is not valid UTF-8"))]
    NotText { path: PathBuf },

    #[snafu(display(
        "the step declares '{declared}', which reaches outside the bundle — everything the plugin \
         can see"
    ))]
    Outside { declared: String },

    #[snafu(display("the plugin cannot be run: {source}"))]
    Abi { source: crate::abi::AbiError },

    #[snafu(display("{message}"))]
    Host { message: String },
}

/// Runs sync plugins through the host's jco adapter. One runner serves every
/// canister: which canister an invocation is about, and where its output goes,
/// arrive with the invocation.
pub struct JsPluginRunner {
    host: Arc<Host>,
    files: BundleFiles,
}

impl JsPluginRunner {
    pub fn new(host: Arc<Host>, files: BundleFiles) -> Self {
        Self { host, files }
    }
}

#[async_trait]
impl Run for JsPluginRunner {
    async fn run(&self, invocation: Invocation) -> Result<Vec<String>, RunError> {
        assume_send(self.run_js(invocation))
            .await
            .map_err(RunError::new)?;
        // Output is streamed as it is printed rather than retained, so there is
        // nothing left to hand back.
        Ok(Vec::new())
    }
}

impl JsPluginRunner {
    async fn run_js(&self, invocation: Invocation) -> Result<(), PluginError> {
        // Declared paths are written relative to the canister's own directory
        // and resolved inside the project. A bundle's project directory is the
        // archive root — `invocation.project_dir` is always it — so confining to
        // the root, which is all `resolve` can do, is the rule icp-cli applies.
        let base = normalize(&invocation.base_dir);

        // The path the fetch seam handed back is the key the wasm is read by.
        let wasm =
            self.files
                .get(&invocation.wasm_path)
                .ok_or_else(|| PluginError::MissingWasm {
                    path: invocation.wasm_path.clone(),
                })?;

        // Which interface the plugin speaks decides the shape of everything
        // below it, so it is settled before any of that is assembled. The bundle
        // was refused at load time for one this deployer cannot drive, and for
        // paths declared in a form the interface cannot carry.
        let abi = plugin_abi(wasm).map_err(|source| PluginError::Abi { source })?;

        // A `dirs:` entry is a directory by declaration. A `files:` entry is
        // whichever the bundle says, for a plugin whose interface takes both
        // under `files:`; the older interface has no way to be handed a
        // directory there, so for it every entry is a file to read.
        let mut dirs: Vec<&KeyedPath> = invocation.dirs.iter().collect();
        let mut inline: Vec<&KeyedPath> = Vec::new();
        for entry in &invocation.files {
            let path = resolve(&base, &entry.path).map_err(|_| PluginError::Outside {
                declared: entry.path.clone(),
            })?;
            if abi == PluginAbi::V2 && self.files.is_dir(&path) {
                dirs.push(entry);
            } else {
                inline.push(entry);
            }
        }

        // The plugin is told about every declared directory, key and all, but
        // only the trees not already covered by another entry are mounted:
        // naming a directory twice, or naming one inside another's, conveys no
        // further access. Each mount is placed at the spelling the manifest
        // wrote, which is the path the plugin will open it at.
        let dir_inputs = Array::new();
        for entry in &dirs {
            let dir = Object::new();
            set(&dir, "key", &optional(entry.key.as_deref()));
            set(&dir, "path", &JsValue::from_str(&entry.path));
            dir_inputs.push(&dir);
        }

        let mounts = Map::new();
        for dir in covering_dirs(dirs.iter().map(|entry| entry.path.as_str())) {
            // The bundle is refused at load time for a directory that reaches
            // out of it; an invocation that gets here anyway must not silently
            // sync nothing.
            let root = resolve(&base, dir).map_err(|_| PluginError::Outside {
                declared: dir.to_owned(),
            })?;
            let tree = Map::new();
            for (entry, contents) in self.files.under(&root) {
                let relative = entry
                    .strip_prefix(&root)
                    .expect("an entry under the mount is relative to it");
                tree.set(
                    &JsValue::from_str(relative.as_str()),
                    &Uint8Array::from(contents),
                );
            }
            mounts.set(&JsValue::from_str(dir), &tree);
        }

        // Files are passed inline, one entry per declaration: two keys naming
        // the same file are two entries, because the key is what the plugin
        // looks the file up by.
        let file_inputs = Array::new();
        for entry in &inline {
            let path = resolve(&base, &entry.path).map_err(|_| PluginError::Outside {
                declared: entry.path.clone(),
            })?;
            let contents = self
                .files
                .get(&path)
                .ok_or_else(|| PluginError::MissingFile { path: path.clone() })?;
            let content = str::from_utf8(contents)
                .map_err(|_| PluginError::NotText { path: path.clone() })?;

            let file = Object::new();
            set(&file, "key", &optional(entry.key.as_deref()));
            set(&file, "name", &JsValue::from_str(&entry.path));
            set(&file, "content", &JsValue::from_str(content));
            file_inputs.push(&file);
        }

        let fields = Array::new();
        for (name, value) in &invocation.fields {
            let field = Object::new();
            set(&field, "name", &JsValue::from_str(name));
            set(&field, "value", &JsValue::from_str(value));
            fields.push(&field);
        }

        // Every canister the deployment named, so a plugin can resolve the ones
        // it knows about — and separately, the ones the step listed, which are
        // the only ones it is allowed to reach.
        let canister_ids = Array::new();
        for (name, canister_id) in &invocation.canister_ids {
            let entry = Object::new();
            set(&entry, "name", &JsValue::from_str(name));
            set(&entry, "id", &JsValue::from_str(&canister_id.to_text()));
            canister_ids.push(&entry);
        }
        let callable = Map::new();
        for (name, canister_id) in &invocation.callable.by_name {
            callable.set(
                &JsValue::from_str(name),
                &JsValue::from_str(&canister_id.to_text()),
            );
        }

        let network = Object::new();
        set(
            &network,
            "apiUrl",
            &JsValue::from_str(invocation.api_url.as_str()),
        );
        set(
            &network,
            "gatewayUrl",
            &optional(invocation.gateway_url.as_ref().map(Url::as_str)),
        );

        // Each line goes out on the step's reporter as the plugin prints it,
        // which is where icp-cli's runtime reports a plugin's output too. Kept
        // alive across the call, and dropped with it: the host must not hold
        // on to the callback past the run.
        let reporter = invocation.reporter.clone();
        let on_output = Closure::<dyn Fn(String)>::new(move |line: String| reporter.stdout(line));

        let request = Object::new();
        set(&request, "wasm", &Uint8Array::from(wasm));
        set(&request, "abi", &JsValue::from_str(abi.as_str()));
        set(
            &request,
            "canisterId",
            &JsValue::from_str(&invocation.host_canister_id.to_text()),
        );
        set(
            &request,
            "environment",
            &JsValue::from_str(&invocation.environment),
        );
        set(&request, "network", &network);
        set(&request, "dirs", &dir_inputs);
        set(&request, "files", &file_inputs);
        set(&request, "fields", &fields);
        set(&request, "canisterIds", &canister_ids);
        set(&request, "callable", &callable);
        set(&request, "mounts", &mounts);
        set(
            &request,
            "onOutput",
            on_output.as_ref().unchecked_ref::<Function>(),
        );

        let result = self.host.run_plugin(&request).await;
        drop(on_output);
        result.map_err(|message| PluginError::Host { message })
    }
}

/// Property assignment on a plain object we just created, which cannot fail.
fn set(target: &Object, key: &str, value: &JsValue) {
    let _ = Reflect::set(target, &JsValue::from_str(key), value);
}

/// A WIT `option<string>`, which the generated bindings read as the value itself
/// or `undefined`.
fn optional(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::UNDEFINED, JsValue::from_str)
}
