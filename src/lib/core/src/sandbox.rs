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
use icp_deploy_canister::prelude::*;

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

/// The meaningful components of a declared entry: the `/`-separated names with
/// empty and `.` components dropped, so `./data/` and `data` compare equal.
///
/// `\` is deliberately not a separator. These comparisons decide what gets
/// mounted for a guest that will open the entry exactly as written.
fn components(path: &str) -> Vec<&str> {
    path.split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect()
}

/// Reduce declared directories to the ones that actually have to be mounted.
///
/// Mounting a directory twice, or mounting one already reachable through an
/// ancestor, conveys no further access. Callers keep the declared list as
/// configuration and mount only what this returns; a nested declared directory
/// is reached through the ancestor covering it.
///
/// Retained entries keep their written spelling and first-occurrence order,
/// because the guest opens each at the spelling the manifest gave it. Comparison
/// is component-wise, so `data` covers `./data/inner` but not `database`. A
/// spelling prefix alone is not containment once entries may contain `..`: `..`
/// is a prefix of `../../shared`, yet one is the canister directory's parent and
/// the other a child of its grandparent, and neither holds the other.
pub fn covering_dirs<'a>(dirs: impl IntoIterator<Item = &'a str>) -> Vec<&'a str> {
    let dirs: Vec<&str> = dirs.into_iter().collect();
    let parts: Vec<Vec<&str>> = dirs.iter().map(|dir| components(dir)).collect();
    dirs.iter()
        .enumerate()
        .filter(|(i, _)| {
            !parts.iter().enumerate().any(|(j, other)| {
                j != *i
                    && parts[*i].starts_with(other)
                    && !parts[*i][other.len()..].contains(&"..")
                    // A strict ancestor always covers; between equals, the
                    // first written wins.
                    && (other.len() < parts[*i].len() || j < *i)
            })
        })
        .map(|(_, dir)| *dir)
        .collect()
}

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

    #[test]
    fn keeps_unrelated_directories() {
        assert_eq!(
            covering_dirs(["assets", "config", "data/seed"]),
            ["assets", "config", "data/seed"]
        );
    }

    #[test]
    fn collapses_duplicates_to_the_first_spelling() {
        assert_eq!(covering_dirs(["./data", "data", "data/"]), ["./data"]);
    }

    #[test]
    fn collapses_a_nested_directory_into_its_ancestor() {
        assert_eq!(covering_dirs(["data", "data/inner"]), ["data"]);
        assert_eq!(covering_dirs(["data/inner", "data"]), ["data"]);
        assert_eq!(covering_dirs(["data/a/b", "data/a", "data"]), ["data"]);
    }

    #[test]
    fn a_name_prefix_is_not_an_ancestor() {
        assert_eq!(covering_dirs(["data", "database"]), ["data", "database"]);
    }

    /// `..` is a spelling prefix of `../../shared` but not an ancestor of it:
    /// one is the canister directory's parent, the other a child of its
    /// grandparent.
    #[test]
    fn a_rising_entry_does_not_cover_one_that_rises_further() {
        assert_eq!(
            covering_dirs(["..", "../../shared"]),
            ["..", "../../shared"]
        );
        assert_eq!(covering_dirs(["..", "../shared"]), [".."]);
    }
}
