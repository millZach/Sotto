import { describe, expect, it } from 'vitest'

import {
  nextPopupDetail, popupKeyAction, popupProject, POPUP_MEMORY_KEY, readPopupMemory, shownMessages, slashCommandOf, slashCommands, slashMatches, writePopupMemory,
} from '../../../../src/renderer/src/popup/popupLogic'
import type { AgentMessage, AgentProject, AgentThreadDetail } from '../../../../src/shared/agents'

const key = (key: string, more: Partial<Pick<KeyboardEvent, 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey' | 'isComposing'>> = {}) =>
  ({ key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, isComposing: false, ...more })
const quiet = { platform: 'darwin' as const, menu: false, canStop: false }

describe('the popup\'s slash menu (ADR-0181)', () => {
  it('offers New, Stop, Open and Watcher on a thread, and back to the thread and Open on Watcher', () => {
    expect(slashCommands('thread', true)).toEqual(['new', 'stop', 'open', 'watcher'])
    expect(slashCommands('thread', false)).toEqual(['new', 'stop', 'open'])
    expect(slashCommands('watcher', true)).toEqual(['thread', 'open'])
  })

  it('matches by the start of a command, then anywhere in one, and only while the prompt is one word starting with /', () => {
    const commands = slashCommands('thread', true)
    expect(slashMatches('/', commands)).toEqual(commands)
    expect(slashMatches('/o', commands)).toEqual(['open'])
    expect(slashMatches('/at', commands)).toEqual(['watcher'])
    expect(slashMatches('/new ', commands)).toEqual([])
    expect(slashMatches('hello', commands)).toEqual([])
  })

  it('runs a command sent on its own, and sends anything else as words', () => {
    const commands = slashCommands('thread', true)
    expect(slashCommandOf(' /New ', commands)).toBe('new')
    expect(slashCommandOf('/new thread please', commands)).toBeNull()
    expect(slashCommandOf('/thread', commands)).toBeNull()
  })
})

describe('the popup\'s keys (ADR-0181)', () => {
  it('sends on Return and makes a new line on Shift or Option with Return', () => {
    expect(popupKeyAction(key('Enter'), quiet)).toBe('send')
    expect(popupKeyAction(key('Enter', { shiftKey: true }), quiet)).toBe('newline')
    expect(popupKeyAction(key('Enter', { altKey: true }), quiet)).toBe('newline')
    expect(popupKeyAction(key('Enter', { isComposing: true }), quiet)).toBeNull()
  })

  it('closes the menu, then stops a running thread turn, then hides', () => {
    expect(popupKeyAction(key('Escape'), { ...quiet, menu: true, canStop: true })).toBe('close-menu')
    expect(popupKeyAction(key('Escape'), { ...quiet, canStop: true })).toBe('stop')
    expect(popupKeyAction(key('Escape'), quiet)).toBe('hide')
  })

  it('moves, completes and runs in the menu', () => {
    const menu = { ...quiet, menu: true }
    expect(popupKeyAction(key('ArrowDown'), menu)).toBe('menu-next')
    expect(popupKeyAction(key('ArrowUp'), menu)).toBe('menu-previous')
    expect(popupKeyAction(key('Tab'), menu)).toBe('complete')
    expect(popupKeyAction(key('Enter'), menu)).toBe('run-command')
    expect(popupKeyAction(key('ArrowDown'), quiet)).toBeNull()
  })

  it('opens in Sotto on Command+O on a Mac and Ctrl+O elsewhere', () => {
    expect(popupKeyAction(key('o', { metaKey: true }), quiet)).toBe('open')
    expect(popupKeyAction(key('o', { ctrlKey: true }), quiet)).toBeNull()
    expect(popupKeyAction(key('o', { ctrlKey: true }), { ...quiet, platform: 'win32' })).toBe('open')
    expect(popupKeyAction(key('O', { ctrlKey: true, shiftKey: true }), { ...quiet, platform: 'win32' })).toBeNull()
  })
})

describe('what the popup keeps (ADR-0181)', () => {
  it('reads back its target, thread and project, and starts on a thread from anything it cannot read', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (name: string) => store.get(name) ?? null, setItem: (name: string, value: string) => { store.set(name, value) } }
    expect(readPopupMemory(storage)).toEqual({ target: 'thread', threadId: null, projectId: null })
    writePopupMemory(storage, { target: 'watcher', threadId: 't1', projectId: 'p1' })
    expect(readPopupMemory(storage)).toEqual({ target: 'watcher', threadId: 't1', projectId: 'p1' })
    store.set(POPUP_MEMORY_KEY, '{"target":"room"}')
    expect(readPopupMemory(storage).target).toBe('thread')
    store.set(POPUP_MEMORY_KEY, 'not json')
    expect(readPopupMemory(storage).threadId).toBeNull()
  })

  it('starts a new thread in the last project it used while that is open, else the main window\'s, else the first', () => {
    const projects = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C', workspaceSettledAt: '2026-11-01T00:00:00.000Z' }] as AgentProject[]
    const shell = { activeProjectId: 'b', host: { projects } }
    expect(popupProject(shell, 'a')?.id).toBe('a')
    expect(popupProject(shell, 'c')?.id).toBe('b')
    expect(popupProject({ ...shell, activeProjectId: null }, null)?.id).toBe('a')
    expect(popupProject({ activeProjectId: null, host: { projects: [] } }, null)).toBeNull()
  })
})

const message = (id: string, role: AgentMessage['role'], text: string, more: Partial<AgentMessage> = {}): AgentMessage => ({ id, role, text, createdAt: '2026-11-02T00:00:00.000Z', ...more })

describe('the popup\'s conversation (ADR-0181)', () => {
  const whole: AgentThreadDetail = { threadId: 't', revision: 3, messages: [message('1', 'user', 'Hi')], activities: [] }

  it('keeps a whole history without its activity, and applies a change to its messages', () => {
    const held = nextPopupDetail(null, whole)!
    expect(held).toEqual({ threadId: 't', revision: 3, messages: whole.messages })
    const next = nextPopupDetail(held, { threadId: 't', baseRevision: 3, revision: 4, messageDeltas: [{ message: message('2', 'assistant', 'Hel') }, { id: '2', appendText: 'lo' }],
      activityDeltas: [{ id: 'run', appendOutput: 'line' }] })
    expect(next?.messages.map(item => item.text)).toEqual(['Hi', 'Hello'])
    expect(next?.revision).toBe(4)
  })

  it('asks for the whole history again when a change does not follow what it holds', () => {
    const held = nextPopupDetail(null, whole)!
    expect(nextPopupDetail(held, { threadId: 't', baseRevision: 2, revision: 4, messageDeltas: [], activityDeltas: [] })).toBeNull()
    expect(nextPopupDetail(null, { threadId: 't', baseRevision: 3, revision: 4, messageDeltas: [], activityDeltas: [] })).toBeNull()
  })

  it('shows what the user and the agent wrote, newest last, without wake-ups', () => {
    const shown = shownMessages([message('1', 'user', 'Ask'), message('2', 'user', 'News', { wakeUp: true }), message('3', 'assistant', 'Answer'), message('4', 'assistant', '  ')])
    expect(shown.map(item => item.id)).toEqual(['1', '3'])
  })
})
