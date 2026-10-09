// @vitest-environment node
import type { AgentHost } from '../../src/main/agents/host';
import type { ProviderId } from '../../src/shared/agents';

export interface RecordedRpc { id?: string | number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> }

/** Short reaper settings so a test can watch a session be stopped instead of waiting out a real hour. */
export interface AdapterSessionOptions { reaperSweepMs?: number; sessionIdleMs?: number }

export interface AdapterFixture {
  host: AgentHost; projectId: string; modelId: string; root: string
  driver: {
    typeInProvider(sessionId: string, text: string): Promise<void>
    completeTurn(sessionId: string, text: string): Promise<void>
    raiseQuestion(sessionId: string, text: string): Promise<void>
    raisePermission(sessionId: string, text: string): Promise<void>
    delayNextAck(method: string): Promise<void>
    requests(): Promise<RecordedRpc[]>
    restart(): Promise<AdapterFixture>
    /**
     * Where the provider reports agent work a turn left running: finish the turn so that a subagent it
     * launched is still running afterwards, then report that subagent finished. Absent where it reports none.
     */
    backgroundWork?: {
      completeLeaving(sessionId: string, text: string, description: string): Promise<void>
      end(sessionId: string): Promise<void>
    }
  }
  cleanup(): Promise<void>
  /** Decode recorded native traffic; fixtures must also reject invalid native replies. */
  protocol?: {
    promptMethod: string
    resumeMethod: string
    permissionDecision(record: RecordedRpc): boolean | undefined
  }
  /** A process-owned turn may stop when its adapter process exits. */
  restartStatus?: 'idle' | 'running'
  /** Lazy provider sessions: what this provider saw start, and whether one thread's session has stopped. */
  sessions?: {
    starts(threadId: string): Promise<number>
    stopped(threadId: string): Promise<boolean>
  }
  /** `sendStages`: the host writes no prompt to a client, so it has none to mark written and acknowledged (#763). */
  skips?: Partial<Record<'uncertain' | 'restart' | 'lazy' | 'sendStages', string>>
  /**
   * Sotto's side writing on this provider's own client (ADR-0026): script the next answer, and read back
   * what each side call was given. Absent where the provider writes nothing, whose adapter answers null.
   */
  sideWriting?: {
    answer(text: string): Promise<void>
    calls(): Promise<{ cwd: string; model: string | undefined; material: string }[]>
  }
  /**
   * Where a provider applies thread settings to its running session in place (#317): script how it answers
   * settings requests from now on (refuse them, lose the answer, or answer normally), and read what the running
   * session would use for its next turn and which process that is. Absent where a provider does not.
   */
  liveSettings?: {
    refuse(): Promise<void>
    silence(): Promise<void>
    answer(): Promise<void>
    effective(threadId: string): Promise<{ process: number; modelId: string; reasoningEffort?: string; runtimeMode: string }>
  }
  /**
   * What a thread settings change hands back (#318). `snapshot`: a change the provider confirmed comes back with
   * the snapshot the adapter emitted for it; absent, a result may leave it out and the coordinator reads the
   * thread instead. `loseConfirmation`: script the next settings change's confirmation away, where the fixture can.
   */
  settings?: { snapshot: boolean; loseConfirmation?(): Promise<void> }
  /**
   * Where the adapter is told its client was replaced on disk (ADR-0042, ADR-0038): which provider it is, and
   * `install`, which puts a newer client where the adapter will find it and answers the version it reports.
   * Absent where the client updates with another app, as Devin's does.
   */
  clientUpdate?: { provider: ProviderId; install(): Promise<string> }
}

/** The same provider behavior at the client boundary. Unlike AgentHost, HostService owns message and
 * command IDs and creates a native session only on first send, so its contract uses returned IDs. */
export interface HostServiceFixture {
  client?: import('../../src/main/agents/hostService').ClientIdentity
  service: import('../../src/main/agents/hostService').HostService
  provider: import('../../src/shared/agents').ProviderId
  root: string
  modelId: string
  driver: Omit<AdapterFixture['driver'], 'restart'> & { restart(): Promise<HostServiceFixture> }
  sessions?: AdapterFixture['sessions']
  nativeStarted(threadId: string): Promise<boolean>
  protocol?: AdapterFixture['protocol']
  skips?: AdapterFixture['skips']
  cleanup(): Promise<void>
}
