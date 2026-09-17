import { fileMentionToken, hasFileMention, type AgentFileReference } from '../../../shared/agentFiles'
import type { FileListing } from '../../../shared/files'
import { isGitAdministrative } from '../tools/filesBrowser'
import { detectMentionTrigger, type MentionTrigger } from './composerMentions'

export type FileEntry = FileListing['entries'][number]
export const MAX_MENTIONED_FILES = 32

/** The `@` token at the caret that opened the file picker. */
export type FileTrigger = MentionTrigger

export function detectFileTrigger(text: string, selectionStart: number, selectionEnd = selectionStart): FileTrigger | null {
  return detectMentionTrigger(text, selectionStart, selectionEnd, '@')
}

/**
 * The query is a working-copy path being typed: everything up to the last `/` chooses the folder
 * the picker lists, and the rest filters that folder's entries. Listing is the Files service's
 * job, so the working copy boundary and its git-administrative entry are never decided here.
 */
export function fileQueryParts(query: string): { readonly directory: string; readonly filter: string } {
  const cut = query.lastIndexOf('/')
  return cut < 0 ? { directory: '', filter: query } : { directory: query.slice(0, cut), filter: query.slice(cut + 1) }
}

function matchScore(value: string, filter: string): number | null {
  if (value === filter) return 0
  if (value.startsWith(filter)) return 1
  if (value.split(/[-_.\s]+/u).some(part => part.startsWith(filter))) return 2
  if (value.includes(filter)) return 3
  return null
}

/** Folders first, then files; a filter ranks name matches, native order breaking ties. */
export function searchFileEntries(entries: readonly FileEntry[], filter: string): FileEntry[] {
  const normalized = filter.trim().toLowerCase()
  const offered = entries.filter(entry => entry.kind !== 'unavailable' && !isGitAdministrative(entry))
  const rank = (entry: FileEntry): number => entry.kind === 'directory' ? 0 : 1
  return offered
    .map((entry, index) => ({ entry, index, score: normalized ? matchScore(entry.name.toLowerCase(), normalized) : 0 }))
    .filter((item): item is { entry: FileEntry; index: number; score: number } => item.score !== null)
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.score - b.score || a.index - b.index)
    .map(item => item.entry)
}

/** Mentioned files whose `@path` is still written in the text; a deleted token takes its reference with it. */
export function retainFileReferences(text: string, files: readonly AgentFileReference[]): AgentFileReference[] {
  return files.filter(file => hasFileMention(text, file.path))
}

export function sameFileReferences(a: readonly AgentFileReference[], b: readonly AgentFileReference[]): boolean {
  return a.length === b.length && a.every((file, index) => file.path === b[index]!.path)
}

/**
 * Replace the trigger token with the file's `@path`, the form every provider reads.
 * Returns the new text, the caret after the token, and the references this text keeps.
 */
export function insertFile(text: string, trigger: FileTrigger, path: string, selected: readonly AgentFileReference[]): { text: string; caret: number; files: AgentFileReference[] } {
  const after = text.slice(trigger.end)
  const spacer = after.startsWith(' ') || after.startsWith('\n') ? '' : ' '
  const token = `${fileMentionToken(path)}${spacer}`
  const next = `${text.slice(0, trigger.start)}${token}${after}`
  const kept = retainFileReferences(next, selected)
  const files = kept.some(file => file.path === path) ? kept : [...kept, { path }].slice(-MAX_MENTIONED_FILES)
  return { text: next, caret: trigger.start + token.length, files }
}

/** Chosen folder: the token becomes `@folder/` and the picker keeps browsing, nothing is mentioned yet. */
export function browseFolder(text: string, trigger: FileTrigger, path: string): { text: string; caret: number } {
  const token = `${fileMentionToken(path)}/`
  return { text: `${text.slice(0, trigger.start)}${token}${text.slice(trigger.end)}`, caret: trigger.start + token.length }
}
