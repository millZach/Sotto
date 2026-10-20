import {
  SOTTO_SPEECH_MODEL_ID,
  SPEECH_MODEL,
  SPEECH_MODEL_BYTES,
  type SpeechModelOption,
  type SpeechModelStatus,
} from '../../shared/speechModel'
import type { CoreMlModelVersion } from './coreMlEngine'
import type { FluidAudioModel } from './fluidAudioModels'
import type { SpeechEngine, SpeechEngineLoader } from './speechEngine'
import { disposeEngine, type SpeechModelStore } from './speechModelStore'

export interface SpeechModelManagerDependencies {
  /** Sotto's own Parakeet v3, which it downloads. */
  readonly store: SpeechModelStore
  /** The FluidAudio models this computer can run; empty off Apple silicon or without the helper. */
  readonly findFluidAudio: () => Promise<readonly FluidAudioModel[]>
  readonly coreMlLoader: (version: CoreMlModelVersion) => SpeechEngineLoader
  readonly readChoice: () => string | null
  readonly saveChoice: (id: string | null) => Promise<void>
  readonly onStatus: (status: SpeechModelStatus) => void
}

const MISSING: SpeechModelStatus = { state: 'missing' }

/**
 * Runs the speech model the user chose for dictation: Sotto's own Parakeet v3 through the store, or a
 * Core ML model FluidAudio keeps on this Mac through Sotto's helper. Nothing downloads unless the user
 * picks Sotto's model; an install that already has it verified keeps it, so dictation works as before.
 * While Sotto's model is chosen its status is the store's; otherwise the manager reports its own.
 * Choices are handled one at a time and the latest wins: a load still running for an earlier choice
 * neither publishes nor keeps its engine.
 */
export class SpeechModelManager {
  private choice: string | null = null
  private ownStatus: SpeechModelStatus = MISSING
  private engine: SpeechEngine | null = null
  /** Bumped whenever the loaded model changes; a load from an earlier one is stale. */
  private load = 0
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(private readonly dependencies: SpeechModelManagerDependencies) {
    dependencies.store.subscribe((status) => {
      if (this.choice === SOTTO_SPEECH_MODEL_ID) this.emit(status)
    })
  }

  /** Loads the saved choice without downloading anything; resolves once that load has finished. */
  async start(): Promise<void> {
    let loaded: Promise<void> = Promise.resolve()
    await this.enqueue(async () => {
      let choice = this.dependencies.readChoice()
      if (choice === null && (await this.dependencies.store.isDownloaded())) {
        // Someone who had Sotto's model before choosing existed keeps it. A download an earlier
        // version started by itself and never finished is not a choice: nothing downloads until the
        // user picks Parakeet v3, and then it resumes from what is here. If the choice cannot be
        // saved, nothing is chosen, so the settings and the status never disagree.
        const saved = await this.dependencies.saveChoice(SOTTO_SPEECH_MODEL_ID).then(() => true, () => false)
        if (saved) choice = SOTTO_SPEECH_MODEL_ID
      }
      this.choice = choice
      loaded = this.loadChoice()
    })
    await loaded
  }

  status(): SpeechModelStatus {
    if (this.choice === SOTTO_SPEECH_MODEL_ID) return this.dependencies.store.get()
    return this.choice === null ? MISSING : this.ownStatus
  }

  /** The engine of the chosen model while it is ready, otherwise null. */
  currentEngine(): SpeechEngine | null {
    if (this.choice === SOTTO_SPEECH_MODEL_ID) return this.dependencies.store.currentEngine()
    return this.choice !== null && this.ownStatus.state === 'ready' ? this.engine : null
  }

  /** Sotto's model first, whether downloaded or not, then the FluidAudio models found now. */
  async list(): Promise<SpeechModelOption[]> {
    const [downloaded, found] = await Promise.all([this.dependencies.store.isDownloaded(), this.findFluidAudio()])
    return [
      {
        id: SOTTO_SPEECH_MODEL_ID,
        name: SPEECH_MODEL.name,
        maker: SPEECH_MODEL.maker,
        languages: `${SPEECH_MODEL.languages} European languages`,
        source: 'sotto',
        installed: downloaded,
        bytes: SPEECH_MODEL_BYTES,
      },
      ...found.map((model): SpeechModelOption => ({
        id: model.id,
        name: model.name,
        maker: model.maker,
        languages: model.languages,
        source: 'fluidaudio',
        installed: true,
        bytes: model.bytes,
      })),
    ]
  }

