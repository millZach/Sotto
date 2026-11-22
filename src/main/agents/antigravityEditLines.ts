import { readFile, realpath, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
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

/**
 * The file `agy` names, as this computer opens it: `/C:/…` is `C:/…` on Windows, and a relative path is the thread's
 * folder's. Undefined for a file outside the thread's folder, which Sotto does not read to place an edit: a path `agy`
 * names could be a network share, and only the user's own folder is read.
 */
export function antigravityFilePath(path: string, cwd: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const paths = platform === 'win32' ? win32 : posix
  const local = platform === 'win32' && /^\/[A-Za-z]:[\\/]/u.test(path) ? path.slice(1) : path
  const full = paths.resolve(cwd, local), within = paths.relative(paths.resolve(cwd), full)
  return within && !within.startsWith('..') && !paths.isAbsolute(within) ? full : undefined
}

/**
 * The edit as hunks with no context, numbered as the file is now, or undefined when its new text is empty or is not in
 * the file exactly once, so Sotto cannot say where it is.
 */
export function placeAntigravityEdit(edit: Pick<AntigravityEdit, 'oldText' | 'newText'>, now: string): string | undefined {
  if (!edit.newText) return undefined
  const at = now.indexOf(edit.newText), end = at + edit.newText.length
  if (at < 0 || now.indexOf(edit.newText, at + 1) >= 0) return undefined
  // Only the whole lines the new text spans are diffed, then numbered from where they start, so a change is never
  // placed outside the text `agy` named, as a diff of the whole file may when the lines around it repeat.
  // At the file's start the line starts there: `lastIndexOf` would read a -1 as 0 and find a leading blank line's newline.
  const start = at === 0 ? 0 : now.lastIndexOf('\n', at - 1) + 1, newline = now.indexOf('\n', end - 1), stop = newline < 0 ? now.length : newline + 1
  const lines = now.slice(start, stop), before = now.slice(start, at) + edit.oldText + now.slice(end, stop)
  const { patch } = turnPatch('file', before, lines, false, 0)
  const hunks = patch.indexOf('\n@@ ')
  if (hunks < 0) return undefined
  let offset = 0
  for (let index = now.indexOf('\n'); index >= 0 && index < start; index = now.indexOf('\n', index + 1)) offset++
  const placed = patch.slice(hunks + 1).replace(/\n$/u, '')
    .replace(/^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@/gmu, (_, from: string, fromCount = '', to: string, toCount = '') => `@@ -${Number(from) + offset}${fromCount} +${Number(to) + offset}${toCount} @@`)
  return placed.length <= MAX_ACTIVITY_TEXT ? placed : undefined
}

/**
 * Each edit placed on its lines from the file as it is now, or undefined for one that cannot be. Never throws. Nothing
 * under `kept`, Sotto's own Antigravity folder where `agy` keeps its sign-in, is ever read (ADR-0212's amendment), even
 * when the thread's folder holds it.
 */
export async function placeAntigravityEdits(edits: readonly AntigravityEdit[], cwd: string, kept: string): Promise<(string | undefined)[]> {
  return Promise.all(edits.map(async edit => {
    try {
      const named = antigravityFilePath(edit.path, cwd)
      if (!named) return undefined
      // Checked again as the real paths, so a link or junction in the thread's folder that leads outside it is never followed.
      const [path, folder, own] = await Promise.all([realpath(named), realpath(cwd), realpath(kept).catch(() => kept)])
      if (!antigravityFilePath(path, folder) || antigravityFilePath(path, own) || (await stat(path)).size > MOST_BYTES) return undefined
      return placeAntigravityEdit(edit, await readFile(path, 'utf8'))
    } catch { return undefined }
  }))
}
