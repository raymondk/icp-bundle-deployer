//! Deploying a verified bundle, through the operation `icp deploy` runs.
//!
//! `icp_project::operations::deploy` is the whole of a deployment: create the
//! canisters the environment declares and the id store does not yet hold, wire
//! every canister's ids into the others' environment variables, apply the
//! manifest's settings, install each wasm in the mode its current status calls
//! for, then run the sync steps. All canisters per phase, so every canister
//! exists before any wasm is installed and every wasm is installed before any
//! sync plugin may call one. This module supplies what that operation runs
//! against — the seams in [`crate::seams`], the calls and plugin runtime the
//! host provides — and translates what it reports into what the page shows.
//!
//! Driving the crate's own operation rather than its individual steps is what
//! makes an upgrade the same run as an install: a canister whose id is already
//! in the store is not created, its install mode is read off its live status,
//! its settings are merged with what it has, and the deployer stays a
//! controller throughout because the settings phase adds controllers and never
//! removes one.
//!
//! The bundle is validated and hashed before any of this runs, so a failure
//! here means the network refused something. When that happens the run stops
//! and reports which canisters exist but are not finished, so nothing is
//! silently left behind.

use std::{collections::BTreeMap, convert::Infallible, sync::Arc};

use candid::Principal;
use icp_canister_interfaces::engine_canister::ENGINE_CANISTER_CID;
use icp_project::{
    Canister,
    calls::CanisterCalls,
    canister::sync::Synchronize,
    defer::Deferred,
    error::flatten,
    host::{EnvironmentSelection, Host, Ignore},
    network::NetworkUrls,
    operations::{
        deploy::{DeployParams, DeployReport, deploy as run},
        task::Task,
    },
    random::Random,
    store_id::IdMapping,
    timer::Timer,
};

use crate::{
    bundle::LoadedBundle,
    events::{Action, DeployEvent, DeployResult, DeployedCanister},
    progress::{Sink, Translator},
    seams::{Artifacts, BundleNetwork, BundleProject, BundleWasm, IdStore, PrebuiltBuild},
};

/// What each created canister is funded with, matching the default `icp deploy`
/// uses.
pub const DEFAULT_CYCLES: u128 = 2_000_000_000_000;

/// The seams only the host can supply: something that runs a sync plugin,
/// something that chooses at random, and something that waits.
pub struct Runtime {
    pub syncer: Arc<dyn Synchronize>,
    pub random: Arc<dyn Random>,
    pub timer: Arc<dyn Timer>,
}

/// What the caller decides about a run.
pub struct Options {
    /// The environment the manifest is read for — `ic` or `local` — which
    /// decides which overrides apply and what a sync plugin is told it is
    /// running against.
    pub environment: String,
    /// Put every canister on this subnet, as `icp deploy --subnet` does.
    /// Omitted, one is resolved the way the CLI resolves one: the subnet of a
    /// canister that already exists, or else one of the network's defaults.
    pub subnet: Option<Principal>,
    /// Cycles each created canister is funded with.
    pub cycles: u128,
    /// Canisters that already exist, by the name the environment files them
    /// under. Empty for an install; for an upgrade, the ids recorded under the
    /// application. A name in here is not created, and is installed in the
    /// mode its live status calls for.
    pub existing: BTreeMap<String, Existing>,
    /// Where the network is reached, as the host knows it. Asked for up front:
    /// a sync plugin is told this, and a host that cannot say should fail the
    /// run before it has created anything.
    pub network: NetworkUrls,
}

/// A canister that exists before the run, as the caller found it. Whether a
/// module is installed decides how the run reports what it does to the
/// canister; the operation itself reads the live status again.
#[derive(Clone, Copy, Debug)]
pub struct Existing {
    pub canister_id: Principal,
    pub installed: bool,
}

impl Existing {
    fn action(self) -> Action {
        if self.installed {
            Action::Upgrade
        } else {
            Action::Install
        }
    }
}

