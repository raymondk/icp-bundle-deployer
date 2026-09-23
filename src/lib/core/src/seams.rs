//! What the deploy operation runs against, supplied for a bundle.
//!
//! `icp_project::operations::deploy` takes a [`Host`](icp_project::host::Host)
//! of seams — where the project comes from, where ids and build artifacts are
//! kept, how a canister is built and synced — because icp-cli keeps all of that
//! on disk and a caller elsewhere keeps it elsewhere. For a bundle every one of
//! them is a few lines: the project is the one the bundle was loaded as, the
//! stores are maps that live as long as the run, a build is a copy of the module
//! the archive already carries. The seams that need JavaScript — canister calls,
//! the plugin runtime, randomness, the clock — are in [`crate::host`],
//! [`crate::plugin`] and [`crate::runtime`]; these need nothing but the bundle,
//! and are tested natively.

use std::{
    collections::BTreeMap,
    sync::{Mutex, PoisonError},
};

use async_trait::async_trait;
use candid::Principal;
use icp_events::StepReporter;
use icp_project::{
    Network, Project, ProjectLoad, ProjectLoadError,
    canister::{
        build::{Build, BuildError, Params as BuildParams},
        sync::script::{ScriptInvocation, ScriptRunError, ScriptRunner},
        wasm::{Fetch, FetchError},
    },
    files::FileSystem,
    manifest::{BuildStep, prebuilt::SourceField},
    network::{
        self, AccessError, CollectFriendlyDomains, Configuration, NetworkAccess, NetworkUrls,
    },
    prelude::*,
    store_artifact::{self, LookupArtifactError, SaveError},
    store_id::{self, CleanupError, IdMapping, LookupIdError, RegisterError, UnregisterError},
};
use snafu::Snafu;

use crate::{
    bundle::sha256_hex,
    files::{BundleFiles, normalize},
};

// ── The project ───────────────────────────────────────────────────────────

/// The project the bundle was loaded as. Loading is what `load_bundle` already
/// did — read the manifest, consolidate it, check every artifact — so there is
/// nothing left to do but hand it over.
pub struct BundleProject(pub Project);

#[async_trait]
impl ProjectLoad for BundleProject {
    async fn load(&self) -> Result<Project, ProjectLoadError> {
        Ok(self.0.clone())
    }

    async fn exists(&self) -> Result<bool, ProjectLoadError> {
        Ok(true)
    }
}

// ── Canister ids ──────────────────────────────────────────────────────────

/// Told each time an id is recorded, with the canister's name and its id.
pub type OnRegister = Box<dyn Fn(&str, Principal) + Send + Sync>;

/// The canister ids of this deployment, in memory.
///
/// icp-cli keeps one of these per environment on disk, which is how a second
/// `icp deploy` finds the canisters the first one created and upgrades them
/// instead of creating more. Here the store lives as long as the run: empty
/// for an install, or seeded with the ids recorded under an application for an
/// upgrade — and everything downstream, from which canisters are created to
/// which install mode each gets, follows from what is in it.
///
/// Registering an id is also where the deployment learns a canister exists,
/// so the store is what reports it: the deploy operation records an id the
/// moment creation returns, before anything that could still fail.
pub struct IdStore {
    ids: Mutex<IdMapping>,
    on_register: OnRegister,
}

impl IdStore {
    pub fn new(existing: IdMapping, on_register: OnRegister) -> Self {
        Self {
            ids: Mutex::new(existing),
            on_register,
        }
    }

    fn ids(&self) -> std::sync::MutexGuard<'_, IdMapping> {
        self.ids.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Everything recorded so far.
    pub fn snapshot(&self) -> IdMapping {
        self.ids().clone()
    }
}

/// The store is per deployment and a deployment is per environment, so the
/// environment and the cache/data split icp-cli keys its files by have nothing
/// to select here.
impl store_id::Access for IdStore {
    fn register(
        &self,
        _is_cache: bool,
        env: &str,
        canister_name: &str,
        canister_id: Principal,
    ) -> Result<(), RegisterError> {
        {
            let mut ids = self.ids();
            if let Some(existing) = ids.get(canister_name) {
                return Err(RegisterError::AlreadyRegistered {
                    env: env.to_owned(),
                    canister_name: canister_name.to_owned(),
                    id: *existing,
                });
            }
            ids.insert(canister_name.to_owned(), canister_id);
        }
        (self.on_register)(canister_name, canister_id);
        Ok(())
    }

    fn unregister(
        &self,
        _is_cache: bool,
        _env: &str,
        canister_name: &str,
    ) -> Result<(), UnregisterError> {
        self.ids().remove(canister_name);
        Ok(())
    }

