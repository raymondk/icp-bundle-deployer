//! Which version of the sync-plugin interface a plugin speaks.
//!
//! `icp:sync-plugin` has two versions in use, and they differ in what `exec` is
//! handed and in whether a request names its own target — so a plugin cannot be
//! run at all until this is settled. It is read off the `icp:sync-plugin/types`
//! instance the component declares, which is where icp-cli reads it too, and the
//! only place it can be read: a component declares just the host functions it
//! actually calls, so which of them it asks for says nothing about which
//! interface it was built against.
//!
//! Only the component's import names are scanned, not its code — this is a
//! question about the wasm's declared shape, and the plugin still has to satisfy
//! the real bindings before it runs.

use snafu::Snafu;

/// The interface versions this deployer knows how to drive. A version is matched
/// the way a caret requirement matches, so every release of a minor version is
/// understood by the host built for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginAbi {
    /// `icp:sync-plugin@0.1.x`: no keys, fields, canister table, or call target.
    V1,
    /// `icp:sync-plugin@0.2.x`.
    V2,
}

impl PluginAbi {
    /// The name the host adapter knows this version by.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::V1 => "v1",
            Self::V2 => "v2",
        }
    }
}

/// The instance whose version answers the question.
const TYPES_INTERFACE: &str = "icp:sync-plugin/types@";

#[derive(Debug, Snafu)]
pub enum AbiError {
    #[snafu(display("it is not a WebAssembly component"))]
    NotAComponent,

    #[snafu(display(
        "it does not implement the icp:sync-plugin interface, so it is not a sync plugin"
    ))]
    NotAPlugin,

    #[snafu(display(
        "it was built against version {version} of the sync-plugin interface, which this deployer \
         does not know how to drive"
    ))]
    Unsupported { version: String },
}

pub fn plugin_abi(wasm: &[u8]) -> Result<PluginAbi, AbiError> {
    let mut declared = None;
    for payload in wasmparser::Parser::new(0).parse_all(wasm) {
        let payload = payload.map_err(|_| AbiError::NotAComponent)?;
        let wasmparser::Payload::ComponentImportSection(section) = payload else {
            continue;
        };
        for import in section {
            let import = import.map_err(|_| AbiError::NotAComponent)?;
            if let Some(version) = import.name.name.strip_prefix(TYPES_INTERFACE) {
                declared = Some(version.to_owned());
            }
        }
    }

    let version = declared.ok_or(AbiError::NotAPlugin)?;
    let mut parts = version.split('.');
    match (parts.next(), parts.next()) {
        (Some("0"), Some("1")) => Ok(PluginAbi::V1),
        (Some("0"), Some("2")) => Ok(PluginAbi::V2),
        _ => Err(AbiError::Unsupported { version }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_something_that_is_not_a_component() {
        let error = plugin_abi(&[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])
            .expect_err("a core module is not a plugin");
        // A bare core module parses, but declares no component imports at all.
        assert!(matches!(error, AbiError::NotAPlugin), "got {error:?}");
    }

    #[test]
    fn refuses_bytes_that_are_not_wasm() {
        assert!(matches!(
            plugin_abi(b"not wasm at all").expect_err("garbage is not a plugin"),
            AbiError::NotAComponent
        ));
    }
}
