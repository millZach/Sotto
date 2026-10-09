// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { TerminalAgentStateMachine } from '../../../src/main/terminals/state'
import { TerminalAgentScreen, TerminalScreenRules } from '../../../src/main/terminals/screen'
import type { TerminalAgentHookEvent } from '../../../src/main/terminals/hooks'
import { normalizeTerminalHook } from '../../../src/main/terminals/hooksNormalizer'

const header = 'Claude Code v2.1.295'
const redraw = (body: string, title = header) => `\x1b[2J\x1b[H${title}\r\n${body}`
const idle = redraw('❯ \r\n? for shortcuts')
const work = redraw('✻ Working… (esc to interrupt)')
const request = redraw('Do you want to make this edit to marker.txt?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel · Tab to amend')
const codexTitle = 'OpenAI Codex (v0.162.0)'
const codexIdle = redraw('› Ask Codex to do anything\r\n? for shortcuts', codexTitle)
const codexWork = redraw('• Working (0s • esc to interrupt)', codexTitle)
const grokTitle = 'Grok Build  1.0.50'
const grokIdle = redraw('│>\r\n└─ Grok 4.7 (xhigh) ─┘\r\nGrok 4.7 (xhigh) · auto-review', grokTitle)
const grokPermission = '┃  Allow Execute?\r\n┃  1 (●) Yes, proceed\r\n┃  2 (○) No, reject (type to add feedback)\r\nTab/Space:permission'
const event = (kind: TerminalAgentHookEvent['kind'], values: Partial<TerminalAgentHookEvent> = {}): TerminalAgentHookEvent => ({ terminalId: 'terminal', runId: 'run', eventId: `${kind}-${Math.random()}`, kind, state: kind === 'working' ? 'working' : 'idle', ...values })
const agent = () => { const state = new TerminalAgentStateMachine('run', 'claude', 100, 30, 'session'); state.started(); state.output(idle); return state }

