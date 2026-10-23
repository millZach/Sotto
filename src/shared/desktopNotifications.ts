import { z } from 'zod'
import type { ProviderId } from './agents'

/**
 * Passed to the main window's preload only while desktop notifications are on here (ADR-0112): Owl, macOS, and a system
 * that can show them. Without it there is no bridge and Settings has no Notifications group.
 */
export const DESKTOP_NOTIFICATIONS_RENDERER_ARGUMENT = '--sotto-desktop-notifications-enabled'
/** Settings' Send a test notification: the window asks, main shows one and says whether the system showed it. */
export const NOTIFICATION_TEST = 'sotto:notification:test'
/** A notification was pressed: main brought the window forward and selected its thread, so the window shows Threads. */
export const NOTIFICATION_OPENED = 'sotto:notification:opened'

/** The system showed the test notification, refused it (unsigned build, notifications not allowed), or cannot show any. */
export const notificationTestResultSchema = z.enum(['shown', 'failed', 'unsupported'])
export type NotificationTestResult = z.infer<typeof notificationTestResultSchema>

export interface NotificationsBridge {
  test(): Promise<NotificationTestResult>
  onOpened(listener: () => void): () => void
}

/** A notification says a thread needs the user, or has finished everything (CONTEXT.md, Alert and Wrapped up). */
export type ThreadAlertKind = 'needs-you' | 'finished'

/**
 * One alert about one thread, in the window's own IDs. It names the thread and what happened, and never carries a
 * message's or a request's words.
 */
export interface ThreadAlert {
  readonly kind: ThreadAlertKind
  /** The thread to open: the thread itself, or the delegated thread that asked, which has its own pane (ADR-0081). */
  readonly threadId: string
  /** What names it in the sidebar: the thread's title, or its top-level thread's when a delegated thread asked. */
  readonly title: string
  /** The thread's provider, so the line can name the agent. */
  readonly providerId?: ProviderId
  /** For needs-you: what is being asked. A permission outranks a question. */
  readonly request?: 'question' | 'permission'
  /** The computer's name, only for a thread that runs on another computer. */
  readonly computer?: string
  /** Unique to the event, so the system shows each once and never merges two. */
  readonly id: string
}

/** How long a finished thread must stay quiet before it is told, so a turn about to start (news, a queue, a report) wins. */
export const ALERT_SETTLE_MS = 3_000
/**
 * The same wait for a thread that delegated work. A delegated thread's answer goes back to it as a turn Sotto sends later,
 * and that send is not in the queue any client sees (it waits for the thread's history and any send ahead of it, and tries
 * again after ten seconds), so a thread that delegated waits long enough for one retry before it is told finished (ADR-0112).
 */
export const ALERT_DELEGATION_SETTLE_MS = 15_000
/** The longest title a notification carries; macOS cuts a whole notification at 256 bytes. */
export const ALERT_TITLE_MAX = 80
/** How many shown notifications main keeps a reference to, so their events are not lost to garbage collection. */
export const ALERT_REFERENCES_MAX = 50
