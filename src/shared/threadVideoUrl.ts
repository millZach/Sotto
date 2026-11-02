/**
 * The address the window's player reads a video an agent wrote from (ADR-0170, part 4): the thread, its record and the
 * handle, never a path. Main answers it from the video's file while that is still the video (`threadMediaScheme.ts`).
 */
export const THREAD_MEDIA_SCHEME = 'sotto-media'

export interface ThreadVideoTarget { readonly threadId: string; readonly activityId: string; readonly mediaId: string }

export function threadVideoUrl(target: ThreadVideoTarget): string {
  return `${THREAD_MEDIA_SCHEME}://video/${[target.threadId, target.activityId, target.mediaId].map(encodeURIComponent).join('/')}`
}

/** What a `threadVideoUrl` names, or undefined for any other address. */
export function threadVideoTarget(url: string): ThreadVideoTarget | undefined {
  let parsed: URL
  try { parsed = new URL(url) } catch { return undefined }
  if (parsed.protocol !== `${THREAD_MEDIA_SCHEME}:` || parsed.hostname !== 'video') return undefined
  const parts = parsed.pathname.split('/').slice(1)
  if (parts.length !== 3) return undefined
  try {
    const [threadId, activityId, mediaId] = parts.map(decodeURIComponent) as [string, string, string]
    return threadId && activityId && mediaId ? { threadId, activityId, mediaId } : undefined
  } catch { return undefined }
}
