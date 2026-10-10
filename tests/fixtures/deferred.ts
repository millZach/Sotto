export interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
  readonly reject: (reason?: unknown) => void
}

/** A fresh gate. The caller must release or reject held work before disposing its owner. */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** Signals entry before waiting, so a test can assert the held operation's pending state. */
export function heldOperation() {
  const entered = deferred()
  const released = deferred()
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    wait: async () => { entered.resolve(); await released.promise },
  }
}
