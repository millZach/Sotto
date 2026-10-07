// Production Electron main, native Claude adapter and ledger; only the external client is scripted.
/* global require, process, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, session } = require('electron')
const fs = require('node:fs')
const promises = require('node:fs/promises')
const os = require('node:os')
const { basename, dirname, join, resolve } = require('node:path')
const { syncBuiltinESMExports } = require('node:module')
const { setTimeout: delay } = require('node:timers/promises')
const childProcess = require('node:child_process')

if (app.isPackaged || !process.env.SOTTO_USAGE_FIXTURE_ROOT || !process.env.SOTTO_USAGE_FIXTURE_NODE) throw new Error('An isolated usage fixture is required.')
const root = fs.realpathSync(process.env.SOTTO_USAGE_FIXTURE_ROOT)
if (dirname(root) !== fs.realpathSync(os.tmpdir()) || !/^sotto-e2e-usage-[A-Za-z0-9_-]+$/.test(basename(root))) throw new Error('Unsafe usage fixture root.')
const node = fs.realpathSync(process.env.SOTTO_USAGE_FIXTURE_NODE)
for (const name of ['profile', 'project', 'home', 'client']) {
  const path = join(root, name)
  if (!fs.statSync(path).isDirectory() || fs.realpathSync(path) !== path) throw new Error('Fixture directories must not be redirected.')
}
const home = join(root, 'home')
const client = join(root, 'client')
const profile = join(root, 'profile')
const executable = join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
if (fs.realpathSync(executable) !== executable) throw new Error('The placeholder executable must be owned.')
const record = event => fs.appendFileSync(join(root, 'events.jsonl'), JSON.stringify({ event }) + '\n')
// No inherited Sotto switches, provider keys, provider homes or Node injection settings.
const keep = new Set(['systemroot', 'windir', 'comspec', 'temp', 'tmp', 'lang', 'lc_all', 'display', 'xauthority', 'wayland_display', 'xdg_runtime_dir'])
for (const key of Object.keys(process.env)) if (!keep.has(key.toLowerCase())) delete process.env[key]
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
  XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'), PATH: dirname(executable) })
os.homedir = () => home
app.setPath('userData', profile)
// A missing fake must fail closed: this placeholder is never executed as a real native client.
const spawn = childProcess.spawn
childProcess.spawn = function (command, args, options) {
  // Anything else (Git asked about a project's folder, the paste helper) fails the way a missing program does: no
  // real process starts, and the app takes its own path for a program it cannot find.
  if (command !== executable) {
    record('unexpected-launch-refused')
    return spawn.call(this, join(root, 'no-such-program'), [], { ...options, shell: false, windowsHide: true })
  }
  record('scripted-claude-launch')
  const nativeArgs = args.includes('--version') ? ['-e', 'process.stdout.write("2.1.268 (scripted Claude)\\n")']
    : [resolve(__dirname, 'fakeClaudeThread.mjs'), client, ...args]
  return spawn.call(this, node, nativeArgs, { ...options, env: { ...options?.env, SOTTO_FAKE_CLAUDE_HOME: join(home, '.claude') }, windowsHide: true })
}
// Hold only the usage archive's atomic replacement, after its data was synced. The test releases it
// after quit has begun, proving production's before-quit drain rather than a test-only flush call.
const rename = promises.rename
promises.rename = async (from, to) => {
  if (to === join(profile, 'claude-usage.json')) {
    if (fs.existsSync(join(root, 'hold-usage-write'))) {
      fs.writeFileSync(join(root, 'usage-write-waiting'), '')
      while (fs.existsSync(join(root, 'hold-usage-write'))) await delay(10)
    }
    await rename(from, to)
    record('usage-write')
  } else await rename(from, to)
}
syncBuiltinESMExports()
// No HTTP requests escape a fixture that uses production main. File-backed renderer assets still load.
globalThis.fetch = async () => { throw new Error('Network disabled in isolated usage fixture.') }
app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest(
  { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_request, answer) => answer({ cancel: true }),
))
app.on('before-quit', () => record('quit-requested'))
require(resolve(__dirname, '../../out/main/index.js'))