describe('terminal agent run state', () => {
  it('recognises the native empty Codex composer at startup and after visible or hidden completion', () => {
    for (const visible of [false, true]) {
      const state = new TerminalAgentStateMachine('run', 'codex', 120, 30); state.started(); state.output(codexIdle)
      expect(state.state).toBe('idle')
      state.setVisible(visible); state.output(codexWork)
      state.hook(event('completed', { turnId: 'turn' })); state.output(codexIdle)
      expect(state.state).toBe(visible ? 'idle' : 'just-finished')
      state.output(redraw('› Ask Codex to do anything else\r\n? for shortcuts', codexTitle))
      expect(state.detection).toBe('unavailable')
    }
  })
  it('keeps empty/supported startup Starting until ready, while admitting unknown/unversioned activity fallback', () => {
    const state = new TerminalAgentStateMachine('run', 'claude', 100, 30)
    state.started(); state.quiet(); expect(state.state).toBe('starting')
    state.output('\x1b[2J\x1b[H\x07'); state.quiet(); expect(state.state).toBe('starting')
    state.output('Preparing the CLI'); expect(state.state).toBe('working'); state.quiet(); expect(state.state).toBe('idle')
    expect(state.detection).toBe('unavailable')
    state.output(redraw('Preparing the CLI')); state.quiet(); expect(state.state).toBe('starting')
    state.output(idle); expect(state.state).toBe('idle')
    const unknown = new TerminalAgentStateMachine('run', 'claude', 100, 30)
    unknown.started(); unknown.output(redraw('Unrecognised new widget', 'Claude Code v9.9.9'))
    expect(unknown.state).toBe('working'); unknown.quiet(); expect(unknown.state).toBe('idle')
    expect(unknown.detection).toBe('unavailable')
  })
  it('resolves a split supported banner back to Starting without inventing a request or unread completion', () => {
    const state = new TerminalAgentStateMachine('run', 'claude', 100, 30); state.started()
    state.output('Claude Code v2.1.'); expect(state.state).toBe('working'); state.quiet(); expect(state.state).toBe('idle')
    state.output('295\r\nPreparing the CLI'); expect(state.state).toBe('starting')
    state.output(idle); expect(state.state).toBe('idle')
    const unversioned = new TerminalAgentStateMachine('run', 'codex', 100, 30); unversioned.started()
    unversioned.output('Would you like to run the following command?\r\n› 1. Yes, proceed (y)\r\n2. No, and tell Codex what to do differently (esc)\r\nPress enter to confirm or esc to cancel')
    expect(unversioned.state).toBe('working'); unversioned.quiet(); expect(unversioned.state).toBe('idle')
    unversioned.output('› \r\n? for shortcuts'); expect(unversioned.state).toBe('working'); unversioned.quiet(); expect(unversioned.state).toBe('idle')
    expect(unversioned.detection).toBe('unavailable')
  })
  it('publishes compatibility per CLI version, not per frame, so a draft, a resize or a streamed reply cannot flicker the pane note', () => {
    const state = agent(); expect(state.compatibility).toBe('available')
    state.input('h'); expect(state.detection).toBe('unavailable'); expect(state.compatibility).toBe('available')
    state.resize(90, 24); expect(state.compatibility).toBe('available')
    state.output(redraw('A streamed reply that matches no rule')); expect(state.detection).toBe('unavailable'); expect(state.compatibility).toBe('available')
    const unknown = new TerminalAgentStateMachine('run', 'claude', 100, 30); unknown.started()
    expect(unknown.compatibility).toBe('available')
    unknown.output(redraw('Unrecognised new widget', 'Claude Code v9.9.9')); expect(unknown.compatibility).toBe('unavailable')
    unknown.input('h'); expect(unknown.compatibility).toBe('unavailable')
    const split = new TerminalAgentStateMachine('run', 'claude', 100, 30); split.started()
    split.output('Claude Code v2.1.'); expect(split.compatibility).toBe('unavailable')
    split.output('295\r\nPreparing the CLI'); expect(split.compatibility).toBe('available')
  })
  it('waits for a live ready prompt after SessionStart and keeps silent known work', () => {
    const state = new TerminalAgentStateMachine('run', 'claude', 100, 30)
    state.started(); state.hook(event('session-start')); expect(state.state).toBe('starting')
    state.output(idle); expect(state.state).toBe('idle')
    state.hook(event('working')); state.quiet(); expect(state.state).toBe('working')
    state.output('unmatched redraw'); state.quiet(); expect(state.state).toBe('working')
  })
  it('holds an unseen completion without a timer and viewing clears it for every client', () => {
    const state = agent(); state.output(work); state.output(idle)
    expect(state.state).toBe('just-finished'); state.quiet(); expect(state.state).toBe('just-finished')
    state.setVisible(true); expect(state.state).toBe('idle')
    state.setVisible(false); state.hook(event('completed')); expect(state.state).toBe('idle')
  })
  it('never marks completion seen in an unfocused pane, or later marks it after leaving', () => {
    const state = agent(); state.setVisible(true); state.output(work); state.output(idle)
    expect(state.state).toBe('idle'); state.setVisible(false); state.hook(event('completed')); expect(state.state).toBe('idle')
  })
  it('requires successful Claude Stop after live hooks, rather than guessing background completion from its ready prompt', () => {
    const state = agent(); state.hook(event('session-start')); state.output(work); state.hook(event('working')); state.output(idle)
    expect(state.state).toBe('idle')
    state.hook(event('completed')); expect(state.state).toBe('just-finished')
    state.setVisible(true); state.setVisible(false); state.hook(event('working')); state.hook(event('completed')); expect(state.state).toBe('idle')
  })
  it.each(['ready-first', 'stop-first', 'stop-first-queued-work'])('remembers a visible Claude completion with %s delivery, while admitting the next unseen turn', order => {
    const state = agent(); state.hook(event('session-start')); state.output(idle); state.setVisible(true)
    state.hook(event('working', { turnId: 'first' })); state.output(work)
    if (order === 'ready-first') state.output(idle); else state.hook(event('completed', { turnId: 'first' }))
    state.setVisible(false)
    if (order === 'stop-first-queued-work') state.output(work)
    if (order === 'ready-first') state.hook(event('completed', { turnId: 'first' })); else state.output(idle)
    expect(state.state).toBe('idle')
    state.input('a new turn\r'); state.hook(event('working', { turnId: 'next', workPhase: 'submitted' })); state.output(work); state.output(idle)
    expect(state.state).toBe('idle')
    state.hook(event('completed', { turnId: 'next' })); expect(state.state).toBe('just-finished')
  })
  it.each([
    ['continuing', { stop_hook_active: true }],
    ['background', { background_tasks: [{}] }],
    ['session-cron', { session_crons: [{}] }],
  ] as const)('admits silent hidden continuation after visible readiness when a %s Stop supplies Working evidence', (reason, extra) => {
    const state = agent(); state.hook(event('session-start')); state.output(idle); state.setVisible(true)
    state.hook(event('working', { turnId: 'turn' })); state.output(work)
    const binding = { terminalId: 'terminal', runId: 'run' }
    const payload = { hook_event_name: 'Stop', session_id: 'session', prompt_id: 'turn' }
    state.quiet(); expect(state.state).toBe('working')
    state.output(idle)
    const continuing = normalizeTerminalHook('claude', 'Stop', { ...payload, ...extra }, binding)!.event
    expect(continuing, `${reason} Stop cannot emit completion`).toMatchObject({ kind: 'working', workPhase: 'continuing' })
    state.hook(continuing); expect(state.state).toBe('working')
    state.output(idle); state.quiet(); expect(state.state).toBe('working')
    state.setVisible(false); state.hook(event('working', { turnId: 'turn', workPhase: 'tool-start' })); expect(state.state).toBe('working')
    state.hook(normalizeTerminalHook('claude', 'Stop', payload, binding)!.event); expect(state.state).toBe('working')
    state.output(idle); expect(state.state).toBe('just-finished')
  })
  it('keeps a viewed ready redraw Working during continuation and marks the later hidden successful finish', () => {
    const state = agent(); state.hook(event('session-start')); state.output(idle)
    state.hook(event('working', { turnId: 'turn', workPhase: 'submitted' })); state.output(work)
    state.hook(event('working', { turnId: 'turn', workPhase: 'continuing' })); state.output(idle)
    expect(state.state).toBe('working')
    state.setVisible(true); state.quiet(); expect(state.state).toBe('working')
    state.setVisible(false); expect(state.state).toBe('working')
    state.hook(event('completed', { turnId: 'turn' })); expect(state.state).toBe('just-finished')
    state.output(idle); expect(state.state).toBe('just-finished')
  })
  it('counts viewing an admitted successful Stop before its ready screen as viewing the completion', () => {
    const state = agent(); state.hook(event('session-start')); state.output(idle)
    state.hook(event('working', { turnId: 'turn', workPhase: 'submitted' })); state.output(work)
    state.hook(event('working', { turnId: 'turn', workPhase: 'continuing' }))
    state.hook(event('completed', { turnId: 'turn' })); expect(state.state).toBe('working')
    state.setVisible(true); expect(state.state).toBe('working')
    state.setVisible(false); state.output(idle); expect(state.state).toBe('idle')
  })
  it('allows continuing evidence to revoke a pending completion before its ready screen settles the turn', () => {
    const state = agent(); state.hook(event('session-start')); state.output(idle)
    state.hook(event('working', { turnId: 'turn', workPhase: 'submitted' })); state.output(work)
    state.hook(event('completed', { turnId: 'turn' })); expect(state.state).toBe('working')
    state.hook(event('working', { turnId: 'turn', workPhase: 'continuing' }))
    state.output(idle); state.quiet(); expect(state.state).toBe('working')
    state.hook(event('completed', { turnId: 'turn' })); expect(state.state).toBe('just-finished')
    state.setVisible(true); state.setVisible(false)
    state.hook(event('working', { turnId: 'turn', workPhase: 'continuing' })); expect(state.state).toBe('idle')
  })
  it.each(['ready-first', 'stop-first'] as const)('retires the known turn after a successful Stop without a turn ID, with %s delivery', order => {
    const state = agent(); state.hook(event('session-start')); state.output(idle)
    state.hook(event('working', { turnId: 'turn', workPhase: 'submitted' })); state.output(work)
    if (order === 'ready-first') state.output(idle)
    state.hook(event('completed'))
    if (order === 'stop-first') state.output(idle)
    expect(state.state).toBe('just-finished')
    state.setVisible(true); state.setVisible(false)
    state.hook(event('working', { turnId: 'turn', workPhase: 'continuing' })); expect(state.state).toBe('idle')
    state.output(idle); state.hook(event('completed', { turnId: 'turn' })); expect(state.state).toBe('idle')
  })
  it('admits a later genuine completion after a prior callback was blocked by a live request', () => {
    const state = agent(); state.hook(event('session-start')); state.output(idle)
    state.hook(event('working', { turnId: 'turn', workPhase: 'submitted' })); state.output(work)
    state.hook(event('permission', { turnId: 'turn', requestId: 'request' }))
    state.hook(event('completed', { turnId: 'turn' })); expect(state.state).toBe('needs-you')
    state.output(idle); state.requestClosed('request'); expect(state.state).toBe('idle')
    state.hook(event('completed', { turnId: 'turn' })); expect(state.state).toBe('just-finished')
  })
  it.each(['none', 'legacy', 'tool-start', 'tool-end'] as const)('remembers viewing hidden readiness before delayed Stop and ignores %s late tool evidence', phase => {
    const state = agent(); state.hook(event('session-start')); state.output(idle)
    state.hook(event('working', { turnId: 'first', workPhase: 'submitted' })); state.output(work); state.output(idle)
    expect(state.state).toBe('idle')
    state.setVisible(true); state.setVisible(false)
    if (phase !== 'none') state.hook(event('working', { turnId: 'first', ...(phase === 'legacy' ? {} : { workPhase: phase }) }))
    state.hook(event('completed', { turnId: 'first' })); expect(state.state).not.toBe('just-finished')
    state.output(idle); expect(state.state).toBe('idle')
  })
  it.each(['legacy', 'tool-start', 'tool-end'] as const)('preserves admitted completion and its visibility through delayed %s evidence without turn IDs', phase => {
    for (const visible of [false, true]) {
      const state = agent(); state.hook(event('session-start')); state.output(idle); state.setVisible(visible)
      state.hook(event('working')); state.output(work); state.hook(event('completed'))
      state.setVisible(false); state.hook(event('working', phase === 'legacy' ? {} : { workPhase: phase }))
      state.output(work); state.output(idle)
      expect(state.state).toBe(visible ? 'idle' : 'just-finished')
    }
  })
  it('admits a genuinely submitted hook-only turn after a viewed finish and refuses the prior turn callbacks', () => {
    const state = agent(); state.hook(event('session-start')); state.output(idle)
    state.hook(event('working', { turnId: 'first', workPhase: 'submitted' })); state.output(work); state.output(idle)
    state.setVisible(true); state.setVisible(false)
    state.hook(event('working', { turnId: 'next', workPhase: 'submitted' })); expect(state.state).toBe('working')
    state.hook(event('working', { turnId: 'first', workPhase: 'tool-end' }))
    state.hook(event('completed', { turnId: 'first' })); state.output(idle); expect(state.state).toBe('working')
    state.hook(event('completed', { turnId: 'next' })); expect(state.state).toBe('just-finished')
  })
  it('retains the pending ready turn binding when the next submitted turn reaches ready before the first Stop', () => {
    const state = agent(); state.hook(event('session-start')); state.output(idle)
    state.hook(event('working', { turnId: 'a', workPhase: 'submitted' })); state.output(work); state.output(idle)
    state.hook(event('working', { turnId: 'b', workPhase: 'submitted' })); state.output(work); state.output(idle)
    state.hook(event('working', { turnId: 'a', workPhase: 'tool-end' })); expect(state.state).toBe('idle')
    state.hook(event('completed', { turnId: 'a' })); expect(state.state).toBe('idle')
    state.hook(event('completed', { turnId: 'b' })); expect(state.state).toBe('just-finished')
  })
  it.each(['prior-turn', 'unbound'] as const)('rejects a %s Stop after local submission and before its submitted hook', binding => {
    const state = agent(); state.hook(event('session-start')); state.output(idle); state.setVisible(true)
    state.hook(event('working', { turnId: 'a', workPhase: 'submitted' })); state.output(work); state.output(idle)
    state.setVisible(false); state.input('the next turn\r'); state.output(idle)
    state.hook(event('completed', binding === 'prior-turn' ? { turnId: 'a' } : {}))
    expect(state.state).toBe('working'); state.output(idle); expect(state.state).toBe('working')
    state.hook(event('working', { turnId: 'a', workPhase: 'tool-end' })); expect(state.state).toBe('working')
    state.hook(event('working', { turnId: 'b', workPhase: 'submitted' })); state.output(work); state.output(idle)
    state.hook(event('completed', { turnId: 'a' })); expect(state.state).toBe('idle')
    state.hook(event('completed', { turnId: 'b' })); expect(state.state).toBe('just-finished')
    state.hook(event('working', { turnId: 'a', workPhase: 'continuing' })); expect(state.state).toBe('just-finished')
  })
  it.each(['ready-first', 'stop-first'] as const)('settles locally submitted work bound by its tool hook before delayed submitted evidence, with %s delivery', order => {
    for (const visible of [false, true]) {
      const state = agent(); state.hook(event('session-start')); state.output(idle); state.setVisible(true)
      state.hook(event('working', { turnId: 'a', workPhase: 'submitted' })); state.output(work); state.output(idle)
      state.setVisible(false); state.input('next turn\r'); state.output(idle)
      state.hook(event('completed', { turnId: 'a' })); state.hook(event('completed')); expect(state.state).toBe('working')
      state.hook(event('working', { turnId: 'b', workPhase: 'tool-start' })); state.output(work); state.setVisible(visible)
      if (order === 'ready-first') state.output(idle)
      state.hook(event('completed', { turnId: 'b' }))
      expect(state.state).toBe(order === 'ready-first' ? visible ? 'idle' : 'just-finished' : 'working')
      state.setVisible(false); state.hook(event('working', { turnId: 'b', workPhase: 'submitted' }))
      if (order === 'stop-first') { expect(state.state).toBe('working'); state.output(idle) }
      expect(state.state).toBe(visible ? 'idle' : 'just-finished')
      state.hook(event('working', { turnId: 'b', workPhase: 'submitted' })); expect(state.state).toBe(visible ? 'idle' : 'just-finished')
    }
  })
  it('preserves viewed readiness when a same-turn submitted hook arrives after its tool evidence but before Stop', () => {
    const state = agent(); state.hook(event('session-start')); state.output(idle)
    state.input('a turn\r'); state.hook(event('working', { turnId: 'turn', workPhase: 'tool-end' })); state.output(work)
    state.setVisible(true); state.output(idle); expect(state.state).toBe('idle')
    state.setVisible(false); state.hook(event('working', { turnId: 'turn', workPhase: 'submitted' })); expect(state.state).toBe('idle')
    state.hook(event('completed', { turnId: 'turn' })); expect(state.state).toBe('idle')
  })
  it('binds a locally submitted turn through its native submitted phase even when the hook supplies no turn ID', () => {
    const state = agent(); state.hook(event('session-start')); state.output(idle)
    state.hook(event('working', { workPhase: 'submitted' })); state.output(work); state.output(idle)
    state.setVisible(true); state.setVisible(false); state.input('next turn\r'); state.output(idle)
    state.hook(event('completed')); expect(state.state).toBe('working')
    state.hook(event('working', { workPhase: 'submitted' })); state.output(work); state.output(idle)
    state.hook(event('completed')); expect(state.state).toBe('just-finished')
  })
  it('admits a new explicit continuation after a viewed finish, while refusing continuation for the completed turn', () => {
    const state = agent(); state.hook(event('session-start')); state.output(idle)
    state.hook(event('working', { turnId: 'a', workPhase: 'submitted' })); state.output(work)
    state.hook(event('completed', { turnId: 'a' })); state.output(idle); expect(state.state).toBe('just-finished')
    state.setVisible(true); state.setVisible(false)
    state.hook(event('working', { turnId: 'a', workPhase: 'continuing' })); expect(state.state).toBe('idle')
    state.hook(event('working', { turnId: 'b', workPhase: 'continuing' })); expect(state.state).toBe('working')
    state.output(idle); state.quiet(); expect(state.state).toBe('working')
    state.hook(event('completed', { turnId: 'b' })); expect(state.state).toBe('just-finished')
  })
  it('keeps a live permission ahead of out-of-order Working, completion and a ready screen', () => {
    const state = agent(); state.hook(event('working')); state.hook(event('permission', { requestId: 'r' }))
    state.hook(event('working')); state.hook(event('completed')); state.output(idle)
    expect(state.state).toBe('needs-you')
    state.requestClosed('another'); expect(state.state).toBe('needs-you')
    state.requestClosed('r'); expect(state.state).toBe('idle')
  })
  it.each(['a', 'b'])('keeps concurrent blocking requests until both close, with %s closing first', first => {
    const state = agent(); state.hook(event('working'))
    state.hook(event('permission', { requestId: 'a' })); state.hook(event('permission', { requestId: 'b' }))
    state.hook(event('working')); state.output(idle); state.requestClosed(first)
    state.hook(event('completed')); state.quiet(); expect(state.state).toBe('needs-you')
    state.requestClosed(first === 'a' ? 'b' : 'a'); expect(state.state).toBe('idle')
  })
  it.each(['cancelled', 'ended', 'exited'] as const)('clears every concurrent request on %s', end => {
    const state = agent(); state.hook(event('working'))
    state.hook(event('permission', { requestId: 'a' })); state.hook(event('permission', { requestId: 'b' }))
    if (end === 'exited') state.exit(); else state.hook(event(end))
    state.output(idle); state.requestClosed('a'); state.requestClosed('b')
    expect(state.state).toBe(end === 'exited' ? 'exited' : 'idle')
  })
  it('recognises a current native request and invalidates it on input/redraw without inventing completion', () => {
    const state = agent(); state.output(work); state.output(request); expect(state.state).toBe('needs-you')
    state.input('2'); expect(state.state).toBe('working')
    state.output(idle); expect(state.state).toBe('idle')
    state.hook(event('notification', { notificationType: 'permission_prompt' })); expect(state.state).toBe('idle')
  })
  it.each(['claude', 'codex'] as const)('keeps a screen-only %s approval open at every selection position', provider => {
    const mark = provider === 'claude' ? '❯' : '›'
    const title = provider === 'claude' ? header : codexTitle
    const prompt = provider === 'claude' ? 'Do you want to proceed?' : 'Would you like to run the following command?'
    const choices = provider === 'claude' ? ['1. Yes', '2. Yes, and do not ask again', '3. No']
      : ['1. Yes, proceed (y)', '2. Yes, and do not ask again (a)', '3. No, and tell Codex what to do differently (esc)']
    const controls = provider === 'claude' ? 'Enter to confirm · Esc to cancel' : 'Press enter to confirm or esc to cancel'
    const state = new TerminalAgentStateMachine('run', provider, 120, 30); state.started()
    state.output(provider === 'claude' ? idle : codexIdle); state.output(provider === 'claude' ? work : codexWork)
    for (let selected = 0; selected < choices.length; selected++) {
      state.input('\x1b[B')
      state.output(redraw(`${prompt}\r\n${choices.map((choice, index) => `${index === selected ? mark : ' '} ${choice}`).join('\r\n')}\r\n${controls}`, title))
      expect(state.state).toBe('needs-you')
    }
    state.input('\r'); state.output(provider === 'claude' ? idle : codexIdle)
    expect(state.state).toBe('idle')
  })
  it('withdraws screen-only requests immediately on resize without output, while retaining every live hook request', () => {
    const screenOnly = agent(); screenOnly.output(request); expect(screenOnly.state).toBe('needs-you')
    screenOnly.resize(80, 20); expect(screenOnly.state).toBe('idle'); expect(screenOnly.detection).toBe('unavailable')
    const working = agent(); working.output(work); working.output(request); working.resize(80, 20)
    expect(working.state).toBe('working'); working.quiet(); expect(working.state).toBe('working')
    const hooked = agent(); hooked.hook(event('permission', { requestId: 'a' })); hooked.hook(event('permission', { requestId: 'b' }))
    hooked.resize(80, 20); expect(hooked.state).toBe('needs-you')
    hooked.requestClosed('a'); expect(hooked.state).toBe('needs-you')
    hooked.requestClosed('b'); expect(hooked.state).toBe('idle')
  })
  it.each(['input', 'failure', 'error'] as const)('returning ready after %s earns no completion', reason => {
    const state = agent(); state.output(work)
    if (reason === 'input') state.input('\x03')
    if (reason === 'failure') state.hook(event('cancelled'))
    if (reason === 'error') state.output(redraw('Error: the operation failed\r\n❯ \r\n? for shortcuts'))
    state.output(idle); state.hook(event('completed')); expect(state.state).toBe('idle')
  })
  it.each([
    ['input', true], ['input', false], ['hook', true], ['hook', false],
  ] as const)('does not revive %s-cancelled work from late tool callbacks with a turn ID: %s', (cancel, hasTurnId) => {
    const prior = hasTurnId ? { turnId: 'a' } : {}
    const state = agent(); state.hook(event('session-start')); state.output(idle)
    state.hook(event('working', { ...prior, workPhase: 'submitted' })); state.output(work)
    if (cancel === 'input') state.input('\x03'); else state.hook(event('cancelled', prior))
    state.output(idle); expect(state.state).toBe('idle')
    state.hook(event('working', { ...prior, workPhase: 'tool-end' })); expect(state.state).toBe('idle')
    state.hook(event('working', prior)); state.hook(event('completed', prior)); state.output(idle)
    expect(state.state).toBe('idle')
  })
  it.each(['submitted', 'continuing', 'native'] as const)('admits genuinely new %s work after interruption without admitting the cancelled turn', source => {
    const state = agent(); state.hook(event('session-start')); state.output(idle)
    state.hook(event('working', { turnId: 'a', workPhase: 'submitted' })); state.output(work)
    state.input('\x03'); state.output(idle)
    if (source !== 'native') state.hook(event('working', { turnId: 'b', workPhase: source }))
    state.output(work); expect(state.state).toBe('working')
    state.hook(event('working', { turnId: 'a', workPhase: 'tool-end' }))
    state.hook(event('completed', { turnId: 'a' })); state.output(idle)
    expect(state.state).not.toBe('just-finished')
    state.hook(event('completed', { turnId: 'b' })); expect(state.state).toBe('just-finished')
  })
  it('binds submitted input across individual typed keys and starts new work after cancellation', () => {
    const state = agent(); state.output(work); state.input('\x03'); state.output(idle)
    state.input('n'); state.input('e'); state.input('w'); state.input('\r'); expect(state.state).toBe('working')
    state.output(work); state.output(idle); expect(state.state).toBe('just-finished')
  })
  it.each(['cancelled', 'ended'] as const)('rejects delayed %s from an interrupted turn while newer work finishes', kind => {
    const state = agent(); state.hook(event('session-start')); state.output(idle)
    state.hook(event('working', { turnId: 'a', workPhase: 'submitted' })); state.output(work)
    state.input('\x03'); state.output(idle); state.input('new work\r')
    state.hook(event('working', { turnId: 'b', workPhase: 'submitted' })); state.output(work)
    state.hook(event('permission', { turnId: 'b', requestId: 'new-request' }))
    state.hook(event(kind, { turnId: 'a' })); expect(state.state).toBe('needs-you')
    state.requestClosed('new-request'); state.output(work)
    state.hook(event('completed', { turnId: 'b' })); state.output(idle)
    expect(state.state).toBe('just-finished')
  })
  it('rejects stale runs/duplicate events and makes Exited final', () => {
    const state = agent(); state.hook(event('working', { runId: 'old-run' })); expect(state.state).toBe('idle')
    const completed = event('completed', { eventId: 'once', turnId: 'turn' }); state.hook(completed); state.setVisible(true)
    state.hook(completed); state.setVisible(false); expect(state.state).toBe('idle')
    state.exit(); state.hook(event('working')); state.output(request); expect(state.state).toBe('exited')
  })
  it('binds Codex identity only on ready and permanently clears conflicting provider sessions', () => {
    const state = new TerminalAgentStateMachine('run', 'codex', 100, 30); state.started()
    state.output(codexWork)
    state.hook(event('completed', { providerSessionId: 'first', turnId: 'a' })); expect(state.providerSessionId).toBeUndefined()
    state.output(redraw('› \r\n? for shortcuts', 'OpenAI Codex (v0.162.0)')); expect(state.providerSessionId).toBe('first')
    state.hook(event('completed', { providerSessionId: 'companion', turnId: 'b' })); expect(state.providerSessionId).toBeUndefined()
    state.output(redraw('› \r\n? for shortcuts', 'OpenAI Codex (v0.162.0)')); expect(state.providerSessionId).toBeUndefined()
  })
  it('refuses an older Codex notify during a new local submission reservation', () => {
    const state = new TerminalAgentStateMachine('run', 'codex', 120, 30); state.started(); state.output(codexIdle)
    state.setVisible(true); state.output(codexWork); state.output(codexIdle)
    state.input('new turn\r'); state.setVisible(false); state.output(codexIdle)
    state.hook(event('completed', { providerSessionId: 'session', turnId: 'a' }))
    expect(state.state).toBe('working')
    state.output(codexWork); state.hook(event('completed', { providerSessionId: 'session', turnId: 'b' }))
    state.output(codexIdle); expect(state.state).toBe('just-finished')
  })
  it('withdraws queued and future Codex notify completion after an identity conflict, then uses observed screen work', () => {
    const state = new TerminalAgentStateMachine('run', 'codex', 100, 30); state.started(); state.output(codexIdle)
    state.output(redraw('Unmatched new widget', codexTitle))
    state.hook(event('completed', { providerSessionId: 'first', turnId: 'a' }))
    state.hook(event('completed', { providerSessionId: 'companion', turnId: 'b' }))
    state.output(codexIdle); expect(state.state).toBe('idle'); expect(state.providerSessionId).toBeUndefined()
    state.hook(event('completed', { providerSessionId: 'first', turnId: 'c' })); expect(state.state).toBe('idle')
    state.output(codexWork); expect(state.state).toBe('working')
    state.hook(event('completed', { providerSessionId: 'companion', turnId: 'd' })); expect(state.state).toBe('working')
    state.output(codexIdle); expect(state.state).toBe('just-finished'); expect(state.providerSessionId).toBeUndefined()
  })
  it.each([
    ['codex', codexTitle, '> Example (esc to interrupt)', codexIdle],
    ['codex', codexTitle, '> • Working (0s • esc to interrupt)', codexIdle],
    ['grok', grokTitle, '> Allow once\r\n> Reject\r\n> Tab/Space: permission', grokIdle],
    ['grok', grokTitle, grokPermission.split('\r\n').map(line => `> ${line}`).join('\r\n'), grokIdle],
  ] as const)('never creates %s request/work evidence or an unread mark from a quoted example followed by ready', (provider, title, quoted, ready) => {
    const state = new TerminalAgentStateMachine('run', provider, 120, 30); state.started(); state.output(ready)
    state.output(redraw(quoted, title)); expect(state.detection).toBe('unavailable'); expect(state.state).not.toBe('needs-you')
    state.output(ready); expect(state.state).toBe('idle')
  })
  it('uses output activity for unsupported versions without creating requests or completions', () => {
    const state = new TerminalAgentStateMachine('run', 'codex', 100, 30); state.started()
    state.output(redraw('Would you like to run the following command?\r\n› 1. Yes, proceed (y)\r\n  2. No, and tell Codex what to do differently (esc)\r\nPress enter to confirm or esc to cancel', 'OpenAI Codex (v9.9.9)'))
    expect(state.state).toBe('working'); expect(state.detection).toBe('unavailable')
    state.quiet(); expect(state.state).toBe('idle')
  })
})

