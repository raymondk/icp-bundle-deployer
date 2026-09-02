//! Turning an archive into a project this deployer is willing to deploy.
//!
//! The manifest is parsed by `icp-deploy-canister` — the same loader icp-cli
//! runs — so a bundle is understood exactly as the CLI understands it, down to
//! the unit suffixes on settings and the shape of init args. What is added here
//! is the part that only matters for a bundle: everything the manifest names has
//! to be *inside* the archive, and has to hash to what the manifest says it does.
//!
//! All of it happens before a deployment starts. A bundle that cannot be
//! deployed is refused while it is still bytes in a tab, not after some of its
//! canisters already exist on chain.

use icp_deploy_canister::{
    Canister, Project, bundle_get_canister_module_path,
    canister::recipe::NoResolve,
    manifest::{
        BuildStep, PROJECT_MANIFEST, ProjectManifest, SyncStep, load_manifest, plugin::NamedPaths,
        prebuilt::SourceField,
    },
    prelude::*,
    project::{consolidate_manifest, verify_sandbox},
};
use sha2::{Digest, Sha256};

use crate::{
    abi::plugin_abi,
    archive::read_archive,
    files::{BundleFiles, ROOT, normalize},
    sandbox::{Escape, covering_dirs},
};

/// Why a bundle was refused. The three kinds are worth telling apart: an archive
/// that will not open, a manifest this deployer cannot honour, and artifacts
/// that do not match the digests declared for them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BundleErrorKind {
    Archive,
    Manifest,
    Integrity,
}

#[derive(Debug)]
pub struct BundleError {
    pub kind: BundleErrorKind,
    pub message: String,
}

impl BundleError {
    fn archive(message: impl Into<String>) -> Self {
        Self {
            kind: BundleErrorKind::Archive,
            message: message.into(),
        }
    }

    fn manifest(message: impl Into<String>) -> Self {
        Self {
            kind: BundleErrorKind::Manifest,
            message: message.into(),
        }
    }

    fn integrity(message: impl Into<String>) -> Self {
        Self {
            kind: BundleErrorKind::Integrity,
            message: message.into(),
        }
    }
}

/// What a bundle holds, for showing before anyone commits to deploying it.
#[derive(Clone, Debug)]
pub struct CanisterSummary {
    pub name: String,
    /// Path of the wasm inside the archive, relative to the bundle root.
    pub wasm_path: String,
    pub wasm_size: usize,
    /// The digest the manifest declared, when it declared one.
    pub declared_sha256: Option<String>,
    /// The digest the wasm actually has.
    pub digest: String,
    /// Directories the canister's sync steps upload.
    pub sync_dirs: Vec<String>,
}

/// A bundle that has been read, validated, and verified.
pub struct LoadedBundle {
    pub files: BundleFiles,
    pub project: Project,
    pub canisters: Vec<CanisterSummary>,
}

/// Read, validate, and verify a bundle.
pub async fn load_bundle(data: &[u8]) -> Result<LoadedBundle, BundleError> {
    let files = read_archive(data).map_err(|e| BundleError::archive(chain(&e)))?;
    let root = Path::new(ROOT);
    let manifest_path = root.join(PROJECT_MANIFEST);

    if !files.contains(&manifest_path) {
        return Err(BundleError::manifest(format!(
            "The bundle has no {PROJECT_MANIFEST} at its root, so it is not an application bundle."
        )));
    }

    // Read the manifest before consolidating it, to refuse what a bundle may not
    // declare with a message about the bundle rather than about a missing file.
    let manifest: ProjectManifest = load_manifest(&files, &manifest_path)
        .await
        .map_err(|e| BundleError::manifest(chain(&e)))?;

    // Nothing in a bundle is fetched: recipes and plugin wasms must already be
    // in the archive, so the resolver only ever serves what is.
    let project = consolidate_manifest(&files, root, &NoResolve(files.clone()), &manifest)
        .await
        .map_err(|e| BundleError::manifest(chain(&e)))?;

    // Asked of the workspace rather than of the root manifest: an umbrella
    // project declares no canisters of its own and exists to pull together the
    // ones its dependencies declare.
    if project.canisters.is_empty() {
        return Err(BundleError::manifest(
            "This bundle declares no canisters, so there is nothing to deploy.",
        ));
    }

    // Script steps shell out, which a browser cannot do. This is the crate's own
    // sandbox rule, so a bundle refused here would be refused by any sandboxed
    // host.
    verify_sandbox(&project).map_err(|e| BundleError::manifest(chain(&e)))?;

    let mut canisters = Vec::new();
    for (name, (canister_dir, canister)) in &project.canisters {
        canisters.push(check_canister(&files, &project, name, canister_dir, canister).await?);
    }

    // An environment may override a canister's init args, so every variant a
    // deployment could install is encoded here too, not just the declared one.
    let mut environments: Vec<&String> = project.environments.keys().collect();
    environments.sort();
    for environment in environments {
        for (name, (_, canister)) in &project.environments[environment].canisters {
            let declared = project.canisters.get(name).map(|(_, c)| &c.init_args);
            if declared != Some(&canister.init_args) {
                check_init_args(name, Some(environment), canister)?;
            }
        }
    }

    Ok(LoadedBundle {
        files,
        project,
        canisters,
    })
}

