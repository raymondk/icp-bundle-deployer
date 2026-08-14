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
    bundle::sha256_hex,
    events::ProgressSink,
    files::{BundleFiles, normalize},
    host::Host,
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
        // The sandbox is rooted at the canister's own directory, so every path
        // the plugin resolves is relative to it, exactly as under icp-cli.
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

        let tree = Map::new();
        for dir in &invocation.dirs {
            for (entry, contents) in self.files.under(&normalize(&base.join(dir))) {
                let relative = entry.strip_prefix(&base).unwrap_or(entry);
                tree.set(
                    &JsValue::from_str(relative.as_str()),
                    &Uint8Array::from(contents),
                );
            }
        }

        let files = Array::new();
        for name in &invocation.files {
            let path = normalize(&base.join(name));
            let contents = self
                .files
                .get(&path)
                .ok_or_else(|| PluginError::MissingFile { path: path.clone() })?;
            let content = str::from_utf8(contents)
                .map_err(|_| PluginError::NotText { path: path.clone() })?;

            let file = Object::new();
            set(&file, "name", &JsValue::from_str(name));
            set(&file, "content", &JsValue::from_str(content));
            files.push(&file);
        }

        // Kept alive across the call, and dropped with it: the host must not
        // hold on to the callback past the run.
        let sink = self.progress.clone();
        let on_output = Closure::<dyn Fn(String)>::new(move |line: String| sink.line(line));

        let request = Object::new();
        set(&request, "wasm", &Uint8Array::from(wasm));
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
        set(
            &request,
            "dirs",
            &invocation
                .dirs
                .iter()
                .map(|dir| JsValue::from_str(dir))
                .collect::<Array>(),
        );
        set(&request, "files", &files);
        set(&request, "tree", &tree);
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
