//! The bundle, as a filesystem.
//!
//! `icp-project` reads a project through [`FileSystem`] rather than `std::fs`,
//! which is what lets the same loader run here: the archive is unpacked into
//! memory once and every path the manifest names — the wasms, the sync plugins,
//! the directories a plugin uploads — is served out of that map. The bundle root
//! is `/`, so a manifest path resolves exactly as it would on disk, without any
//! of it ever touching a disk.
//!
//! The trait also has the writes a build needs, and the deploy operation does
//! run one: a pre-built step writes its module to a scratch path and the
//! operation reads it back from the same filesystem. So there is one place a
//! write lands, a scratch area kept beside the archive and gone when the run is,
//! and it is the only one. The bundle itself is never touched.

use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicUsize, Ordering},
    },
};

use async_trait::async_trait;
use camino::Utf8Component;
use icp_project::{
    files::{FileSystem, FsError, Scratch},
    prelude::*,
};
use snafu::Snafu;

/// The bundle root. Every entry is keyed by its absolute path beneath it.
pub const ROOT: &str = "/";

/// Where a build step's output goes. Nothing in an archive is unpacked here:
/// a bundle carries no path beginning with `.scratch`, and the reads that
/// resolve the manifest never look here.
pub const SCRATCH: &str = "/.scratch";

/// The unpacked archive, shared by everything that reads out of it, plus the
/// scratch area a build writes into. Cloning is cheap and clones share both;
/// the archive is never mutated after it is read.
#[derive(Clone, Debug, Default)]
pub struct BundleFiles(Arc<Inner>);

#[derive(Debug, Default)]
struct Inner {
    entries: BTreeMap<PathBuf, Vec<u8>>,
    scratch: Mutex<BTreeMap<PathBuf, Vec<u8>>>,
    scratch_dirs: AtomicUsize,
}

impl Inner {
    fn scratch(&self) -> std::sync::MutexGuard<'_, BTreeMap<PathBuf, Vec<u8>>> {
        self.scratch.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl BundleFiles {
    pub fn new(entries: BTreeMap<PathBuf, Vec<u8>>) -> Self {
        Self(Arc::new(Inner {
            entries,
            ..Inner::default()
        }))
    }

    /// A file the archive holds. The scratch area is not consulted: what the
    /// bundle carries is what these readers are asking about.
    pub fn get(&self, path: &Path) -> Option<&[u8]> {
        self.0.entries.get(&normalize(path)).map(Vec::as_slice)
    }

    pub fn contains(&self, path: &Path) -> bool {
        self.0.entries.contains_key(&normalize(path))
    }

    /// A directory exists exactly when the archive holds a file beneath it —
    /// tar directory entries carry nothing, so they are not kept. A path that
    /// names a file is not a directory, whatever the manifest calls it.
    pub fn is_dir(&self, path: &Path) -> bool {
        let prefix = normalize(path);
        has_dir(self.0.entries.keys(), &prefix)
    }

    /// Every file at or beneath `dir`, in path order, as `(path, contents)`.
    /// Used to mirror a sync step's declared directories into the plugin's
    /// sandbox.
    pub fn under(&self, dir: &Path) -> Vec<(&Path, &[u8])> {
        let prefix = normalize(dir);
        self.0
            .entries
            .iter()
            .filter(|(path, _)| path.starts_with(&prefix))
            .map(|(path, contents)| (path.as_path(), contents.as_slice()))
            .collect()
    }

    pub fn paths(&self) -> impl Iterator<Item = &Path> {
        self.0.entries.keys().map(PathBuf::as_path)
    }

    pub fn is_empty(&self) -> bool {
        self.0.entries.is_empty()
    }

    /// A scratch file, cloned out from under the lock.
    fn scratch_get(&self, path: &Path) -> Option<Vec<u8>> {
        self.0.scratch().get(path).cloned()
    }

    fn scratch_contains(&self, path: &Path) -> bool {
        self.0.scratch().contains_key(path)
    }

    fn scratch_is_dir(&self, prefix: &Path) -> bool {
        has_dir(self.0.scratch().keys(), prefix)
    }
}

/// Whether some entry lies strictly beneath `prefix`.
fn has_dir<'a>(mut keys: impl Iterator<Item = &'a PathBuf>, prefix: &Path) -> bool {
    keys.any(|entry| entry != prefix && entry.starts_with(prefix))
}

/// Whether a path is in the scratch area, the one place a write may land.
fn in_scratch(path: &Path) -> bool {
    path.starts_with(SCRATCH) && path != SCRATCH
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

/// Why the bundle could not serve a request. Wrapped in [`FsError`] at the trait
/// boundary, which displays it as itself.
#[derive(Debug, Snafu)]
pub enum BundleFsError {
    #[snafu(display("'{path}' is not in the bundle"))]
    NotInBundle { path: PathBuf },

    #[snafu(display("'{path}' is not valid UTF-8"))]
    NotText { path: PathBuf },

    #[snafu(display("cannot write '{path}': a bundle is read-only"))]
    ReadOnly { path: PathBuf },
}

impl From<BundleFsError> for FsError {
    fn from(error: BundleFsError) -> Self {
        FsError::new(error)
    }
}

/// A scratch directory: a prefix under [`SCRATCH`] that is this holder's alone,
/// emptied when the holder is dropped, as a temporary directory on disk would
/// be removed.
struct ScratchDir {
    path: PathBuf,
    files: Arc<Inner>,
}

impl Scratch for ScratchDir {
    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        self.files
            .scratch()
            .retain(|entry, _| !entry.starts_with(&self.path));
    }
}

