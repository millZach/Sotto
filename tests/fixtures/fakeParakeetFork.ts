import { type ChildProcess, fork } from 'node:child_process'
import { resolve } from 'node:path'

import type { ForkHelper, HelperProcess } from '../../src/main/asr/parakeetEngine'

const fixture = resolve('tests/fixtures/fakeParakeetHelper.mjs')

/**
 * Starts `fakeParakeetHelper.mjs` as a real child process in place of Electron's utility process. The IPC channel uses
 * advanced serialization, the structured clone Electron's parent port uses, so a Float32Array arrives as one.
 * `mode` is read at each start, so a test can change what the next helper does.
 */
export function fakeParakeetFork(mode: () => string = () => 'ready'): { fork: ForkHelper; children: ChildProcess[] } {
  const children: ChildProcess[] = []
  const forkHelper: ForkHelper = (_modulePath, args) => {
    const child = fork(fixture, args, {
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, FAKE_PARAKEET_MODE: mode() },
    })
    children.push(child)
    const helper: HelperProcess = {
      postMessage: (request) => { child.send(request) },
      kill: () => child.kill(),
      on(event: 'message' | 'exit' | 'error', listener: (value: never) => void) {
        child.on(event, listener as (value: unknown) => void)
        return helper
      },
    }
    return helper
  }
  return { fork: forkHelper, children }
}

/** True while the process is still running. */
export function running(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

/** Resolves once the process has exited, at once if it already has. */
export function exited(child: ChildProcess): Promise<void> {
  return running(child) ? new Promise((done) => { child.once('exit', () => done()) }) : Promise.resolve()
}