  /**
   * Switches dictation to `id`, downloading Sotto's model if that is the one picked, since the user
   * asked for it. False for a model that is not on offer or a choice that could not be saved, and
   * then nothing changes. Resolves once the choice is saved, not when the model is ready.
   */
  choose(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.disposed) return false
      if (id !== SOTTO_SPEECH_MODEL_ID && !(await this.findFluidAudio()).some((model) => model.id === id)) return false
      if (id === this.choice) {
        // Settings can lose the saved choice while the model runs (an import, a hand edit); save it again.
        if (this.dependencies.readChoice() !== id && !(await this.dependencies.saveChoice(id).then(() => true, () => false))) return false
        this.retry()
        return true
      }
      if (!(await this.dependencies.saveChoice(id).then(() => true, () => false))) return false
      const previous = this.choice
      this.choice = id
      this.release(previous)
      void this.loadChoice()
      return true
    })
  }

  /** Try again for the chosen model; with nothing chosen there is nothing to try. */
  download(): void {
    void this.enqueue(async () => { this.retry() })
  }

  dispose(): void {
    this.disposed = true
    this.load += 1
    disposeEngine(this.engine)
    this.engine = null
    this.dependencies.store.dispose()
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task)
    this.queue = next.catch(() => undefined)
    return next
  }

  private retry(): void {
    if (this.disposed || this.choice === null) return
    if (this.choice === SOTTO_SPEECH_MODEL_ID) {
      void this.dependencies.store.ensure()
      return
    }
    if (this.ownStatus.state === 'loading' || this.ownStatus.state === 'ready') return
    void this.loadChoice()
  }

  /** Lets go of the model chosen before, so two never hold memory or a helper process at once. */
  private release(previous: string | null): void {
    this.load += 1
    if (previous === SOTTO_SPEECH_MODEL_ID) this.dependencies.store.unload()
    disposeEngine(this.engine)
    this.engine = null
    this.ownStatus = MISSING
  }

  /**
   * Loads the current choice. Sotto's model downloads only because the user chose it, so a download
   * that stopped when Sotto quit picks up again at the next start.
   */
  private async loadChoice(): Promise<void> {
    const load = ++this.load
    const choice = this.choice
    if (choice === null) {
      this.emit(MISSING)
      return
    }
    if (choice === SOTTO_SPEECH_MODEL_ID) {
      if (load === this.load) await this.dependencies.store.ensure()
      return
    }

    const model = (await this.findFluidAudio()).find((candidate) => candidate.id === choice)
    if (load !== this.load) return
    if (model === undefined) {
      // The app that downloaded it removed it, or the folder moved; its size is no longer known.
      this.ownStatus = { state: 'failed', reason: 'gone', receivedBytes: 0, totalBytes: 1 }
      this.emit(this.ownStatus)
      return
    }
    this.ownStatus = { state: 'loading' }
    this.emit(this.ownStatus)
    let engine: SpeechEngine
    try {
      engine = await this.dependencies.coreMlLoader(model.version)(model.directory)
    } catch {
      if (load !== this.load) return
      this.ownStatus = { state: 'failed', reason: 'engine', receivedBytes: 0, totalBytes: Math.max(1, model.bytes) }
      this.emit(this.ownStatus)
      return
    }
    if (load !== this.load) {
      disposeEngine(engine)
      return
    }
    this.engine = engine
    this.ownStatus = { state: 'ready' }
    this.emit(this.ownStatus)
    // macOS can stop the helper (memory pressure, a crash). Say so, so Try again can start it again.
    engine.onStopped?.(() => {
      if (load !== this.load || this.engine !== engine) return
      this.engine = null
      this.ownStatus = { state: 'failed', reason: 'engine', receivedBytes: 0, totalBytes: Math.max(1, model.bytes) }
      this.emit(this.ownStatus)
    })
  }

  private findFluidAudio(): Promise<readonly FluidAudioModel[]> {
    return this.dependencies.findFluidAudio().catch(() => [])
  }

  private emit(status: SpeechModelStatus): void {
    if (this.disposed) return
    try {
      this.dependencies.onStatus(status)
    } catch {
      // A window that cannot take the update does not stop the model.
    }
  }
}
