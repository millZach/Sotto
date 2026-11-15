import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseHostEntityKey } from '../../../../shared/clientIdentity'
import type { Model3dListed, Model3dView } from '../../../../shared/models3d'
import { useOptionalAgents } from '../../agents/AgentContext'

/**
 * The 3D models the 3D models page and Tools › 3D models list (the Meshy plan's ticket 5): every one being made or done,
 * newest first, or one thread's. Read from main once, then kept by ticket 4's change notification: a known 3D model takes
 * each new view, one that ended without being made leaves the list, and one not heard of before, as a new one, reads the
 * list again. A 3D model that is not this list's, as another thread's, reads it once and is then let be.
 */
export interface Models3dList {
  /** Undefined until main answers. */
  readonly models: readonly Model3dListed[] | undefined
  /** Takes one out after main removed its record. */
  readonly drop: (id: string) => void
  /** Reads the list again, as after main kept a record the window asked it to remove. */
  readonly reload: () => void
}

/** How often a shown list looks again at whether its 3D models' files are there, at most. */
export const MODEL_FILES_RECHECK_MS = 30_000

/**
 * `threadId` null lists nothing, as with no thread open; undefined lists every 3D model. With `watchFiles`, while the
 * page or the surface is shown, the list is read again when the window comes back into focus and every half minute
 * while it can be seen, so files moved, deleted or put back outside Sotto, or by an agent, show as they are.
 */
export function useModels3d(on: boolean, threadId?: string | null, { watchFiles = false }: { readonly watchFiles?: boolean } = {}): Models3dList {
  const [models, setModels] = useState<readonly Model3dListed[] | undefined>(undefined)
  const held = useRef<readonly Model3dListed[] | undefined>(undefined)
  const read = useRef<() => void>(() => undefined)
  const keep = useCallback((next: readonly Model3dListed[] | undefined) => { held.current = next; setModels(next) }, [])
  /**
   * 3D models whose records went, removed or with their forgotten thread: never listed again, whatever a read already
   * on its way says. Their IDs are never used again, so they are kept for as long as the list is.
   */
  const gone = useRef(new Set<string>())
  // Another thread's list, or none, is not shown for a moment while the new one is read: it is let go as this render
  // starts, before anything picks a 3D model from it, starts its view or lights the rail's dot.
  const listing = on && threadId !== null ? threadId ?? '' : null
  const [listedFor, setListedFor] = useState(listing)
  const stale = listedFor !== listing
  if (stale) { setListedFor(listing); setModels(undefined) }

  useEffect(() => {
    keep(undefined)
    if (!on || threadId === null) return undefined
    const plugins = window.sotto?.plugins
    if (!plugins?.models3d) { keep([]); return undefined }
    let live = true
    let reading = false
    let again = false
    /** 3D models main did not list here, so a change to one does not read the list again. */
    const elsewhere = new Set<string>()
    const asked = new Set<string>()
    const forgotten = gone.current
    /** What was heard while a read was on its way, newer than what it will answer, and laid over it. */
    const heard = new Map<string, Model3dView>()
    const list = (): void => {
      if (reading) { again = true; return }
      reading = true
      heard.clear()
      plugins.models3d(threadId).then(found => {
        if (!live) return
        for (const id of asked) if (!found.some(model => model.id === id)) elsewhere.add(id)
        asked.clear()
        keep(found.flatMap(model => {
          if (forgotten.has(model.id)) return []
          const view = heard.get(model.id)
          return !view ? [model] : listed(view) ? [merged(model, view)] : []
        }))
        // One heard of during the read that it did not list came after it: the list is read again.
        for (const [id, view] of heard) if (listed(view) && !found.some(model => model.id === id) && !elsewhere.has(id)) { asked.add(id); again = true }
        heard.clear()
      }, () => { if (live && held.current === undefined) keep([]) }).finally(() => {
        reading = false
        if (live && again) { again = false; list() }
      })
    }
    read.current = list
    const stop = plugins.onModel3dChanged?.(view => {
      if (!live || forgotten.has(view.id)) return
      if (reading) heard.set(view.id, view)
      const current = held.current
      const known = current?.some(model => model.id === view.id) === true
      if (known && current) keep(listed(view) ? current.map(model => model.id === view.id ? merged(model, view) : model) : current.filter(model => model.id !== view.id))
      else if (listed(view) && !elsewhere.has(view.id) && !reading) { asked.add(view.id); list() }
    })
    const stopRemoved = plugins.onModels3dRemoved?.(ids => {
      if (!live) return
      for (const id of ids) { forgotten.add(id); heard.delete(id) }
      if (held.current?.some(model => forgotten.has(model.id))) keep(held.current.filter(model => !forgotten.has(model.id)))
    })
    list()
    return () => { live = false; read.current = () => undefined; stop?.(); stopRemoved?.() }
  }, [on, threadId, keep])

  // Whether the files are there is read with the list, so a shown list reads it again on focus and every half minute.
  useEffect(() => {
    if (!on || threadId === null || !watchFiles) return undefined
    const again = (): void => { if (document.visibilityState !== 'hidden') read.current() }
    window.addEventListener('focus', again)
    const timer = window.setInterval(again, MODEL_FILES_RECHECK_MS)
    return () => { window.removeEventListener('focus', again); window.clearInterval(timer) }
  }, [on, threadId, watchFiles])

  const drop = useCallback((id: string) => { gone.current.add(id); if (held.current) keep(held.current.filter(model => model.id !== id)) }, [keep])
  const reload = useCallback(() => { read.current() }, [])
  return { models: stale ? undefined : models, drop, reload }
}

