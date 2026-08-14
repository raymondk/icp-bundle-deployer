//! Manifest settings, as the management canister wants them.
//!
//! A deployment applies a canister's settings in two goes, and the split is the
//! point: everything else first, controllers last. Handing over control is the
//! one change that can lock the deployer out of a canister it is still setting
//! up, so it happens once there is nothing left to do.
//!
//! Environment variables are in neither half — `icp-deploy-canister` writes them
//! itself, merged with the canister ids it injects.

use candid::{Nat, Principal};
use ic_management_canister_types::{CanisterSettings, LogVisibility, UpdateSettingsArgs};
use icp_deploy_canister::{Canister, canister::resolve_controllers, ids::IdMapping};

/// Every setting the manifest declares except environment variables and
/// controllers. `None` when the manifest declared none, so a canister with no
/// settings costs no call.
pub fn configuration(canister: &Canister) -> Option<CanisterSettings> {
    let s = &canister.settings;
    let settings = CanisterSettings {
        log_visibility: s.log_visibility.clone().map(LogVisibility::from),
        compute_allocation: s.compute_allocation.map(Nat::from),
        memory_allocation: s.memory_allocation.as_ref().map(|m| Nat::from(m.get())),
        freezing_threshold: s.freezing_threshold.as_ref().map(|d| Nat::from(d.get())),
        reserved_cycles_limit: s.reserved_cycles_limit.as_ref().map(|c| Nat::from(c.get())),
        wasm_memory_limit: s.wasm_memory_limit.as_ref().map(|m| Nat::from(m.get())),
        wasm_memory_threshold: s.wasm_memory_threshold.as_ref().map(|m| Nat::from(m.get())),
        log_memory_limit: s.log_memory_limit.as_ref().map(|m| Nat::from(m.get())),
        controllers: None,
        environment_variables: None,
        snapshot_visibility: None,
    };

    declares_anything(&settings).then_some(settings)
}

/// The controllers the manifest hands the canister over to, resolved against the
/// ids this deployment created. A manifest may name another canister in the
/// bundle rather than a principal, which is why this needs the id mapping.
///
/// `None` when the manifest names no controllers, which leaves the deployer in
/// control — the same thing `icp deploy` leaves behind.
pub fn controllers(
    canister: &Canister,
    ids: &IdMapping,
) -> Result<Option<CanisterSettings>, String> {
    let Some(declared) = &canister.settings.controllers else {
        return Ok(None);
    };

    let (resolved, unresolved) = resolve_controllers(declared, ids);
    if !unresolved.is_empty() {
        return Err(format!(
            "its controllers name {}, which this deployment did not create",
            unresolved.join(", ")
        ));
    }

    Ok(Some(CanisterSettings {
        controllers: Some(resolved),
        ..Default::default()
    }))
}

/// The candid-encoded `update_settings` argument for a canister.
pub fn update_settings_arg(
    canister_id: Principal,
    settings: CanisterSettings,
) -> Result<Vec<u8>, String> {
    candid::encode_one(UpdateSettingsArgs {
        canister_id,
        settings,
        sender_canister_version: None,
    })
    .map_err(|e| format!("could not encode the settings: {e}"))
}

fn declares_anything(settings: &CanisterSettings) -> bool {
    let CanisterSettings {
        log_visibility,
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
        || compute_allocation.is_some()
        || memory_allocation.is_some()
        || freezing_threshold.is_some()
        || reserved_cycles_limit.is_some()
        || wasm_memory_limit.is_some()
        || wasm_memory_threshold.is_some()
        || log_memory_limit.is_some()
}
