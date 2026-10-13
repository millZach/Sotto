// Internal proof helper: restart one explicitly owned nested shell, never the live desktop.
import assert from 'node:assert/strict'
import process from 'node:process'
import { readFileSync, writeFileSync, openSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { setTimeout as wait } from 'node:timers/promises'
const root = process.env.SOTTO_SETUP_PROOF_ROOT
assert.ok(process.env.SOTTO_OMARCHY_SETUP_PROOF === '1' && root?.startsWith(join(process.cwd(), '.cache/')))
const pid = Number(readFileSync(join(root, 'shell-pid'), 'utf8'))
if (existsSync(`/proc/${pid}/cgroup`)) assert.match(readFileSync(`/proc/${pid}/cgroup`, 'utf8'), /app-sottoproof[^/]+\.slice/)
try { execFileSync('qs', ['kill', '-p', '/usr/share/omarchy/shell'], { env: process.env, timeout: 5000 }) } catch { /* An explicitly stopped private shell can be started again. */ }
// qs kill acknowledges the request before the old instance releases its lock.
const stopDeadline = Date.now() + 10000
while (Date.now() < stopDeadline) {
  const listed = execFileSync('qs', ['list', '-j', '-p', '/usr/share/omarchy/shell'], { env: process.env, encoding: 'utf8' }).trim()
  const instances = listed.startsWith('No running instances for ') ? [] : JSON.parse(listed)
  if (instances.length === 0) break
  await wait(100)
}
const shell = spawn('dbus-run-session', [`--config-file=${join(root, 'dbus.conf')}`, '--', 'quickshell', '-n', '-p', '/usr/share/omarchy/shell'], {
  env: process.env, detached: true, stdio: ['ignore', openSync(join(root, 'shell-update.log'), 'a'), openSync(join(root, 'shell-update.log'), 'a')],
})
writeFileSync(join(root, 'updated-shell-pid'), String(shell.pid))
shell.unref()
const end = Date.now() + 20000
while (Date.now() < end) {
  try { execFileSync('omarchy-shell', ['shell', 'ping'], { env: process.env, timeout: 2000, stdio: 'ignore' }); process.exit(0) }
  catch { await wait(100) }
}
throw new Error('The private shell did not restart')
