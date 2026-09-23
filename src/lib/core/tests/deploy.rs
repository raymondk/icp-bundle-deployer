//! Driving the deploy operation against a network that answers as one would.
//!
//! What a deployment does to the network is `icp-project`'s business and is
//! tested there. What is tested here is the seam this crate adds around it: a
//! canister whose id is already in the store is not created and is installed
//! in the mode its live status calls for, and the run reports what it did in
//! this crate's own vocabulary. That is the hook an upgrade builds on — seed
//! the store from an application's record, and the rest is the same run.

#[allow(dead_code)]
mod support;

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use candid::{Decode, Encode, Nat, Principal};
use futures::executor::block_on;
use ic_management_canister_types::{
    CanisterInstallMode, CanisterStatusResult, CanisterStatusType, DefiniteCanisterSettings,
    InstallCodeArgs, MemoryMetrics, QueryStats,
};
use icp_bundle_deployer_core::{
    bundle::load_bundle,
    deploy::{DEFAULT_CYCLES, Options, Runtime, deploy},
    events::{DeployEvent, DeployResult},
};
use icp_project::{
    calls::{Authority, Call, CallError, CanisterCalls},
    canister::sync::UnimplementedMockSyncer,
    network::NetworkUrls,
    random::FirstChoice,
    store_id::IdMapping,
    timer::Immediate,
};
use indoc::formatdoc;
use snafu::Snafu;
use support::{file, tar};

const WASM: &[u8] = &[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/// The id an earlier run is supposed to have recorded for `app`.
fn existing_id() -> Principal {
    Principal::from_text("rrkah-fqaaa-aaaaa-aaaaq-cai").unwrap()
}

/// A management-canister method this double was not written to answer.
#[derive(Debug, Snafu)]
#[snafu(display("the test network does not answer '{method}'"))]
struct Unanswered {
    method: String,
}

/// A network with one canister on it, in the state the test puts it in. It
/// records every management-canister call it is asked to make, and refuses to
/// create anything: the point of the test is that it is never asked to.
struct Network {
    /// What `canister_status` reports as installed.
    module_hash: Option<Vec<u8>>,
    /// Every `(method, argument)` the deployment sent, in order.
    calls: Mutex<Vec<(String, Vec<u8>)>>,
}

impl Network {
    fn new(module_hash: Option<Vec<u8>>) -> Arc<Self> {
        Arc::new(Self {
            module_hash,
            calls: Mutex::new(Vec::new()),
        })
    }

    fn methods(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|(method, _)| method.clone())
            .collect()
    }

    fn install_mode(&self) -> CanisterInstallMode {
        let calls = self.calls.lock().unwrap();
        let (_, arg) = calls
            .iter()
            .find(|(method, _)| method == "install_code")
            .expect("the deployment should have installed the canister");
        Decode!(arg, InstallCodeArgs).unwrap().mode
    }

    fn status(&self) -> CanisterStatusResult {
        CanisterStatusResult {
            status: CanisterStatusType::Running,
            ready_for_migration: false,
            version: 1,
            settings: DefiniteCanisterSettings {
                controllers: vec![Principal::anonymous()],
                ..DefiniteCanisterSettings::default()
            },
            module_hash: self.module_hash.clone(),
            memory_size: Nat::from(0u8),
            memory_metrics: MemoryMetrics {
                wasm_memory_size: Nat::from(0u8),
                stable_memory_size: Nat::from(0u8),
                global_memory_size: Nat::from(0u8),
                wasm_binary_size: Nat::from(0u8),
                custom_sections_size: Nat::from(0u8),
                canister_history_size: Nat::from(0u8),
                wasm_chunk_store_size: Nat::from(0u8),
                snapshots_size: Nat::from(0u8),
                log_memory_store_size: Nat::from(0u8),
            },
            cycles: Nat::from(0u8),
            reserved_cycles: Nat::from(0u8),
            idle_cycles_burned_per_day: Nat::from(0u8),
            query_stats: QueryStats {
                num_calls_total: Nat::from(0u8),
                num_instructions_total: Nat::from(0u8),
                request_payload_bytes_total: Nat::from(0u8),
                response_payload_bytes_total: Nat::from(0u8),
            },
        }
    }
}

#[async_trait]
impl CanisterCalls for Network {
    fn caller(&self) -> Principal {
        Principal::anonymous()
    }

    async fn update(&self, call: Call) -> Result<Vec<u8>, CallError> {
        self.calls
            .lock()
            .unwrap()
            .push((call.method.clone(), call.arg.clone()));
        match call.method.as_str() {
            "canister_status" => Ok(Encode!(&self.status()).unwrap()),
            "update_settings" | "install_code" | "start_canister" | "stop_canister" => {
                Ok(Encode!().unwrap())
            }
            method => Err(CallError::failed(
                call.canister,
                method,
                Unanswered {
                    method: method.to_owned(),
                },
            )),
        }
    }

