import { app, BrowserWindow, ipcMain, safeStorage } from 'electron'
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentControl } from '../../src/main/agents/control'
import { AgentCredentials } from '../../src/main/agents/credentials'
import { TurnRecorder } from '../../src/main/agents/turns'
import { E2EAgentHost } from '../../src/main/e2e/agentEffects'
import { OpenRouterTranscriptionService } from '../../src/main/asr/openRouterTranscriptionService'
import { defaultSettings } from '../../src/shared/settings'
import { agentCommandSchema } from '../../src/shared/agents'
import { transcriptionRequestSchema } from '../../src/shared/contracts'

const root = resolve(process.env.SOTTO_VOICE_PERF_ROOT!)
const profile = process.env.SOTTO_VOICE_PERF_PROFILE || join(app.getPath('appData'), 'sotto')
const isolated = mkdtempSync(join(tmpdir(), 'sotto-voice-perf-'))
// Chromium's encrypted key metadata is needed by safeStorage; no plaintext is copied.
copyFileSync(join(profile, 'Local State'), join(isolated, 'Local State'))
app.setPath('userData', isolated)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
let control: AgentControl | undefined
app.whenReady().then(async () => {
  const savedCredentials = new AgentCredentials(profile, safeStorage)
  await savedCredentials.load()
  if (!savedCredentials.has('formatting')) throw new Error('Saved OpenRouter transcription key unavailable')
  const credentials = new AgentCredentials(isolated, safeStorage)
  await credentials.load()
  const recorder = new TurnRecorder({ directory: isolated, historyEnabled: () => false, resolveSession: () => undefined })
  control = new AgentControl({ directory: isolated, credentials, turns: recorder, historyEnabled: () => false,
    host: new E2EAgentHost(),
    reasoner: { async intent() { throw new Error('Fixture unexpectedly requested reasoning') }, async decide() { throw new Error('Fixture unexpectedly requested supervision') } },
    membership: { async status() { return { status: 'beta', label: 'Isolated benchmark', expiresAt: null } }, async action() { return { status: 'beta', label: 'Isolated benchmark', expiresAt: null } } },
  })
  await control.start()
  await control.command({ type: 'connect' })
  await control.command({ type: 'select-thread', threadId: 'workshop' })
  const service = new OpenRouterTranscriptionService({ getSettings: async () => ({ ...defaultSettings('Control+Space'), language: 'en', llmDictionary: '', llmApiKey: savedCredentials.get('formatting') }) })
  let requests = 0
  ipcMain.handle('perf:transcribe', async (_event, input) => {
    const request = transcriptionRequestSchema.parse(input)
    if (++requests > 5 || request.wav.byteLength > 160_044) throw new Error('Five short fixture requests per process maximum')
    return service.transcribe(request)
  })
  ipcMain.handle('perf:cancel', (_event, id: string) => service.cancel(id))
  ipcMain.handle('perf:fixture', () => new Uint8Array(readFileSync(join(root, 'scripts/asr-bench/fixtures/speech-tiny.wav'))))
  ipcMain.handle('perf:prepare', async () => { await control!.command({ type: 'cancel-draft' }); await control!.command({ type: 'compose', text: 'Fixture: ' }) })
  ipcMain.handle('perf:utterance', async (_event, command) => {
    const parsed = agentCommandSchema.parse(command)
    if (parsed.type !== 'utterance') throw new Error('Only fixture utterances are accepted')
    const state = await control!.command(parsed)
    const [record] = await recorder.recent(1)
    if (record?.source !== 'utterance' || record.outcome !== 'completed' || state.error) throw new Error('Fixture turn did not complete')
    return { record, draft: state.draft }
  })
  const window = new BrowserWindow({ show: false, width: 640, height: 300, webPreferences: { preload: join(root, 'scripts/voice-perf/preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  await window.loadFile(join(root, 'artifacts/voice-perf/build/renderer/scripts/voice-perf/capture.html'))
}).catch(() => { console.error('Voice benchmark initialization failed; verify the saved OpenRouter key and fixture paths.'); app.exit(1) })
app.on('before-quit', () => control?.dispose())
