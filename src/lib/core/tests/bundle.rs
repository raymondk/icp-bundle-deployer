//! What a bundle has to be before anything is deployed.
//!
//! Most of these assert a *refusal*, and that is the point: these checks decide
//! whether a deployment starts at all, so a bundle that cannot be deployed has
//! to be refused while it is still bytes — not after some of its canisters
//! already exist on chain. Each refusal is also checked for saying what to fix.

mod support;

use futures::executor::block_on;
use icp_bundle_deployer_core::bundle::{BundleError, BundleErrorKind, LoadedBundle, load_bundle};
use indoc::formatdoc;
use support::{Entry, file, gzip, overstate_first_entry, plugin, tar};

const WASM: &[u8] = &[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/// The interface version a plugin speaks decides how it is driven, so the
/// stand-in plugin these tests carry declares one. Most of them do not care
/// which; where it matters, the test builds its own.
fn plugin_wasm() -> Vec<u8> {
    plugin("0.1.0")
}

fn digest(bytes: &[u8]) -> String {
    icp_bundle_deployer_core::bundle::sha256_hex(bytes)
}

/// A bundle holding `manifest` plus one canister wasm, and whatever else is
/// asked for.
fn bundle(manifest: &str, extra: Vec<Entry>) -> Vec<u8> {
    let mut entries = vec![file("icp.yaml", manifest), file("canisters/app.wasm", WASM)];
    entries.extend(extra);
    tar(entries)
}

fn minimal() -> String {
    formatdoc! {"
        canisters:
        - name: app
          build:
            steps:
            - type: pre-built
              path: canisters/app.wasm
              sha256: {}
    ", digest(WASM)}
}

fn load(data: &[u8]) -> Result<LoadedBundle, BundleError> {
    block_on(load_bundle(data))
}

fn refusal(data: &[u8]) -> BundleError {
    load(data)
        .err()
        .expect("the bundle should have been refused")
}

/// Asserts a refusal of the right kind whose message a user could act on.
#[track_caller]
fn refuses(data: &[u8], kind: BundleErrorKind, expected: &str) {
    let error = refusal(data);
    assert_eq!(error.kind, kind, "wrong kind of refusal: {}", error.message);
    assert!(
        error.message.to_lowercase().contains(expected),
        "message should mention {expected:?}, got: {}",
        error.message
    );
}

// ── Archive ─────────────────────────────────────────────────────────────────

#[test]
fn reads_a_plain_tar() {
    let loaded = load(&bundle(&minimal(), vec![])).expect("a minimal bundle should load");
    assert_eq!(loaded.canisters.len(), 1);
    assert_eq!(loaded.canisters[0].name, "app");
    assert_eq!(loaded.canisters[0].wasm_path, "canisters/app.wasm");
    assert_eq!(loaded.canisters[0].wasm_size, WASM.len());
    assert_eq!(loaded.canisters[0].declared_sha256, Some(digest(WASM)));
    assert_eq!(loaded.canisters[0].digest, digest(WASM));
}

#[test]
fn reads_a_gzipped_tar() {
    let loaded = load(&gzip(&bundle(&minimal(), vec![]))).expect("a gzipped bundle should load");
    assert_eq!(loaded.canisters.len(), 1);
}

#[test]
fn honours_a_name_too_long_for_a_tar_header() {
    let long = format!("canisters/{}app.wasm", "nested/".repeat(20));
    let manifest = formatdoc! {"
        canisters:
        - name: app
          build:
            steps:
            - type: pre-built
              path: {long}
              sha256: {}
    ", digest(WASM)};

    let archive = tar(vec![file("icp.yaml", manifest.as_str()), file(&long, WASM)]);
    let loaded = load(&archive).expect("a long path should survive the round trip");
    assert_eq!(loaded.canisters[0].wasm_path, long);
}

#[test]
fn rejects_an_empty_archive() {
    refuses(&tar(vec![]), BundleErrorKind::Archive, "no files");
}

#[test]
fn rejects_a_truncated_archive() {
    let full = bundle(&minimal(), vec![]);
    refuses(&full[..700], BundleErrorKind::Archive, "truncated");
}

/// An entry's size is read from its header before any of the entry is, so a
/// header claiming more than the archive can hold must be reported rather than
/// allocated for: on the 32-bit heap the module runs on, reserving what a hostile
/// header asks for aborts the instance instead of refusing the bundle.
#[test]
fn rejects_an_entry_claiming_more_than_the_archive_holds() {
    let archive = overstate_first_entry(bundle(&minimal(), vec![]), 2 * 1024 * 1024 * 1024);
    refuses(&archive, BundleErrorKind::Archive, "truncated");
}

// ── Manifest ────────────────────────────────────────────────────────────────

#[test]
fn requires_a_manifest_at_the_root() {
    let archive = tar(vec![file("canisters/app.wasm", WASM)]);
    refuses(
        &archive,
        BundleErrorKind::Manifest,
        "not an application bundle",
    );
}

#[test]
fn rejects_a_manifest_that_is_not_yaml() {
    let archive = bundle("canisters: [", vec![]);
    refuses(&archive, BundleErrorKind::Manifest, "icp.yaml");
}

/// A bundle with nothing to deploy anywhere in it — not in the root project and
/// not in a dependency, since it has none.
#[test]
fn rejects_a_bundle_with_no_canisters() {
    refuses(
        &bundle("canisters: []", vec![]),
        BundleErrorKind::Manifest,
        "no canisters",
    );
}

// ── Dependencies ────────────────────────────────────────────────────────────

/// A bundle mirrors the workspace it was built from: the root project at the
/// archive root, and each dependency at the directory it sits in relative to
/// that root. This is that shape — one dependency vendored at `vendor/lib`,
/// whose own manifest is `dependency`, written as that project wrote it.
fn workspace(dependency: &str, extra: Vec<Entry>) -> Vec<u8> {
    let root = formatdoc! {"
        canisters:
        - name: app
          build:
            steps:
            - type: pre-built
              path: canisters/app.wasm
              sha256: {}
        dependencies:
        - name: lib
          path: ./vendor/lib
    ", digest(WASM)};

    let mut entries = vec![
        file("icp.yaml", root.as_str()),
        file("canisters/app.wasm", WASM),
        file("vendor/lib/icp.yaml", dependency),
        file("vendor/lib/canisters/backend.wasm", WASM),
    ];
    entries.extend(extra);
    tar(entries)
}

/// The vendored project, declaring one canister and nothing else.
fn dependency_manifest() -> String {
    formatdoc! {"
        canisters:
        - name: backend
          build:
            steps:
            - type: pre-built
              path: canisters/backend.wasm
              sha256: {}
    ", digest(WASM)}
}

fn with_dependency(extra: Vec<Entry>) -> Vec<u8> {
    workspace(&dependency_manifest(), extra)
}

/// A dependency is deployed along with the project that depends on it, so its
/// canisters are part of the bundle and reported with it. They are keyed by
/// where the dependency sits, which is what keeps two dependencies that both
/// call a canister `backend` apart.
#[test]
fn accepts_a_bundle_with_a_dependency() {
    let loaded = load(&with_dependency(vec![])).expect("a vendored dependency should load");

    let names: Vec<&str> = loaded.canisters.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["app", "vendor/lib:backend"]);
    assert_eq!(
        loaded.canisters[1].wasm_path,
        "vendor/lib/canisters/backend.wasm"
    );

    // The whole workspace deploys, not just the project that depends on it: a
    // dependency's canisters may call each other, so leaving them out would
    // deploy something that does not work.
    let local = loaded
        .project
        .environments
        .get("local")
        .expect("every project has an implicit local environment");
    assert!(local.canisters.contains_key("app"));
    assert!(local.canisters.contains_key("vendor/lib:backend"));
}

/// An umbrella project declares no canisters of its own: it exists to pull
/// together the ones its dependencies declare. Whether there is anything to
/// deploy is a question about the workspace, not about the root manifest.
#[test]
fn accepts_a_workspace_whose_canisters_are_all_in_dependencies() {
    // Written the way an umbrella project is: no `canisters:` key at all.
    let root = indoc::indoc! {"
        dependencies:
        - name: lib
          path: ./vendor/lib
    "};

    let archive = tar(vec![
        file("icp.yaml", root),
        file("vendor/lib/icp.yaml", dependency_manifest().as_str()),
        file("vendor/lib/canisters/backend.wasm", WASM),
    ]);
    let loaded = load(&archive).expect("an umbrella project should load");

    let names: Vec<&str> = loaded.canisters.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["vendor/lib:backend"]);
}

/// A dependency's sync step names the canisters it may call the way that
/// dependency's own manifest names them — a bare local name for one of its own,
/// which is not the key the workspace files it under. Deploying resolves those
/// spellings, so checking a bundle must accept them.
#[test]
fn accepts_a_call_target_a_dependency_names_locally() {
    let dependency = formatdoc! {"
        canisters:
        - name: backend
          build:
            steps:
            - type: pre-built
              path: canisters/backend.wasm
              sha256: {}
        - name: frontend
          build:
            steps:
            - type: pre-built
              path: canisters/backend.wasm
              sha256: {}
          sync:
            steps:
            - type: plugin
              path: plugins/sync.wasm
              sha256: {}
              dirs:
              - assets
              canisters:
              - backend
    ", digest(WASM), digest(WASM), digest(&plugin_wasm())};

    let extra = vec![
        file("vendor/lib/plugins/sync.wasm", plugin_wasm()),
        file("vendor/lib/assets/index.html", "<h1>hi"),
    ];
    let loaded = load(&workspace(&dependency, extra))
        .expect("a dependency's own name for a sibling should be accepted");

    let names: Vec<&str> = loaded.canisters.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["app", "vendor/lib:backend", "vendor/lib:frontend"]);
}

/// The rule is still a rule: a name that resolves to nothing under either
/// spelling is a manifest error, in a dependency as much as in the root.
#[test]
fn rejects_a_call_target_a_dependency_does_not_have() {
    let dependency = formatdoc! {"
        canisters:
        - name: backend
          build:
            steps:
            - type: pre-built
              path: canisters/backend.wasm
              sha256: {}
          sync:
            steps:
            - type: plugin
              path: plugins/sync.wasm
              sha256: {}
              dirs:
              - assets
              canisters:
              - ledger
    ", digest(WASM), digest(&plugin_wasm())};

    let extra = vec![
        file("vendor/lib/plugins/sync.wasm", plugin_wasm()),
        file("vendor/lib/assets/index.html", "<h1>hi"),
    ];
    refuses(
        &workspace(&dependency, extra),
        BundleErrorKind::Manifest,
        "declares no canister by that name",
    );
}

/// Nothing is fetched for a bundle, so a dependency it does not carry is a
/// bundle that cannot be deployed rather than something to go and find.
#[test]
fn rejects_a_dependency_the_bundle_does_not_carry() {
    let manifest = formatdoc! {"
        {}
        dependencies:
        - name: other
          path: ./vendor/other
    ", minimal()};
    refuses(
        &bundle(&manifest, vec![]),
        BundleErrorKind::Manifest,
        "other",
    );
}

#[test]
fn rejects_a_script_build_step() {
    let manifest = indoc::indoc! {"
        canisters:
        - name: app
          build:
            steps:
            - type: script
              command: make
    "};
    refuses(
        &bundle(manifest, vec![]),
        BundleErrorKind::Manifest,
        "script",
    );
}

#[test]
fn rejects_a_build_step_that_points_at_a_url() {
    let manifest = indoc::indoc! {"
        canisters:
        - name: app
          build:
            steps:
            - type: pre-built
              url: https://example.com/app.wasm
              sha256: 903fc05018e19bd44ea66dd7e74d9d9f55c622d86fbe453861ba64ee8c637847
    "};
    refuses(
        &bundle(manifest, vec![]),
        BundleErrorKind::Manifest,
        "remote url",
    );
}

#[test]
fn rejects_a_wasm_that_is_not_in_the_bundle() {
    let manifest = indoc::indoc! {"
        canisters:
        - name: app
          build:
            steps:
            - type: pre-built
              path: canisters/missing.wasm
    "};
    refuses(
        &bundle(manifest, vec![]),
        BundleErrorKind::Manifest,
        "not in the bundle",
    );
}

#[test]
fn rejects_a_canister_built_by_more_than_one_step() {
    let manifest = formatdoc! {"
        canisters:
        - name: app
          build:
            steps:
            - type: pre-built
              path: canisters/app.wasm
              sha256: {0}
            - type: pre-built
              path: canisters/app.wasm
              sha256: {0}
    ", digest(WASM)};
    refuses(
        &bundle(&manifest, vec![]),
        BundleErrorKind::Manifest,
        "single build step",
    );
}

// ── Integrity ───────────────────────────────────────────────────────────────

#[test]
fn rejects_a_wasm_that_does_not_match_its_digest() {
    let manifest = indoc::indoc! {"
        canisters:
        - name: app
          build:
            steps:
            - type: pre-built
              path: canisters/app.wasm
              sha256: 0000000000000000000000000000000000000000000000000000000000000000
    "};
    refuses(
        &bundle(manifest, vec![]),
        BundleErrorKind::Integrity,
        "does not match the digest",
    );
}

#[test]
fn accepts_a_wasm_with_no_declared_digest_and_reports_the_real_one() {
    let manifest = indoc::indoc! {"
        canisters:
        - name: app
          build:
            steps:
            - type: pre-built
              path: canisters/app.wasm
    "};
    let loaded = load(&bundle(manifest, vec![])).expect("a digest is optional");
    assert_eq!(loaded.canisters[0].declared_sha256, None);
    assert_eq!(loaded.canisters[0].digest, digest(WASM));
}

// ── Sync steps ──────────────────────────────────────────────────────────────

/// A bundle whose one canister syncs through `step`, carrying `wasm` as the
/// plugin the step names. The step is written flush-left and indented into place
/// here — the sync steps of a manifest sit four spaces in.
fn with_plugin_wasm(step: &str, wasm: Vec<u8>, extra: Vec<Entry>) -> Vec<u8> {
    let steps = step
        .lines()
        .map(|line| format!("    {line}"))
        .collect::<Vec<_>>()
        .join("\n");

    let manifest = formatdoc! {"
        canisters:
        - name: app
          build:
            steps:
            - type: pre-built
              path: canisters/app.wasm
              sha256: {}
          sync:
            steps:
        {steps}
    ", digest(WASM)};

    let mut entries = vec![file("plugins/sync.wasm", wasm)];
    entries.extend(extra);
    bundle(&manifest, entries)
}

/// The same, with the stand-in plugin these tests mostly use.
fn with_plugin(step: &str, extra: Vec<Entry>) -> Vec<u8> {
    with_plugin_wasm(step, plugin_wasm(), extra)
}

fn assets() -> Vec<Entry> {
    vec![file("assets/index.html", "<h1>hi")]
}

#[test]
fn accepts_a_plugin_sync_step() {
    let step = formatdoc! {"
        - type: plugin
          path: plugins/sync.wasm
          sha256: {}
          dirs:
          - assets
    ", digest(&plugin_wasm())};

    let loaded = load(&with_plugin(&step, assets())).expect("a plugin step should be accepted");
    assert_eq!(loaded.canisters[0].sync_dirs, ["assets"]);
}

#[test]
fn rejects_a_script_sync_step() {
    let step = indoc::indoc! {"
        - type: script
          command: ./upload.sh
    "};
    refuses(
        &with_plugin(step, vec![]),
        BundleErrorKind::Manifest,
        "script",
    );
}

#[test]
fn rejects_a_plugin_that_points_at_a_url() {
    let step = indoc::indoc! {"
        - type: plugin
          url: https://example.com/sync.wasm
          sha256: 903fc05018e19bd44ea66dd7e74d9d9f55c622d86fbe453861ba64ee8c637847
          dirs:
          - assets
    "};
    refuses(
        &with_plugin(step, assets()),
        BundleErrorKind::Manifest,
        "url",
    );
}

#[test]
fn rejects_a_plugin_that_does_not_match_its_digest() {
    let step = indoc::indoc! {"
        - type: plugin
          path: plugins/sync.wasm
          sha256: 0000000000000000000000000000000000000000000000000000000000000000
          dirs:
          - assets
    "};
    refuses(
        &with_plugin(step, assets()),
        BundleErrorKind::Integrity,
        "does not match the digest",
    );
}

#[test]
fn rejects_a_sync_directory_the_bundle_does_not_carry() {
    let step = formatdoc! {"
        - type: plugin
          path: plugins/sync.wasm
          sha256: {}
          dirs:
          - assets
    ", digest(&plugin_wasm())};
    refuses(
        &with_plugin(&step, vec![]),
        BundleErrorKind::Manifest,
        "no files under that path",
    );
}

#[test]
fn rejects_a_sync_file_the_bundle_does_not_carry() {
    let step = formatdoc! {"
        - type: plugin
          path: plugins/sync.wasm
          sha256: {}
          files:
          - config.txt
    ", digest(&plugin_wasm())};
    refuses(
        &with_plugin(&step, vec![]),
        BundleErrorKind::Manifest,
        "not in the bundle",
    );
}

/// A plugin is handed these files inline as text, so one that is not text has to
/// be refused here rather than part-way through a sync — by then the canister is
/// installed.
#[test]
fn rejects_a_sync_file_that_is_not_text() {
    let step = formatdoc! {"
        - type: plugin
          path: plugins/sync.wasm
          sha256: {}
          files:
          - config.txt
    ", digest(&plugin_wasm())};
    refuses(
        &with_plugin(&step, vec![file("config.txt", vec![0xff, 0xfe, 0x00])]),
        BundleErrorKind::Manifest,
        "not valid utf-8",
    );
}

/// A plugin's sandbox is the whole project, so an entry may rise out of the
/// canister's own directory and name a tree the rest of the bundle carries.
#[test]
fn accepts_a_sync_directory_elsewhere_in_the_bundle() {
    let canister = formatdoc! {"
        name: site
        build:
          steps:
          - type: pre-built
            path: app.wasm
            sha256: {}
        sync:
          steps:
          - type: plugin
            path: sync.wasm
            sha256: {}
            dirs:
            - ../shared
    ", digest(WASM), digest(&plugin_wasm())};

    let archive = tar(vec![
        file("icp.yaml", "canisters:\n- canisters/site\n"),
        file("canisters/site/canister.yaml", canister.as_str()),
        file("canisters/site/app.wasm", WASM),
        file("canisters/site/sync.wasm", plugin_wasm()),
        file("canisters/shared/index.html", "<h1>hi"),
    ]);
    let loaded = load(&archive).expect("a directory inside the bundle should be accepted");
    assert_eq!(loaded.canisters[0].sync_dirs, ["../shared"]);
}

/// What it may not do is leave the bundle. Nothing outside one exists to give
/// the plugin, so an entry that walks out of it names nothing at all.
#[test]
fn rejects_a_sync_directory_outside_the_bundle() {
    let step = formatdoc! {"
        - type: plugin
          path: plugins/sync.wasm
          sha256: {}
          dirs:
          - ../shared
    ", digest(&plugin_wasm())};

    refuses(
        &with_plugin(&step, assets()),
        BundleErrorKind::Manifest,
        "reaches outside the bundle",
    );
}

/// `dirs`/`files` may be written as a map, which tags each entry with a name the
/// plugin looks it up by. The paths are the same paths either way.
#[test]
fn accepts_dirs_and_files_written_as_a_map() {
    let step = formatdoc! {"
        - type: plugin
          path: plugins/sync.wasm
          sha256: {}
          dirs:
            site: assets
            extra:
            - assets/nested
          files:
            config: assets/config.txt
    ", digest(&plugin_wasm())};

    let extra = vec![
        file("assets/index.html", "<h1>hi"),
        file("assets/nested/page.html", "<h1>nested"),
        file("assets/config.txt", "key = value"),
    ];
    let loaded = load(&with_plugin(&step, extra)).expect("a keyed step should be accepted");
    // `assets/nested` is inside `assets`, so it is one tree to upload, not two.
    assert_eq!(loaded.canisters[0].sync_dirs, ["assets"]);
}

/// A step may only reach canisters the bundle actually declares. An environment
/// can still leave one out, which only a deployment can know, but a name the
/// project never declares is wrong before anything is deployed.
#[test]
fn rejects_a_plugin_that_may_call_a_canister_the_bundle_does_not_declare() {
    let step = formatdoc! {"
        - type: plugin
          path: plugins/sync.wasm
          sha256: {}
          dirs:
          - assets
          canisters:
          - ledger
    ", digest(&plugin_wasm())};

    refuses(
        &with_plugin(&step, assets()),
        BundleErrorKind::Manifest,
        "declares no canister by that name",
    );
}

/// Which interface a plugin speaks decides how it is driven, so one built
/// against an interface this deployer has no bindings for is refused before its
/// canister exists rather than part-way through a deployment.
#[test]
fn rejects_a_plugin_built_against_an_unsupported_interface() {
    let future = plugin("0.9.0");
    let step = formatdoc! {"
        - type: plugin
          path: plugins/sync.wasm
          sha256: {}
          dirs:
          - assets
    ", digest(&future)};

    refuses(
        &with_plugin_wasm(&step, future, assets()),
        BundleErrorKind::Manifest,
        "does not know how to drive",
    );
}

/// A plugin that is not a component at all cannot be driven either, and says so
/// rather than failing somewhere inside jco.
#[test]
fn rejects_a_plugin_that_is_not_a_component() {
    let step = formatdoc! {"
        - type: plugin
          path: plugins/sync.wasm
          sha256: {}
          dirs:
          - assets
    ", digest(WASM)};

    refuses(
        &with_plugin_wasm(&step, WASM.to_vec(), assets()),
        BundleErrorKind::Manifest,
        "not a sync plugin",
    );
}

// ── Init args ───────────────────────────────────────────────────────────────

/// A bundle whose one canister is initialized with `args`, written as the
/// mapping under `init_args`.
fn with_init_args(args: &str) -> Vec<u8> {
    let manifest = formatdoc! {"
        canisters:
        - name: app
          init_args:
            {args}
          build:
            steps:
            - type: pre-built
              path: canisters/app.wasm
              sha256: {}
    ", digest(WASM)};
    bundle(&manifest, vec![])
}

/// Candid *text* init args are encoded by the same parser icp-cli uses, so a
/// bundle no longer has to pre-encode them.
#[test]
fn accepts_candid_text_init_args() {
    load(&with_init_args("value: '(42 : nat64)'\n    format: candid"))
        .expect("candid text init args should be accepted");
}

/// Init args are encoded at install time, which is after every canister has been
/// created and funded — so they are encoded here as well, where a bad value can
/// still refuse the bundle.
#[test]
fn rejects_candid_init_args_that_do_not_parse() {
    refuses(
        &with_init_args("value: '(this is not candid'\n    format: candid"),
        BundleErrorKind::Manifest,
        "init args of canister \"app\"",
    );
}

#[test]
fn rejects_hex_init_args_that_are_not_hex() {
    refuses(
        &with_init_args("value: 'zzzz'\n    format: hex"),
        BundleErrorKind::Manifest,
        "init args of canister \"app\"",
    );
}

/// An environment may replace a canister's init args, and that value is what
/// gets installed — so it is encoded too, not just the declared one.
#[test]
fn rejects_init_args_an_environment_overrides_with_something_unencodable() {
    let manifest = formatdoc! {"
        {}
        environments:
        - name: ic
          network: ic
          init_args:
            app:
              value: '(this is not candid'
              format: candid
    ", minimal()};
    refuses(
        &bundle(&manifest, vec![]),
        BundleErrorKind::Manifest,
        "\"ic\" environment",
    );
}
