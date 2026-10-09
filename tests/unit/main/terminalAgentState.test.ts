// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { TerminalAgentStateMachine } from '../../../src/main/terminals/state'
import { TerminalAgentScreen, TerminalScreenRules } from '../../../src/main/terminals/screen'
import type { TerminalAgentHookEvent } from '../../../src/main/terminals/hooks'

const header = 'Claude Code v2.1.295'
const redraw = (body: string, title = header) => `\x1b[2J\x1b[H${title}\r\n${body}`
const idle = redraw('❯ \r\n? for shortcuts')
const work = redraw('✻ Working… (esc to interrupt)')
const request = redraw('Do you want to make this edit to marker.txt?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel · Tab to amend')
const event = (kind: TerminalAgentHookEvent['kind'], values: Partial<TerminalAgentHookEvent> = {}): TerminalAgentHookEvent => ({ terminalId: 'terminal', runId: 'run', eventId: `${kind}-${Math.random()}`, kind, state: kind === 'working' ? 'working' : 'idle', ...values })
const agent = () => { const state = new TerminalAgentStateMachine('run', 'claude', 100, 30, 'session'); state.started(); state.output(idle); return state }

describe('terminal agent run state', () => {
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
  it('keeps a live permission ahead of out-of-order Working, completion and a ready screen', () => {
    const state = agent(); state.hook(event('working')); state.hook(event('permission', { requestId: 'r' }))
    state.hook(event('working')); state.hook(event('completed')); state.output(idle)
    expect(state.state).toBe('needs-you')
    state.requestClosed('another'); expect(state.state).toBe('needs-you')
    state.requestClosed('r'); expect(state.state).toBe('idle')
  })
  it('recognises a current native request and invalidates it on input/redraw without inventing completion', () => {
    const state = agent(); state.output(work); state.output(request); expect(state.state).toBe('needs-you')
    state.input('2'); expect(state.state).toBe('working')
    state.output(idle); expect(state.state).toBe('idle')
    state.hook(event('notification', { notificationType: 'permission_prompt' })); expect(state.state).toBe('idle')
  })
  it.each(['input', 'failure', 'error'] as const)('returning ready after %s earns no completion', reason => {
    const state = agent(); state.output(work)
    if (reason === 'input') state.input('\x03')
    if (reason === 'failure') state.hook(event('cancelled'))
    if (reason === 'error') state.output(redraw('Error: the operation failed\r\n❯ \r\n? for shortcuts'))
    state.output(idle); state.hook(event('completed')); expect(state.state).toBe('idle')
  })
  it('binds submitted input across individual typed keys and starts new work after cancellation', () => {
    const state = agent(); state.output(work); state.input('\x03'); state.output(idle)
    state.input('n'); state.input('e'); state.input('w'); state.input('\r'); expect(state.state).toBe('working')
    state.output(work); state.output(idle); expect(state.state).toBe('just-finished')
  })
  it('rejects stale runs/duplicate events and makes Exited final', () => {
    const state = agent(); state.hook(event('working', { runId: 'old-run' })); expect(state.state).toBe('idle')
    const completed = event('completed', { eventId: 'once', turnId: 'turn' }); state.hook(completed); state.setVisible(true)
    state.hook(completed); state.setVisible(false); expect(state.state).toBe('idle')
    state.exit(); state.hook(event('working')); state.output(request); expect(state.state).toBe('exited')
  })
  it('binds Codex identity only on ready and permanently clears conflicting provider sessions', () => {
    const state = new TerminalAgentStateMachine('run', 'codex', 100, 30); state.started()
    state.output(redraw('• Working (esc to interrupt)', 'OpenAI Codex (v0.162.0)'))
    state.hook(event('completed', { providerSessionId: 'first', turnId: 'a' })); expect(state.providerSessionId).toBeUndefined()
    state.output(redraw('› \r\n? for shortcuts', 'OpenAI Codex (v0.162.0)')); expect(state.providerSessionId).toBe('first')
    state.hook(event('completed', { providerSessionId: 'companion', turnId: 'b' })); expect(state.providerSessionId).toBeUndefined()
    state.output(redraw('› \r\n? for shortcuts', 'OpenAI Codex (v0.162.0)')); expect(state.providerSessionId).toBeUndefined()
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
  it('never inspects saved scrollback, discarded OSC/BEL, or quoted permission examples', () => {
    const screen = new TerminalAgentScreen(100, 8), rules = new TerminalScreenRules('claude')
    screen.write(request); expect(rules.read(screen).state).toBe('needs-you')
    screen.write('\r\n' + 'ordinary output\r\n'.repeat(20)); expect(rules.read(screen).state).toBeUndefined()
    screen.write(redraw('Quoted example:\r\n> Do you want to proceed?\r\n> ❯ 1. Yes\r\n> 2. No\r\n> Esc to cancel'))
    expect(rules.read(screen).state).toBeUndefined()
    screen.write('\x1b]9;Do you want to proceed?\x07'); expect(rules.read(screen).state).toBeUndefined()
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
    ['grok', 'Grok Build  1.0.50', 'Choose a colour.\r\n1 (○) Blue\r\n2 (○) Green\r\nOther (type your own answer)\r\nTab/Space: question'],
  ] as const)('recognises %s current question controls and rejects quoted/scrollback copies', (provider, title, body) => {
    const screen = new TerminalAgentScreen(120, 30), rules = new TerminalScreenRules(provider)
    screen.write(redraw(body, title)); expect(rules.read(screen).state).toBe('needs-you')
    screen.write(redraw(body.split('\r\n').map(line => `> ${line}`).join('\r\n'), title)); expect(rules.read(screen).state).toBeUndefined()
    screen.write(redraw(body, title)); screen.write('\r\n' + 'ordinary output\r\n'.repeat(40)); expect(rules.read(screen).state).toBeUndefined()
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
