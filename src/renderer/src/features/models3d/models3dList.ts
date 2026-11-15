import { useCallback, useEffect, useRef, useState } from 'react'
import type { Model3dListed, Model3dView } from '../../../../shared/models3d'

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

/** `threadId` null lists nothing, as with no thread open; undefined lists every 3D model. */
export function useModels3d(on: boolean, threadId?: string | null): Models3dList {
  const [models, setModels] = useState<readonly Model3dListed[] | undefined>(undefined)
  const held = useRef<readonly Model3dListed[] | undefined>(undefined)
  const read = useRef<() => void>(() => undefined)
  const keep = useCallback((next: readonly Model3dListed[] | undefined) => { held.current = next; setModels(next) }, [])

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
    const list = (): void => {
      if (reading) { again = true; return }
      reading = true
      plugins.models3d(threadId).then(found => {
        if (!live) return
        for (const id of asked) if (!found.some(model => model.id === id)) elsewhere.add(id)
        asked.clear()
        keep(found)
      }, () => { if (live && held.current === undefined) keep([]) }).finally(() => {
        reading = false
        // A change heard while the read was on its way may be newer than what it read.
        if (live && again) { again = false; list() }
      })
    }
    read.current = list
    const stop = plugins.onModel3dChanged?.(view => {
      if (!live) return
      const current = held.current
      const known = current?.some(model => model.id === view.id) === true
      const listed = view.state === 'making' || view.state === 'done'
      if (known && current) keep(listed ? current.map(model => model.id === view.id ? merged(model, view) : model) : current.filter(model => model.id !== view.id))
      else if (listed && !elsewhere.has(view.id)) { asked.add(view.id); list() }
    })
    list()
    return () => { live = false; read.current = () => undefined; stop?.() }
  }, [on, threadId, keep])

  const drop = useCallback((id: string) => { if (held.current) keep(held.current.filter(model => model.id !== id)) }, [keep])
  const reload = useCallback(() => { read.current() }, [])
  return { models, drop, reload }
}

/** A listed 3D model with a newer view: its thread, account, words and when it was asked for stay as they were. */
function merged(model: Model3dListed, view: Model3dView): Model3dListed {
  return { ...view, threadId: model.threadId, account: model.account, askedAt: model.askedAt,
    ...(model.words !== undefined ? { words: model.words } : {}), ...(model.photo !== undefined ? { photo: model.photo } : {}) }
}

/** This month's credits across this computer's Meshy accounts, read again whenever `key` changes. */
export function useMonthCredits(on: boolean, key: string): number | undefined {
  const [credits, setCredits] = useState<number>()
  useEffect(() => {
    if (!on) return undefined
    let live = true
    void window.sotto?.plugins?.meshyCredits().then(byAccount => { if (live) setCredits(Object.values(byAccount).reduce((sum, each) => sum + each, 0)) }, () => undefined)
    return () => { live = false }
  }, [on, key])
  return credits
}

/** Whether a 3D model's name or the words it was made from hold what was searched for. */
export function modelMatches(model: Pick<Model3dListed, 'name' | 'words'>, query: string): boolean {
  const wanted = query.trim().toLocaleLowerCase()
  return wanted === '' || model.name.toLocaleLowerCase().includes(wanted) || (model.words?.toLocaleLowerCase().includes(wanted) ?? false)
}