describe('bounded active terminal screen', () => {
  it('applies split ANSI redraw, erase, cursor movement and alternate-buffer restoration', () => {
    const screen = new TerminalAgentScreen(12, 4)
    screen.write('old\r\ntext'); screen.write('\x1b['); screen.write('2J\x1b[Hnew')
    expect(screen.lines()).toEqual(['new', '', '', ''])
    screen.write('\x1b[?1049hsecret\x1b[2;1Hsecond'); expect(screen.lines()[0]).toBe('secret')
    screen.write('\x1b[?1049l'); expect(screen.lines()).toEqual(['new', '', '', ''])
    screen.write('\rwrong\r\x1b[2Kright'); expect(screen.lines()[0]).toBe('right')
  })
  it.each(['\x1b[T', '\x1bM'])('keeps screen cells and soft-wrap metadata together through reverse scroll %s', control => {
    const screen = new TerminalAgentScreen(8, 4)
    screen.write('123456789\r\nlast\x1b[H' + control)
    expect(screen.lines()).toEqual(['', '12345678', '9', 'last'])
    expect(screen.logicalLines()).toEqual(['', '123456789', 'last'])
  })
  it('never inspects saved scrollback, discarded OSC/BEL, or quoted permission examples', () => {
    const screen = new TerminalAgentScreen(100, 8), rules = new TerminalScreenRules('claude')
    screen.write(request); expect(rules.read(screen).state).toBe('needs-you')
    screen.write('\r\n' + 'ordinary output\r\n'.repeat(20)); expect(rules.read(screen).state).toBeUndefined()
    screen.write(redraw('Quoted example:\r\n> Do you want to proceed?\r\n> ❯ 1. Yes\r\n> 2. No\r\n> Esc to cancel'))
    expect(rules.read(screen).state).toBeUndefined()
    screen.write('\x1b]9;Do you want to proceed?\x07'); expect(rules.read(screen).state).toBeUndefined()
  })
  it.each([
    ['claude', header, 'Do you want to proceed?\r\n❯ 1. Yes\r\n2. No\r\nEsc to cancel', '❯ \r\n? for shortcuts'],
    ['codex', codexTitle, 'Would you like to run the following command?\r\n› 1. Yes, proceed (y)\r\n2. No, and tell Codex what to do differently (esc)\r\nPress enter to confirm or esc to cancel', '› \r\n? for shortcuts'],
    ['grok', grokTitle, grokPermission, '│>\r\nGrok 4.7 (xhigh) · auto-review'],
  ] as const)('recognises current %s Ready controls below historical approval examples', (provider, title, example, ready) => {
    const screen = new TerminalAgentScreen(120, 30), rules = new TerminalScreenRules(provider)
    screen.write(redraw(`Example of the native menu:\r\n${example}\r\n${ready}`, title))
    expect(rules.read(screen).state).toBe('idle')
    const state = new TerminalAgentStateMachine('run', provider, 120, 30); state.started()
    state.output(redraw(`Example of the native menu:\r\n${example}\r\n${ready}`, title))
    expect(state.state).toBe('idle')
    const draft = ready.replace(/([❯›>])/u, '$1 hello')
    state.input('hello')
    screen.write(redraw(`Example of the native menu:\r\n${example}\r\n${draft}`, title))
    expect(rules.read(screen).state).not.toBe('needs-you')
    state.output(redraw(`Example of the native menu:\r\n${example}\r\n${draft}`, title))
    expect(state.state).not.toBe('needs-you')
    screen.write(redraw(`${example}\r\nOrdinary output after the example`, title))
    expect(rules.read(screen).state).not.toBe('needs-you')
  })
  it('requires a new redraw at the resized dimensions and handles streamed Unicode', () => {
    const screen = new TerminalAgentScreen(100, 30), rules = new TerminalScreenRules('claude')
    screen.write(idle); expect(rules.read(screen).state).toBe('idle')
    screen.resize(80, 20); expect(rules.read(screen).detection).toBe('unavailable')
    screen.write(idle); expect(rules.read(screen).state).toBe('idle')
    const unicode = new TerminalAgentScreen(12, 2); unicode.write('\uD83D'); unicode.write('\uDE42abc'); expect(unicode.lines()[0]).toBe('🙂abc')
  })
  it('recognises wrapped live prompt controls at narrow pane widths, while preserving explicit quote boundaries', () => {
    const screen = new TerminalAgentScreen(30, 30), rules = new TerminalScreenRules('codex')
    screen.write(redraw('Would you like to run the following command?\r\n› 1. Yes, proceed (y)\r\n2. No, and tell Codex what to do differently (esc)\r\nPress enter to confirm or esc to cancel', 'OpenAI Codex (v0.162.0)'))
    expect(rules.read(screen).state).toBe('needs-you')
  })
  it('keeps oversized control-string payloads out of the screen across chunks', () => {
    const screen = new TerminalAgentScreen(30, 2)
    screen.write('\x1b]52;' + 'a'.repeat(9000)); screen.write('PRIVATE_SECRET\x1b'); screen.write('\\visible')
    expect(screen.lines().join()).toContain('visible'); expect(screen.lines().join()).not.toContain('PRIVATE_SECRET')
  })
  it.each([
    ['claude', header, 'Choose a colour.\r\n❯ 1. Blue\r\n2. Green\r\n3. Type something.\r\nEnter to select · ↑/↓ to navigate · Esc to cancel'],
    ['codex', 'OpenAI Codex (v0.162.0)', 'Question 1/1 (1 unanswered)\r\nChoose a colour.\r\n› 1. Blue\r\n2. Green\r\ntab to add notes | enter to submit answer | esc to interrupt'],
    ['codex', 'OpenAI Codex (v0.162.0)', 'Question 1/1 (1 unanswered)\r\nShare details.\r\n› Type your answer (optional)\r\nenter to submit answer | esc to interrupt'],
    ['grok', grokTitle, '┃  Choose a colour.\r\n┃  1 (○) Blue\r\n┃  2 (○) Green\r\n┃  (○) Other (type your own answer)\r\nTab/Space:question'],
    ['grok', grokTitle, '│  Choose colours.\r\n│  1 [x] Blue\r\n│  2 [ ] Green\r\n│  z [ ] Other (type your own answer)\r\nTab/Space:question'],
  ] as const)('recognises %s current question controls and rejects quoted/scrollback copies', (provider, title, body) => {
    const screen = new TerminalAgentScreen(120, 30), rules = new TerminalScreenRules(provider)
    screen.write(redraw(body, title)); expect(rules.read(screen).state).toBe('needs-you')
    screen.write(redraw(body.split('\r\n').map(line => `> ${line}`).join('\r\n'), title)); expect(rules.read(screen).state).toBeUndefined()
    if (provider === 'grok') {
      screen.write(redraw(body.replace(/[│┃]/gu, ''), title)); expect(rules.read(screen).state).toBeUndefined()
      screen.write(redraw(body.replace('Tab/Space:question', 'Tab:next answer  │  Esc:scrollback  │  X:dismiss'), title))
      expect(rules.read(screen).state).toBe('needs-you')
    }
    screen.write(redraw(body, title)); screen.write('\r\n' + 'ordinary output\r\n'.repeat(40)); expect(rules.read(screen).state).toBeUndefined()
  })
  it.each([
    '• Working (0s • esc to interrupt)',
    'Working (1m 00s • esc to interrupt)',
    '• Mapping the app structure (1h 00m 00s • esc to interrupt) • 1 background process',
  ])('recognises the native Codex timed status row %s, including reduced motion', body => {
    const screen = new TerminalAgentScreen(120, 30), rules = new TerminalScreenRules('codex')
    screen.write(redraw(body, codexTitle)); expect(rules.read(screen).state).toBe('working')
    screen.write(redraw(`> ${body}`, codexTitle)); expect(rules.read(screen).state).toBeUndefined()
  })
  it.each(['┃', '│'])('requires Grok permission card chrome with the %s rail and a final native hint', rail => {
    const screen = new TerminalAgentScreen(120, 30), rules = new TerminalScreenRules('grok')
    const body = grokPermission.replaceAll('┃', rail)
    screen.write(redraw(body, grokTitle)); expect(rules.read(screen).state).toBe('needs-you')
    screen.write(redraw(body.replace('Tab/Space:permission', 'Ctrl+c:cancel  │  Tab/Space: permission  │  Ctrl+/:shortcuts'), grokTitle))
    expect(rules.read(screen).state).toBe('needs-you')
    screen.write(redraw(body.replace('Tab/Space:permission', '1/2:select  │  Tab:next option  │  Ctrl+c:cancel'), grokTitle))
    expect(rules.read(screen).state).toBe('needs-you')
    screen.write(redraw(body.split('\r\n').map(line => `> ${line}`).join('\r\n'), grokTitle)); expect(rules.read(screen).state).toBeUndefined()
    screen.write(redraw(body + '\r\nOrdinary output after the example', grokTitle)); expect(rules.read(screen).state).toBeUndefined()
    screen.write(redraw(body.replace(`${rail}  Allow Execute?\r\n`, ''), grokTitle)); expect(rules.read(screen).state).toBeUndefined()
    screen.write(redraw(`⠧ Thinking… 0.2s       0.2s [stop]\r\n${body}`, grokTitle)); expect(rules.read(screen).state).toBe('working')
    screen.write(redraw(body, grokTitle)); screen.write('\r\n' + 'ordinary output\r\n'.repeat(40)); expect(rules.read(screen).state).toBeUndefined()
  })
  it('recognises the inspected Grok 1.0.50 bordered prompt and mode footer', () => {
    const screen = new TerminalAgentScreen(120, 30), rules = new TerminalScreenRules('grok')
    screen.write(redraw('│>\r\n└─ Grok 4.7 (xhigh) ─┘\r\nGrok 4.7 (xhigh) · auto-review\r\nUse Shift+Tab to cycle between modes like Plan mode.', 'Grok Build  1.0.50'))
    expect(rules.read(screen).state).toBe('idle')
  })
  it('marks a submitted supported Grok turn on its new ready frame, while excluding local commands and cancellation', () => {
    const ready = redraw('│>\r\n└─ Grok 4.7 (xhigh) ─┘\r\nGrok 4.7 (xhigh) · auto-review', 'Grok Build  1.0.50')
    const work = redraw('⠧ Thinking… 0.2s       0.2s [stop]\r\n│>\r\nGrok 4.7 (xhigh) · auto-review\r\nCtrl+C:cancel', 'Grok Build  1.0.50')
    const state = new TerminalAgentStateMachine('run', 'grok', 120, 30); state.started(); state.output(ready)
    state.input('/help\r'); state.output(ready); expect(state.state).toBe('idle')
    state.input('do work\r'); expect(state.state).toBe('working'); state.output(work); state.output(ready); expect(state.state).toBe('just-finished')
    state.setVisible(true); state.setVisible(false); state.input('new turn\r'); state.input('\x03'); state.output(ready); expect(state.state).toBe('idle')
    state.input('another turn\r'); state.output(work); state.input('\x1b'); state.output(ready); expect(state.state).toBe('just-finished')
  })
  it('does not mistake an echoed/unchanged Grok ready frame for a completed submitted turn', () => {
    const ready = redraw('│>\r\n└─ Grok 4.7 (xhigh) ─┘\r\nGrok 4.7 (xhigh) · auto-review', 'Grok Build  1.0.50')
    const state = new TerminalAgentStateMachine('run', 'grok', 120, 30); state.started(); state.output(ready)
    state.input('w\r'); state.output('\r\n'); expect(state.state).toBe('working')
    state.output(ready); expect(state.state).toBe('working')
    state.output(redraw('Thinking\r\nCtrl+C to cancel', 'Grok Build  1.0.50')); expect(state.detection).toBe('unavailable')
    state.output(ready); expect(state.state).toBe('working')
    state.output(redraw('⠧ Thinking… 0.2s       0.2s [stop]', 'Grok Build  1.0.50')); expect(state.detection).toBe('available')
    state.output(ready); expect(state.state).toBe('just-finished')
  })
})
