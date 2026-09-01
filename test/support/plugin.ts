/**
 * A stand-in sync plugin.
 *
 * Nothing in the offline suite runs one, but loading a bundle reads the
 * interface version off the plugin's component to decide whether it could be
 * run at all — so the stand-in has to be a real component declaring a real
 * version, not an arbitrary blob. This is the smallest one that is: a component
 * importing the `icp:sync-plugin/types` instance and nothing else.
 */

/** A component declaring `icp:sync-plugin/types@<version>` and nothing else. */
export function syncPlugin(version: string): Uint8Array {
  const name = new TextEncoder().encode(`icp:sync-plugin/types@${version}`)

  return new Uint8Array([
    // `\0asm`, then the component preamble: version 0x000d, layer 0x0001.
    0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00,
    // Component type section: one instance type, declaring nothing.
    ...section(0x07, [0x01, 0x42, 0x00]),
    // Component import section: one import of that instance type, by name.
    ...section(0x0a, [0x01, 0x00, ...uleb(name.length), ...name, 0x05, 0x00]),
  ])
}

/** A section: its id, its length, and its body. */
function section(id: number, body: number[]): number[] {
  return [id, ...uleb(body.length), ...body]
}

/** An unsigned LEB128 integer, which is how wasm writes every length. */
function uleb(value: number): number[] {
  const bytes: number[] = []
  do {
    const byte = value & 0x7f
    value >>>= 7
    bytes.push(value === 0 ? byte : byte | 0x80)
  } while (value !== 0)
  return bytes
}
