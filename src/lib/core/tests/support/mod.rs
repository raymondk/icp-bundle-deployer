//! Building bundles in memory, so the tests need no fixture files and can
//! construct exactly the shapes worth testing.

use std::io::Write;

use flate2::{Compression, write::GzEncoder};

pub struct Entry {
    pub name: String,
    pub content: Vec<u8>,
}

pub fn file(name: &str, content: impl Into<Vec<u8>>) -> Entry {
    Entry {
        name: name.to_owned(),
        content: content.into(),
    }
}

pub fn tar(entries: Vec<Entry>) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for entry in entries {
        let mut header = tar::Header::new_ustar();
        header.set_size(entry.content.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, &entry.name, entry.content.as_slice())
            .expect("writing to a Vec cannot fail");
    }
    builder.into_inner().expect("finishing the archive")
}

/// Rewrites the size the archive's first entry header claims, leaving the entry
/// itself as it was, and repairs the checksum so a reader still accepts the
/// header. The size a tar header states is the one field a reader must not trust:
/// it arrives before any of the data it describes.
pub fn overstate_first_entry(mut tar: Vec<u8>, size: u64) -> Vec<u8> {
    let header = &mut tar[..512];
    header[124..136].copy_from_slice(format!("{size:011o}\0").as_bytes());

    // The checksum is the sum of every header byte with its own field read as
    // spaces, six octal digits followed by a NUL and a space.
    header[148..156].fill(b' ');
    let sum: u32 = header.iter().map(|byte| u32::from(*byte)).sum();
    header[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
    tar
}

pub fn gzip(data: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(data)
        .expect("writing to a Vec cannot fail");
    encoder.finish().expect("finishing the stream")
}
