import { spawn } from 'node:child_process'
import { LAUNCH_SCRIPT_SOURCE } from '../../src/main/hosts/launchScript'

/** Runs the actual SSH control source beside a loopback host, with no SSH or grant stub. */
export async function ensureFixtureDesktopAnswers(dataDirectory: string, hostId: string, clientId: string): Promise<void> {
  // The fixed source goes on stdin, as SSH carries it, which also keeps it clear of Windows' command line limit. Pairing
  // credentials are never arguments or output.
  const child = spawn(process.execPath, ['--input-type=commonjs', '-', JSON.stringify({ op: 'desktop-answers', dataDirectory, installPath: dataDirectory, hostId, clientId })],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, timeout: 15_000 })
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.length > 4096) child.kill() })
  child.stdin.end(LAUNCH_SCRIPT_SOURCE)
  await new Promise(resolve => child.once('close', resolve))
  const result = JSON.parse(stdout.trim() || '{}') as { type?: string; hostId?: string }
  if (result.type !== 'desktop-answers' || result.hostId !== hostId) throw new Error('The fixture host could not establish desktop permissions.')
}
