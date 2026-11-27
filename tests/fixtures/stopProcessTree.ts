// Ends a host or engine a test started, with everything it started, and answers once it has exited.
import { execFile, type ChildProcess } from 'node:child_process'

/** How long a host has to stop its providers after SIGTERM before it is killed. */
const GRACE_MS = 20_000

/**
 * On Windows a signal is TerminateProcess: the host's own shutdown never runs, so the providers it started lose their
 * parent and keep running. `taskkill /T` ends them with it, and must run while the host still heads the tree. Elsewhere
 * SIGTERM lets the host stop its providers itself, and SIGKILL follows if it has not exited within the grace period.
 */
export async function stopProcessTree(child: ChildProcess): Promise<void> {
  // A child that never started has no process to end and never emits exit.
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  if (process.platform === 'win32') {
    const ended = await new Promise<boolean>(done => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => done(!error)))
    if (!ended) child.kill('SIGKILL')
  } else {
    child.kill('SIGTERM')
  }
  const forced = setTimeout(() => child.kill('SIGKILL'), GRACE_MS)
  await exited
  clearTimeout(forced)
}
