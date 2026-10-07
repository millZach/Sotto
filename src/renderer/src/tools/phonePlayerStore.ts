import { useSyncExternalStore } from 'react'
import { TEST_IPHONE } from '../../../shared/browser'
import { BROWSER_PLAYER_STRIP_HEIGHT, type WindowSize } from './browserPlayerStore'

/** The phone player's three sizes, as Virtual iPhone had them: the width of the phone's screen in pixels. */
export const PHONE_SIZES = [{ id: 'small', label: 'Small', screen: 200 }, { id: 'medium', label: 'Medium', screen: 240 }, { id: 'large', label: 'Large', screen: 290 }] as const
export type PhoneSize = typeof PHONE_SIZES[number]['id']

/** The bezel around the screen, as a share of the screen's width. */
const BEZEL = 0.045
/**
 * The label above the phone and the status below it, with their gaps: what the player adds to the phone's height
 * before it has been measured. The player measures its own, which grows while a request waits for an answer.
 */
export const PHONE_PLAYER_CHROME_HEIGHT = 124
/** The narrowest the label above the phone is allowed to make the player. */
const LABEL_WIDTH = 292
const EDGE_GAP = 16
/** How far the arrow keys move the player at a press, and with Shift held. */
export const PHONE_PLAYER_MOVE_STEP = 16
export const PHONE_PLAYER_MOVE_STEP_LARGE = 64

export interface PhoneLayout {
  /** The phone's screen, where main draws the page: always the test iPhone's 393 by 852 shape. */
  readonly screen: { readonly width: number; readonly height: number }
  readonly bezel: number
  /** The whole player: the label, the phone and the status. */
  readonly width: number
  readonly height: number
}

/** The player at `size`, made smaller when the window is too short for it, so it never runs off the bottom. */
export function phoneLayout(size: PhoneSize, window: WindowSize, chrome = PHONE_PLAYER_CHROME_HEIGHT): PhoneLayout {
  const wanted = PHONE_SIZES.find(item => item.id === size)!.screen
  const ratio = TEST_IPHONE.height / TEST_IPHONE.width
  const room = window.height - BROWSER_PLAYER_STRIP_HEIGHT - EDGE_GAP * 2 - chrome
  const width = Math.max(120, Math.min(wanted, Math.floor(room / (ratio + BEZEL * 2))))
  const height = Math.round(width * ratio)
  const bezel = Math.round(width * BEZEL)
  return { screen: { width, height }, bezel, width: Math.max(LABEL_WIDTH, width + bezel * 2), height: height + bezel * 2 + chrome }
}

export interface PhonePoint { readonly x: number; readonly y: number }

/** Keeps the whole player inside the window, below the drag strip. */
export function clampPhonePoint(point: PhonePoint, layout: PhoneLayout, window: WindowSize): PhonePoint {
  return {
    x: Math.round(Math.min(Math.max(point.x, 0), Math.max(0, window.width - layout.width))),
    y: Math.round(Math.min(Math.max(point.y, BROWSER_PLAYER_STRIP_HEIGHT), Math.max(BROWSER_PLAYER_STRIP_HEIGHT, window.height - layout.height))),
  }
}

/** Against the focused pane's right edge, just under the drag strip, before the user has moved it. */
function defaultPoint(layout: PhoneLayout, window: WindowSize): PhonePoint {
  const pane = typeof document === 'undefined' ? undefined : document.querySelector<HTMLElement>('.thread-pane[data-focused]')?.getBoundingClientRect()
  const right = pane ? pane.right - 20 : window.width - 24
  return clampPhonePoint({ x: right - layout.width, y: BROWSER_PLAYER_STRIP_HEIGHT + 12 }, layout, window)
}

/**
 * The phone player's place, size and per-thread visibility for this session. One place and one size serve every
 * thread; whether it shows is per thread, so hiding one thread's phone leaves another's alone. Nothing is saved
 * across a restart, as with the Browser player.
 */
export class PhonePlayerStore {
  private point: PhonePoint | null = null
  private size: PhoneSize = 'medium'
  private readonly open = new Set<string>()
  /** Every task ID a thread's phone has shown, so a late update to one the user already hid never reopens it. */
  private readonly seenTaskIds = new Map<string, Set<string>>()
  private readonly listeners = new Set<() => void>()
  private snapshot = { point: this.point, size: this.size }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private emit(): void {
    this.snapshot = { point: this.point, size: this.size }
    for (const listener of [...this.listeners]) listener()
  }
  placement = (): { readonly point: PhonePoint | null; readonly size: PhoneSize } => this.snapshot

  /** Where to draw the player at `layout`: the user's place, or the default, kept inside the window. */
  pointFor(layout: PhoneLayout, window: WindowSize): PhonePoint { return this.point ? clampPhonePoint(this.point, layout, window) : defaultPoint(layout, window) }
  setPoint(point: PhonePoint, layout: PhoneLayout, window: WindowSize): void {
    const next = clampPhonePoint(point, layout, window)
    if (this.point && this.point.x === next.x && this.point.y === next.y) return
    this.point = next
    this.emit()
  }
  setSize(size: PhoneSize): void {
    if (this.size === size) return
    this.size = size
    this.emit()
  }

  isOpen(threadId: string): boolean { return this.open.has(threadId) }
  show(threadId: string): void { if (!this.open.has(threadId)) { this.open.add(threadId); this.emit() } }
  hide(threadId: string): void { if (this.open.delete(threadId)) this.emit() }

  /**
   * A thread's phone has a task the player has not shown before: it opens when `autoShow` is on (the same setting
   * as the Browser player's), and otherwise stays as the user left it. The same task's progress never reopens it.
   */
  taskSeen(threadId: string, taskId: string, autoShow: boolean): void {
    let seen = this.seenTaskIds.get(threadId)
    if (!seen) { seen = new Set(); this.seenTaskIds.set(threadId, seen) }
    if (seen.has(taskId)) return
    seen.add(taskId)
    if (autoShow) this.show(threadId)
  }
}

/** In-session singleton, like the Browser player's. */
export const phonePlayerStore = new PhonePlayerStore()

export function usePhonePlayerOpen(store: PhonePlayerStore, threadId: string | null): boolean {
  return useSyncExternalStore(store.subscribe, () => threadId !== null && store.isOpen(threadId))
}

export function usePhonePlacement(store: PhonePlayerStore): { readonly point: PhonePoint | null; readonly size: PhoneSize } {
  return useSyncExternalStore(store.subscribe, store.placement)
}
