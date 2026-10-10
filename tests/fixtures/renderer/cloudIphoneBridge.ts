import { vi } from 'vitest'
import type { CloudEvent, CloudIphoneBridge, CloudIphoneStatus, CloudSession } from '../../../src/shared/cloudIphone'
import { bridgePublication } from './bridgePublication'

export function cloudSession(patch: Partial<CloudSession> = {}): CloudSession {
  return structuredClone({ id: '11111111-1111-4111-8111-111111111111', threadId: 'workshop', workspaceId: 'workspace',
    status: 'asking', description: 'Checking the Needs you list', buildPath: 'apps/ios/build/Sotto.app.zip', buildBytes: 41_000_000,
    device: null, expiresAt: Date.now() + 300_000, startedAt: null, endedAt: null, endReason: null, minutes: 0,
    problem: null, steps: [], summary: null, unchecked: [], ...patch })
}

export function cloudStatus(patch: Partial<CloudIphoneStatus> = {}): CloudIphoneStatus {
  return structuredClone({ keySaved: true, month: '2026-10', monthMinutes: 38, capMinutes: 750, recent: [], ...patch })
}

export function cloudIphoneBridgeFixture(options: { sessions?: CloudSession[]; status?: CloudIphoneStatus;
  commands?: Partial<Omit<CloudIphoneBridge, 'onEvent'>> } = {}) {
  const events = bridgePublication<CloudEvent>()
  let status = structuredClone(options.status ?? cloudStatus())
  let sessions = structuredClone(options.sessions ?? [])
  const bridge: CloudIphoneBridge = {
    status: vi.fn<CloudIphoneBridge['status']>(async () => ({ ok: true, value: status })), sessions: vi.fn<CloudIphoneBridge['sessions']>(async () => ({ ok: true, value: sessions })),
    setKey: vi.fn<CloudIphoneBridge['setKey']>(), answer: vi.fn<CloudIphoneBridge['answer']>(), end: vi.fn<CloudIphoneBridge['end']>(), mount: vi.fn<CloudIphoneBridge['mount']>(async () => ({ ok: true, value: undefined })),
    onEvent: events.subscribe, ...options.commands,
  }
  return { ...events, bridge, setStatus: (next: CloudIphoneStatus) => { status = next }, setSessions: (next: CloudSession[]) => { sessions = next } }
}
