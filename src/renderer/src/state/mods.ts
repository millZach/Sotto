import { useEffect, useState } from 'react'
import type { ModListed, ModsBridge, ModsList } from '../../../shared/mods'

/** The id of the one stylesheet every mod's look is painted into. */
export const MOD_LOOKS_ID = 'sotto-mod-looks'

/** The window's mods bridge, present only while the `mods` Owl feature is on (ADR-0217). */
export const modsBridge = (): ModsBridge | undefined => window.sotto?.mods

/**
 * The mods folder's list, read once and again whenever main says a file changed. Undefined until the first read
 * answers, or while `reading` is false.
 */
export function useModsList(reading: boolean, bridge: ModsBridge | undefined = modsBridge()): ModsList | undefined {
  const [list, setList] = useState<ModsList | undefined>(undefined)
  useEffect(() => {
    if (!reading || !bridge) { setList(undefined); return }
    let live = true
    const stop = bridge.onChanged(next => { if (live) setList(next) })
    void bridge.list().then(next => { if (live) setList(next) }, () => undefined)
    return () => { live = false; stop() }
  }, [reading, bridge])
  return list
}

/**
 * The switched-off ids with one mod's switch changed, or every mod off, keeping only ids of mods still in the folder: a
 * mod's folder removed by hand takes its id with it, so `modsOff` never fills past its limit with mods that have gone.
 */
export function nextModsOff(off: readonly string[], mods: readonly ModListed[], change: { readonly id: string; readonly on: boolean } | 'all-off'): string[] {
  const present = mods.map(mod => mod.id)
  if (change === 'all-off') return present
  const kept = off.filter(id => present.includes(id) && id !== change.id)
  return change.on ? kept : [...kept, change.id]
}

/** Whether a mod paints: it is switched on and its look passed main's check. */
export const modPaints = (mod: ModListed, off: readonly string[]): boolean => mod.problem === undefined && !off.includes(mod.id) && mod.look.trim() !== ''

/** The text of the mods' stylesheet: each painting mod's look, in id order, under a comment naming it. */
export function modLooksText(mods: readonly ModListed[], off: readonly string[]): string {
  return mods.filter(mod => modPaints(mod, off)).map(mod => `/* ${mod.id} */\n${mod.look}`).join('\n\n')
}

/**
 * Keeps the mods' stylesheet last in the document's head, so a look wins a tie with Sotto's own rules: a stylesheet
 * loaded later, as a lazily loaded page's is, would otherwise come after it. The text is replaced in place, so a change
 * repaints without reloading or remounting anything.
 */
function paintLooks(text: string): () => void {
  let sheet = document.getElementById(MOD_LOOKS_ID) as HTMLStyleElement | null
  if (!sheet) {
    sheet = document.createElement('style')
    sheet.id = MOD_LOOKS_ID
    document.head.append(sheet)
  }
  if (sheet.textContent !== text) sheet.textContent = text
  const own = sheet
  const keepLast = (): void => { if (document.head.lastElementChild !== own) document.head.append(own) }
  keepLast()
  const observer = new MutationObserver(keepLast)
  observer.observe(document.head, { childList: true })
  return () => observer.disconnect()
}

/**
 * Paints every switched-on mod's look over the main window (ADR-0217), and answers the View menu's Turn off every mod.
 * With the feature off, nothing is read and the stylesheet goes.
 */
export function useModLooks(on: boolean, off: readonly string[] | undefined, save: (modsOff: string[]) => void): void {
  const bridge = on ? modsBridge() : undefined
  const list = useModsList(on, bridge)
  const text = list && off ? modLooksText(list.mods, off) : ''
  useEffect(() => {
    if (!on) { document.getElementById(MOD_LOOKS_ID)?.remove(); return }
    return paintLooks(text)
  }, [on, text])
  useEffect(() => {
    if (!bridge) return
    return bridge.onAllOff(() => {
      // Before the list or the settings have loaded there is nothing to switch off, and saving now would clear the
      // switches already saved.
      if (!list || !off) return
      save(nextModsOff(off, list.mods, 'all-off'))
    })
  }, [bridge, list, off, save])
}
