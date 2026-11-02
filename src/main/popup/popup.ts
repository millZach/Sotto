import { t } from '@lingui/core/macro'

import { AGENT_THREAD_DETAIL, type AgentCommand, type AgentState } from '../../shared/agents'
import { SETTINGS_CHANGED } from '../../shared/channels'
import { POPUP_OPENED, POPUP_SHORTCUT_STATE_CHANGED, POPUP_THREAD, type PopupOpen, type PopupOpened, type PopupShortcutResult } from '../../shared/popup'
import type { SottoPlatform } from '../../shared/platform'
import type { AppSettings, SettingsPatch } from '../../shared/settings'
import { coalesceAgentThreadDetailPublishes } from '../agents/control'
import { desktopPopupClient, desktopWindowClient, type ClientIdentity } from '../agents/hostService'
import type { GlobalShortcutAdapter } from '../hotkeys/hotkeyManager'
import { PopupFeed } from './popupFeed'
import type { PopupIpcService } from './popupIpc'
import { PopupShortcut } from './popupShortcut'
import { PopupWindow, type PopupWindowDependencies } from '../windows/popupWindow'

export interface PopupDependencies {
  readonly window: Omit<PopupWindowDependencies, 'onVisible'>
  readonly shortcuts: GlobalShortcutAdapter
  readonly platform: SottoPlatform
  readonly settings: { getSettings(): Promise<AppSettings>; updateSettings(patch: SettingsPatch): Promise<AppSettings> }
  /** The desktop router's command, which keeps each client's observed threads apart. */
  readonly command: (command: AgentCommand, client: ClientIdentity) => Promise<AgentState>
  readonly showMain: () => Promise<void>
  readonly sendToMain: (channel: string, payload: unknown) => void
}

export interface Popup {
  readonly window: PopupWindow
  readonly feed: PopupFeed
  readonly ipc: PopupIpcService
  toggle(): void
  show(): void
  /** Every settings change: the shortcut follows the saved keys and the card its look. */
  settingsChanged(settings: AppSettings): void
  dispose(): void
}

/**
 * The popup (ADR-0181) as main runs it while the Owl feature is on: its window, its shortcut and what it is sent. Stable
 * never makes one, so nothing of it registers or shows there, and the saved shortcut is left as it is.
 */
export function createPopup(dependencies: PopupDependencies, startup: AppSettings): Popup {
  const detail = coalesceAgentThreadDetailPublishes(update => window.send(AGENT_THREAD_DETAIL, update))
  const feed = new PopupFeed(thread => window.send(POPUP_THREAD, thread), update => detail.publish(update))
  const popupClient = desktopPopupClient()
  // A hidden or vanished popup observes nothing: main says so itself, so a renderer that stopped can never keep a thread
  // loaded and streaming. Showing it again observes its thread again from the page.
  const window: PopupWindow = new PopupWindow({
    ...dependencies.window,
    onVisible: visible => {
      if (visible) return
      feed.observe([])
      void dependencies.command({ type: 'observe-threads', threadIds: [] }, popupClient).catch(() => undefined)
    },
  })
  const toggle = (): void => { void window.toggle().catch(() => undefined) }
  const shortcut = new PopupShortcut(dependencies.shortcuts, toggle, dependencies.platform,
    state => dependencies.sendToMain(POPUP_SHORTCUT_STATE_CHANGED, state))
  shortcut.apply(startup)

  const ipc: PopupIpcService = {
    hide: () => window.hide(),
    fit: height => window.fit(height),
    open: async (request: PopupOpen) => {
      window.hide()
      await dependencies.showMain()
      dependencies.sendToMain(POPUP_OPENED, request.watcher ? { page: 'watcher' } satisfies PopupOpened : await selectThread(request.threadId))
    },
    shortcutState: () => shortcut.state(),
    replaceShortcut: async (chord): Promise<PopupShortcutResult> => {
      const saved = await dependencies.settings.getSettings()
      const result = shortcut.replace(chord, saved)
      if (!result.ok) return result
      try {
        await dependencies.settings.updateSettings({ popupShortcut: chord })
        return result
      } catch {
        // Not saved: the keys go back to the saved ones, which still work.
        shortcut.apply(saved)
        return { ok: false, reason: 'unavailable' }
      }
    },
    suspendShortcut: suspended => shortcut.suspend(suspended),
  }

  /** Selects the thread in the main window, as a notification's press does; one that is gone opens Threads and says so. */
  const selectThread = async (threadId: string): Promise<PopupOpened> => {
    try {
      const state = await dependencies.command({ type: 'select-thread', threadId }, desktopWindowClient())
      if (state.host.threads.some(thread => thread.id === threadId)) return { page: 'threads', ...(state.error ? { notice: state.error } : {}) }
      return { page: 'threads', notice: t`The popup's thread is no longer available. Choose another thread or start a new one.` }
    } catch {
      return { page: 'threads', notice: t`Sotto could not open the popup's thread. Check its host's connection in Settings, then choose the thread again.` }
    }
  }

  return {
    window,
    feed,
    ipc,
    toggle,
    show: () => { void window.show().catch(() => undefined) },
    settingsChanged: settings => {
      shortcut.apply(settings)
      window.send(SETTINGS_CHANGED, settings)
    },
    dispose: () => {
      shortcut.dispose()
      detail.dispose()
      window.dispose()
    },
  }
}
