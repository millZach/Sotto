import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { GrokSpeechService } from '../../src/main/agents/grokSpeech'
import { KokoroSpeechService } from '../../src/main/agents/kokoroSpeech'

const root = resolve(process.env.SOTTO_VOICE_PERF_ROOT!)
const profile = process.env.SOTTO_VOICE_PERF_PROFILE || join(app.getPath('appData'), 'sotto')
const isolated = mkdtempSync(join(tmpdir(), 'sotto-voice-perf-'))
copyFileSync(join(profile, 'Local State'), join(isolated, 'Local State'))
app.setPath('userData', isolated)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.whenReady().then(async () => {
  const credentials = new AgentCredentials(profile, safeStorage)
  await credentials.load()
  const grok = new GrokSpeechService({ credentials })
  const kokoro = new KokoroSpeechService({ credentials })
  const fixtures = JSON.parse(readFileSync(join(root, 'scripts/tts-bench/fixtures.json'), 'utf8')) as Array<{ id: string; text: string }>
  const fixture = fixtures.find(item => item.id === 'status-01')!
  let requests = 0
  ipcMain.handle('perf:speech', (_event, provider: string, text: string) => {
    if (++requests > 4 || text !== fixture.text || !['grok', 'kokoro'].includes(provider)) throw new Error('Four fixed-fixture speech requests per process maximum')
    return provider === 'grok' ? grok.synthesize(text, 'altair') : kokoro.synthesize(text)
  })
  ipcMain.handle('perf:speech-stop', () => { grok.cancel(); kokoro.cancel() })
  const window = new BrowserWindow({ show: false, width: 640, height: 300, webPreferences: { preload: join(root, 'scripts/voice-perf/speech-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  await window.loadFile(join(root, 'artifacts/voice-perf/build/renderer/scripts/voice-perf/speech.html'))
}).catch(() => { console.error('Speech benchmark initialization failed; check the saved speech credentials.'); app.exit(1) })
