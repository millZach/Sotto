import type { TerminalAgentState, TerminalProvider } from '../../shared/terminalWorkspace'
import type { TerminalAgentHookEvent } from './hooks'
import { TerminalAgentScreen, TerminalScreenRules, type TerminalScreenEvidence } from './screen'

/** Run-local state only. A request, unread mark and provider identity are never restored from output or disk. */
export class TerminalAgentStateMachine {
  state: TerminalAgentState = 'starting'
  detection: 'available' | 'unavailable' = 'unavailable'
  providerSessionId: string | undefined
  private readonly screen: TerminalAgentScreen
  private readonly rules: TerminalScreenRules
  private evidence: TerminalScreenEvidence = { detection: 'unavailable' }
  private live = false
  private seen = new Set<string>()
  private visible = false
  private knownWork = false
  private screenWork = false
  private interrupted = false
  private completion = false
  private request: string | undefined
  private candidateSession: string | undefined
  private conflictingSession = false
  private completedTurns = new Set<string>()
  private activeTurn: string | undefined
  private fresh = false
  private awaitingReady = true
  private inputReady = false
  private finishedObserved = false
  private localCommand = false
  private draftStarted = false
  private hooksKnown = false
  private pendingSubmission = false
  constructor(readonly runId: string, private readonly provider: TerminalProvider, cols: number, rows: number, providerSessionId?: string) {
    this.screen = new TerminalAgentScreen(cols, rows); this.rules = new TerminalScreenRules(provider)
    this.providerSessionId = providerSessionId
  }
  started(): void { this.live = true; this.reconcile() }
  setVisible(visible: boolean): void { this.visible = visible; if (visible && this.state === 'just-finished') this.state = 'idle' }
  resize(cols: number, rows: number): void { this.screen.resize(cols, rows); this.fresh = false; this.evidence = { detection: 'unavailable' }; this.detection = 'unavailable' }
  output(chunk: string): void {
    if (this.state === 'exited') return
    this.screen.write(chunk); this.fresh = true
    this.evidence = this.rules.read(this.screen); this.detection = this.evidence.detection
    if (this.evidence.unsupportedVersion) this.awaitingReady = false
    if (this.evidence.state) this.inputReady = this.evidence.state === 'idle'
    if (this.evidence.state === 'idle' && !this.draftStarted) this.localCommand = false
    if (this.evidence.failed) { this.interrupted = true; this.completion = false }
    this.reconcile()
  }
  /** Input invalidates a screen-only request. Ctrl+C cancels; Grok's Escape deliberately does not. */
  input(data: string): void {
    if (this.state === 'exited') return
    const submitted = /[\r\n]/u.test(data) && this.inputReady && !this.request
    if (this.inputReady && !this.draftStarted && data.charCodeAt(0) >= 32) { this.localCommand = data.trimStart().startsWith('/'); this.draftStarted = true }
    const cancel = data.includes('\x03') || this.provider !== 'grok' && data === '\x1b' && this.state === 'working'
    this.fresh = false; this.evidence = { detection: 'unavailable' }; this.detection = 'unavailable'
    if (cancel) { this.interrupted = true; this.completion = false; this.knownWork = false; this.screenWork = false; this.request = undefined; this.pendingSubmission = false }
    if (submitted && !cancel && !this.localCommand) {
      this.state = 'working'; this.knownWork = true; this.interrupted = false; this.completion = false; this.inputReady = false; this.finishedObserved = false
      // A PTY can echo into its old ready screen before drawing the new turn. Only a current work frame or admitted completion ends this reservation.
      this.pendingSubmission = true
    }
    if (submitted || cancel) { this.draftStarted = false; this.localCommand = false }
    else if (!this.request && this.state === 'needs-you') this.state = this.knownWork ? 'working' : 'idle'
  }
  hook(event: TerminalAgentHookEvent): void {
    if (this.state === 'exited' || event.runId !== this.runId || this.seen.has(event.eventId)) return
    this.seen.add(event.eventId)
    if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!)
    if (this.provider === 'codex' && event.providerSessionId) {
      if (this.candidateSession && this.candidateSession !== event.providerSessionId) this.conflictingSession = true
      this.candidateSession ??= event.providerSessionId
      if (this.conflictingSession) this.providerSessionId = undefined
    }
    switch (event.kind) {
      case 'session-start': this.hooksKnown = true; this.awaitingReady = true; break // SessionStart precedes the actual live input prompt.
      case 'working':
        if (event.turnId && this.completedTurns.has(event.turnId)) break
        if (this.finishedObserved && this.fresh && this.evidence.state === 'idle') break // A delayed tool hook cannot create a second unseen finish.
        this.hooksKnown = true
        this.activeTurn = event.turnId ?? this.activeTurn
        this.knownWork = true; this.interrupted = false; this.completion = false; this.awaitingReady = false; this.finishedObserved = false
        this.fresh = false; this.state = 'working'; break
      case 'permission':
        if (this.interrupted) break
        this.request = event.requestId; this.completion = false; this.pendingSubmission = false; this.state = 'needs-you'; break
      case 'completed':
        if (event.turnId && (this.completedTurns.has(event.turnId) || this.provider === 'codex' && this.activeTurn && this.activeTurn !== event.turnId)) break
        if (!this.interrupted && !this.finishedObserved && !this.request && this.evidence.state !== 'needs-you') { this.completion = true; this.pendingSubmission = false }
        if (event.turnId) {
          this.completedTurns.add(event.turnId)
          if (this.completedTurns.size > 512) this.completedTurns.delete(this.completedTurns.values().next().value!)
        }
        break
      case 'cancelled': case 'ended':
        this.interrupted = true; this.knownWork = false; this.screenWork = false; this.completion = false; this.request = undefined; this.pendingSubmission = false; break
      case 'notification':
        // Delayed notifications corroborate a *current* screen, never invent a request/completion.
        if (event.notificationType !== 'idle_prompt' && this.fresh && this.evidence.state === 'needs-you') this.state = 'needs-you'
        break
    }
    this.reconcile()
  }
  requestClosed(requestId: string): void { if (this.request === requestId) { this.request = undefined; this.reconcile() } }
  unavailable(): void { this.request = undefined; this.detection = 'unavailable'; this.reconcile() }
  exit(): void { this.state = 'exited'; this.live = false; this.knownWork = false; this.screenWork = false; this.request = undefined; this.completion = false; this.providerSessionId = undefined; this.pendingSubmission = false }
  /** Output activity may settle only work inferred by the compatibility fallback, never known silent work. */
  quiet(): void { if (this.live && !this.knownWork && !this.request && this.evidence.state === undefined && this.state === 'working') this.state = 'idle' }
  private reconcile(): void {
    if (this.state === 'exited' || !this.live) return
    if (this.request || this.fresh && this.evidence.state === 'needs-you') { this.screenWork = false; this.completion = false; this.pendingSubmission = false; this.state = 'needs-you'; return }
    if (this.fresh && this.evidence.state === 'working') { if (this.state === 'idle' || this.state === 'just-finished') { this.interrupted = false; this.finishedObserved = false }; this.knownWork = true; this.screenWork = true; this.pendingSubmission = false; this.awaitingReady = false; this.state = 'working'; return }
    if (this.fresh && this.evidence.state === 'idle') {
      this.awaitingReady = false
      if (this.pendingSubmission) { this.state = 'working'; return }
      if (this.provider === 'codex' && this.candidateSession && !this.conflictingSession) this.providerSessionId = this.candidateSession
      const finished = !this.interrupted && (this.completion || this.screenWork && (this.provider !== 'claude' || !this.hooksKnown))
      this.knownWork = false; this.screenWork = false; this.completion = false; this.activeTurn = undefined
      if (finished) { this.finishedObserved = true; this.state = this.visible ? 'idle' : 'just-finished' }
      else if (this.state !== 'just-finished') this.state = 'idle'
      return
    }
    if (this.knownWork) this.state = 'working'
    else if (this.state !== 'just-finished') this.state = this.awaitingReady && !this.evidence.unresolvedVersion ? 'starting' : this.fresh ? 'working' : 'idle'
  }
}
