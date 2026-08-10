/**
 * Reads an application bundle archive: a tar, optionally gzipped.
 *
 * Everything runs in the browser, so decompression goes through
 * `DecompressionStream` and the tar itself is parsed here — the format is small
 * enough that pulling in a Node-oriented streaming library costs more than it saves.
 */

export type ArchiveEntries = Map<string, Uint8Array>

const BLOCK_SIZE = 512

/** Offsets into a 512-byte USTAR header block. */
const HEADER = {
  name: [0, 100],
  size: [124, 136],
  typeflag: [156, 157],
  prefix: [345, 500],
} as const

export class ArchiveError extends Error {}

/** Decompresses (if needed) and unpacks an archive into `path -> contents`. */
export async function readArchive(data: Uint8Array): Promise<ArchiveEntries> {
  return readTar(isGzip(data) ? await gunzip(data) : data)
}

function isGzip(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const decompressed = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(decompressed).arrayBuffer())
}

function readTar(data: Uint8Array): ArchiveEntries {
  const entries: ArchiveEntries = new Map()
  // Set by a preceding GNU long-name ('L') or pax ('x') entry, consumed by the
  // file entry that follows it.
  let pendingName: string | undefined

  let offset = 0
  while (offset + BLOCK_SIZE <= data.length) {
    const header = data.subarray(offset, offset + BLOCK_SIZE)
    if (isZeroBlock(header)) break // end-of-archive marker

    const size = parseOctal(header, ...HEADER.size)
    const contentStart = offset + BLOCK_SIZE
    const contentEnd = contentStart + size
    if (contentEnd > data.length) {
      throw new ArchiveError('Truncated archive: an entry extends past the end of the file.')
    }
    const content = data.subarray(contentStart, contentEnd)
    // Older tars mark a regular file with a NUL typeflag rather than '0'; both
    // decode to '' here.
    const typeflag = decodeString(header.subarray(...HEADER.typeflag))

    switch (typeflag) {
      case 'L': // GNU long name — names the entry that follows
        pendingName = decodeString(content)
        break
      case 'x': // pax extended header — may carry a `path=` override
      case 'X':
        pendingName = paxPath(decodeString(content)) ?? pendingName
        break
      case '':
      case '0': {
        // A regular file. `content` is a view into `data`; copy it so callers
        // hold an independent buffer.
        const name = pendingName ?? headerName(header)
        pendingName = undefined
        entries.set(name, new Uint8Array(content))
        break
      }
      default: // directories, links, and other types carry nothing we need
        pendingName = undefined
        break
    }

    offset = contentStart + roundUpToBlock(size)
  }

  if (entries.size === 0) {
    throw new ArchiveError('The archive contains no files.')
  }
  return entries
}

function headerName(header: Uint8Array): string {
  const name = decodeString(header.subarray(...HEADER.name))
  const prefix = decodeString(header.subarray(...HEADER.prefix))
  return prefix ? `${prefix}/${name}` : name
}

/** Extracts the `path` record from a pax extended header's `len key=value\n` records. */
function paxPath(records: string): string | undefined {
  for (const line of records.split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(line)
    if (match) return match[1]
  }
  return undefined
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0)
}

function roundUpToBlock(size: number): number {
  return Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
}

function parseOctal(header: Uint8Array, start: number, end: number): number {
  const text = decodeString(header.subarray(start, end)).trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  if (!Number.isFinite(value) || value < 0) {
    throw new ArchiveError(`Malformed archive: invalid size field ${JSON.stringify(text)}.`)
  }
  return value
}

/** Decodes NUL-terminated ASCII/UTF-8 out of a header field. */
function decodeString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end))
}
