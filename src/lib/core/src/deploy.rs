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
//! `icp-deploy-canister` does not impose that separation — its `deploy_canister`
//! installs one canister and immediately syncs it — so the two halves are driven
//! here, from the same crate's pieces.
//!
//! The bundle is validated and hashed before any of this runs, so a failure here
//! means the network refused something. When that happens the run stops and
//! reports which canisters exist but are not finished, so nothing is silently
//! left behind.

use std::collections::BTreeMap;

use candid::Principal;
use icp_deploy_canister::{
    Canister, InstallMode,
    deploy::{apply_binding_env_vars, install_canister, run_sync_steps, start_canister},
    ids::{IdStore, InMemoryIdStore},
    network::Configuration,
    prelude::*,
    sync_exec::{NoScripts, SyncStepContext},
};

use crate::{
    bundle::{LoadedBundle, artifact_path, chain},
    events::{DeployEvent, DeployResult, DeployedCanister, Emitter, ProgressSink},
    files::BundleFiles,
    host::Host,
    plugin::JsPluginExecutor,
    settings,
};

/// Deploy every canister the bundle declares.
///
/// Never fails: an unusable bundle or a refused canister comes back in the
/// result, because by then there may already be canisters worth telling the
/// caller about.
pub async fn deploy(
    bundle: &LoadedBundle,
    host: &Host,
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

    // Which of the two id stores an implementation keeps; with one in-memory
    // store it makes no difference, but the crate's API asks for the answer.
    let is_cache = matches!(env.network.configuration, Configuration::Managed { .. });
    let ids = InMemoryIdStore::default();

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

        if let Err(e) = ids.register(is_cache, environment, name, canister_id) {
            return run.fail(emitter, name, chain(&e));
        }
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
        let canister_id = match id_of(&ids, is_cache, environment, name) {
            Ok(canister_id) => canister_id,
            Err(message) => return run.fail(emitter, name, message),
        };

        emitter.emit(DeployEvent::Progress {
            name: name.clone(),
            message: "Applying the settings the manifest declares…".to_owned(),
        });
        if let Err(message) = update_settings(host, canister_id, configured).await {
            return run.fail(
                emitter,
                name,
                format!("Could not configure canister \"{name}\" ({canister_id}): {message}"),
            );
        }
    }

    // Every id this deployment created, which is what a canister is told about
    // its neighbours and what a sync plugin resolves a call target against. It
    // is complete because the create phase is: nothing below adds a canister.
    let canister_ids = ids
        .lookup_by_environment(is_cache, environment)
        .unwrap_or_default();

    // ── Install ───────────────────────────────────────────────────────────
    // Environment variables (the canister ids included), the wasm, then a
    // start — in that order, which is the crate's. Syncing is left to the phase
    // below; a canister has to be running before its assets go up, and every
    // *other* canister has to be running before a plugin may call one.
    for (name, (canister_dir, canister)) in &env.canisters {
        let canister_id = match id_of(&ids, is_cache, environment, name) {
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
            Some(Err(e)) => return run.fail(emitter, name, chain(&e)),
            None => None,
        };

        emitter.emit(DeployEvent::Progress {
            name: name.clone(),
            message: installing(bundle, name),
        });

        let installed = install(
            host,
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
        let canister_id = match id_of(&ids, is_cache, environment, name) {
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

            let progress = ProgressSink::new(emitter.clone(), name.clone());
            let plugins = JsPluginExecutor::new(host, bundle.files.clone(), progress.clone());
            let ctx = SyncStepContext {
                canister_path: canister_dir.clone(),
                project_dir: bundle.project.dir.clone(),
                canister_id,
                canister_name: canister.name.clone(),
                environment: environment.to_owned(),
                network: env.network.name.clone(),
                canister_ids: canister_ids.clone(),
                // A proxy is something icp-cli is given on the command line;
                // a browser deployment has none.
                proxy: None,
            };

            if let Err(e) =
                run_sync_steps(canister, &ctx, &plugins, &NoScripts, Some(&progress)).await
            {
                return run.fail(
                    emitter,
                    name,
                    format!(
                        "Could not sync canister \"{name}\" ({canister_id}): {}",
                        chain(&e)
                    ),
                );
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
    let mapping = ids
        .lookup_by_environment(is_cache, environment)
        .unwrap_or_default();
    for (name, (_, canister)) in &env.canisters {
        let canister_id = match id_of(&ids, is_cache, environment, name) {
            Ok(canister_id) => canister_id,
            Err(message) => return run.handover_failed(emitter, name, message),
        };

        let handover = match settings::controllers(canister, &mapping, host.caller()) {
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

        if let Err(message) = update_settings(host, canister_id, handover).await {
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

/// The install half of the crate's `deploy_canister`, without the sync half it
/// runs straight afterwards: the environment variables the canister is given,
/// the wasm, and a start. `install_code` preserves a canister's status, and a
/// freshly created one is stopped, so the start is what leaves it able to answer
/// — both for its own sync steps and for another canister's plugin calling it.
#[allow(clippy::too_many_arguments)]
async fn install(
    host: &Host,
    files: &BundleFiles,
    name: &str,
    canister: &Canister,
    canister_id: Principal,
    artifact: &Path,
    init_args: Option<&[u8]>,
    canister_ids: &BTreeMap<String, Principal>,
) -> Result<(), String> {
    apply_binding_env_vars(canister, canister_id, canister_ids, host)
        .await
        .map_err(|e| chain(&e))?;
    install_canister(
        name,
        canister_id,
        artifact,
        InstallMode::Install,
        init_args,
        None,
        files,
        host,
    )
    .await
    .map_err(|e| chain(&e))?;
    start_canister(host, name, canister_id)
        .await
        .map_err(|e| chain(&e))
}

async fn update_settings(
    host: &Host,
    canister_id: Principal,
    settings: ic_management_canister_types::CanisterSettings,
) -> Result<(), String> {
    let arg = settings::update_settings_arg(canister_id, settings)?;
    // The management canister has no routing of its own, so the call is
    // addressed to it but routed to the canister it is about.
    host.update_call(
        Principal::management_canister(),
        "update_settings",
        arg,
        canister_id,
        0,
    )
    .await
    .map(|_| ())
}

fn id_of(
    ids: &InMemoryIdStore,
    is_cache: bool,
    environment: &str,
    name: &str,
) -> Result<Principal, String> {
    ids.lookup(is_cache, environment, name)
        .map_err(|e| chain(&e))
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
