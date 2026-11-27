// Ends a host or engine a test started, with everything it started, and answers once it has exited.
import { execFile, type ChildProcess } from 'node:child_process'

/**
 * On Windows a signal is TerminateProcess: the host's own shutdown never runs, so the providers it started lose their
 * parent and keep running. `taskkill /T` ends them with it, and must run while the host still heads the tree. Elsewhere
 * SIGTERM lets the host stop its providers itself, and SIGKILL follows if it has not exited within `graceMs`.
 */
export async function stopProcessTree(child: ChildProcess, graceMs = 20_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  if (process.platform === 'win32' && child.pid !== undefined) {
    const pid = String(child.pid)
    await new Promise<void>(done => execFile('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true }, () => done()))
  } else {
    child.kill('SIGTERM')
  }
  const forced = setTimeout(() => child.kill('SIGKILL'), graceMs)
  await exited
  clearTimeout(forced)
}
