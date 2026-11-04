import {
  AudioRecorder,
  createAudioRecorderDependencies,
  type AudioContextAdapter,
  type AudioRecorderDependencies,
  type AudioRecorderOptions,
} from './audioRecorder'

export interface PreparedCaptureContext {
  readonly context: AudioContextAdapter
  suspended: Promise<void>
  readonly registered: Promise<void>
  readonly stateChanged: () => void
  active: boolean
  stale: boolean
  retired: boolean
  onClosed?: () => void
}

/** One controller's graph preparation. Microphone streams and audio stay in its recorders. */
export class PreparedAudioCapture {
  private prepared: PreparedCaptureContext | undefined
  private enabled = true
  private disposed = false
  private readonly deviceChanged = (): void => {
    const prepared = this.prepared
    if (prepared === undefined) return
    prepared.stale = true
    // A changed device list need not mean the active microphone disappeared.
    // Its track events still own that decision; replace the context at release.
    if (!prepared.active) void this.rebuild(prepared)
  }

  constructor(private readonly dependencies: AudioRecorderDependencies = createAudioRecorderDependencies()) {
    dependencies.mediaDevices.addEventListener?.('devicechange', this.deviceChanged)
  }

  createRecorder(options: AudioRecorderOptions): AudioRecorder {
    return new AudioRecorder(options, this.dependencies, this)
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return
    this.enabled = enabled
    if (enabled) {
      this.dependencies.mediaDevices.addEventListener?.('devicechange', this.deviceChanged)
    } else {
      this.dependencies.mediaDevices.removeEventListener?.('devicechange', this.deviceChanged)
      if (this.prepared !== undefined) void this.retire(this.prepared)
    }
  }

  async prewarm(): Promise<void> {
    if (!this.enabled || this.disposed) return
    await this.prepare().registered
  }

  claim(onClosed: () => void): PreparedCaptureContext {
    if (!this.enabled || this.disposed) throw new Error('Audio capture is off')
    const prepared = this.prepare()
    if (prepared.active) throw new Error('Audio capture is already in use')
    prepared.active = true
    prepared.onClosed = onClosed
    return prepared
  }

  async release(prepared: PreparedCaptureContext): Promise<void> {
    if (!prepared.active) return
    prepared.active = false
    delete prepared.onClosed
    if (prepared.retired) return
    if (prepared.stale || prepared.context.state === 'closed') {
      await this.rebuild(prepared)
    } else {
      try {
        // A fresh recorder can start while the previous cancel is finishing.
        // It must await this suspension before resuming the shared context.
        prepared.suspended = prepared.context.suspend()
        await prepared.suspended
      } catch {
        // A context that cannot go idle must not keep audio resources running.
        await this.retire(prepared)
      }
    }
  }

  dispose(): void {
    this.setEnabled(false)
    this.disposed = true
  }

  private prepare(): PreparedCaptureContext {
    if (this.prepared?.context.state === 'closed') void this.retire(this.prepared)
    if (this.prepared !== undefined) return this.prepared
    const context = this.dependencies.createAudioContext()
    const suspended = context.suspend()
    const prepared: PreparedCaptureContext = {
      context,
      suspended,
      registered: suspended.then(() => context.audioWorklet.addModule(this.dependencies.audioWorkletModuleUrl)),
      active: false,
      stale: false,
      retired: false,
      stateChanged: () => {
        if (context.state !== 'closed' || prepared.retired) return
        prepared.stale = true
        if (prepared.active) prepared.onClosed?.()
        else void this.rebuild(prepared)
      },
    }
    this.prepared = prepared
    context.addEventListener?.('statechange', prepared.stateChanged)
    // A failed background preparation is retried on the next explicit start.
    void prepared.registered.catch(() => this.retire(prepared))
    return prepared
  }

  private async rebuild(prepared: PreparedCaptureContext): Promise<void> {
    await this.retire(prepared)
    // Preparation has no press-time marks; the recorder measures its own wait.
    void this.prewarm().catch(() => undefined)
  }

  private async retire(prepared: PreparedCaptureContext): Promise<void> {
    if (prepared.retired) return
    prepared.retired = true
    delete prepared.onClosed
    prepared.context.removeEventListener?.('statechange', prepared.stateChanged)
    if (this.prepared === prepared) this.prepared = undefined
    try {
      if (prepared.context.state !== 'closed') await prepared.context.close()
    } catch {
      // The owner has dropped this context; cleanup cannot revive or reuse it.
    }
  }
}
