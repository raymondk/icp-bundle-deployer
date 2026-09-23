//! Deploying a verified bundle, in phases.
//!
//! The phases exist for one reason: canisters have to discover each other. Every
//! canister is created first so all the ids are known, and only then is any wasm
//! installed — because installing one canister at a time would leave the first
//! one unable to learn the second one's id. Syncing is a third phase for the
//! same reason one step further on: a sync plugin may call any canister its step
//! lists, so no sync may run until every canister it could reach is installed
//! and running. Interleaving the two would have the first canister's plugin
//! calling one that is still empty.
//!
//! `icp-project`'s own `deploy` runs these same phases in this same order. The
//! phases are nonetheless driven here, out of the crate's individual
//! operations — the same environment variables, the same install, the same
//! syncer — for a historical reason: this module was written against a branch
//! whose `deploy` installed and synced each canister together and was shaped
//! around a project on disk, and the orchestration was kept when the crate
//! moved to `main`. Its `deploy` also takes a `Host` struct with seams this
//! module does not yet supply (an id store, an artifact store, a builder).
//! Replacing this module with an adapter over `operations::deploy` is tracked
//! in <https://github.com/raymondk/icp-bundle-deployer/issues/7>.
//!
//! The bundle is validated and hashed before any of this runs, so a failure here
//! means the network refused something. When that happens the run stops and
//! reports which canisters exist but are not finished, so nothing is silently
//! left behind.

use std::sync::Arc;

use async_trait::async_trait;
use candid::Principal;
use ic_management_canister_types::{
    CanisterIdRecord, CanisterInstallMode, CanisterSettings, CanisterStatusType, UpdateSettingsArgs,
};
use icp_events::StepReporter;
use icp_project::{
    Canister, Environment,
    calls::CanisterCalls,
    canister::sync::{
        Params, Syncer, Synchronize,
        script::{ScriptInvocation, ScriptRunError, ScriptRunner},
    },
    error::flatten,
    network::{Configuration, NetworkUrls},
    operations::{
        binding_env_vars::set_env_vars_for_canister, install::install_canister, proxy_management,
    },
    prelude::*,
    store_id::IdMapping,
};
use snafu::Snafu;

use crate::{
    bundle::{LoadedBundle, artifact_path},
    events::{DeployEvent, DeployResult, DeployedCanister, Emitter, ProgressSink},
    files::BundleFiles,
    host::Host,
    plugin::{BundleWasm, JsPluginRunner},
    settings,
};

