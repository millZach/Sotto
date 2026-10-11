import { vi } from 'vitest'
import type { BrowserBridge, BrowserEvent, BrowserPage, BrowserTask } from '../../../src/shared/browser'
import type { FileWorkspace } from '../../../src/shared/files'
import { bridgePublication } from './bridgePublication'

export function browserPage(workspace: FileWorkspace, patch: Partial<BrowserPage> = {}): BrowserPage {
  return structuredClone({ id: '11111111-1111-4111-8111-111111111111', workspace, url: 'http://localhost:5173/', title: 'Vite App',
    status: 'ready', error: null, canGoBack: false, canGoForward: false, ...patch })
}

export function browserTask(patch: Partial<BrowserTask> = {}): BrowserTask {
  return structuredClone({ id: '22222222-2222-4222-8222-222222222222', threadId: 'visual-gate', workspaceId: 'workspace',
    pageId: '11111111-1111-4111-8111-111111111111', status: 'working', description: 'Checking the form', steps: [],
    thumbnail: null, summary: null, unchecked: [], updatedAt: 1, pendingAction: null, output: null, ...patch })
}

/** Page commands and task commands share Electron's event stream, but each keeps its own scripted replies. */
export function browserBridgeFixture(options: { workspace: FileWorkspace; pages?: BrowserPage[]; tasks?: BrowserTask[];
  commands?: Partial<Omit<BrowserBridge, 'onEvent'>> }) {
  const events = bridgePublication<BrowserEvent>()
  let pages = structuredClone(options.pages ?? [])
  let tasks = structuredClone(options.tasks ?? [])
  const bridge: BrowserBridge = {
    list: vi.fn<BrowserBridge['list']>(async () => ({ ok: true, value: { workspace: options.workspace, pages } })),
    tasks: vi.fn<BrowserBridge['tasks']>(async () => ({ ok: true, value: tasks })),
    create: vi.fn<BrowserBridge['create']>(), navigate: vi.fn<BrowserBridge['navigate']>(), back: vi.fn<BrowserBridge['back']>(), forward: vi.fn<BrowserBridge['forward']>(), reload: vi.fn<BrowserBridge['reload']>(), close: vi.fn<BrowserBridge['close']>(), share: vi.fn<BrowserBridge['share']>(), viewport: vi.fn<BrowserBridge['viewport']>(), capture: vi.fn<BrowserBridge['capture']>(),
    controlTask: vi.fn<BrowserBridge['controlTask']>(), answerAction: vi.fn<BrowserBridge['answerAction']>(), mount: vi.fn<BrowserBridge['mount']>(async () => ({ ok: true, value: undefined })),
    stopGrant: vi.fn<BrowserBridge['stopGrant']>(async () => ({ ok: true, value: undefined })), openLink: vi.fn<BrowserBridge['openLink']>(), onEvent: events.subscribe, ...options.commands,
  }
  return { ...events, bridge, setPages: (next: BrowserPage[]) => { pages = next }, setTasks: (next: BrowserTask[]) => { tasks = next } }
}
