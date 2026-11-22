import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { MAX_ACTIVITY_TEXT } from '../../shared/agentActivity'
import { turnPatch } from '../../shared/turnDiff'

/**
 * An Antigravity edit placed on its lines (parity slice 5; Zach picked variant B of the prototype kept as the tag
 * `prototype/antigravity-edit-lines`, November 21, 2026). `agy` reports an edit as its old and new text, with no line
 * numbers: 1.5.14 sends the whole file before and after, and an older one may send only the snippet, which T3 Code places
 * by matching the file. Sotto reads the file once the edit is done and finds the new text in it. Found exactly once, the
 * file as it was is the file now with that text put back, so the row shows only the changed lines, numbered as the file
 * is now, the way a Codex edit row does. Not found, or found twice, the row stays as `agy` reported it.
 */

/** A file larger than this is not read to place an edit: its row stays as `agy` reported it. */
const MOST_BYTES = 4 * 1024 * 1024

/** One edit `agy` reported in a finished tool call: the file it names, and its text before and after. */
export interface AntigravityEdit { readonly path: string; readonly oldText: string; readonly newText: string }

/** The edits a finished `tool_call_update` reports, in the order its row lists their changes. */
export function antigravityEdits(update: Record<string, unknown>): AntigravityEdit[] {
  if (update.sessionUpdate !== 'tool_call_update' || update.status !== 'completed' || !Array.isArray(update.content)) return []
  return update.content.flatMap((item): AntigravityEdit[] => {
    const block = item !== null && typeof item === 'object' ? item as Record<string, unknown> : undefined
    // Every diff with a path, as the row lists one: one without new text keeps its row as reported.
    return block?.type === 'diff' && typeof block.path === 'string'
      ? [{ path: block.path, oldText: typeof block.oldText === 'string' ? block.oldText : '', newText: typeof block.newText === 'string' ? block.newText : '' }] : []
  })
}

/** The file `agy` names, as this computer opens it: `/C:/…` is `C:/…` on Windows, and a relative path is the thread's folder's. */
export function antigravityFilePath(path: string, cwd: string, platform: NodeJS.Platform = process.platform): string {
  const local = platform === 'win32' && /^\/[A-Za-z]:[\\/]/u.test(path) ? path.slice(1) : path
  return isAbsolute(local) ? local : resolve(cwd, local)
}

/**
 * The edit as hunks with no context, numbered as the file is now, or undefined when its new text is empty or is not in
 * the file exactly once, so Sotto cannot say where it is.
 */
export function placeAntigravityEdit(edit: Pick<AntigravityEdit, 'oldText' | 'newText'>, now: string): string | undefined {
  if (!edit.newText) return undefined
  const at = now.indexOf(edit.newText)
  if (at < 0 || now.indexOf(edit.newText, at + 1) >= 0) return undefined
  const before = now.slice(0, at) + edit.oldText + now.slice(at + edit.newText.length)
  const { patch } = turnPatch('file', before, now, false, 0)
  const hunks = patch.indexOf('\n@@ ')
  if (hunks < 0) return undefined
  const placed = patch.slice(hunks + 1).replace(/\n$/u, '')
  return placed.length <= MAX_ACTIVITY_TEXT ? placed : undefined
}

/** Each edit placed on its lines from the file as it is now, or undefined for one that cannot be. Never throws. */
export async function placeAntigravityEdits(edits: readonly AntigravityEdit[], cwd: string): Promise<(string | undefined)[]> {
  return Promise.all(edits.map(async edit => {
    try {
      const path = antigravityFilePath(edit.path, cwd)
      if ((await stat(path)).size > MOST_BYTES) return undefined
      return placeAntigravityEdit(edit, await readFile(path, 'utf8'))
    } catch { return undefined }
  }))
}