/// Deploy every canister the bundle declares.
///
/// Never fails: an unusable bundle or a refused canister comes back in the
/// result, because by then there may already be canisters worth telling the
/// caller about.
pub async fn deploy(
    bundle: &LoadedBundle,
    host: &Arc<Host>,
    environment: &str,
    emitter: &Emitter,
) -> DeployResult {
    let mut run = Run::default();

    let Some(env) = bundle.project.environments.get(environment) else {
        return run.failed(format!(
            "This bundle has no \"{environment}\" environment, so there is nothing to deploy to."
        ));
    };
    if env.canisters.is_empty() {
        return run.failed(format!(
            "The \"{environment}\" environment of this bundle declares no canisters, so there is \
             nothing to deploy to it."
        ));
    }
    // An environment may name only some of the project's canisters, and the
    // bundle was presented as everything the project declares — so say which
    // ones this environment leaves out rather than quietly deploying fewer.
    for name in bundle.project.canisters.keys() {
        if !env.canisters.contains_key(name) {
            emitter.emit(DeployEvent::Progress {
                name: name.clone(),
                message: format!("Not part of the \"{environment}\" environment; skipped."),
            });
        }
    }

    // Asked for up front: a sync plugin is told where the network is, and a
    // host that cannot say so should fail the run before it has created
    // anything.
    let urls = match network_urls(host, env) {
        Ok(urls) => urls,
        Err(message) => return run.failed(message),
    };

    let calls: Arc<dyn CanisterCalls> = host.clone();

    // Every id this deployment creates, under the key the environment files the
    // canister by. This is what a canister is told about its neighbours and
    // what a sync plugin resolves a call target against; icp-cli keeps the same
    // table in a store on disk.
    let mut canister_ids = IdMapping::new();

    // ── Create ────────────────────────────────────────────────────────────
    // Placement — the subnet, and whether a cloud engine's operator creates
    // instead of the cycles ledger — belongs to the host; all that is needed
    // here is that every canister exists before any wasm is installed.
    for (name, _) in &env.canisters {
        emitter.emit(DeployEvent::Started { name: name.clone() });

        let canister_id = match host.create_canister().await {
            Ok(canister_id) => canister_id,
            Err(message) => {
                return run.fail(
                    emitter,
                    name,
                    format!("Could not create canister \"{name}\": {message}"),
                );
            }
        };

        canister_ids.insert(name.clone(), canister_id);
        run.created.push(DeployedCanister {
            name: name.clone(),
            canister_id: canister_id.to_text(),
        });
        emitter.emit(DeployEvent::Created {
            name: name.clone(),
            canister_id: canister_id.to_text(),
        });
    }

    // ── Settings ──────────────────────────────────────────────────────────
    // Controllers are deliberately not part of this: handing over control now
    // would lock us out of a canister we are still setting up. Environment
    // variables are not either — the install phase writes them together with the
    // canister ids.
    for (name, (_, canister)) in &env.canisters {
        let Some(configured) = settings::configuration(canister) else {
            continue;
        };
        let canister_id = match id_of(&canister_ids, name) {
            Ok(canister_id) => canister_id,
            Err(message) => return run.fail(emitter, name, message),
        };

        emitter.emit(DeployEvent::Progress {
            name: name.clone(),
            message: "Applying the settings the manifest declares…".to_owned(),
        });
        if let Err(message) = update_settings(calls.as_ref(), canister_id, configured).await {
            return run.fail(
                emitter,
                name,
                format!("Could not configure canister \"{name}\" ({canister_id}): {message}"),
            );
        }
    }

    // ── Install ───────────────────────────────────────────────────────────
    // Environment variables (the canister ids included), the wasm, then a
    // start — in that order, which is the crate's. Syncing is left to the phase
    // below; a canister has to be running before its assets go up, and every
    // *other* canister has to be running before a plugin may call one.
    for (name, (canister_dir, canister)) in &env.canisters {
        let canister_id = match id_of(&canister_ids, name) {
            Ok(canister_id) => canister_id,
            Err(message) => return run.fail(emitter, name, message),
        };
        let artifact = match artifact_path(canister_dir, canister) {
            Ok(artifact) => artifact,
            Err(e) => return run.fail(emitter, name, e.message),
        };
        let init_args = match canister.init_args.as_ref().map(|args| args.to_bytes()) {
            Some(Ok(args)) => Some(args),
            // The bundle was refused at load time for init args that cannot be
            // encoded, so this is unreachable rather than a user's mistake.
            Some(Err(e)) => return run.fail(emitter, name, flatten(&e)),
            None => None,
        };

        emitter.emit(DeployEvent::Progress {
            name: name.clone(),
            message: installing(bundle, name),
        });

        let installed = install(
            calls.as_ref(),
            &bundle.files,
            name,
            canister,
            canister_id,
            &artifact,
            init_args.as_deref(),
            &canister_ids,
        )
        .await;
        if let Err(message) = installed {
            return run.fail(
                emitter,
                name,
                format!("Could not install canister \"{name}\" ({canister_id}): {message}"),
            );
        }

        emitter.emit(DeployEvent::Installed {
            name: name.clone(),
            canister_id: canister_id.to_text(),
        });
    }

    // ── Sync ──────────────────────────────────────────────────────────────
    // Only now, with every canister installed and running, may a plugin run:
    // one that calls a canister the step listed would otherwise reach a
    // canister with no module in it.
    for (name, (canister_dir, canister)) in &env.canisters {
        let canister_id = match id_of(&canister_ids, name) {
            Ok(canister_id) => canister_id,
            Err(message) => return run.fail(emitter, name, message),
        };

        if !canister.sync.steps.is_empty() {
            // Syncing no longer follows this canister's own install line, so say
            // it is starting — otherwise a plugin's output is the first sign,
            // arriving under a canister the log last reported as installed.
            emitter.emit(DeployEvent::Progress {
                name: name.clone(),
                message: "Running the sync steps the manifest declares…".to_owned(),
            });

            // The crate's own syncer, with the browser behind each of its seams:
            // no scripts, wasms out of the bundle, plugins through jco. Built per
            // canister so the plugin's output lands under the right name.
            let progress = ProgressSink::new(emitter.clone(), name.clone());
            let syncer = Syncer::new(
                Arc::new(NoScripts),
                Arc::new(BundleWasm(bundle.files.clone())),
                Arc::new(JsPluginRunner::new(
                    Arc::clone(host),
                    bundle.files.clone(),
                    progress,
                )),
            );
            let params = Params {
                path: canister_dir.clone(),
                project_dir: bundle.project.dir.clone(),
                cid: canister_id,
                name: canister.name.clone(),
                environment: environment.to_owned(),
                network: env.network.name.clone(),
                urls: urls.clone(),
                canister_ids: canister_ids.clone(),
                // A proxy is something icp-cli is given on the command line;
                // a browser deployment has none.
                proxy: None,
            };

            for step in &canister.sync.steps {
                // A plugin's output is streamed to the emitter as it prints, so
                // the reporter — which would carry the same lines — is left
                // unconnected, and the lines a step hands back were seen already.
                let synced = syncer
                    .sync(step, &params, &calls, &StepReporter::null())
                    .await;
                if let Err(e) = synced {
                    return run.fail(
                        emitter,
                        name,
                        format!(
                            "Could not sync canister \"{name}\" ({canister_id}): {}",
                            flatten(&e)
                        ),
                    );
                }
            }
        }

        run.finished.push(DeployedCanister {
            name: name.clone(),
            canister_id: canister_id.to_text(),
        });
    }

    // ── Hand over control, if the bundle asked for it ─────────────────────
    // The deployer stays a controller alongside whoever the manifest names: a
    // list sent verbatim would replace it, not extend it.
    for (name, (_, canister)) in &env.canisters {
        let canister_id = match id_of(&canister_ids, name) {
            Ok(canister_id) => canister_id,
            Err(message) => return run.handover_failed(emitter, name, message),
        };

        let handover = match settings::controllers(canister, &canister_ids, host.caller()) {
            Ok(None) => continue,
            Ok(Some(handover)) => handover,
            Err(message) => {
                return run.handover_failed(
                    emitter,
                    name,
                    format!(
                        "Deployed canister \"{name}\" ({canister_id}) but {message}, so its \
                         controllers were left unchanged."
                    ),
                );
            }
        };

        if let Err(message) = update_settings(calls.as_ref(), canister_id, handover).await {
            return run.handover_failed(
                emitter,
                name,
                format!(
                    "Deployed canister \"{name}\" ({canister_id}) but could not set its \
                     controllers: {message}"
                ),
            );
        }
    }

    run.done()
}

