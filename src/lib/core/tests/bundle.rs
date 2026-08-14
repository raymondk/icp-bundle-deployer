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
use support::{Entry, file, gzip, tar};

const WASM: &[u8] = &[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
const PLUGIN: &[u8] = &[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x01];

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

#[test]
fn rejects_a_bundle_with_no_canisters() {
    refuses(
        &bundle("canisters: []", vec![]),
        BundleErrorKind::Manifest,
        "no canisters",
    );
}

#[test]
fn rejects_project_dependencies() {
    let manifest = formatdoc! {"
        {}
        dependencies:
        - name: other
          path: ../other
    ", minimal()};
    refuses(
        &bundle(&manifest, vec![]),
        BundleErrorKind::Manifest,
        "dependencies",
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

/// A bundle whose one canister syncs through `step`, which is written
/// flush-left and indented into place here — the sync steps of a manifest sit
/// four spaces in.
fn with_plugin(step: &str, extra: Vec<Entry>) -> Vec<u8> {
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

    let mut entries = vec![file("plugins/sync.wasm", PLUGIN)];
    entries.extend(extra);
    bundle(&manifest, entries)
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
    ", digest(PLUGIN)};

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
    ", digest(PLUGIN)};
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
    ", digest(PLUGIN)};
    refuses(
        &with_plugin(&step, vec![]),
        BundleErrorKind::Manifest,
        "not in the bundle",
    );
}

// ── Init args ───────────────────────────────────────────────────────────────

/// Candid *text* init args are encoded by the same parser icp-cli uses, so a
/// bundle no longer has to pre-encode them.
#[test]
fn accepts_candid_text_init_args() {
    let manifest = formatdoc! {"
        canisters:
        - name: app
          init_args:
            value: '(42 : nat64)'
            format: candid
          build:
            steps:
            - type: pre-built
              path: canisters/app.wasm
              sha256: {}
    ", digest(WASM)};
    load(&bundle(&manifest, vec![])).expect("candid text init args should be accepted");
}