    fn lookup(
        &self,
        _is_cache: bool,
        env: &str,
        canister_name: &str,
    ) -> Result<Principal, LookupIdError> {
        self.ids()
            .get(canister_name)
            .copied()
            .ok_or_else(|| LookupIdError::IdNotFound {
                env: env.to_owned(),
                canister_name: canister_name.to_owned(),
            })
    }

    /// Empty rather than an error when nothing is recorded yet, as icp-cli's
    /// own store reads a file that is not there: an install starts from
    /// nothing, and that is not a failure.
    fn lookup_by_environment(
        &self,
        _is_cache: bool,
        _env: &str,
    ) -> Result<IdMapping, LookupIdError> {
        Ok(self.snapshot())
    }

    fn cleanup(&self, _is_cache: bool, _env: &str) -> Result<(), CleanupError> {
        self.ids().clear();
        Ok(())
    }
}

// ── Build artifacts ───────────────────────────────────────────────────────

/// The modules the build phase produced, by canister, for the install phase to
/// pick up. icp-cli caches these under `.icp/`; a bundle's are already in the
/// archive, so keeping them in memory for one run costs a copy and nothing
/// else.
#[derive(Default)]
pub struct Artifacts(Mutex<BTreeMap<String, Vec<u8>>>);

#[async_trait]
impl store_artifact::Access for Artifacts {
    async fn save(&self, name: &str, wasm: &[u8]) -> Result<(), SaveError> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(name.to_owned(), wasm.to_vec());
        Ok(())
    }

    async fn lookup(&self, name: &str) -> Result<Vec<u8>, LookupArtifactError> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(name)
            .cloned()
            .ok_or_else(|| LookupArtifactError::LookupArtifactNotFound {
                name: name.to_owned(),
            })
    }
}

// ── Building ──────────────────────────────────────────────────────────────

/// Why a build step could not be run against a bundle. Every one of these is
/// refused at load time already, so reaching one here is a bug rather than a
/// user's mistake — but the seam has to say something.
#[derive(Debug, Snafu)]
#[snafu(module)]
pub enum BuildRefused {
    #[snafu(display("a bundle's canisters are built by pre-built steps only"))]
    NotPrebuilt,

    #[snafu(display(
        "the module is referenced by URL, and a bundle must carry every wasm it installs"
    ))]
    Remote,

    #[snafu(display("the module '{path}' is not in the bundle"))]
    Missing { path: PathBuf },

    #[snafu(display(
        "the module '{path}' does not match its declared digest\n  expected {expected}\n  \
         actual   {actual}"
    ))]
    Digest {
        path: PathBuf,
        expected: String,
        actual: String,
    },
}

/// The build a bundle can run: a pre-built step, whose module is in the
/// archive. Upstream's builder is host-side because of script steps, which the
/// loader refuses for a bundle, so this is the half of it that remains — the
/// module copied to the output path the operation reads it back from.
pub struct PrebuiltBuild(pub BundleFiles);

#[async_trait]
impl Build for PrebuiltBuild {
    async fn build(
        &self,
        step: &BuildStep,
        params: &BuildParams,
        _reporter: &StepReporter,
    ) -> Result<(), BuildError> {
        let BuildStep::Prebuilt(adapter) = step else {
            return Err(BuildError::new(BuildRefused::NotPrebuilt));
        };
        let SourceField::Local(source) = &adapter.source else {
            return Err(BuildError::new(BuildRefused::Remote));
        };

        let path = normalize(&params.path.join(&source.path));
        let wasm = self
            .0
            .get(&path)
            .ok_or_else(|| BuildError::new(BuildRefused::Missing { path: path.clone() }))?;
        if let Some(expected) = adapter.sha256.as_deref() {
            let actual = sha256_hex(wasm);
            if !expected.eq_ignore_ascii_case(&actual) {
                return Err(BuildError::new(BuildRefused::Digest {
                    path,
                    expected: expected.to_owned(),
                    actual,
                }));
            }
        }

        self.0
            .write(&params.output, wasm)
            .await
            .map_err(BuildError::new)
    }
}

// ── Plugin wasms ──────────────────────────────────────────────────────────

/// Why a plugin wasm could not be produced.
#[derive(Debug, Snafu)]
#[snafu(module)]
pub enum WasmError {
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
}

/// Serves the plugin wasms the bundle carries, and nothing that would have to
/// be fetched. `icp-project` asks for a path rather than bytes, since icp-cli's
/// runtime loads the component off disk; here the path is the key the bytes are
/// read back by.
pub struct BundleWasm(pub BundleFiles);

