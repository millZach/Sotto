/**
 * The owner's Watcher record as it stood on November 13, 2026, when a paired host's every push froze main: 942
 * requests, 1,110 operations, 823 prompt turns and 499 watch fences, 2.7 MB. It is a copy, never the live file, and it
 * holds no words: every ID, digest and message ID in it was replaced, consistently, so its shape and what refers to what
 * is the owner's and nothing else is. Its two machines have fixed IDs, the desktop's and the paired host's, which a fixture
 * replaces with its own.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import type { WatcherRecord } from '../../src/shared/watcher'

/** The desktop the owner's Watcher ran on, as the copy names it. */
export const OWNER_DESKTOP_ID = '00000000-0000-4000-8000-00000000d001'
/** The paired host where most of the owner's watched threads ran, as the copy names it. */
export const OWNER_PAIRED_HOST_ID = '00000000-0000-4000-8000-00000000a002'

/** A fresh copy of the owner's record with its desktop and paired host renamed to `desktop` and `paired`. */
export function ownerWatcherRecord(desktop: string, paired: string): WatcherRecord {
  const text = gunzipSync(readFileSync(fileURLToPath(new URL('./watcherOwnerRecord.json.gz', import.meta.url)))).toString('utf8')
  return (JSON.parse(text.replaceAll(OWNER_DESKTOP_ID, desktop).replaceAll(OWNER_PAIRED_HOST_ID, paired)) as { watcher: WatcherRecord }).watcher
}
