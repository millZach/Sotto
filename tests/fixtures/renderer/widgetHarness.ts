import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

import { platformCopy } from '../../../src/renderer/src/platformCopy'
import type { CommandResult } from '../../../src/shared/contracts'
import { type WidgetSnapshot } from '../../../src/shared/dictation'
import { DEFAULT_WIDGET_PALETTE } from '../../../src/shared/themeBranding'


export const win32Copy = platformCopy('win32')

export type SnapshotDefaults = Pick<WidgetSnapshot, 'theme' | 'palette' | 'reducedMotion' | 'shortcut' | 'cancellable'>

export const metadata: SnapshotDefaults = {
  theme: 'dark',
  palette: DEFAULT_WIDGET_PALETTE,
  reducedMotion: 'system',
  shortcut: 'Ctrl+Shift+Space',
  cancellable: false,
}

export type SnapshotInput = {
  [Status in WidgetSnapshot['status']]: Omit<Extract<WidgetSnapshot, { status: Status }>, keyof SnapshotDefaults> & Partial<SnapshotDefaults>
}[WidgetSnapshot['status']]

export function snapshot(state: SnapshotInput): WidgetSnapshot {
  return { ...metadata, ...state }
}

export const commandSucceeded = async (): Promise<CommandResult> => ({ ok: true })

export function setWindowSize(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height })
}
export function setupWidgetTests(): void {
  afterEach(() => {
    cleanup()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-brand')
    document.documentElement.removeAttribute('data-reduced-motion')
    setWindowSize(1_024, 768)
    vi.useRealTimers()
  })
}
