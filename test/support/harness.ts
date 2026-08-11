/**
 * A very small test runner. The suite is short enough that a framework would cost
 * more than it gives, and this keeps `npm test` dependency-free apart from tsx.
 */

type Case = { name: string; fn: () => void | Promise<void> }

const cases: Case[] = []
let currentGroup = ''

export function group(name: string): void {
  currentGroup = name
}

export function test(name: string, fn: () => void | Promise<void>): void {
  cases.push({ name: currentGroup ? `${currentGroup} — ${name}` : name, fn })
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`)
  }
}

/** Asserts the call fails, and that the message says why in a way a user could act on. */
export async function assertRejects(
  fn: () => unknown | Promise<unknown>,
  expected: RegExp,
  message: string,
): Promise<void> {
  try {
    await fn()
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (!expected.test(text)) {
      throw new Error(`${message}\n  expected message matching ${expected}\n  actual: ${text}`)
    }
    return
  }
  throw new Error(`${message}\n  expected a rejection, but it succeeded`)
}

export async function run(title: string): Promise<void> {
  console.log(`\n${title}\n`)
  let failed = 0

  for (const { name, fn } of cases) {
    try {
      await fn()
      console.log(`  ✓ ${name}`)
    } catch (error) {
      failed++
      const text = error instanceof Error ? error.message : String(error)
      console.log(`  ✗ ${name}\n      ${text.replaceAll('\n', '\n      ')}`)
    }
  }

  console.log(`\n${cases.length - failed}/${cases.length} passed`)
  if (failed > 0) process.exitCode = 1
}
