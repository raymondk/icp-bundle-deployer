//! Deploying an application bundle to the Internet Computer.
//!
//! This is the deployment core of the library in `src/lib`, compiled to
//! WebAssembly. It reads a bundle, holds it to the rules a bundle has to follow,
//! and then deploys it through `icp-deploy-canister` — the same crate icp-cli
//! deploys with, so a bundle is installed and synced the way the CLI would
//! install and sync it, not the way a reimplementation guessed.
//!
//! Everything that needs the network or a component runtime is the host's:
//! signing calls, creating canisters, running sync plugins. See [`host`].
//!
//! Reading and checking a bundle needs none of that, so those modules build for
//! any target and are tested with `cargo test`. The rest talks to JavaScript —
//! whose values are neither `Send` nor `Sync`, which only holds together on a
//! single-threaded target — and is compiled for wasm alone.

pub mod archive;
pub mod bundle;
pub mod files;
pub mod settings;

#[cfg(target_family = "wasm")]
mod api;
#[cfg(target_family = "wasm")]
mod deploy;
#[cfg(target_family = "wasm")]
mod events;
#[cfg(target_family = "wasm")]
mod host;
#[cfg(target_family = "wasm")]
mod plugin;

/// A byte count, for showing how big a wasm is.
pub fn format_bytes(bytes: usize) -> String {
    const KIB: usize = 1024;
    const MIB: usize = 1024 * 1024;
    match bytes {
        ..KIB => format!("{bytes} B"),
        KIB..MIB => format!("{:.1} KiB", bytes as f64 / KIB as f64),
        _ => format!("{:.1} MiB", bytes as f64 / MIB as f64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_byte_counts() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1536), "1.5 KiB");
        assert_eq!(format_bytes(3 * 1024 * 1024), "3.0 MiB");
    }
}
