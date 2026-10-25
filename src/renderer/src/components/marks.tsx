import React, { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'

/**
 * A mark is a fact a part of a surface tells the surface, which wears it as a `data-<name>` attribute for its
 * stylesheet to select on: the Threads page wears `data-tools="docked"` while the tools panel is docked, a pane
 * wears `data-greeting` while its greeting shows.
 *
 * It stands in for `:has()` on an element above the terminal. Chromium keys `:has()` invalidation by the pseudo-class,
 * not by the rule: every node inserted or text changed under an element whose style was resolved against a `:has()`
 * subject restyles that subject with the merged right-hand sides of every `:has()` rule in the document. With the
 * page root as a subject, each of the two hundred glyph measurements xterm's DOM renderer makes on a text size change
 * restyled most of the page, and a zoom press froze the window for seconds (#1441).
 */
type Value = string | boolean | null | undefined
type Tell = (source: string, name: string, value: string | null) => void
type Told = ReadonlyMap<string, ReadonlyMap<string, string>>

const MarksContext = createContext<Tell | null>(null)

const same = (before: ReadonlyMap<string, string> | undefined, after: ReadonlyMap<string, string>): boolean =>
  (before?.size ?? 0) === after.size && [...after].every(([source, value]) => before?.get(source) === value)

/** The attributes a surface wears, to spread on its element, and the `tell` its parts reach through `<Marks>`. */
export function useMarkedSurface(): { readonly marks: Readonly<Record<string, string>>; readonly tell: Tell } {
  const [told, setTold] = useState<Told>(() => new Map())
  const tell = useCallback<Tell>((source, name, value) => {
    setTold(current => {
      const sources = new Map(current.get(name))
      if (value === null) sources.delete(source)
      else sources.set(source, value)
      if (same(current.get(name), sources)) return current
      const next = new Map(current)
      if (sources.size) next.set(name, sources)
      else next.delete(name)
      return next
    })
  }, [])
  const marks = useMemo(() => {
    const attributes: Record<string, string> = {}
    for (const [name, sources] of told) attributes[`data-${name}`] = sources.values().next().value ?? ''
    return attributes
  }, [told])
  return { marks, tell }
}

/** The parts inside tell their marks to the surface that owns `tell`. */
export function Marks({ tell, children }: { readonly tell: Tell; readonly children: ReactNode }): ReactNode {
  return <MarksContext.Provider value={tell}>{children}</MarksContext.Provider>
}

/**
 * Tell the nearest surface a fact, before the frame paints; `false` or `null` withdraws it, as does unmounting. A
 * string is the attribute's value, `true` an attribute with none. Several parts may tell the same mark: it stays
 * while any of them holds it. With no surface above, nothing happens.
 */
export function useMark(name: string, value: Value): void {
  const tell = useContext(MarksContext)
  const source = useId()
  const told = value === null || value === undefined || value === false ? null : value === true ? '' : value
  useLayoutEffect(() => {
    if (!tell || told === null) return
    tell(source, name, told)
    return () => tell(source, name, null)
  }, [tell, source, name, told])
}

/** A surface drawn by `children`, which spreads the marks on its element; the parts inside tell. */
export function Marked({ children }: { readonly children: (marks: Readonly<Record<string, string>>) => ReactNode }): ReactNode {
  const { marks, tell } = useMarkedSurface()
  return <MarksContext.Provider value={tell}>{children(marks)}</MarksContext.Provider>
}

/** A mark told for as long as this renders, for a part whose branches each draw the thing the mark names. */
export function Mark({ name, value = true }: { readonly name: string; readonly value?: Value }): ReactNode {
  useMark(name, value)
  return null
}
