//! Manifest settings, as the management canister wants them.
//!
//! A deployment applies a canister's settings in two goes, and the split is the
//! point: everything else first, controllers last. Handing over control is the
//! one change that can lock the deployer out of a canister it is still setting
//! up, so it happens once there is nothing left to do.
//!
//! Environment variables are in neither half — `icp-project` writes them itself,
//! merged with the canister ids it injects.

use candid::{Nat, Principal};
use ic_management_canister_types::{
    CanisterSettings, LogVisibility, SnapshotVisibility, StatusVisibility,
};
use icp_project::{Canister, canister::resolve_controllers, store_id::IdMapping};

/// Every setting the manifest declares except environment variables and
/// controllers. `None` when the manifest declared none, so a canister with no
/// settings costs no call.
pub fn configuration(canister: &Canister) -> Option<CanisterSettings> {
    let s = &canister.settings;
    let settings = CanisterSettings {
        log_visibility: s.log_visibility.clone().map(|v| LogVisibility::from(v.0)),
        snapshot_visibility: s
            .snapshot_visibility
            .clone()
            .map(|v| SnapshotVisibility::from(v.0)),
        status_visibility: s
            .status_visibility
            .clone()
            .map(|v| StatusVisibility::from(v.0)),
        compute_allocation: s.compute_allocation.map(Nat::from),
        memory_allocation: s.memory_allocation.as_ref().map(|m| Nat::from(m.get())),
        freezing_threshold: s.freezing_threshold.as_ref().map(|d| Nat::from(d.get())),
        reserved_cycles_limit: s.reserved_cycles_limit.as_ref().map(|c| Nat::from(c.get())),
        wasm_memory_limit: s.wasm_memory_limit.as_ref().map(|m| Nat::from(m.get())),
        wasm_memory_threshold: s.wasm_memory_threshold.as_ref().map(|m| Nat::from(m.get())),
        log_memory_limit: s.log_memory_limit.as_ref().map(|m| Nat::from(m.get())),
        controllers: None,
        environment_variables: None,
        ..Default::default()
    };

    declares_anything(&settings).then_some(settings)
}

/// The controllers the manifest hands the canister over to, resolved against the
/// ids this deployment created. A manifest may name another canister in the
/// bundle rather than a principal, which is why this needs the id mapping.
///
/// `None` when the manifest names no controllers, which leaves the deployer in
/// control — the same thing `icp deploy` leaves behind.
///
/// `caller` is added to whatever the manifest declares, because
/// `update_settings` replaces a controller list rather than adding to it and the
/// deployer is the only controller a canister it just created has. Sending the
/// declared list verbatim would hand a canister the deployer paid for to the
/// bundle's author and lock the deployer out of it — and `controllers: []`,
/// which a manifest may legally say, would lock everyone out permanently. This
/// is what icp-cli does for the same reason, on both the create and the update
/// path.
pub fn controllers(
    canister: &Canister,
    ids: &IdMapping,
    caller: Principal,
) -> Result<Option<CanisterSettings>, String> {
    let Some(declared) = &canister.settings.controllers else {
        return Ok(None);
    };

    let (mut resolved, unresolved) = resolve_controllers(declared, ids);
    if !unresolved.is_empty() {
        return Err(format!(
            "its controllers name {}, which this deployment did not create",
            unresolved.join(", ")
        ));
    }
    if !resolved.contains(&caller) {
        resolved.push(caller);
    }

    Ok(Some(CanisterSettings {
        controllers: Some(resolved),
        ..Default::default()
    }))
}

fn declares_anything(settings: &CanisterSettings) -> bool {
    let CanisterSettings {
        log_visibility,
        snapshot_visibility,
        status_visibility,
        compute_allocation,
        memory_allocation,
        freezing_threshold,
        reserved_cycles_limit,
        wasm_memory_limit,
        wasm_memory_threshold,
        log_memory_limit,
        ..
    } = settings;

    log_visibility.is_some()
        || snapshot_visibility.is_some()
        || status_visibility.is_some()
        || compute_allocation.is_some()
        || memory_allocation.is_some()
        || freezing_threshold.is_some()
        || reserved_cycles_limit.is_some()
        || wasm_memory_limit.is_some()
        || wasm_memory_threshold.is_some()
        || log_memory_limit.is_some()
}
