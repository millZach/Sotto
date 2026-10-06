import { z } from 'zod'
import { namesHostThread } from '../../shared/clientIdentity'
import { TERMINAL_CHANNEL } from '../../shared/terminal'
import { BROWSER_CHANNEL } from '../../shared/browser'
import { GIT_CHANGES_CHANNEL, gitPathRequestSchema, gitReviewRequestSchema, type GitChangeListing, type GitPathRequest, type GitReview, type GitReviewRequest } from '../../shared/gitChanges'
import type { FilePath } from '../../shared/files'
import { toolListRequestSchema, type ToolListRequest, type ToolsResult } from '../../shared/tools'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'
import type { TerminalService } from './terminal'
import type { BrowserService } from './browser'
import type { GitChangesService } from './gitChanges'

/**
 * Changes for a thread on a paired host, read on that host through the router (ADR-0025, October 5 amendment): the
 * change list, Working tree and Branch changes, and Copy path of the host's own path. Reveal, the watch and the turn
 * checkpoints need the thread on this computer, so a request for one is refused here.
 */
export interface HostedGitChanges {
  list(request: ToolListRequest): Promise<ToolsResult<GitChangeListing>>
  review(request: GitReviewRequest): Promise<ToolsResult<GitReview>>
  copyPath(request: GitPathRequest): Promise<ToolsResult<FilePath>>
}

const GIT_CHANGES_METHODS = ['list', 'review', 'copyPath', 'reveal', 'watch', 'checkpoints', 'inspectCheckpoint', 'revertCheckpoint', 'recoverCheckpoint'] as const
/** What each Changes request a paired host's thread cannot have says instead. */
const NOT_ON_HOST: Partial<Record<typeof GIT_CHANGES_METHODS[number], string>> = {
  reveal: 'This file is on the host machine, so it cannot be shown in a folder here. Nothing was opened.',
  watch: 'Changes reads this thread again when its host says its files changed, so there is nothing to watch here. Nothing was changed.',
}
const NO_CHECKPOINTS = 'Turn checkpoints are kept only for threads on this computer. Nothing was changed.'
const INVALID = 'This tool request is invalid. Refresh the tools panel.'

export function registerToolsIpc(ipc: IpcMainAdapter, services: { terminal: TerminalService; browser: BrowserService; gitChanges: GitChangesService; hostedGitChanges?: HostedGitChanges }, senders: () => readonly TrustedIpcSender[]): () => void {
  const channels: string[] = []
  const register = (channel: string, operation: (payload: unknown) => unknown): void => {
    ipc.handle(channel, (event, ...args) => {
      if (!isAuthorizedIpcSender(event, senders(), ['main'])) throw new Error('TOOLS_MAIN_WINDOW_REQUIRED')
      const [payload] = z.tuple([z.unknown()]).parse(args)
      return operation(payload)
    })
    channels.push(channel)
  }
  /** A request for a thread on a paired host goes to that host, checked here as Changes would check it on this computer. */
  const onHost = async (method: typeof GIT_CHANGES_METHODS[number], payload: unknown): Promise<ToolsResult<unknown>> => {
    const hosted = services.hostedGitChanges
    if (!hosted) return { ok: false, error: { code: 'unavailable', message: 'Changes cannot reach the host machine from this window. Nothing was changed. Restart Sotto and try again.' } }
    const invalid = { ok: false, error: { code: 'invalid-request', message: INVALID } } as const
    if (method === 'list') { const parsed = toolListRequestSchema.safeParse(payload); return parsed.success ? hosted.list(parsed.data) : invalid }
    if (method === 'review') { const parsed = gitReviewRequestSchema.safeParse(payload); return parsed.success ? hosted.review(parsed.data) : invalid }
    if (method === 'copyPath') { const parsed = gitPathRequestSchema.safeParse(payload); return parsed.success ? hosted.copyPath(parsed.data) : invalid }
    return { ok: false, error: { code: 'unavailable', message: NOT_ON_HOST[method] ?? NO_CHECKPOINTS } }
  }
  for (const method of ['list', 'create', 'read', 'write', 'resize', 'interrupt', 'close', 'reopen'] as const) register(TERMINAL_CHANNEL + method, payload => services.terminal[method](payload))
  for (const method of ['list', 'create', 'navigate', 'back', 'forward', 'reload', 'close', 'mount', 'openLink', 'tasks', 'share', 'controlTask', 'answerAction', 'stopGrant', 'viewport', 'capture'] as const) register(BROWSER_CHANNEL + method, payload => services.browser[method](payload))
  for (const method of GIT_CHANGES_METHODS) register(GIT_CHANGES_CHANNEL + method, payload => namesHostThread(payload) ? onHost(method, payload) : services.gitChanges[method](payload))
  return () => {
    for (const channel of channels) ipc.removeHandler(channel)
    services.browser.dispose(); services.terminal.dispose(); services.gitChanges.dispose()
  }
}
