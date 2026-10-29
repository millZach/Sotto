/**
 * A loaded speech model: float samples at 16 kHz in, the words heard out. Sotto's own Parakeet models run in a helper
 * process (`parakeetEngine.ts`), and so do FluidAudio's Core ML models on a Mac (`coreMlEngine.ts`); whatever runs one,
 * main sees only this.
 */
export interface SpeechEngine {
  transcribe(samples: Float32Array): Promise<string>
  /** Lets go of what the model holds outside main, such as its helper process; an engine with nothing to let go of leaves it out. */
  dispose?(): void
  /** Tells `listener` once if the model stops by itself, a helper that crashed or hung, so it can be loaded again. */
  onStopped?(listener: () => void): void
}

/**
 * Starts the engine on a verified model folder; rejects when the native module or the model will not load. `signal`
 * cancels a load still under way, so letting go of the model while it loads ends whatever the load started.
 */
export type SpeechEngineLoader = (modelDirectory: string, signal?: AbortSignal) => Promise<SpeechEngine>