/// The artifact a canister installs: the single pre-built local module its build
/// step names, resolved against the canister's own directory.
pub fn artifact_path(canister_dir: &Path, canister: &Canister) -> Result<PathBuf, BundleError> {
    let module = bundle_get_canister_module_path(canister).map_err(|e| {
        BundleError::manifest(format!(
            "{}. A bundle must carry every wasm it installs.",
            chain(&e)
        ))
    })?;
    Ok(normalize(&canister_dir.join(module)))
}

async fn check_canister(
    files: &BundleFiles,
    project: &Project,
    name: &str,
    canister_dir: &Path,
    canister: &Canister,
) -> Result<CanisterSummary, BundleError> {
    let base = normalize(canister_dir);
    let wasm_path = artifact_path(canister_dir, canister)?;
    let wasm = read(files, &wasm_path, &format!("Canister \"{name}\""))?;

    let declared_sha256 = declared_module_digest(canister);
    let digest = sha256_hex(wasm);
    check_digest(
        &wasm_path,
        declared_sha256.as_deref(),
        &digest,
        &format!("canister \"{name}\""),
    )?;

    check_init_args(name, None, canister)?;

    let mut sync_dirs = Vec::new();
    for step in &canister.sync.steps {
        let SyncStep::Plugin(adapter) = step else {
            // `verify_sandbox` has already refused script steps; a sync step is
            // one or the other.
            unreachable!("script sync steps are refused by verify_sandbox");
        };

        let SourceField::Local(source) = &adapter.source else {
            return Err(BundleError::manifest(format!(
                "The sync plugin of canister \"{name}\" is referenced by URL rather than by a path \
                 inside the bundle. A bundle must carry every plugin it runs."
            )));
        };

        let plugin_path = normalize(&base.join(&source.path));
        let plugin = read(
            files,
            &plugin_path,
            &format!("The sync plugin of canister \"{name}\""),
        )?;
        // A sync plugin runs with the same reach as the deployment itself, so
        // its wasm is held to the same standard as the canister's.
        check_digest(
            &plugin_path,
            adapter.sha256.as_deref(),
            &sha256_hex(plugin),
            &format!("the sync plugin of canister \"{name}\""),
        )?;
        // Which interface it speaks decides how it is called at all, so a plugin
        // this deployer could not drive is refused now rather than after the
        // canister it syncs is already installed.
        plugin_abi(plugin).map_err(|e| {
            BundleError::manifest(format!(
                "The sync plugin of canister \"{name}\" cannot be run: {}.",
                chain(&e)
            ))
        })?;

        // Every canister the step wants to reach has to be one this bundle
        // deploys. An environment may leave some of them out, which only the
        // deployment can know; a name the project never declares is wrong now.
        for target in adapter.canisters.iter().flatten() {
            if !names_a_canister(project, name, target) {
                return Err(BundleError::manifest(format!(
                    "The sync plugin of canister \"{name}\" lists \"{target}\" among the canisters \
                     it may call, but this bundle declares no canister by that name."
                )));
            }
        }

        let declared: Vec<&str> = adapter
            .dirs
            .iter()
            .flat_map(NamedPaths::entries)
            .map(|entry| entry.path)
            .collect();
        for dir in &declared {
            let path = resolve_declared(&base, dir, name, "declares", "for syncing")?;
            if files.under(&path).is_empty() {
                return Err(BundleError::manifest(format!(
                    "Canister \"{name}\" declares \"{dir}\" for syncing, but the bundle contains \
                     no files under that path."
                )));
            }
        }
        // The declared list is configuration — the same tree may be named twice,
        // or beside a subtree of itself — but what gets uploaded is the trees
        // behind it, which is what is worth reporting.
        sync_dirs.extend(covering_dirs(declared).into_iter().map(str::to_owned));

        for entry in adapter.files.iter().flat_map(NamedPaths::entries) {
            let file = entry.path;
            let path = resolve_declared(&base, file, name, "passes", "to its sync plugin")?;
            let contents = read(
                files,
                &path,
                &format!("The sync step of canister \"{name}\""),
            )?;
            // These are handed to the plugin inline, as text; one that is not
            // text cannot be passed to it at all.
            if str::from_utf8(contents).is_err() {
                return Err(BundleError::manifest(format!(
                    "Canister \"{name}\" passes \"{file}\" to its sync plugin, which takes text, \
                     but that file is not valid UTF-8."
                )));
            }
        }
    }

    Ok(CanisterSummary {
        name: name.to_owned(),
        wasm_path: relative(&wasm_path).to_string(),
        wasm_size: wasm.len(),
        declared_sha256,
        digest,
        sync_dirs,
    })
}

