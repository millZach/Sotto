// After build: mise exec node@24.22.1 -- node tools/verify-omarchy-muted-surfaces.mjs
import console from 'node:console'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const temporary = mkdtempSync('/tmp/sotto-muted-')
const evidence = resolve('artifacts/omarchy-muted')
mkdirSync(evidence, { recursive: true })
for (const folder of ['home', 'tmp', 'config', 'state', 'data', 'cache']) mkdirSync(join(temporary, folder))
const busConfig = join(temporary, 'session-bus.conf')
// No service directories: the private session cannot activate a portal or desktop services.
writeFileSync(busConfig, '<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>\n')
const child = spawn(process.execPath, [
  'scripts/with-nested-hyprland.mjs', join(evidence, 'sandbox'), 'dbus-run-session', `--config-file=${busConfig}`, '--',
  process.execPath, 'node_modules/@playwright/test/cli.js', 'test',
  'tests/e2e/omarchy-muted-surfaces.spec.ts', '--workers=1', `--output=${join(temporary, 'test-results')}`,
], { stdio: 'inherit', env: {
  ...process.env, HOME: join(temporary, 'home'), TMPDIR: join(temporary, 'tmp'),
  XDG_CONFIG_HOME: join(temporary, 'config'), XDG_STATE_HOME: join(temporary, 'state'),
  XDG_DATA_HOME: join(temporary, 'data'), XDG_CACHE_HOME: join(temporary, 'cache'),
  SOTTO_OMARCHY_MUTED_EVIDENCE: '1', SOTTO_MUTED_EVIDENCE_DIRECTORY: evidence,
} })
console.log(`Owned nested verification runner PID ${child.pid}; isolated home ${temporary}`)
const stop = () => child.kill('SIGTERM')
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
try {
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
  process.exitCode = code ?? 1
} finally {
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
  rmSync(temporary, { recursive: true, force: true })
}
