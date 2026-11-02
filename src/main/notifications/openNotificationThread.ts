import { t } from '@lingui/core/macro'
import type { NotificationOpening } from '../../shared/desktopNotifications'
import { desktopWindowClient } from '../agents/hostService'
import type { DesktopHostRouter } from '../hosts/desktopHostRouter'

/** A press only navigates (ADR-0117). Watcher's current conversation has its own room, outside Threads. */
export async function openNotificationThread(router: Pick<DesktopHostRouter, 'view' | 'command'>, threadId: string, watcherThreadId?: string): Promise<NotificationOpening> {
  let state = router.view()
  const thread = state.host.threads.find(item => item.id === threadId)
  if (thread?.kind === 'watcher' && threadId === watcherThreadId) {
    return { page: 'watcher', notice: t`This notification is for Watcher. Its conversation is in this room.` }
  }
  try {
    if (thread && thread.kind !== 'watcher') {
      state = await router.command({ type: 'select-thread', threadId }, desktopWindowClient())
      if (state.host.threads.some(item => item.id === threadId)) {
        return { page: 'threads', ...(state.error ? { notice: state.error } : {}) }
      }
    }
    // A cleared thread or another Watcher's room must not replace a usable pane with a hidden selection.
    const available = state.host.threads.filter(item => item.kind !== 'watcher')
    const fallback = available.find(item => item.id === state.activeThreadId) ?? available[0]
    if (fallback && fallback.id !== state.activeThreadId) await router.command({ type: 'select-thread', threadId: fallback.id }, desktopWindowClient())
    return { page: 'threads', notice: thread?.kind === 'watcher'
      ? t`This notification is for another Watcher room. Open Sotto on its computer to read it.`
      : t`The thread for this notification is no longer available. Choose another thread or start a new one.` }
  } catch {
    return { page: 'threads', notice: t`Sotto could not open this thread. Check its host's connection in Settings, then choose the thread again.` }
  }
}