/// Deploy every canister the environment declares.
///
/// Never fails: an unusable environment or a refused canister comes back in the
/// result, because by then there may already be canisters worth telling the
/// caller about.
pub async fn deploy(
    bundle: &LoadedBundle,
    calls: Arc<dyn CanisterCalls>,
    runtime: Runtime,
    options: Options,
    sink: Sink,
) -> DeployResult {
    let environment = &options.environment;
    let Some(env) = bundle.project.environments.get(environment) else {
        return DeployResult::failed(format!(
            "This bundle has no \"{environment}\" environment, so there is nothing to deploy to."
        ));
    };
    if env.canisters.is_empty() {
        return DeployResult::failed(format!(
            "The \"{environment}\" environment of this bundle declares no canisters, so there is \
             nothing to deploy to it."
        ));
    }
    // An environment may name only some of the project's canisters, and the
    // bundle was presented as everything the project declares — so say which
    // ones this environment leaves out rather than quietly deploying fewer.
    for name in bundle.project.canisters.keys() {
        if !env.canisters.contains_key(name) {
            sink(DeployEvent::Progress {
                name: name.clone(),
                message: format!("Not part of the \"{environment}\" environment; skipped."),
            });
        }
    }

    // What the run does to the canisters that already exist, said up front and
    // in the environment's order: they are not created, so nothing else would
    // announce them before their install.
    let mut actions = BTreeMap::new();
    let mut seed = IdMapping::new();
    for name in env.canisters.keys() {
        let Some(existing) = options.existing.get(name) else {
            continue;
        };
        actions.insert(name.clone(), existing.action());
        seed.insert(name.clone(), existing.canister_id);
        sink(DeployEvent::Started {
            name: name.clone(),
            action: existing.action(),
            canister_id: Some(existing.canister_id.to_text()),
        });
    }

    // The store is where an id lands the moment a canister exists, so it is
    // what reports the canister — before anything that could still fail.
    let ids = Arc::new(IdStore::new(
        seed,
        Box::new({
            let sink = sink.clone();
            move |name, canister_id| {
                sink(DeployEvent::Created {
                    name: name.to_owned(),
                    canister_id: canister_id.to_text(),
                    action: Action::Create,
                })
            }
        }),
    ));

    let files = bundle.files.clone();
    let host = Host {
        project: Arc::new(BundleProject(bundle.project.clone())),
        files: Arc::new(files.clone()),
        ids: ids.clone(),
        artifacts: Arc::new(Artifacts::default()),
        builder: Arc::new(PrebuiltBuild(files.clone())),
        syncer: runtime.syncer,
        wasm: Arc::new(BundleWasm(files)),
        network: Arc::new(BundleNetwork {
            urls: options.network,
        }),
        random: runtime.random,
        timer: runtime.timer,
        observer: Arc::new(Ignore),
    };

    let params = DeployParams {
        environment: EnvironmentSelection::Named(environment.clone()),
        canisters: env.canisters.keys().cloned().collect(),
        // Read off each canister's live status: install when it is empty,
        // upgrade when a module is installed.
        mode: "auto".to_owned(),
        subnet: options.subnet,
        // A proxy is something icp-cli is given on the command line; a browser
        // deployment has none.
        proxy: None,
        cycles: options.cycles,
        engine_registry: Principal::from_text(ENGINE_CANISTER_CID)
            .expect("the engine registry's id is a principal"),
        no_create: false,
        // The Candid compatibility check needs the previous interface off the
        // canister and applies to an upgrade only; skipped for now.
        yes: true,
        args: None,
    };

    // The operation asks for its means of calling canisters at the first
    // phase that needs the network. Ours are made already.
    let calls = Deferred::new(move || {
        let calls = Arc::clone(&calls);
        async move { Ok::<_, Infallible>(calls) }
    });

    let wasm_sizes: BTreeMap<String, usize> = bundle
        .canisters
        .iter()
        .map(|summary| (summary.name.clone(), summary.wasm_size))
        .collect();
    let mut translator = Translator::new(sink, wasm_sizes, actions);
    let mut report = DeployReport::default();

    // The operation reports on a channel; the translator reads it as the run
    // goes, so a plugin's lines reach the page while the plugin is still
    // running rather than when the deployment is over. The channel closes
    // when the reporter is dropped, which is what ends the reading side.
    let (reporter, mut events) = icp_events::channel::<Task>();
    let outcome = {
        let (host, calls, params, report) = (&host, &calls, &params, &mut report);
        async move {
            let outcome = run(host, calls, params, &reporter, report).await;
            drop(reporter);
            outcome
        }
    };
    let translate = async {
        while let Some(event) = events.recv().await {
            translator.handle(event);
        }
    };
    let (outcome, ()) = futures::join!(outcome, translate);

    // Every canister with an id, in the environment's order.
    let ids = ids.snapshot();
    let with_id = |name: &str| {
        ids.get(name).map(|canister_id| DeployedCanister {
            name: name.to_owned(),
            canister_id: canister_id.to_text(),
        })
    };

    match outcome {
        Ok(()) => DeployResult {
            deployed: env
                .canisters
                .keys()
                .filter_map(|name| with_id(name))
                .collect(),
            incomplete: Vec::new(),
            error: None,
        },
        Err(error) => {
            // What counts as finished is what the run got through for that
            // canister: its wasm installed and running, and its sync steps run
            // if it has any. Whatever this run created and did not finish
            // exists and the caller controls it, so it is reported rather than
            // lost.
            let outcomes = translator.outcomes();
            let finished = |name: &str, canister: &Canister| {
                outcomes.installed.contains(name)
                    && (canister.sync.steps.is_empty() || outcomes.synced.contains(name))
            };
            let deployed: Vec<DeployedCanister> = env
                .canisters
                .iter()
                .filter(|(name, (_, canister))| finished(name, canister))
                .filter_map(|(name, _)| with_id(name))
                .collect();
            let incomplete = report
                .created
                .iter()
                .filter(|(name, _)| !deployed.iter().any(|done| done.name == *name))
                .map(|(name, canister_id)| DeployedCanister {
                    name: name.clone(),
                    canister_id: canister_id.to_text(),
                })
                .collect();
            DeployResult {
                deployed,
                incomplete,
                error: Some(flatten(&error)),
            }
        }
    }
}
