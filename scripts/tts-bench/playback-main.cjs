/* global Buffer, console, process, require, __dirname */
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, safeStorage, protocol, net, ipcMain } = require('electron')
const { readFileSync, mkdtempSync, copyFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const root = resolve(__dirname, '../..')
const compiled = join(root, 'artifacts/tts-bench/playback-build')
const { NaturalSpeechModels } = require(join(compiled, 'speechModels.cjs'))
const { GrokSpeechService } = require(join(compiled, 'grokSpeech.cjs'))
const { KokoroSpeechService } = require(join(compiled, 'kokoroSpeech.cjs'))
const { registerModelSchemesAsPrivileged, registerLocalAssetProtocols, loadVerifiedRuntimeSource } = require(join(compiled, 'modelProtocol.cjs'))
const profile = process.env.SOTTO_TTS_PROFILE || join(app.getPath('appData'), 'sotto')
const isolated = mkdtempSync(join(tmpdir(), 'sotto-tts-playback-'))
copyFileSync(join(profile, 'Local State'), join(isolated, 'Local State'))
app.setPath('userData', isolated)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
registerModelSchemesAsPrivileged(protocol)
app.whenReady().then(async () => {
  const vault = JSON.parse(readFileSync(join(profile, 'credentials.json'), 'utf8'))
  const credentials = { get: slot => {
    if (!safeStorage.isEncryptionAvailable() || !vault[slot]) throw new Error('Saved benchmark credential unavailable')
    return safeStorage.decryptString(Buffer.from(vault[slot], 'base64'))
  } }
  const models = new NaturalSpeechModels(join(profile, 'models'))
  if (!(await models.status()).ready) throw new Error('Supertonic model is not installed')
  registerLocalAssetProtocols({ protocol, net, modelSources: () => models.protocolSources(), runtimeSource: await loadVerifiedRuntimeSource(join(root, 'resources/runtime')) })
  const grok = new GrokSpeechService({ credentials }), kokoro = new KokoroSpeechService({ credentials })
  let reservedUsd = 0
  const budgetUsd = 0.5
  const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures.json'), 'utf8'))
  ipcMain.handle('bench:status', () => models.status())
  ipcMain.handle('bench:synthesize', async (_event, provider, text, fixtureId) => {
    if (!['grok', 'kokoro'].includes(provider) || !fixtures.some(f => f.id === fixtureId && f.text === text)) throw new Error('Unknown benchmark request')
    const charge = Buffer.byteLength(text, 'utf8') * (provider === 'grok' ? 15 : 4) / 1e6
    if (reservedUsd + charge > budgetUsd) throw new Error('Benchmark budget exhausted')
    reservedUsd += charge
    app.benchReservedUsd = reservedUsd
    return provider === 'grok' ? grok.synthesize(text, 'altair') : kokoro.synthesize(text)
  })
  ipcMain.handle('bench:cancel', () => { grok.cancel(); kokoro.cancel() })
  const window = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { preload: join(__dirname, 'playback-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  await window.loadFile(join(compiled, 'renderer/scripts/tts-bench/playback.html'))
}).catch(error => { console.error(error.message); app.exit(1) })
