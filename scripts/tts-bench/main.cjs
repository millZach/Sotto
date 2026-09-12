/* global Buffer, console, process, require */
/* eslint-disable @typescript-eslint/no-require-imports */
const { app, safeStorage } = require('electron')
const { readFileSync, mkdtempSync, copyFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

// Separate Chromium profile; the real profile is only read for these two slots
// and the selected voice. Keys never enter a renderer, result file, or log.
const sourceProfile = process.env.SOTTO_TTS_PROFILE || join(app.getPath('appData'), 'sotto')
const isolatedProfile = mkdtempSync(join(tmpdir(), 'sotto-tts-bench-'))
// Chromium's OS-encrypted key lives in Local State. Copy that encrypted file,
// never the decrypted credentials, so safeStorage can read the existing vault.
copyFileSync(join(sourceProfile, 'Local State'), join(isolatedProfile, 'Local State'))
app.setPath('userData', isolatedProfile)
let stage = 'startup'
app.whenReady().then(async () => {
  stage = 'profile-read'
  const profile = sourceProfile
  const readJson = name => JSON.parse(readFileSync(join(profile, name), 'utf8').replace(/^\uFEFF/u, ''))
  const config = readJson('agents.json').configuration
  const vault = readJson('credentials.json')
  console.log(JSON.stringify({ event: 'credential-presence', openrouter: Boolean(vault.formatting), grok: Boolean(vault.grokSpeech), secureStorage: safeStorage.isEncryptionAvailable(), grokVoice: config.grokSpeechVoice }))
  const getKey = slot => {
    const override = slot === 'formatting' ? process.env.OPENROUTER_API_KEY : process.env.XAI_API_KEY
    if (override) return override
    if (!safeStorage.isEncryptionAvailable() || !vault[slot]) throw new Error('Required saved credential is unavailable.')
    return safeStorage.decryptString(Buffer.from(vault[slot], 'base64'))
  }
  stage = 'module-import'
  const { run } = await import('./bench.mjs')
  stage = 'benchmark'
  await run({ getKey, grokVoice: config.grokSpeechVoice, argv: process.argv.slice(2) })
  app.exit(0)
}).catch(error => {
  // Raw errors from networking/credential stores must not be logged.
  console.error(JSON.stringify({ event: 'stopped', stage, errorType: error?.name, localFrames: String(error?.stack || '').split('\n').slice(1).filter(line => line.includes('scripts/tts-bench') || line.includes('scripts\\tts-bench')) }))
  app.exit(1)
})
