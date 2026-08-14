//! Reading an application bundle archive: a tar, optionally gzipped.

use std::{
    collections::BTreeMap,
    io::{Cursor, Read},
};

use flate2::read::GzDecoder;
use icp_deploy_canister::prelude::*;
use snafu::Snafu;

use crate::files::{BundleFiles, normalize};

#[derive(Debug, Snafu)]
pub enum ArchiveError {
    #[snafu(display("the bundle could not be decompressed: {message}"))]
    Gunzip { message: String },

    #[snafu(display(
        "the bundle is not a readable tar archive: {message}. An application bundle is a tar, \
         optionally gzipped."
    ))]
    Tar { message: String },

    #[snafu(display("the archive holds an entry whose name is not valid UTF-8"))]
    Name,

    #[snafu(display("the archive contains no files."))]
    Empty,
}

/// Decompress (if needed) and unpack an archive into its files, keyed by
/// absolute path beneath the bundle root.
///
/// Directory, link, and device entries carry nothing the deployment needs and
/// are skipped; the long-name and pax extensions a real tar writer emits are
/// handled by the tar reader itself.
pub fn read_archive(data: &[u8]) -> Result<BundleFiles, ArchiveError> {
    let tar = if is_gzip(data) {
        let mut out = Vec::new();
        GzDecoder::new(Cursor::new(data))
            .read_to_end(&mut out)
            .map_err(|e| ArchiveError::Gunzip {
                message: e.to_string(),
            })?;
        out
    } else {
        data.to_vec()
    };

    let mut entries = BTreeMap::new();
    let unpacked = tar.len();
    let mut archive = tar::Archive::new(Cursor::new(tar));
    for entry in archive.entries().map_err(tar_error)? {
        let mut entry = entry.map_err(tar_error)?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry
            .path()
            .map_err(|_| ArchiveError::Name)?
            .to_str()
            .ok_or(ArchiveError::Name)?
            .to_owned();

        // The size is what the entry's header claims, before a byte of it has
        // been read: a corrupt or hostile header naming gigabytes would abort the
        // module on a 32-bit heap instead of being reported as the truncation it
        // is. The archive it came out of is the ceiling.
        let claimed = usize::try_from(entry.size()).unwrap_or(usize::MAX);
        let mut contents = Vec::with_capacity(claimed.min(unpacked));
        entry.read_to_end(&mut contents).map_err(tar_error)?;
        entries.insert(normalize(Path::new(&path)), contents);
    }

    let files = BundleFiles::new(entries);
    if files.is_empty() {
        return Err(ArchiveError::Empty);
    }
    Ok(files)
}

fn is_gzip(data: &[u8]) -> bool {
    data.starts_with(&[0x1f, 0x8b])
}

/// A truncated archive surfaces as an unexpected end of file — sometimes as an
/// `ErrorKind`, sometimes only in the reader's own wording — which says nothing
/// on its own; name it for what it is.
fn tar_error(error: std::io::Error) -> ArchiveError {
    let truncated = error.kind() == std::io::ErrorKind::UnexpectedEof
        || error.to_string().to_lowercase().contains("unexpected eof");
    let message = if truncated {
        "it is truncated, ending part-way through an entry".to_owned()
    } else {
        error.to_string()
    };
    ArchiveError::Tar { message }
}