/// Canisters created so far, and which of them are finished.
#[derive(Default)]
struct Run {
    created: Vec<DeployedCanister>,
    finished: Vec<DeployedCanister>,
}

impl Run {
    fn done(self) -> DeployResult {
        DeployResult {
            deployed: self.finished,
            incomplete: Vec::new(),
            error: None,
        }
    }

    /// A failure part-way through: whatever was created but not finished is
    /// reported, since those canisters exist and the caller controls them.
    fn failed(&mut self, error: String) -> DeployResult {
        let incomplete = self
            .created
            .iter()
            .filter(|c| !self.finished.iter().any(|done| done.name == c.name))
            .map(|c| DeployedCanister {
                name: c.name.clone(),
                canister_id: c.canister_id.clone(),
            })
            .collect();

        DeployResult {
            deployed: std::mem::take(&mut self.finished),
            incomplete,
            error: Some(error),
        }
    }

    fn fail(&mut self, emitter: &Emitter, name: &str, message: String) -> DeployResult {
        emitter.emit(DeployEvent::Failed {
            name: name.to_owned(),
            message: message.clone(),
        });
        self.failed(message)
    }

    /// Every canister is deployed; only the handover failed. Nothing is
    /// incomplete — the canisters work, they are just still ours.
    fn handover_failed(&mut self, emitter: &Emitter, name: &str, message: String) -> DeployResult {
        emitter.emit(DeployEvent::Failed {
            name: name.to_owned(),
            message: message.clone(),
        });
        DeployResult {
            deployed: std::mem::take(&mut self.finished),
            incomplete: Vec::new(),
            error: Some(message),
        }
    }
}

