//! Deploying a verified bundle, in the phases `icp deploy` uses.
//!
//! The phases exist for one reason: canisters have to discover each other. Every
//! canister is created first so all the ids are known, and only then is any wasm
//! installed — because installing one canister at a time would leave the first
//! one unable to learn the second one's id. Each install is immediately followed
//! by the canister's own sync steps, which need it running.
//!
//! The bundle is validated and hashed before any of this runs, so a failure here
//! means the network refused something. When that happens the run stops and
//! reports which canisters exist but are not finished, so nothing is silently
//! left behind.

use candid::Principal;
use icp_deploy_canister::{
    InstallMode,
    deploy::deploy_canister,
    ids::{IdStore, InMemoryIdStore},
    network::Configuration,
    sync_exec::NoScripts,
};

use crate::{
    bundle::{LoadedBundle, artifact_path, chain},
    events::{DeployEvent, DeployResult, DeployedCanister, Emitter, ProgressSink},
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

    // ── Install, then sync ────────────────────────────────────────────────
    for (name, (canister_dir, canister)) in &env.canisters {
        let canister_id = match id_of(&ids, is_cache, environment, name) {
            Ok(canister_id) => canister_id,
            Err(message) => return run.fail(emitter, name, message),
        };
        let artifact = match artifact_path(canister_dir, canister) {
            Ok(artifact) => artifact,
            Err(e) => return run.fail(emitter, name, e.message),
        };

        emitter.emit(DeployEvent::Progress {
            name: name.clone(),
            message: installing(bundle, name),
        });

        let progress = ProgressSink::new(emitter.clone(), name.clone());
        let plugins = JsPluginExecutor::new(host, bundle.files.clone(), progress.clone());

        // Environment variables (the canister ids included), the wasm, a start,
        // and the sync steps — in that order, which is the crate's.
        if let Err(e) = deploy_canister(
            &bundle.project,
            name,
            environment,
            &artifact,
            InstallMode::Install,
            None,
            &bundle.files,
            host,
            &ids,
            &plugins,
            &NoScripts,
            Some(&progress),
        )
        .await
        {
            return run.fail(
                emitter,
                name,
                format!(
                    "Could not deploy canister \"{name}\" ({canister_id}): {}",
                    chain(&e)
                ),
            );
        }

        run.finished.push(DeployedCanister {
            name: name.clone(),
            canister_id: canister_id.to_text(),
        });
        emitter.emit(DeployEvent::Installed {
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
