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

pub fn gzip(data: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(data)
        .expect("writing to a Vec cannot fail");
    encoder.finish().expect("finishing the stream")
}