/// Whether `target`, as the sync step of the canister keyed `syncing` spelled
/// it, names a canister this bundle declares.
///
/// A step names a canister the way its own project names it, which is not always
/// the key the workspace files it under. A project vendored into a workspace
/// keeps writing `backend` for its own canister, and `vendor/ledger:ledger` for
/// one belonging to a dependency of its own, while the workspace knows those as
/// `services/crm:backend` and `services/crm/vendor/ledger:ledger` — the point
/// being that vendoring a project does not rewrite its manifests. Deploying
/// resolves both spellings against a table built this same way, so a name that
/// passes here is one that will resolve there.
fn names_a_canister(project: &Project, syncing: &str, target: &str) -> bool {
    if project.canisters.contains_key(target) {
        return true;
    }
    // A canister of the app root is already in the namespace store keys are
    // relative to, so its project's spellings are the store keys.
    let Some((namespace, _)) = syncing.rsplit_once(':') else {
        return false;
    };
    project
        .canisters
        .keys()
        .any(|key| member_relative_alias(namespace, key) == Some(target))
}

/// The name a canister has *within* the subproject at `namespace`: its store key
/// with that subproject's prefix removed. A canister of the subproject itself
/// comes back under its bare local name; one belonging to a subproject nested
/// below it comes back under the key it would have if that subproject were the
/// app root. `None` for a canister the subproject has no name of its own for.
///
/// A local name never contains a colon but a subproject directory may, so a key
/// splits on its *last* colon.
fn member_relative_alias<'a>(namespace: &str, key: &'a str) -> Option<&'a str> {
    let (key_namespace, _) = key.rsplit_once(':')?;
    let rest = key.strip_prefix(namespace)?;
    match key_namespace == namespace {
        // The colon separating the subproject from a local name of its own.
        true => rest.strip_prefix(':'),
        // Otherwise the key's subproject must sit *below* this one. Demanding
        // the path separator is what keeps `services/crm-legacy:backend` out of
        // `services/crm`, which it merely shares a spelling prefix with.
        false => rest.strip_prefix('/'),
    }
}

/// Resolve a path a sync step declared, or refuse the bundle for it.
///
/// The entry is written relative to the canister's own directory but resolved
/// inside the bundle, so it may name a sibling canister's tree with `..`. What
/// it may not do is leave the bundle: the plugin runs against the bundle's
/// contents and nothing else exists to give it. `verb` and `role` place the
/// entry in the sentence — "declares … for syncing", "passes … to its sync
/// plugin".
fn resolve_declared(
    base: &Path,
    declared: &str,
    name: &str,
    verb: &str,
    role: &str,
) -> Result<PathBuf, BundleError> {
    crate::sandbox::resolve(base, declared).map_err(|escape| {
        let reason = match escape {
            Escape::NotRelative => "is an absolute path",
            Escape::AboveRoot => "reaches outside the bundle",
        };
        BundleError::manifest(format!(
            "Canister \"{name}\" {verb} \"{declared}\" {role}, which {reason}. A sync plugin sees \
             what the bundle carries and nothing else."
        ))
    })
}