/** The chosen 3D model on the page or in Tools, and the way to choose another or follow a removal. */
export interface ModelChoice {
  readonly selected: Model3dListed | undefined
  readonly choose: (id: string) => void
  /**
   * Main removed `id`'s record: it leaves the list, and when it is still the chosen one the choice moves to its
   * neighbour, which this returns so focus can follow. A removal answered after another was chosen moves nothing.
   */
  readonly removed: (id: string) => string | undefined
}

/**
 * The chosen 3D model: the one pressed, or first the newest that is done, else the newest. Whatever is shown first stays
 * chosen, so one finishing meanwhile does not take its place; the choice moves on its own only when the chosen one is no
 * longer listed at all. `shown` is the list as filtered, so a search that hides the chosen one keeps it chosen.
 */
export function useModelChoice(list: Models3dList, shown: readonly Model3dListed[]): ModelChoice {
  const [chosen, setChosen] = useState<string | null>(null)
  const selected = shown.find(model => model.id === chosen) ?? shown.find(model => model.state === 'done') ?? shown[0]
  const models = list.models
  useEffect(() => {
    if (selected && (chosen === null || !models?.some(model => model.id === chosen))) setChosen(selected.id)
  }, [selected, chosen, models])
  const current = useRef({ selected: selected?.id, shown })
  current.current = { selected: selected?.id, shown }
  const { drop } = list
  const removed = useCallback((id: string): string | undefined => {
    const { selected: now, shown: seen } = current.current
    drop(id)
    if (now !== id) return undefined
    const at = seen.findIndex(model => model.id === id)
    const next = seen[at + 1] ?? seen[at - 1]
    setChosen(next?.id ?? null)
    return next?.id
  }, [drop])
  return { selected, choose: setChosen, removed }
}

/** Whether the page and Tools list a 3D model in this state: one being made or done. */
const listed = (view: Pick<Model3dView, 'state'>): boolean => view.state === 'making' || view.state === 'done'

/** A listed 3D model with a newer view: its thread, account, words, computer and when it was asked for stay as they were. */
function merged(model: Model3dListed, view: Model3dView): Model3dListed {
  return { ...view, threadId: model.threadId, account: model.account, askedAt: model.askedAt, ...(model.computer !== undefined ? { computer: model.computer } : {}),
    ...(model.words !== undefined ? { words: model.words } : {}), ...(model.photo !== undefined ? { photo: model.photo } : {}) }
}

/**
 * This month's credits across the Meshy accounts, read again whenever `key` changes: the shared total Settings shows,
 * counted on this computer and on each paired host that said what it spent (the Meshy plan's ticket 6), with those
 * hosts' names, which the page's header names after this computer.
 */
export function useMonthCredits(on: boolean, key: string): { readonly credits: number; readonly across: readonly string[] } | undefined {
  const [credits, setCredits] = useState<{ readonly credits: number; readonly across: readonly string[] }>()
  // What a host said it spent can come after the 3D model's own news, so it reads the count again too (Sol's review).
  const [told, setTold] = useState(0)
  useEffect(() => {
    if (!on) return undefined
    return window.sotto?.plugins?.onMeshyCreditsChanged?.(() => { setTold(count => count + 1) })
  }, [on])
  useEffect(() => {
    if (!on) return undefined
    let live = true
    void window.sotto?.plugins?.meshyCredits().then(byAccount => {
      if (!live) return
      const each = Object.values(byAccount)
      setCredits({ credits: each.reduce((sum, account) => sum + account.credits, 0), across: [...new Set(each.flatMap(account => account.across))] })
    }, () => undefined)
    return () => { live = false }
  }, [on, key, told])
  return credits
}

/**
 * The paired hosts connected now that show their 3D models here, by ID: a host's 3D models are listed only while it is
 * (Zach's pick on #2497). A string of them too, which changes only when the hosts do, to read the list again by.
 */
export function useHostsShown(): { readonly shown: ReadonlySet<string>; readonly key: string } {
  const connections = useOptionalAgents()?.state?.connections
  const key = connections?.filter(host => host.kind === 'remote' && host.connected && host.models3d === true).map(host => host.hostId).sort().join(',') ?? ''
  return useMemo(() => ({ shown: new Set(key === '' ? [] : key.split(',')), key }), [key])
}

/** Whether a listed 3D model is this computer's, or a host's that is shown now. */
export function modelShown(model: Pick<Model3dListed, 'id' | 'computer'>, hosts: ReadonlySet<string>): boolean {
  if (model.computer === undefined) return true
  const hostId = parseHostEntityKey(model.id)?.hostId
  return hostId !== undefined && hosts.has(hostId)
}

/** Whether a 3D model's name or the words it was made from hold what was searched for. */
export function modelMatches(model: Pick<Model3dListed, 'name' | 'words'>, query: string): boolean {
  const wanted = query.trim().toLocaleLowerCase()
  return wanted === '' || model.name.toLocaleLowerCase().includes(wanted) || (model.words?.toLocaleLowerCase().includes(wanted) ?? false)
}
