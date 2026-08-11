import { pathToFileURL } from 'node:url'

const PREFIX = '@bytecodealliance/preview2-shim/'
const BROWSER_DIST = new URL(
  './node_modules/@bytecodealliance/preview2-shim/dist/browser/',
  pathToFileURL(`${process.cwd()}/`),
)

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(PREFIX)) {
    return {
      url: new URL(`${specifier.slice(PREFIX.length)}.js`, BROWSER_DIST).href,
      shortCircuit: true,
    }
  }
  return nextResolve(specifier, context)
}
