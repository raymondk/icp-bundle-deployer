//! Which paths a sync plugin may see, and where it sees them.
//!
//! A `dirs:`/`files:` entry is written relative to the canister's own directory,
//! but the sandbox it resolves inside is the whole project — here, the bundle.
//! An entry may rise out of the canister directory with `..` and name anything
//! else the bundle carries; it may not leave the bundle. That is the rule
//! `icp-sync-plugin` applies when icp-cli runs a plugin, restated over the
//! bundle's in-memory filesystem so a bundle is refused for the same reasons and
//! a plugin is handed the same paths.
//!
//! Declared entries are configuration as much as they are a grant: the same tree
//! may legitimately be declared twice under two keys, or alongside a subtree of
//! itself, and the plugin is told about every entry as written. The grant behind
//! them has no such multiplicity, which is what [`covering_dirs`] reduces away.

use camino::Utf8Component;
use icp_project::prelude::*;

use crate::files::normalize;

/// Why a declared entry cannot be anchored inside the bundle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Escape {
    /// The entry is absolute, so joining it would discard the canister
    /// directory it was written relative to.
    NotRelative,
    /// The entry rose above the bundle root with `..`.
    AboveRoot,
}

/// Resolve an entry written relative to `base` into the bundle path it names.
///
/// Unlike [`normalize`], which clamps at the root because every path it is given
/// is already known to be inside the bundle, this reports an entry that walks
/// out of one — the difference between a path to read and a manifest to refuse.
pub fn resolve(base: &Path, declared: &str) -> Result<PathBuf, Escape> {
    let mut path = normalize(base);
    for component in Path::new(declared).components() {
        match component {
            Utf8Component::Normal(name) => path.push(name),
            Utf8Component::CurDir => {}
            Utf8Component::ParentDir => {
                if !path.pop() {
                    return Err(Escape::AboveRoot);
                }
            }
            Utf8Component::RootDir | Utf8Component::Prefix(_) => return Err(Escape::NotRelative),
        }
    }
    Ok(path)
}

// The reduction of declared directories to the trees actually mounted is
// `icp-project`'s own, since icp-cli's runtime and bundler both apply it; the
// same rule is applied here so a bundle mounts exactly what the CLI would.
pub use icp_project::canister::sync::declared::covering_dirs;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_an_entry_against_the_canister_directory() {
        let base = Path::new("/canisters/site");
        assert_eq!(resolve(base, "dist").unwrap(), "/canisters/site/dist");
        assert_eq!(resolve(base, "./dist/").unwrap(), "/canisters/site/dist");
    }

    /// The sandbox is the bundle, not the canister directory, so an entry may
    /// reach a sibling canister's tree.
    #[test]
    fn resolves_an_entry_that_rises_out_of_the_canister_directory() {
        let base = Path::new("/canisters/site");
        assert_eq!(resolve(base, "../shared").unwrap(), "/canisters/shared");
        assert_eq!(resolve(base, "../..").unwrap(), "/");
    }

    #[test]
    fn refuses_an_entry_that_leaves_the_bundle() {
        let base = Path::new("/canisters/site");
        assert_eq!(resolve(base, "../../../etc"), Err(Escape::AboveRoot));
        assert_eq!(resolve(base, "/etc"), Err(Escape::NotRelative));
    }
}
