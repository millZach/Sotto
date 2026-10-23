// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { electronOwlEnvironment, type OwlElectron } from '../../../../src/main/tray/menuBarOwlElectron'

interface FakeImage { readonly scaleFactor: number; readonly representations: { scaleFactor: number; buffer: Buffer }[]; readonly empty: boolean; addRepresentation(options: { scaleFactor: number; buffer: Buffer }): void; isEmpty(): boolean }

function fakeElectron(options: { empty?: boolean; reduced?: boolean; locked?: boolean } = {}) {
  const handlers = new Map<string, () => void>()
  const workspace = new Map<number, () => void>()
  const created: FakeImage[] = []
  let nextId = 1
  const electron: OwlElectron<FakeImage> = {
    nativeImage: {
      createFromBuffer(buffer, { scaleFactor }) {
        const image: FakeImage = {
          scaleFactor,
          representations: [{ scaleFactor, buffer }],
          empty: options.empty ?? false,
          addRepresentation(representation) { image.representations.push(representation) },
          isEmpty: () => options.empty ?? false,
        }
        created.push(image)
        return image
      },
    },
    systemPreferences: {
      getAnimationSettings: () => ({ prefersReducedMotion: options.reduced ?? false }),
      subscribeWorkspaceNotification(name, callback) {
        expect(name).toBe('NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification')
        const id = nextId++
        workspace.set(id, callback)
        return id
      },
      unsubscribeWorkspaceNotification(id) { workspace.delete(id) },
    },
    powerMonitor: {
      getSystemIdleState: () => (options.locked ? 'locked' : 'active'),
      on(event, listener) { handlers.set(event, listener); return undefined },
      removeListener(event) { handlers.delete(event); return undefined },
    },
  }
  return { electron, handlers, workspace, created }
}

describe('the menu bar owl in Electron', () => {
  it('builds one image with a 2x picture and a 1x one', () => {
    const { electron, created } = fakeElectron()
    const env = electronOwlEnvironment(electron, '/resources')
    const one = Buffer.from([1])
    const two = Buffer.from([2])
    const image = env.createImage(one, two)
    expect(created).toHaveLength(1)
    expect(image.representations).toEqual([{ scaleFactor: 2, buffer: two }, { scaleFactor: 1, buffer: one }])
  })

  it('throws for an image Electron cannot read', () => {
    const { electron } = fakeElectron({ empty: true })
    expect(() => electronOwlEnvironment(electron, '/resources').createImage(Buffer.from([1]), Buffer.from([2]))).toThrow()
  })

  it('reads a file under tray/owl, or null when it is not there', () => {
    const { electron } = fakeElectron()
    const env = electronOwlEnvironment(electron, '/no/such/folder')
    expect(env.readOwlFile('manifest.json')).toBeNull()
  })

  it('reports the system\'s reduced motion and watches the accessibility notification', () => {
    const { electron, workspace } = fakeElectron({ reduced: true })
    const env = electronOwlEnvironment(electron, '/resources')
    expect(env.systemPrefersReducedMotion()).toBe(true)
    let calls = 0
    const stop = env.watchSystemReducedMotion(() => { calls += 1 })
    expect(workspace.size).toBe(1)
    for (const callback of workspace.values()) callback()
    expect(calls).toBe(1)
    stop()
    expect(workspace.size).toBe(0)
  })

  it('holds while the Mac sleeps or the screen is locked, whichever ends last', () => {
    const { electron, handlers } = fakeElectron()
    const env = electronOwlEnvironment(electron, '/resources')
    const seen: boolean[] = []
    const stop = env.watchPower(paused => seen.push(paused))
    handlers.get('lock-screen')!()
    handlers.get('suspend')!()
    handlers.get('resume')!()
    handlers.get('unlock-screen')!()
    expect(seen).toEqual([true, true, true, false])
    stop()
    expect(handlers.size).toBe(0)
  })

  it('starts paused when the screen is already locked, and carries on once it is unlocked', () => {
    const { electron, handlers } = fakeElectron({ locked: true })
    const seen: boolean[] = []
    electronOwlEnvironment(electron, '/resources').watchPower(paused => seen.push(paused))
    expect(seen).toEqual([true])
    handlers.get('unlock-screen')!()
    expect(seen).toEqual([true, false])
  })

  it('does not start paused on an unlocked screen', () => {
    const { electron } = fakeElectron()
    const seen: boolean[] = []
    electronOwlEnvironment(electron, '/resources').watchPower(paused => seen.push(paused))
    expect(seen).toEqual([])
  })
})
