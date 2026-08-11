/**
 * Builds tar archives in memory, so the bundle tests need no fixture files and can
 * construct exactly the shapes worth testing — including the ones a real tar writer
 * would not easily produce.
 */

const BLOCK = 512

export interface TarFile {
  name: string
  content: Uint8Array | string
  /** Defaults to a NUL byte, which is how the sample bundles mark a regular file. */
  typeflag?: string
}

export function createTar(files: TarFile[]): Uint8Array {
  const blocks: Uint8Array[] = []

  for (const file of files) {
    const content =
      typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content
    blocks.push(header(file.name, content.length, file.typeflag))
    blocks.push(pad(content))
  }

  // Two zero blocks mark the end of the archive.
  blocks.push(new Uint8Array(BLOCK * 2))
  return concat(blocks)
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function header(name: string, size: number, typeflag = '\0'): Uint8Array {
  const block = new Uint8Array(BLOCK)
  const write = (text: string, offset: number) => {
    block.set(new TextEncoder().encode(text), offset)
  }

  // Names longer than 100 bytes need a GNU long-name entry; callers do that
  // explicitly with typeflag 'L', so keep this path simple.
  write(name.slice(0, 100), 0)
  write('000644 \0', 100) // mode
  write('000000 \0', 108) // uid
  write('000000 \0', 116) // gid
  write(`${size.toString(8).padStart(11, '0')} `, 124)
  write('00000000000 ', 136) // mtime
  write(typeflag, 156)
  write('ustar  \0', 257)

  // Checksum is computed with its own field blank-filled.
  write('        ', 148)
  const sum = block.reduce((total, byte) => total + byte, 0)
  write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)

  return block
}

function pad(content: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(content.length / BLOCK) * BLOCK)
  padded.set(content)
  return padded
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
