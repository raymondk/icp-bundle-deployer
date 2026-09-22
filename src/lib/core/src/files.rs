//! The bundle, as a filesystem.
//!
//! `icp-deploy-canister` reads a project through [`FileAccess`] rather than
//! `std::fs`, which is what lets the same loader run here: the archive is
//! unpacked into memory once and every path the manifest names — the wasms, the
//! sync plugins, the directories a plugin uploads — is served out of that map.
//! The bundle root is `/`, so a manifest path resolves exactly as it would on
//! disk, without any of it ever touching a disk.

use std::{collections::BTreeMap, sync::Arc};

use async_trait::async_trait;
use camino::Utf8Component;
use icp_deploy_canister::{
    files::{FileAccess, FileAccessError},
    prelude::*,
};

/// The bundle root. Every entry is keyed by its absolute path beneath it.
pub const ROOT: &str = "/";

/// The unpacked archive, shared by everything that reads out of it. Cloning is
/// cheap; the contents are never mutated after the archive is read.
#[derive(Clone, Debug, Default)]
pub struct BundleFiles(Arc<BTreeMap<PathBuf, Vec<u8>>>);

impl BundleFiles {
    pub fn new(entries: BTreeMap<PathBuf, Vec<u8>>) -> Self {
        Self(Arc::new(entries))
    }

    pub fn get(&self, path: &Path) -> Option<&[u8]> {
        self.0.get(&normalize(path)).map(Vec::as_slice)
    }

    pub fn contains(&self, path: &Path) -> bool {
        self.0.contains_key(&normalize(path))
    }

    /// Every file at or beneath `dir`, in path order, as `(path, contents)`.
    /// Used to mirror a sync step's declared directories into the plugin's
    /// sandbox.
    pub fn under(&self, dir: &Path) -> Vec<(&Path, &[u8])> {
        let prefix = normalize(dir);
        self.0
            .iter()
            .filter(|(path, _)| path.starts_with(&prefix))
            .map(|(path, contents)| (path.as_path(), contents.as_slice()))
            .collect()
    }

    pub fn paths(&self) -> impl Iterator<Item = &Path> {
        self.0.keys().map(PathBuf::as_path)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Resolve a path into the absolute form the map is keyed by: `.` dropped, `..`
/// applied, and always rooted at [`ROOT`]. A manifest names its artifacts
/// relative to the canister directory, and joining those against the bundle root
/// produces paths like `/./canisters/app.wasm` that must resolve to the same
/// entry the archive was read into.
pub fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::from(ROOT);
    for component in path.components() {
        match component {
            Utf8Component::Normal(part) => out.push(part),
            Utf8Component::ParentDir => {
                out.pop();
            }
            // A prefix or root only re-anchors at the root we already start from.
            Utf8Component::CurDir | Utf8Component::RootDir | Utf8Component::Prefix(_) => {}
        }
    }
    out
}

#[cfg_attr(target_family = "wasm", async_trait(?Send))]
#[cfg_attr(not(target_family = "wasm"), async_trait)]
impl FileAccess for BundleFiles {
    async fn read_file(&self, path: &Path) -> Result<Vec<u8>, FileAccessError> {
        self.get(path)
            .map(<[u8]>::to_vec)
            .ok_or_else(|| FileAccessError::Read {
                path: path.to_owned(),
                message: "not in the bundle".to_owned(),
            })
    }

    async fn read_to_string(&self, path: &Path) -> Result<String, FileAccessError> {
        let bytes = self.read_file(path).await?;
        String::from_utf8(bytes).map_err(|_| FileAccessError::Read {
            path: path.to_owned(),
            message: "not valid UTF-8".to_owned(),
        })
    }

    async fn exists(&self, path: &Path) -> bool {
        self.is_file(path).await || self.is_dir(path).await
    }

    async fn is_file(&self, path: &Path) -> bool {
        self.contains(path)
    }

    /// A directory exists exactly when the archive holds a file beneath it —
    /// tar directory entries carry nothing, so they are not kept.
    async fn is_dir(&self, path: &Path) -> bool {
        let prefix = normalize(path);
        self.0
            .keys()
            .any(|entry| entry != &prefix && entry.starts_with(&prefix))
    }

    async fn read_dir(&self, path: &Path) -> Result<Vec<PathBuf>, FileAccessError> {
        let prefix = normalize(path);
        let mut children: Vec<PathBuf> = self
            .0
            .keys()
            .filter_map(|entry| entry.strip_prefix(&prefix).ok())
            .filter_map(|relative| relative.components().next())
            .map(|first| prefix.join(first.as_str()))
            .collect();
        children.dedup();
        Ok(children)
    }

    /// Nothing in the bundle is a symlink and every path is already normalized,
    /// so identity is just the normalized path.
    async fn canonicalize(&self, path: &Path) -> Option<PathBuf> {
        let path = normalize(path);
        (self.contains(&path) || self.is_dir(&path).await || path == ROOT).then_some(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files() -> BundleFiles {
        BundleFiles::new(BTreeMap::from([
            ("/icp.yaml".into(), b"canisters: []".to_vec()),
            ("/canisters/app.wasm".into(), b"wasm".to_vec()),
            ("/canisters/site/dist/index.html".into(), b"<html>".to_vec()),
        ]))
    }

    #[test]
    fn normalizes_relative_and_dotted_paths() {
        assert_eq!(
            normalize(Path::new("canisters/app.wasm")),
            "/canisters/app.wasm"
        );
        assert_eq!(
            normalize(Path::new("/./canisters/app.wasm")),
            "/canisters/app.wasm"
        );
        assert_eq!(normalize(Path::new("/canisters/../icp.yaml")), "/icp.yaml");
    }

    #[test]
    fn finds_files_under_a_directory() {
        let files = files();
        let under = files.under(Path::new("canisters/site/dist"));
        assert_eq!(under.len(), 1);
        assert_eq!(under[0].0, "/canisters/site/dist/index.html");
    }
}