#[async_trait]
impl Fetch for BundleWasm {
    async fn wasm(
        &self,
        source: &SourceField,
        base_dir: &Path,
        sha256: Option<&str>,
        _reporter: &StepReporter,
    ) -> Result<PathBuf, FetchError> {
        let SourceField::Local(source) = source else {
            return Err(FetchError::new(WasmError::Remote));
        };
        let path = normalize(&base_dir.join(&source.path));
        let wasm = self
            .0
            .get(&path)
            .ok_or_else(|| FetchError::new(WasmError::Missing { path: path.clone() }))?;

        if let Some(expected) = sha256 {
            let actual = sha256_hex(wasm);
            if !expected.eq_ignore_ascii_case(&actual) {
                return Err(FetchError::new(WasmError::Digest {
                    path,
                    expected: expected.to_owned(),
                    actual,
                }));
            }
        }
        Ok(path)
    }
}

// ── Scripts ───────────────────────────────────────────────────────────────

/// The script runner for a host with no shell. A bundle with a script step is
/// refused at load time, so this is never reached; the syncer takes one all the
/// same.
pub struct NoScripts;

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

// ── The network ───────────────────────────────────────────────────────────

/// A browser has no root key to hand out: its agent verifies every reply
/// itself, and nothing on a deployment's path asks for one.
#[derive(Debug, Snafu)]
#[snafu(display(
    "a browser deployment has no root key to hand out; its agent verifies replies itself"
))]
struct NoRootKey;

/// Where the network is reached, as the deploy operation asks and a sync plugin
/// is told.
///
/// The API endpoint is the host's — that is where every call actually goes.
/// The gateway is whatever the host knows, or failing that what the manifest
/// declares for the environment's network: a connected network names its
/// gateway, while a managed one is described by how to launch it, which says
/// nothing about where a running one is. Friendly domains are something a
/// managed network's launcher serves, and there is no launcher here.
pub struct BundleNetwork {
    pub urls: NetworkUrls,
}

#[async_trait]
impl network::Access for BundleNetwork {
    async fn access(&self, _network: &Network) -> Result<NetworkAccess, AccessError> {
        Err(AccessError::new(NoRootKey))
    }

    async fn urls(&self, network: &Network) -> Result<NetworkUrls, AccessError> {
        let mut urls = self.urls.clone();
        if urls.http_gateway_url.is_none()
            && let Configuration::Connected { connected } = &network.configuration
        {
            urls.http_gateway_url = connected.http_gateway_url.clone();
        }
        Ok(urls)
    }

    async fn publish_friendly_domains(
        &self,
        _network: &Network,
        _collect: &CollectFriendlyDomains<'_>,
    ) {
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use icp_project::store_id::Access as _;

    use super::*;

    fn principal(byte: u8) -> Principal {
        Principal::from_slice(&[byte; 4])
    }

    /// The store tells its listener about an id the moment it is recorded, and
    /// only about ids recorded through it — what it was seeded with is what an
    /// earlier run created.
    #[test]
    fn the_id_store_reports_what_is_registered_and_not_what_it_was_seeded_with() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let store = IdStore::new(
            IdMapping::from([("existing".to_owned(), principal(1))]),
            Box::new({
                let seen = Arc::clone(&seen);
                move |name, id| seen.lock().unwrap().push((name.to_owned(), id))
            }),
        );

        store.register(true, "local", "new", principal(2)).unwrap();
        assert_eq!(
            *seen.lock().unwrap(),
            vec![("new".to_owned(), principal(2))]
        );
        assert_eq!(
            store.lookup(true, "local", "existing").unwrap(),
            principal(1)
        );
        assert_eq!(store.lookup_by_environment(true, "local").unwrap().len(), 2);
    }

    /// Registering a name twice is the mistake icp-cli's store refuses, so it
    /// is refused here the same way rather than silently replacing an id.
    #[test]
    fn the_id_store_refuses_a_second_id_for_a_name() {
        let store = IdStore::new(IdMapping::new(), Box::new(|_, _| {}));
        store.register(true, "local", "app", principal(1)).unwrap();
        let error = store
            .register(true, "local", "app", principal(2))
            .expect_err("a second id for the same name");
        assert!(
            matches!(error, RegisterError::AlreadyRegistered { .. }),
            "{error}"
        );
        assert_eq!(store.lookup(true, "local", "app").unwrap(), principal(1));
    }

    /// An install starts from an empty store, which is not an error.
    #[test]
    fn an_empty_id_store_lists_nothing() {
        let store = IdStore::new(IdMapping::new(), Box::new(|_, _| {}));
        assert!(
            store
                .lookup_by_environment(true, "local")
                .unwrap()
                .is_empty()
        );
        assert!(matches!(
            store.lookup(true, "local", "app"),
            Err(LookupIdError::IdNotFound { .. })
        ));
    }
}
