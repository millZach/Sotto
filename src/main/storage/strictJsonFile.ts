import { readFile } from 'node:fs/promises'
import { hasErrorCode } from './atomicJsonStore'

/**
 * A record read without recovery, for one whose loss would be unsafe: a file that is not there is `missing`; any other
 * read or parse failure is `unreadable`, with the JSON when that much parsed, so the caller can keep what it can still
 * name safe and leave the file as it is. `AtomicJsonStore.read` instead puts a broken file aside and starts again empty.
 */
export type StrictJsonRead<T> = { readonly status: 'valid'; readonly value: T } | { readonly status: 'missing' } | { readonly status: 'unreadable'; readonly raw?: unknown }

export async function readStrictJson<T>(path: string, parse: (input: unknown) => T): Promise<StrictJsonRead<T>> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch (error) { return hasErrorCode(error, 'ENOENT') ? { status: 'missing' } : { status: 'unreadable' } }
  let raw: unknown
  try { raw = JSON.parse(text) as unknown } catch { return { status: 'unreadable' } }
  try { return { status: 'valid', value: parse(raw) } } catch { return { status: 'unreadable', raw } }
}