/// The install half of the crate's deploy, without the sync it runs afterwards:
/// the environment variables the canister is given, the wasm, and a start.
/// `install_code` preserves a canister's status, so the start is what makes
/// sure it can answer — both for its own sync steps and for another canister's
/// plugin calling it. It is idempotent, so a canister already running loses
/// nothing to it; icp-cli starts every canister it is about to sync for the
/// same reason.
#[allow(clippy::too_many_arguments)]
async fn install(
    calls: &dyn CanisterCalls,
    files: &BundleFiles,
    name: &str,
    canister: &Canister,
    canister_id: Principal,
    artifact: &Path,
    init_args: Option<&[u8]>,
    canister_ids: &IdMapping,
) -> Result<(), String> {
    // Each canister is told the ids it is wired to — its own project's
    // canisters under their local names, its dependencies under their aliases —
    // resolved against the ids this run created. The same wiring `icp deploy`
    // writes, from the same table.
    let bindings: Vec<(String, String)> = canister
        .bindings
        .iter()
        .filter_map(|(variable, key)| {
            canister_ids
                .get(key)
                .map(|id| (format!("PUBLIC_CANISTER_ID:{variable}"), id.to_text()))
        })
        .collect();
    set_env_vars_for_canister(calls, &canister_id, canister, &bindings)
        .await
        .map_err(|e| flatten(&e))?;

    // The bundle was checked at load time, so the module is there.
    let wasm = files
        .get(artifact)
        .ok_or_else(|| format!("the module '{artifact}' is not in the bundle"))?;
    install_canister(
        calls,
        &canister_id,
        name,
        wasm,
        CanisterInstallMode::Install,
        // Only an upgrade or a reinstall looks at the status, to stop a running
        // canister first; a fresh install leaves the canister as it found it.
        CanisterStatusType::Running,
        init_args,
        None,
    )
    .await
    .map_err(|e| flatten(&e))?;

    proxy_management::start_canister(calls, CanisterIdRecord { canister_id })
        .await
        .map_err(|e| flatten(&e))
}

async fn update_settings(
    calls: &dyn CanisterCalls,
    canister_id: Principal,
    settings: CanisterSettings,
) -> Result<(), String> {
    proxy_management::update_settings(
        calls,
        UpdateSettingsArgs {
            canister_id,
            settings,
            sender_canister_version: None,
        },
    )
    .await
    .map_err(|e| flatten(&e))
}

/// Where the network is reached, as a sync plugin is told it. The API endpoint
/// is the host's — that is where every call actually goes. The gateway is
/// whatever the host knows, or failing that what the manifest declares for the
/// environment's network: a connected network names its gateway, while a
/// managed one is described by how to launch it, which says nothing about where
/// a running one is.
fn network_urls(host: &Host, env: &Environment) -> Result<NetworkUrls, String> {
    let mut urls = host.network()?;
    if urls.http_gateway_url.is_none()
        && let Configuration::Connected { connected } = &env.network.configuration
    {
        urls.http_gateway_url = connected.http_gateway_url.clone();
    }
    Ok(urls)
}

fn id_of(canister_ids: &IdMapping, name: &str) -> Result<Principal, String> {
    canister_ids
        .get(name)
        .copied()
        .ok_or_else(|| format!("no canister was created for \"{name}\""))
}

/// What is about to be installed, and how. A wasm over the ingress limit goes up
/// through the chunk store, which is worth saying because it takes noticeably
/// longer.
fn installing(bundle: &LoadedBundle, name: &str) -> String {
    const CHUNK_THRESHOLD: usize = 2 * 1024 * 1024;

    let Some(summary) = bundle.canisters.iter().find(|c| c.name == name) else {
        return "Installing…".to_owned();
    };
    let size = crate::format_bytes(summary.wasm_size);
    if summary.wasm_size > CHUNK_THRESHOLD {
        format!("Installing {size} through the chunk store…")
    } else {
        format!("Installing {size}…")
    }
}

/// The script runner for a host with no shell. A bundle with a script step is
/// refused at load time, so this is never reached; the syncer takes one all the
/// same.
struct NoScripts;

#[derive(Debug, Snafu)]
#[snafu(display("a browser cannot run a script step"))]
struct NoScriptsError;

#[async_trait]
impl ScriptRunner for NoScripts {
    async fn run_script(
        &self,
        _invocation: ScriptInvocation,
        _reporter: &StepReporter,
    ) -> Result<Vec<String>, ScriptRunError> {
        Err(ScriptRunError {
            source: Box::new(NoScriptsError),
        })
    }
}
