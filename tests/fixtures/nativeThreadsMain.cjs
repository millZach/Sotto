// Test-only entry point: production main and native adapters, isolated application data.
/* global require, process, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports -- Electron bootstrap must set userData synchronously before loading main. */
const { app, dialog } = require('electron')
const { realpathSync, statSync } = require('node:fs')
const { resolve, join, basename, dirname } = require('node:path')
const { tmpdir } = require('node:os')

if (app.isPackaged || process.env.SOTTO_NATIVE_THREADS_LIVE !== '1') {
  throw new Error('Native Threads smoke requires an unpackaged opt-in launch.')
}
const root = realpathSync(process.env.SOTTO_NATIVE_THREADS_ROOT || '')
if (dirname(root) !== realpathSync(tmpdir()) || !/^sotto-e2e-native-[A-Za-z0-9_-]+$/.test(basename(root))) {
  throw new Error('Native Threads smoke requires an owned temporary root.')
}
const profile = join(root, 'profile')
const project = join(root, 'project')
if (!statSync(profile).isDirectory() || !statSync(project).isDirectory()) throw new Error('Missing isolated directories.')
for (const key of Object.keys(process.env)) if (key.startsWith('SOTTO_E2E') || key === 'SOTTO_MEMORY_PROBE') delete process.env[key]
app.setPath('userData', profile)
dialog.showOpenDialog = async (_parent, options) => {
  if (JSON.stringify(options.properties) !== JSON.stringify(['openDirectory'])) throw new Error('Unexpected dialog in native smoke.')
  return { canceled: false, filePaths: [project] }
}
require(resolve(__dirname, '../../out/main/index.js'))
