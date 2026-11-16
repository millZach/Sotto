import { randomUUID } from 'node:crypto'
import { modelFolder } from '../meshy/download'
import { ElevenLabsApi, ElevenLabsApiError, type ElevenLabsApiFetch, type ElevenLabsVoice, type SoundKind } from './api'
import type { SoundFailure, SoundRecord, SoundRecords } from './records'
import { saveSound, SoundSaveError, SOUND_FOLDER } from './save'

/**
 * Sounds made with ElevenLabs (ADR-0205; the plugins plan's slice 12, part 2): the account's voices read for the agent
 * to choose from, and one sound made and saved into its thread's folder, with its record kept before anything is sent.
 * Used by main; it imports nothing from Electron, so a headless host can run it too once its threads make sounds.
 */
export interface ElevenLabsSoundsOptions {
  readonly records: SoundRecords
  readonly fetch: ElevenLabsApiFetch
  /** The account's key, or nothing when the account is gone. Throws when the credential store will not hand it over. */
  readonly keyOf: (accountId: string) => Promise<string | undefined>
  readonly base?: string
  /** Aborts when Sotto stops. */
  readonly signal: AbortSignal
  /** Told each time a sound's record changes: started, made or failed. */
  readonly changed?: (sound: SoundRecord) => void
  readonly now?: () => number
}

/** One sound the user allowed, or made without a card because they turned asking off. */
export interface SoundRequest {
  readonly threadId: string
  readonly accountId: string
  readonly kind: SoundKind
  readonly name: string
  /** The words spoken, or what the effect or music is made from. */
  readonly words: string
  /** The voice speech is spoken in. */
  readonly voice?: ElevenLabsVoice
  readonly seconds?: number
  readonly instrumental?: boolean
  /** The thread's working folder, as it really is, and the folder inside it the MP3 goes into. */
  readonly root: string
  readonly folder?: string
  /** What it costs at ElevenLabs' published prices, in US dollars: counted from when it is asked for. */
  readonly cost: number
}

/** The account's key could not be read for a call: the account is gone, or the credential store is locked. */
export class SoundAccountError extends Error {
  constructor(readonly problem: 'no-account' | 'locked') { super(`elevenlabs-account-${problem}`) }
}

export class ElevenLabsSounds {
  constructor(private readonly options: ElevenLabsSoundsOptions) {}

  /** The account's voices, by name. Throws an `ElevenLabsApiError` or a `SoundAccountError`; nothing is made. */
  async voices(accountId: string): Promise<readonly ElevenLabsVoice[]> {
    return (await this.api(accountId)).voices()
  }

  /**
   * Starts a sound. Its record is kept, counting its cost, before anything goes to ElevenLabs; `done` settles with the
   * record as it ended, made or failed, or undefined when the thread was forgotten meanwhile or Sotto stopped. Rejects,
   * with nothing sent, when the folder is not inside the thread's working folder or the record cannot be kept.
   */
  async make(request: SoundRequest): Promise<{ readonly sound: SoundRecord; readonly done: Promise<SoundRecord | undefined> }> {
    const folder = await modelFolder(request.root, request.folder ?? SOUND_FOLDER)
    const sound = await this.options.records.add({
      id: randomUUID(), threadId: request.threadId, accountId: request.accountId, kind: request.kind, name: request.name, words: request.words,
      ...(request.voice ? { voice: request.voice.name } : {}), ...(request.seconds !== undefined ? { seconds: request.seconds } : {}),
      folder, cost: request.cost, askedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(), state: 'making',
    })
    this.options.changed?.(sound)
    return { sound, done: this.run(sound, request) }
  }

  private async run(sound: SoundRecord, request: SoundRequest): Promise<SoundRecord | undefined> {
    let failure: SoundFailure
    // Whether ElevenLabs answered with the sound: from then on it has charged for it, whatever becomes of the file.
    let billed = false
    try {
      const api = await this.api(request.accountId)
      const answer = request.kind === 'speech' ? await api.speech({ voiceId: request.voice?.id ?? '', text: request.words })
        : request.kind === 'effect' ? await api.soundEffect({ words: request.words, ...(request.seconds !== undefined ? { seconds: request.seconds } : {}) })
          : await api.music({ words: request.words, seconds: request.seconds ?? 0, instrumental: request.instrumental === true })
      billed = true
      const saved = await saveSound(answer, { root: request.root, folder: request.folder ?? SOUND_FOLDER, name: request.name })
      // The MP3 is in the thread's folder whether or not its record could be written, or its thread was forgotten:
      // the agent is told where it is (Sol's review).
      return await this.end(sound, { state: 'made', folder: saved.folder, fileName: saved.fileName, bytes: saved.bytes })
    } catch (error) {
      // Sotto is stopping, and ElevenLabs may have made it already: the record stays as it is, counted, and is settled
      // as stopped when Sotto starts again.
      if (this.options.signal.aborted) return undefined
      failure = error instanceof ElevenLabsApiError || error instanceof SoundSaveError || error instanceof SoundAccountError ? error.problem : 'unreachable'
    }
    // A sound ElevenLabs did not make costs nothing and is not counted (Zach's pick on #2498). One it made and charged
    // for, which Sotto then could not save (the answer cut off, too large, or a folder that would not take it), stays
    // counted at its estimate, so the limit sees what was spent (Bug Bot on #2648, L1).
    return this.end(sound, billed ? { state: 'failed', failure } : { state: 'failed', failure, cost: 0 })
  }

  /**
   * Writes how a sound ended, and says so. A record that is gone, as with its thread forgotten, or that cannot be
   * written now, still ends as said here: a cost taken back comes out of the ledger, a change not written goes with
   * the next write, and the window hears of it either way (Bug Bot on #2648, N1).
   */
  private async end(sound: SoundRecord, ending: Partial<SoundRecord>): Promise<SoundRecord> {
    let ended: SoundRecord | undefined
    try { ended = await this.options.records.update(sound.id, record => ({ ...record, ...ending })) } catch {
      console.warn('elevenlabs-sound-record-not-written')
    }
    if (!ended) {
      ended = { ...sound, ...ending }
      // Its thread was forgotten while it was made: what it was counted at is taken back, if nothing was charged.
      if (ending.cost === 0) await this.options.records.refundForgotten(sound.id).catch(() => undefined)
    }
    this.options.changed?.(ended)
    return ended
  }

  private async api(accountId: string): Promise<ElevenLabsApi> {
    let key: string | undefined
    try { key = await this.options.keyOf(accountId) } catch { throw new SoundAccountError('locked') }
    if (!key) throw new SoundAccountError('no-account')
    return new ElevenLabsApi(this.options.fetch, key, { ...(this.options.base ? { base: this.options.base } : {}), signal: this.options.signal })
  }
}