#[async_trait]
impl FileSystem for BundleFiles {
    async fn read(&self, path: &Path) -> Result<Vec<u8>, FsError> {
        let path = normalize(path);
        if let Some(contents) = self.scratch_get(&path) {
            return Ok(contents);
        }
        Ok(self
            .get(&path)
            .map(<[u8]>::to_vec)
            .ok_or(BundleFsError::NotInBundle { path })?)
    }

    async fn read_to_string(&self, path: &Path) -> Result<String, FsError> {
        let bytes = self.read(path).await?;
        Ok(
            String::from_utf8(bytes).map_err(|_| BundleFsError::NotText {
                path: path.to_owned(),
            })?,
        )
    }

    async fn write(&self, path: &Path, contents: &[u8]) -> Result<(), FsError> {
        let path = normalize(path);
        if !in_scratch(&path) {
            return Err(BundleFsError::ReadOnly { path }.into());
        }
        self.0.scratch().insert(path, contents.to_vec());
        Ok(())
    }

    /// A directory is implied by the files beneath it, so in the scratch area
    /// there is nothing to create; anywhere else there is nothing that may be.
    async fn create_dir_all(&self, path: &Path) -> Result<(), FsError> {
        let path = normalize(path);
        if in_scratch(&path) || path == SCRATCH {
            return Ok(());
        }
        Err(BundleFsError::ReadOnly { path }.into())
    }

    async fn copy(&self, from: &Path, to: &Path) -> Result<(), FsError> {
        let contents = self.read(from).await?;
        self.write(to, &contents).await
    }

    async fn exists(&self, path: &Path) -> bool {
        let path = normalize(path);
        self.contains(&path)
            || BundleFiles::is_dir(self, &path)
            || self.scratch_contains(&path)
            || self.scratch_is_dir(&path)
    }

    async fn is_file(&self, path: &Path) -> bool {
        let path = normalize(path);
        self.contains(&path) || self.scratch_contains(&path)
    }

    async fn is_dir(&self, path: &Path) -> bool {
        let path = normalize(path);
        BundleFiles::is_dir(self, &path) || self.scratch_is_dir(&path)
    }

    async fn read_dir(&self, path: &Path) -> Result<Vec<PathBuf>, FsError> {
        let prefix = normalize(path);
        let scratch = self.0.scratch();
        let mut children: Vec<PathBuf> = self
            .0
            .entries
            .keys()
            .chain(scratch.keys())
            .filter_map(|entry| entry.strip_prefix(&prefix).ok())
            .filter_map(|relative| relative.components().next())
            .map(|first| prefix.join(first.as_str()))
            .collect();
        children.sort();
        children.dedup();
        Ok(children)
    }

    /// Nothing in the bundle is a symlink and every path is already normalized,
    /// so identity is just the normalized path.
    async fn canonicalize(&self, path: &Path) -> Option<PathBuf> {
        let path = normalize(path);
        (path == ROOT || self.exists(&path).await).then_some(path)
    }

    /// A fresh prefix under [`SCRATCH`], numbered so two builds running at once
    /// never share one, as two temporary directories on disk would not.
    async fn scratch_dir(&self) -> Result<Box<dyn Scratch>, FsError> {
        let n = self.0.scratch_dirs.fetch_add(1, Ordering::Relaxed);
        Ok(Box::new(ScratchDir {
            path: PathBuf::from(format!("{SCRATCH}/{n}")),
            files: Arc::clone(&self.0),
        }))
    }
}

#[cfg(test)]
mod tests {
    use futures::executor::block_on;

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

    /// A build writes its output to a scratch path and the operation reads it
    /// back through the same filesystem, so a copy into scratch has to be
    /// readable there — and nowhere else may be written.
    #[test]
    fn a_build_output_lands_in_scratch_and_nowhere_else() {
        let files = files();
        block_on(async {
            let scratch = files.scratch_dir().await.unwrap();
            let output = scratch.path().join("out.wasm");
            files
                .copy(Path::new("canisters/app.wasm"), &output)
                .await
                .unwrap();
            assert!(files.exists(&output).await);
            assert!(files.is_file(&output).await);
            assert!(FileSystem::is_dir(&files, scratch.path()).await);
            assert_eq!(files.read(&output).await.unwrap(), b"wasm");
            // The archive is what it was.
            assert!(files.get(&output).is_none());
            assert!(
                files
                    .write(Path::new("canisters/other.wasm"), b"no")
                    .await
                    .is_err()
            );

            drop(scratch);
            assert!(
                !files.exists(&output).await,
                "scratch is emptied with its holder"
            );
        });
    }

    #[test]
    fn scratch_directories_are_distinct() {
        let files = files();
        block_on(async {
            let a = files.scratch_dir().await.unwrap();
            let b = files.scratch_dir().await.unwrap();
            assert_ne!(a.path(), b.path());
        });
    }
}
