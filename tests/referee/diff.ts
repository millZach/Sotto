// Structural differences between two JSON values, as a person reads them, and the patches the recordings are stored as.

export type Path = readonly (string | number)[]
/** One change: `value` at `path`, or the key or item at `path` removed. */
export type Op = { readonly path: Path; readonly value: unknown } | { readonly path: Path; readonly remove: true }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => equal(item, b[index]))
  if (!isObject(a) || !isObject(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]))
}

/** The changes that turn `from` into `to`. An array that changed length is replaced from the first item that differs. */
export function diff(from: unknown, to: unknown, path: Path = []): Op[] {
  if (equal(from, to)) return []
  if (isObject(from) && isObject(to)) {
    const ops: Op[] = []
    for (const key of Object.keys(from)) if (!Object.hasOwn(to, key)) ops.push({ path: [...path, key], remove: true })
    for (const key of Object.keys(to)) ops.push(...(Object.hasOwn(from, key) ? diff(from[key], to[key], [...path, key]) : [{ path: [...path, key], value: to[key] }]))
    return ops
  }
  if (Array.isArray(from) && Array.isArray(to)) {
    const ops: Op[] = []
    const shared = Math.min(from.length, to.length)
    for (let index = 0; index < shared; index++) ops.push(...diff(from[index], to[index], [...path, index]))
    for (let index = from.length - 1; index >= shared; index--) ops.push({ path: [...path, index], remove: true })
    for (let index = shared; index < to.length; index++) ops.push({ path: [...path, index], value: to[index] })
    return ops
  }
  return [{ path, value: to }]
}

/** `from` with `ops` applied, as a new value. */
export function patch(from: unknown, ops: readonly Op[]): unknown {
  let root = structuredClone(from)
  for (const op of ops) {
    if (op.path.length === 0) { root = 'remove' in op ? undefined : structuredClone(op.value); continue }
    let parent = root as Record<string | number, unknown>
    for (const key of op.path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>
    const last = op.path.at(-1)!
    if ('remove' in op) { if (Array.isArray(parent)) parent.splice(last as number, 1); else delete parent[last] }
    else parent[last] = structuredClone(op.value)
  }
  return root
}

export function pathText(path: Path): string {
  return path.reduce<string>((text, key) => typeof key === 'number' ? `${text}[${key}]` : /^[A-Za-z_$][\w$-]*$/u.test(key) ? `${text}${text ? '.' : ''}${key}` : `${text}[${JSON.stringify(key)}]`, '') || '(the whole value)'
}

function shown(value: unknown): string {
  const text = JSON.stringify(value)
  return text === undefined ? 'nothing' : text.length > 160 ? `${text.slice(0, 157)}...` : text
}

/** Up to `limit` lines saying where `actual` differs from `expected`, recorded first. */
export function describeDifferences(expected: unknown, actual: unknown, limit = 8): string[] {
  const lines: string[] = []
  const walk = (a: unknown, b: unknown, path: Path): void => {
    if (lines.length > limit || equal(a, b)) return
    if (isObject(a) && isObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!Object.hasOwn(b, key)) lines.push(`at ${pathText([...path, key])}: recorded ${shown(a[key])}, this host sent no such field`)
        else if (!Object.hasOwn(a, key)) lines.push(`at ${pathText([...path, key])}: the recording has no such field, this host sent ${shown(b[key])}`)
        else walk(a[key], b[key], [...path, key])
      }
      return
    }
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) { a.forEach((item, index) => walk(item, b[index], [...path, index])); return }
    if (Array.isArray(a) && Array.isArray(b)) {
      lines.push(`at ${pathText(path)}: recorded ${a.length} items, this host sent ${b.length}`)
      const first = a.findIndex((item, index) => !equal(item, b[index]))
      if (first >= 0) walk(a[first], b[first], [...path, first])
      return
    }
    lines.push(`at ${pathText(path)}: recorded ${shown(a)}, this host sent ${shown(b)}`)
  }
  walk(expected, actual, [])
  if (lines.length > limit) return [...lines.slice(0, limit), '...and more']
  return lines
}
