import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { MenuBarOwlEnvironment } from './menuBarOwl'

/** The slice of Electron the menu bar owl uses, so a test can stand in for it. */
export interface OwlElectron<Image> {
  readonly nativeImage: {
    createFromBuffer(buffer: Buffer, options: { scaleFactor: number }): Image & { addRepresentation(options: { scaleFactor: number; buffer: Buffer }): void; isEmpty(): boolean }
  }
  readonly systemPreferences: {
    getAnimationSettings(): { prefersReducedMotion: boolean }
    subscribeWorkspaceNotification(name: string, callback: () => void): number
    unsubscribeWorkspaceNotification(id: number): void
  }
  readonly powerMonitor: {
    /** 'locked' while the screen is locked. */
    getSystemIdleState?(idleThresholdSeconds: number): string
    on(event: 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen', listener: () => void): unknown
    removeListener(event: 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen', listener: () => void): unknown
  }
}

/** macOS posts this when any accessibility display option changes, Reduce motion among them. */
const ACCESSIBILITY_DISPLAY_CHANGED = 'NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification'

/** The menu bar owl's surroundings in the running app. */
export function electronOwlEnvironment<Image>(electron: OwlElectron<Image>, resourceRoot: string, log?: MenuBarOwlEnvironment<Image>['log']): MenuBarOwlEnvironment<Image> {
  return {
    readOwlFile(name) {
      try {
        return readFileSync(join(resourceRoot, 'tray', 'owl', name))
      } catch {
        return null
      }
    },
    createImage(png1x, png2x) {
      const image = electron.nativeImage.createFromBuffer(png2x, { scaleFactor: 2 })
      image.addRepresentation({ scaleFactor: 1, buffer: png1x })
      if (image.isEmpty()) throw new Error('empty')
      return image
    },
    systemPrefersReducedMotion: () => electron.systemPreferences.getAnimationSettings().prefersReducedMotion,
    watchSystemReducedMotion(listener) {
      const id = electron.systemPreferences.subscribeWorkspaceNotification(ACCESSIBILITY_DISPLAY_CHANGED, listener)
      return () => electron.systemPreferences.unsubscribeWorkspaceNotification(id)
    },
    watchPower(listener) {
      let asleep = false
      let locked = false
      const apply = (): void => listener(asleep || locked)
      const on: Array<[Parameters<OwlElectron<Image>['powerMonitor']['on']>[0], () => void]> = [
        ['suspend', () => { asleep = true; apply() }],
        ['resume', () => { asleep = false; apply() }],
        ['lock-screen', () => { locked = true; apply() }],
        ['unlock-screen', () => { locked = false; apply() }],
      ]
      for (const [event, handler] of on) electron.powerMonitor.on(event, handler)
      // The screen may already be locked when the owl starts, and no event says so.
      if (electron.powerMonitor.getSystemIdleState?.(1) === 'locked') {
        locked = true
        apply()
      }
      return () => { for (const [event, handler] of on) electron.powerMonitor.removeListener(event, handler) }
    },
    ...(log ? { log } : {}),
  }
}
