//! Running a bundle's sync plugin.
//!
//! A sync plugin is a `wasm32-wasip2` component, which this module cannot run
//! and does not try to: `icp-deploy-canister` resolves the step into a
//! [`PluginInvocation`] — which wasm, which directories, which canister — and
//! the host runs it through jco. What is done here is the resolution the CLI's
//! host also does: find the wasm, check it against its digest, and lay out the
//! files the plugin is allowed to see.
//!
//! The plugin is the same wasm `icp sync` runs, so what lands on the canister —
//! compression, clean URLs, redirect rules, the resulting state hash — matches a
//! CLI deployment rather than approximating it.

use async_trait::async_trait;
use icp_deploy_canister::{
    manifest::prebuilt::SourceField,
    prelude::*,
    sync_exec::{PluginExecutor, PluginExecutorError, PluginInvocation, StepProgress},
};
use js_sys::{Array, Function, Map, Object, Reflect, Uint8Array};
use snafu::Snafu;
use wasm_bindgen::prelude::*;

use crate::{
    abi::plugin_abi,
    bundle::sha256_hex,
    events::ProgressSink,
    files::{BundleFiles, normalize},
    host::Host,
    sandbox::{covering_dirs, resolve},
};

#[derive(Debug, Snafu)]
pub enum PluginError {
    #[snafu(display(
        "the plugin is referenced by URL, and a bundle must carry every plugin it runs"
    ))]
    Remote,

    #[snafu(display("the plugin wasm '{path}' is not in the bundle"))]
    Missing { path: PathBuf },

    #[snafu(display(
        "the plugin wasm '{path}' does not match its declared digest\n  expected {expected}\n  \
         actual   {actual}"
    ))]
    Digest {
        path: PathBuf,
        expected: String,
        actual: String,
    },

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

/// Runs sync plugins through the host's jco adapter.
pub struct JsPluginExecutor<'a> {
    host: &'a Host,
    files: BundleFiles,
    progress: ProgressSink,
}

impl<'a> JsPluginExecutor<'a> {
    pub fn new(host: &'a Host, files: BundleFiles, progress: ProgressSink) -> Self {
        Self {
            host,
            files,
            progress,
        }
    }
}

#[cfg_attr(target_family = "wasm", async_trait(?Send))]
#[cfg_attr(not(target_family = "wasm"), async_trait)]
impl PluginExecutor for JsPluginExecutor<'_> {
    async fn run_plugin(
        &self,
        invocation: PluginInvocation,
        _progress: Option<&dyn StepProgress>,
    ) -> Result<Vec<String>, PluginExecutorError> {
        self.run(invocation)
            .await
            .map_err(|source| PluginExecutorError {
                source: Box::new(source),
            })?;
        // Output is streamed as it is printed rather than retained, so there is
        // nothing left to hand back.
        Ok(Vec::new())
    }
}

impl JsPluginExecutor<'_> {
    async fn run(&self, invocation: PluginInvocation) -> Result<(), PluginError> {
        // Declared paths are written relative to the canister's own directory
        // and resolved inside the project. A bundle's project directory is the
        // archive root — `invocation.project_dir` is always it — so confining to
        // the root, which is all `resolve` can do, is the rule icp-cli applies.
        let base = normalize(&invocation.base_dir);

        let SourceField::Local(source) = &invocation.source else {
            return Err(PluginError::Remote);
        };
        let path = normalize(&base.join(&source.path));
        let wasm = self
            .files
            .get(&path)
            .ok_or_else(|| PluginError::Missing { path: path.clone() })?;

        if let Some(expected) = &invocation.sha256 {
            let actual = sha256_hex(wasm);
            if !expected.eq_ignore_ascii_case(&actual) {
                return Err(PluginError::Digest {
                    path,
                    expected: expected.clone(),
                    actual,
                });
            }
        }

        // Which interface the plugin speaks decides the shape of everything
        // below it, so it is settled before any of that is assembled. The bundle
        // was refused at load time for one this deployer cannot drive.
        let abi = plugin_abi(wasm).map_err(|source| PluginError::Abi { source })?;

        // The plugin is told about every declared directory, key and all, but
        // only the trees not already covered by another entry are mounted:
        // naming a directory twice, or naming one inside another's, conveys no
        // further access. Each mount is placed at the spelling the manifest
        // wrote, which is the path the plugin will open it at.
        let dirs = Array::new();
        for entry in &invocation.dirs {
            let dir = Object::new();
            set(&dir, "key", &optional(entry.key.as_deref()));
            set(&dir, "path", &JsValue::from_str(&entry.path));
            dirs.push(&dir);
        }

        let mounts = Map::new();
        let declared = invocation.dirs.iter().map(|entry| entry.path.as_str());
        for dir in covering_dirs(declared) {
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
        let files = Array::new();
        for entry in &invocation.files {
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
            files.push(&file);
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
        for (name, canister_id) in &invocation.callable {
            callable.set(
                &JsValue::from_str(name),
                &JsValue::from_str(&canister_id.to_text()),
            );
        }

        // Kept alive across the call, and dropped with it: the host must not
        // hold on to the callback past the run.
        let sink = self.progress.clone();
        let on_output = Closure::<dyn Fn(String)>::new(move |line: String| sink.line(line));

        let request = Object::new();
        set(&request, "wasm", &Uint8Array::from(wasm));
        set(&request, "abi", &JsValue::from_str(abi.as_str()));
        set(
            &request,
            "canisterId",
            &JsValue::from_str(&invocation.canister_id.to_text()),
        );
        set(
            &request,
            "environment",
            &JsValue::from_str(&invocation.environment),
        );
        set(&request, "dirs", &dirs);
        set(&request, "files", &files);
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
