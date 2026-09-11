import { z } from 'zod'
import { app } from 'electron'
import { join } from 'node:path'
import { AGENT_COMMAND, AGENT_GET, AGENT_SPEECH, AGENT_SPEECH_CANCEL, AGENT_GROK_VOICES, AGENT_VOICE_MODEL, AGENT_WAKE, agentCommandSchema } from '../../shared/agents'
import type { SottoPlatform } from '../../shared/platform'
import { synthesizeAgentSpeech } from './speech'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { AgentControl } from './control'
import { AgentWakeService } from './wake'
import type { NaturalSpeechModels } from './speechModels'
import type { GrokSpeechService } from './grokSpeech'

export function registerAgentIpc(ipc: IpcMainAdapter, control: Pick<AgentControl, 'get' | 'command'>, senders: () => readonly TrustedIpcSender[], platform: SottoPlatform, speechModels: Pick<NaturalSpeechModels, 'status' | 'download'>, grokSpeech: Pick<GrokSpeechService, 'synthesize' | 'voices' | 'cancel'>): () => void {
  ipc.handle(AGENT_GROK_VOICES, async (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    z.undefined().parse(payload)
    return grokSpeech.voices()
  })
  ipc.handle(AGENT_VOICE_MODEL, async (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    const action = z.enum(['status', 'download']).parse(payload)
    return action === 'download' ? speechModels.download() : speechModels.status()
  })
  const wake = new AgentWakeService(app.isPackaged ? join(process.resourcesPath, 'runtime', 'kws') : join(app.getAppPath(), 'node_modules', 'sherpa-onnx'), join(__dirname, 'wakeWorker.js'))
  ipc.handle(AGENT_WAKE, async (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    const request = z.discriminatedUnion('type', [
      z.object({ type: z.literal('prepare') }).strict(),
      z.object({ type: z.literal('detect'), audio: z.instanceof(Float32Array) }).strict(),
      z.object({ type: z.literal('release') }).strict(),
    ]).parse(payload)
    if (request.type === 'release') { wake.dispose(); return { detected: false, endSeconds: 0 } }
    const state = control.get()
    if (!state.configuration.enabled || !['active', 'beta'].includes(state.membership.status)) throw new Error('Agent voice control is not enabled.')
    await wake.prepare(state.configuration.wakeModelDirectory, state.configuration.wakeRuntimeDirectory || undefined)
    return request.type === 'detect' ? wake.detect(request.audio) : { detected: false, endSeconds: 0 }
  })
  let speechOperation: symbol | null = null
  let remoteSpeech = false
  ipc.handle(AGENT_SPEECH_CANCEL, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    z.undefined().parse(payload)
    grokSpeech.cancel()
    if (remoteSpeech) speechOperation = null
  })
  ipc.handle(AGENT_SPEECH, async (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    if (speechOperation !== null) throw new Error('Speech is already being prepared.')
    const text = z.string().min(1).max(2000).parse(payload)
    const configuration = control.get().configuration
    if (configuration.speechProvider === 'natural') throw new Error('Natural speech uses the local voice worker. Reopen Sotto and retry.')
    const operation = Symbol('speech')
    speechOperation = operation
    remoteSpeech = configuration.speechProvider === 'grok'
    try {
      return remoteSpeech ? await grokSpeech.synthesize(text, configuration.grokSpeechVoice) : await synthesizeAgentSpeech(text, platform)
    } finally { if (speechOperation === operation) speechOperation = null }
  })
  ipc.handle(AGENT_GET, event => {
    if (!isAuthorizedIpcSender(event, senders(), ['main', 'widget'])) throw new Error('AGENT_SENDER_REJECTED')
    return control.get()
  })
  ipc.handle(AGENT_COMMAND, (event, payload) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main', 'widget'])) throw new Error('AGENT_SENDER_REJECTED')
    const command = agentCommandSchema.parse(payload)
    if (['configure', 'credential', 'connect', 'disconnect', 'membership', 'voice-state', 'check-reasoning', 'preview-voice'].includes(command.type) && !isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('AGENT_MAIN_WINDOW_REQUIRED')
    return control.command(command)
  })
  return () => { grokSpeech.cancel(); wake.dispose(); ipc.removeHandler(AGENT_WAKE); ipc.removeHandler(AGENT_GET); ipc.removeHandler(AGENT_COMMAND); ipc.removeHandler(AGENT_SPEECH); ipc.removeHandler(AGENT_SPEECH_CANCEL); ipc.removeHandler(AGENT_GROK_VOICES); ipc.removeHandler(AGENT_VOICE_MODEL) }
}
