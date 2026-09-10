export interface VoiceSpeechOutput {
  /** Resolves after output ends or the user stops it; rejects on output failure. */
  speak(text: string): Promise<void>
  stop(): void
}

interface LocalAudioElement {
  src: string
  onended: (() => void) | null
  onerror: (() => void) | null
  play(): Promise<void>
  pause(): void
}

/** Plays WAV data from the narrow native synthesis bridge; no provider key enters this window. */
export class NativeSystemSpeech implements VoiceSpeechOutput {
  private finish: (() => void) | null = null

  constructor(private readonly synthesize: (text: string) => Promise<{ audioBase64: string; mimeType: 'audio/wav' }>, private readonly cancelSynthesis?: () => void) {}

  speak(text: string): Promise<void> {
    this.stop()
    if (text.trim().length === 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let settled = false
      let player: LocalAudioElement | undefined
      let objectUrl: string | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) globalThis.clearTimeout(timer)
        if (player !== undefined) {
          player.onended = null
          player.onerror = null
          player.pause()
          player.src = ''
        }
        if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl)
        if (this.finish === cancel) this.finish = null
        if (error === undefined) resolve()
        else reject(error)
      }
      const cancel = (): void => finish()
      this.finish = cancel
      timer = globalThis.setTimeout(() => finish(new Error('Local speech generation timed out. Read the reply in the widget.')), 65_000)
      void this.synthesize(text).then(async (result) => {
        if (settled) return
        const bytes = Uint8Array.from(atob(result.audioBase64), (character) => character.charCodeAt(0))
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }))
        const browser = globalThis as unknown as { Audio: new (url: string) => LocalAudioElement }
        player = new browser.Audio(objectUrl)
        player.onended = () => finish()
        player.onerror = () => finish(new Error('Spoken reply could not play. Check your audio output.'))
        if (timer !== undefined) globalThis.clearTimeout(timer)
        timer = globalThis.setTimeout(() => finish(new Error('Spoken reply timed out. Read it in the widget.')), 180_000)
        await player.play()
      }).catch((error: unknown) => finish(error instanceof Error ? error : new Error('Spoken reply is unavailable. Check the selected voice and audio output.')))
    })
  }

  stop(): void {
    const finish = this.finish
    this.finish = null
    finish?.()
    this.cancelSynthesis?.()
  }
}

interface SystemVoice {
  readonly localService: boolean
  readonly default: boolean
  readonly lang: string
}

interface SpeechUtterance {
  voice: SystemVoice | null
  lang: string
  onend: (() => void) | null
  onerror: (() => void) | null
}

interface SpeechBrowser {
  readonly SpeechSynthesisUtterance?: new (text: string) => SpeechUtterance
  readonly speechSynthesis?: {
    getVoices(): SystemVoice[]
    addEventListener(event: 'voiceschanged', listener: () => void): void
    removeEventListener(event: 'voiceschanged', listener: () => void): void
    speak(utterance: SpeechUtterance): void
    cancel(): void
  }
}

/** No provider credentials, network speech API, or remote browser voice. */
export class LocalSystemSpeech implements VoiceSpeechOutput {
  private finish: (() => void) | null = null

  async speak(text: string): Promise<void> {
    this.stop()
    if (text.trim().length === 0) return
    const browser = globalThis as unknown as SpeechBrowser
    if (browser.speechSynthesis === undefined || browser.SpeechSynthesisUtterance === undefined) {
      throw new Error('Spoken replies are unavailable on this system. Read the reply in the widget.')
    }
    const synthesis = browser.speechSynthesis
    const createUtterance = browser.SpeechSynthesisUtterance
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | undefined
      let utterance: SpeechUtterance | undefined
      const cleanup = (): void => {
        if (timeout !== undefined) globalThis.clearTimeout(timeout)
        synthesis.removeEventListener('voiceschanged', trySpeak)
        if (utterance !== undefined) {
          utterance.onend = null
          utterance.onerror = null
        }
        if (this.finish === cancel) this.finish = null
      }
      const complete = (error?: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        if (error === undefined) resolve()
        else reject(error)
      }
      const cancel = (): void => complete()
      const trySpeak = (): void => {
        if (settled || utterance !== undefined) return
        const voices = synthesis.getVoices().filter((voice) => voice.localService)
        const voice = voices.find((entry) => entry.default)
          ?? voices.find((entry) => entry.lang.startsWith('en')) ?? voices[0]
        if (voice === undefined) return
        if (timeout !== undefined) globalThis.clearTimeout(timeout)
        synthesis.removeEventListener('voiceschanged', trySpeak)
        utterance = new createUtterance(text)
        utterance.voice = voice
        utterance.lang = voice.lang
        utterance.onend = () => complete()
        utterance.onerror = () => complete(new Error('Spoken reply failed. Read the reply in the widget.'))
        // A missing OS completion event must not leave microphone input suppressed forever.
        timeout = globalThis.setTimeout(() => {
          complete(new Error('Spoken reply timed out. Read the reply in the widget.'))
          synthesis.cancel()
        }, Math.min(180_000, Math.max(15_000, text.length * 140)))
        try { synthesis.speak(utterance) } catch {
          complete(new Error('Spoken reply failed. Read the reply in the widget.'))
        }
      }
      this.finish = cancel
      synthesis.addEventListener('voiceschanged', trySpeak)
      timeout = globalThis.setTimeout(() => {
        complete(new Error('No local voice is available. Install a system voice to enable spoken replies.'))
      }, 2_000)
      trySpeak()
    })
  }

  stop(): void {
    const finish = this.finish
    this.finish = null
    finish?.()
    const browser = globalThis as unknown as SpeechBrowser
    browser.speechSynthesis?.cancel()
  }
}