    async fn query(&self, call: Call) -> Result<Vec<u8>, CallError> {
        self.update(call).await
    }

    /// No canister here declares a metadata section, which is also what tells
    /// the install that this is not a Motoko canister with orthogonal
    /// persistence to preserve.
    async fn metadata_section(
        &self,
        _canister: Principal,
        _path: &str,
        _authority: Authority,
    ) -> Result<Option<Vec<u8>>, CallError> {
        Ok(None)
    }

    async fn controllers(&self, canister: Principal) -> Result<Option<Vec<Principal>>, CallError> {
        Err(CallError::failed(
            canister,
            "controllers",
            Unanswered {
                method: "controllers".to_owned(),
            },
        ))
    }

    async fn module_hash(&self, canister: Principal) -> Result<Option<Vec<u8>>, CallError> {
        Err(CallError::failed(
            canister,
            "module_hash",
            Unanswered {
                method: "module_hash".to_owned(),
            },
        ))
    }

    async fn subnet_of(&self, canister: Principal) -> Result<Principal, CallError> {
        Err(CallError::failed(
            canister,
            "subnet_of",
            Unanswered {
                method: "subnet_of".to_owned(),
            },
        ))
    }

    async fn subnet_uses_engine_operator(&self, _subnet: Principal) -> Result<bool, CallError> {
        Ok(false)
    }
}

/// A bundle with one canister, `app`, and nothing to sync.
fn bundle() -> Vec<u8> {
    let manifest = formatdoc! {"
        canisters:
        - name: app
          build:
            steps:
            - type: pre-built
              path: canisters/app.wasm
              sha256: {}
    ", icp_bundle_deployer_core::bundle::sha256_hex(WASM)};
    tar(vec![
        file("icp.yaml", manifest),
        file("canisters/app.wasm", WASM),
    ])
}

/// Deploys the bundle to `network` with `app` already in the id store, and
/// returns the result with every event the run reported.
fn deploy_existing(network: Arc<Network>) -> (DeployResult, Vec<DeployEvent>) {
    let bundle = block_on(load_bundle(&bundle())).expect("the bundle is well-formed");
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::new({
        let events = Arc::clone(&events);
        move |event| events.lock().unwrap().push(event)
    });
    let calls: Arc<dyn CanisterCalls> = network;
    let result = block_on(deploy(
        &bundle,
        calls,
        Runtime {
            syncer: Arc::new(UnimplementedMockSyncer),
            random: Arc::new(FirstChoice),
            timer: Arc::new(Immediate),
        },
        Options {
            environment: "local".to_owned(),
            subnet: None,
            cycles: DEFAULT_CYCLES,
            existing: IdMapping::from([("app".to_owned(), existing_id())]),
            network: NetworkUrls {
                api_url: "http://127.0.0.1:8000/".parse().unwrap(),
                http_gateway_url: None,
            },
        },
        sink,
    ));
    let events = events.lock().unwrap().clone();
    (result, events)
}

/// A name already in the id store is not created — the network is never asked
/// to — and with a module installed its status calls for an upgrade.
#[test]
fn a_canister_in_the_id_store_is_upgraded_rather_than_created() {
    let network = Network::new(Some(vec![0xab; 32]));
    let (result, events) = deploy_existing(Arc::clone(&network));

    assert_eq!(result.error, None, "{result:?}");
    assert_eq!(
        result
            .deployed
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["app"]
    );
    assert_eq!(result.deployed[0].canister_id, existing_id().to_text());
    assert!(result.incomplete.is_empty());

    let methods = network.methods();
    assert!(
        !methods.iter().any(|m| m == "create_canister"),
        "nothing should have been created, but the network saw {methods:?}"
    );
    assert!(
        matches!(network.install_mode(), CanisterInstallMode::Upgrade(_)),
        "a canister with a module installed is upgraded"
    );

    // No `started`/`created` for a canister that already existed; the run
    // reports the canister once it is installed, under the id it already had.
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, DeployEvent::Started { .. } | DeployEvent::Created { .. })),
        "{events:?}"
    );
    assert!(
        events.contains(&DeployEvent::Installed {
            name: "app".to_owned(),
            canister_id: existing_id().to_text(),
        }),
        "{events:?}"
    );
    assert!(
        events.contains(&DeployEvent::Phase {
            message: "All canisters already exist".to_owned()
        }),
        "{events:?}"
    );
}

/// A name in the store whose canister is empty — created by a run that failed
/// before installing anything — is installed rather than upgraded, and still
/// not created again.
#[test]
fn an_empty_canister_in_the_id_store_is_installed() {
    let network = Network::new(None);
    let (result, _) = deploy_existing(Arc::clone(&network));

    assert_eq!(result.error, None, "{result:?}");
    assert!(!network.methods().iter().any(|m| m == "create_canister"));
    assert!(matches!(
        network.install_mode(),
        CanisterInstallMode::Install
    ));
}
