/**
 * Warning before the page is left while a deployment is running.
 *
 * Closing or reloading the tab kills a deployment mid-flight: the module's
 * phases are not safely interruptible, and an outbound call is not guaranteed
 * to complete once the page is going away. So nothing here tries to finish or
 * roll back anything on `unload`. The whole feature is the browser's own
 * leave-page confirmation, armed for exactly as long as a deployment is
 * pending, so an accidental close does not leave a half-installed application
 * behind without a word.
 *
 * Only a deployment arms it. Sign-in, sign-out and bundle selection also keep
 * the page busy, and none of them leaves anything behind when interrupted.
 */

/**
 * Where the handler goes: `window` in the page, a stand-in in a test. Only the
 * two methods the guard uses, so the offline suite — which has no DOM — can
 * hand in one of its own.
 */
export interface UnloadTarget {
  addEventListener(type: 'beforeunload', listener: (event: BeforeUnloadEvent) => void): void
  removeEventListener(type: 'beforeunload', listener: (event: BeforeUnloadEvent) => void): void
}

/**
 * Asks the browser to confirm leaving the page while `pending` is outstanding.
 *
 * The handler is attached before this returns and detached once the promise
 * settles either way; the promise itself comes back unchanged, so the call
 * wraps an existing `await` without altering what it yields or throws.
 */
export function guardUnload<T>(target: UnloadTarget, pending: Promise<T>): Promise<T> {
  target.addEventListener('beforeunload', warn)
  return pending.finally(() => target.removeEventListener('beforeunload', warn))
}

/**
 * The browser shows its own dialog and ignores any text of ours. Calling
 * `preventDefault` is the standard way to ask for it; setting `returnValue` is
 * what older engines look at instead. Browsers only honour either after the
 * user has interacted with the page, which a deployment guarantees: it takes a
 * click to start one.
 */
function warn(event: BeforeUnloadEvent): void {
  event.preventDefault()
  event.returnValue = true
}
