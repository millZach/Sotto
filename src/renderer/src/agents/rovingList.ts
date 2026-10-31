import { useCallback, useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent, type RefObject } from 'react'

/**
 * A list that is one Tab stop (ADR-0164, Zach's pick A of #1827): the control it last held keeps `tabindex="0"` and every
 * other control in it `-1`, so one Tab enters it and the next leaves it. Up and Down move through its controls in the
 * order they are drawn and Home and End go to its ends, without wrapping. As a tree (the thread list), Right opens a
 * closed folder or steps into an open one, and Left closes an open one or steps out to the folder or shelf it is in,
 * the WAI-ARIA tree pattern's keys on the buttons the rows already are.
 *
 * Its controls are every button, link and field drawn in it except a row's own actions (`data-row-actions`), which the
 * row's menu repeats in words, and an open menu's rows. A disabled control is passed over. The tab stops are kept by
 * hand rather than by props, so the folders, rows and the Owl lines inside them need not know about it, and the rows
 * stay memoised: nothing re-renders when the focus moves.
 */
export const ROW_ACTIONS = 'data-row-actions'
/** A folder or the Settled shelf: Left from inside it goes to its toggle. */
export const ROVING_GROUP = 'data-roving-group'
/** The toggle of a group, which Left from inside the group lands on. */
export const ROVING_TOGGLE = 'data-roving-toggle'
/** What the list remembers its stop by, so a row drawn anew (another update, a folder closed and opened) keeps it. */
export const ROVING_KEY = 'data-roving-key'

const CONTROL = 'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex]'

/** Every control drawn in the list that keeps a tab stop of its own, a row's own actions and an open menu's rows aside. */
function listStops(list: HTMLElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(CONTROL)].filter(control => control.closest(`[${ROW_ACTIONS}], [role="menu"], [role="dialog"], [hidden], [inert]`) === null)
}

/** The list's controls a press can reach, in the order they are drawn. */
export function listControls(list: HTMLElement): HTMLElement[] {
  return listStops(list).filter(control => !(control as HTMLButtonElement).disabled)
}

const typing = (target: EventTarget): boolean => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
  || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)

/** Left from inside a group: the toggle of the group the control is in, or of the one around it when it is the toggle. */
function parentToggle(control: HTMLElement): HTMLElement | null {
  let group = control.closest<HTMLElement>(`[${ROVING_GROUP}]`)
  if (group !== null && group.querySelector(`[${ROVING_TOGGLE}]`) === control) group = group.parentElement?.closest<HTMLElement>(`[${ROVING_GROUP}]`) ?? null
  return group?.querySelector<HTMLElement>(`[${ROVING_TOGGLE}]`) ?? null
}

export interface RovingList {
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  readonly onFocus: (event: FocusEvent<HTMLElement>) => void
}

