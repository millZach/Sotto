import { z } from 'zod'
import { TERMINAL_CHANNEL } from '../../shared/terminal'
import { BROWSER_CHANNEL } from '../../shared/browser'
import { GIT_CHANGES_CHANNEL } from '../../shared/gitChanges'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { TerminalService } from './terminal'
import type { BrowserService } from './browser'
import type { GitChangesService } from './gitChanges'

export function registerToolsIpc(ipc: IpcMainAdapter, services: { terminal: TerminalService; browser: BrowserService; gitChanges: GitChangesService }, senders: () => readonly TrustedIpcSender[]): () => void {
  const channels: string[] = []
  const register = (channel: string, operation: (payload: unknown) => unknown): void => {
    ipc.handle(channel, (event, ...args) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('TOOLS_MAIN_WINDOW_REQUIRED')
      const [payload] = z.tuple([z.unknown()]).parse(args)
      return operation(payload)
    })
    channels.push(channel)
  }
  for (const method of ['list', 'create', 'read', 'write', 'resize', 'interrupt', 'close', 'reopen'] as const) register(TERMINAL_CHANNEL + method, payload => services.terminal[method](payload))
  for (const method of ['list', 'create', 'navigate', 'back', 'forward', 'reload', 'close', 'mount', 'openLink'] as const) register(BROWSER_CHANNEL + method, payload => services.browser[method](payload))
  for (const method of ['list', 'diff', 'copyPath', 'reveal', 'watch', 'act', 'branches', 'checkpoints', 'inspectCheckpoint', 'revertCheckpoint', 'recoverCheckpoint', 'draftCommitMessage', 'reviewPullRequest', 'draftPullRequestText', 'actPullRequest'] as const) register(GIT_CHANGES_CHANNEL + method, payload => services.gitChanges[method](payload))
  return () => {
    for (const channel of channels) ipc.removeHandler(channel)
    services.browser.dispose(); services.terminal.dispose(); services.gitChanges.dispose()
  }
}