/// Encode a canister's init args and throw the bytes away: they are encoded
/// again at install time, and this is the only place a value that cannot be
/// encoded can be refused before any canister exists. Candid text is parsed and
/// hex is decoded here, so neither can fail on chain.
fn check_init_args(
    name: &str,
    environment: Option<&str>,
    canister: &Canister,
) -> Result<(), BundleError> {
    let Some(args) = &canister.init_args else {
        return Ok(());
    };

    args.to_bytes().map(|_| ()).map_err(|e| {
        let subject = match environment {
            Some(environment) => format!(
                "The init args canister \"{name}\" is given in the \"{environment}\" environment"
            ),
            None => format!("The init args of canister \"{name}\""),
        };
        BundleError::manifest(format!("{subject} could not be encoded: {}", chain(&e)))
    })
}

/// The digest the manifest declared for a canister's module, if any. The build
/// is known to be a single pre-built step by the time this is called.
fn declared_module_digest(canister: &Canister) -> Option<String> {
    match canister.build.steps.first()? {
        BuildStep::Prebuilt(adapter) => adapter.sha256.as_ref().map(|s| s.to_lowercase()),
        BuildStep::Script(_) => None,
    }
}

/// A path as the manifest wrote it: relative to the bundle root, which is what a
/// reader of the message will recognize.
fn relative(path: &Path) -> &Path {
    path.strip_prefix(ROOT).unwrap_or(path)
}

fn read<'a>(files: &'a BundleFiles, path: &Path, subject: &str) -> Result<&'a [u8], BundleError> {
    files.get(path).ok_or_else(|| {
        BundleError::manifest(format!(
            "{subject} refers to \"{}\", which is not in the bundle.",
            relative(path)
        ))
    })
}

fn check_digest(
    path: &Path,
    declared: Option<&str>,
    actual: &str,
    subject: &str,
) -> Result<(), BundleError> {
    match declared {
        Some(declared) if declared != actual => Err(BundleError::integrity(format!(
            "\"{}\" does not match the digest declared for {subject}.\n  expected {declared}\n  \
             actual   {actual}",
            relative(path)
        ))),
        _ => Ok(()),
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// A snafu error and everything under it, as one line. The crate's errors put
/// the context in the outer message and the cause in the source, so only the
/// whole chain says what actually went wrong.
pub fn chain(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(current) = source {
        message.push_str(": ");
        message.push_str(&current.to_string());
        source = current.source();
    }
    message
}

#[cfg(test)]
mod tests {
    use super::member_relative_alias;

    /// A canister of the subproject itself is named bare within it.
    #[test]
    fn a_subprojects_own_canister_is_named_bare() {
        assert_eq!(
            member_relative_alias("services/crm", "services/crm:backend"),
            Some("backend")
        );
    }

    /// One belonging to a subproject nested below it keeps the key it would have
    /// if that subproject were the app root — the very key its own manifest
    /// writes, which is what lets vendoring leave those manifests alone.
    #[test]
    fn a_nested_subprojects_canister_is_named_relative_to_the_subproject() {
        assert_eq!(
            member_relative_alias("services/crm", "services/crm/vendor/ledger:ledger"),
            Some("vendor/ledger:ledger")
        );
        assert_eq!(
            member_relative_alias(
                "services/crm",
                "services/crm/vendor/ledger/vendor/util:util"
            ),
            Some("vendor/ledger/vendor/util:util")
        );
    }

    /// A subproject whose path merely starts with the same characters is not
    /// nested below this one, so it has no name here.
    #[test]
    fn a_spelling_prefix_is_not_nesting() {
        assert_eq!(
            member_relative_alias("services/crm", "services/crm-legacy:backend"),
            None
        );
    }

    /// A canister of the app root, or of an unrelated subproject, is not
    /// something this subproject has a name of its own for.
    #[test]
    fn an_unrelated_canister_has_no_name_here() {
        assert_eq!(member_relative_alias("services/crm", "backend"), None);
        assert_eq!(
            member_relative_alias("services/crm", "services/other:backend"),
            None
        );
    }

    /// A subproject directory may itself contain a colon, so a key splits on its
    /// last one — and a colon in a directory name is not nesting.
    #[test]
    fn keys_split_at_the_last_colon() {
        assert_eq!(
            member_relative_alias("services/odd:name", "services/odd:name:frontend"),
            Some("frontend")
        );
        assert_eq!(
            member_relative_alias("services/odd", "services/odd:name:frontend"),
            None
        );
    }
}