export function useRovingList(ref: RefObject<HTMLElement | null>, { tree }: { readonly tree: boolean }): RovingList {
  /** The control the user last put the focus on, its key, where it stood, and whether it still has the focus. */
  const held = useRef<{ control: HTMLElement | null; key: string | null; index: number; focused: boolean }>({ control: null, key: null, index: 0, focused: false })
  /** The focus is on `control`: it becomes the list's one stop. */
  const take = useCallback((control: HTMLElement, controls: readonly HTMLElement[]): void => {
    for (const other of controls) if (other !== control && other.getAttribute('tabindex') === '0') other.setAttribute('tabindex', '-1')
    control.setAttribute('tabindex', '0')
    held.current = { control, key: control.getAttribute(ROVING_KEY), index: Math.max(0, controls.indexOf(control)), focused: true }
  }, [])
  /**
   * Gives the stop to the control the list holds: the one last focused, or the row drawn anew in its place, or until the
   * focus has been here the thread on screen (`aria-current`), or the first. A disabled control keeps `-1` too, so it
   * cannot become a second stop when it is enabled again.
   */
  const sync = useCallback((): void => {
    const list = ref.current
    if (list === null) return
    const stops = listStops(list)
    const controls = stops.filter(control => !(control as HTMLButtonElement).disabled)
    const memory = held.current
    // A control that had the focus and was taken away (a row settled from its menu) hands it to the one now in its place.
    if (memory.focused && memory.control !== null && !memory.control.isConnected && (document.activeElement === null || document.activeElement === document.body)) {
      memory.focused = false
      const next = controls[Math.min(memory.index, controls.length - 1)]
      if (next !== undefined) { take(next, controls); next.focus(); return }
    }
    const stop = (memory.control !== null && controls.includes(memory.control) ? memory.control : undefined)
      ?? (memory.key === null ? undefined : controls.find(control => control.getAttribute(ROVING_KEY) === memory.key))
      ?? controls.find(control => control.getAttribute('aria-current') === 'page') ?? controls[0]
    for (const control of stops) {
      const wanted = control === stop ? '0' : '-1'
      if (control.getAttribute('tabindex') !== wanted) control.setAttribute('tabindex', wanted)
    }
  }, [ref, take])
  // Kept by a watch on the list rather than on every render: a folder, a row or a preview drawn or gone, the thread on
  // screen changing, a control enabled. A working row's clock rewrites its own text every second, which changes nothing.
  const watched = useRef<{ list: HTMLElement | null; stop: () => void }>({ list: null, stop: () => undefined })
  useLayoutEffect(() => {
    const list = ref.current
    if (watched.current.list === list) return
    watched.current.stop()
    watched.current = { list, stop: () => undefined }
    if (list === null) return
    sync()
    let queued = false
    const later = (): void => { if (!queued) { queued = true; queueMicrotask(() => { queued = false; sync() }) } }
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(records => {
      if (records.some(record => record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === Node.ELEMENT_NODE))) later()
    })
    observer?.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-current', 'disabled', 'hidden'] })
    // The focus leaving for good, rather than its control being taken away, is not a focus to hand on.
    const left = (event: globalThis.FocusEvent): void => {
      const from = event.target
      if (event.relatedTarget !== null) { if (!list.contains(event.relatedTarget as Node)) held.current.focused = false; return }
      queueMicrotask(() => { if (from instanceof Node && from.isConnected) held.current.focused = false; else sync() })
    }
    list.addEventListener('focusout', left)
    watched.current = { list, stop: () => { observer?.disconnect(); list.removeEventListener('focusout', left) } }
  })
  useLayoutEffect(() => () => { watched.current.stop() }, [])

  const onFocus = useCallback((event: FocusEvent<HTMLElement>): void => {
    const list = ref.current
    const target = event.target
    if (list === null || !(target instanceof HTMLElement)) return
    const controls = listControls(list)
    if (controls.includes(target)) take(target, controls)
  }, [ref, take])
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>): void => {
    const list = ref.current
    const target = event.target
    if (list === null || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || !(target instanceof HTMLElement) || typing(target)) return
    if (target.closest('[role="menu"], [role="dialog"]') !== null) return
    const controls = listControls(list)
    const at = controls.indexOf(target)
    if (at < 0) return
    const go = (index: number): void => {
      event.preventDefault()
      const next = controls[Math.max(0, Math.min(index, controls.length - 1))]
      if (next !== undefined && next !== target) next.focus()
    }
    if (event.shiftKey) return
    switch (event.key) {
      case 'ArrowDown': go(at + 1); return
      case 'ArrowUp': go(at - 1); return
      case 'Home': go(0); return
      case 'End': go(controls.length - 1); return
    }
    if (!tree || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return
    const expanded = target.getAttribute('aria-expanded')
    if (event.key === 'ArrowRight') {
      if (expanded === 'false') { event.preventDefault(); target.click() } else if (expanded === 'true') go(at + 1)
      return
    }
    if (expanded === 'true') { event.preventDefault(); target.click(); return }
    const parent = parentToggle(target)
    if (parent !== null) { event.preventDefault(); parent.focus() }
  }, [ref, tree])
  return { onKeyDown, onFocus }
}
