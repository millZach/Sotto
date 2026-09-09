import type { AgentVoiceDependencies } from '../agents/voiceSession'

/** Controlled microphone/transcription/speaker effects around the production voice state machine. */
export function createE2EAgentVoiceEffects(): AgentVoiceDependencies {
  const transcripts = new Map<number, string>()
  let next = 0
  return {
    createWakeDetector: () => ({
      async load() {},
      async detect(audio) {
        const id = audio[0] ?? 0
        const detected = /^[\s\p{P}]*hey[\s\p{P}]+sot{1,2}o(?=$|[\s\p{P}])/iu.test(transcripts.get(id) ?? '')
        if (!detected) transcripts.delete(id)
        return { detected, endSeconds: 0 }
      },
      dispose() { transcripts.clear() },
    }),
    createCapture: options => {
      let suppressed = false
      const receive = (event: Event): void => {
        if (suppressed || !(event instanceof CustomEvent) || typeof event.detail !== 'string') return
        const id = ++next
        transcripts.set(id, event.detail)
        options.onUtterance(new Float32Array([id]))
      }
      return {
        async start() { window.addEventListener('sotto:e2e:microphone', receive) },
        async stop() { window.removeEventListener('sotto:e2e:microphone', receive); transcripts.clear() },
        setSuppressed(value) { suppressed = value },
      }
    },
    createLocalTranscriber: () => ({
      async load() {},
      async transcribe({ audio }) {
        const id = audio[0] ?? 0
        const text = transcripts.get(id) ?? ''
        transcripts.delete(id)
        return { text, language: 'en' }
      },
      cancel() {}, dispose() { transcripts.clear() },
    }),
    speech: { async speak() {}, stop() {} },
    createId: () => crypto.randomUUID(),
    setTimer: (callback, duration) => window.setTimeout(callback, duration),
    clearTimer: timer => window.clearTimeout(timer as number),
  }
}
