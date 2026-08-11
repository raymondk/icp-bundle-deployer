/**
 * Node resolves @bytecodealliance/preview2-shim to its Node build, which lacks the
 * in-memory filesystem and stdout hooks the browser build provides. Forcing the
 * browser build makes the e2e suite exercise the same code the page runs.
 */
import { register } from 'node:module'

register('./shim-loader.mjs', import.meta.url)
