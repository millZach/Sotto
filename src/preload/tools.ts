import { z } from 'zod'
import { filePathSchema } from '../shared/files'
import { toolListRequestSchema, toolsResultSchema } from '../shared/tools'
import { TERMINAL_CHANNEL, TERMINAL_EVENT, terminalCreateSchema, terminalRequestSchema, terminalWriteSchema, terminalResizeSchema, terminalSnapshotSchema, terminalListingSchema, terminalEventSchema, type TerminalBridge } from '../shared/terminal'
import { BROWSER_CHANNEL, BROWSER_EVENT, browserCreateSchema, browserRequestSchema, browserNavigateSchema, browserMountSchema, browserOpenLinkSchema, browserPageSchema, browserListingSchema, browserOpenResultSchema, browserEventSchema, type BrowserBridge } from '../shared/browser'
import { GIT_CHANGES_CHANNEL, GIT_CHANGES_EVENT, gitActionSchema, gitBranchesSchema, gitCommitDraftRequestSchema, gitCommitDraftSchema, gitDiffRequestSchema, gitWatchRequestSchema, gitListingSchema, gitDiffSchema, gitChangedSchema, type GitChangesBridge } from '../shared/gitChanges'
import type { IpcRendererAdapter } from './index'
import { prReviewRequestSchema, prReviewSchema, prDraftRequestSchema, prDraftSchema, prActionSchema, prActionResultSchema } from '../shared/gitPullRequests'
import { checkpointListingSchema, checkpointRequestSchema, checkpointRevertSchema, checkpointSchema, checkpointInspectionSchema } from '../shared/checkpoints'

export function createToolsBridges(renderer: IpcRendererAdapter): { terminal: TerminalBridge; browser: BrowserBridge; gitChanges: GitChangesBridge } {
  const call = async <T>(channel: string, input: z.ZodType, output: z.ZodType<T>, payload: unknown) => toolsResultSchema(output).parse(await renderer.invoke(channel, input.parse(payload)))
  const subscribe = <T>(channel: string, schema: z.ZodType<T>, listener: (event: T) => void): (() => void) => {
    const wrapped = (_event: unknown, ...args: unknown[]): void => {
      if (args.length !== 1) return
      const result = schema.safeParse(args[0])
      if (result.success) listener(result.data)
    }
    renderer.on(channel, wrapped)
    return () => { renderer.removeListener(channel, wrapped) }
  }
  return {
    terminal: Object.freeze<TerminalBridge>({
      list: request => call(TERMINAL_CHANNEL + 'list', toolListRequestSchema, terminalListingSchema, request),
      create: request => call(TERMINAL_CHANNEL + 'create', terminalCreateSchema, terminalSnapshotSchema, request),
      read: request => call(TERMINAL_CHANNEL + 'read', terminalRequestSchema, terminalSnapshotSchema, request),
      write: request => call(TERMINAL_CHANNEL + 'write', terminalWriteSchema, z.undefined(), request),
      resize: request => call(TERMINAL_CHANNEL + 'resize', terminalResizeSchema, z.undefined(), request),
      interrupt: request => call(TERMINAL_CHANNEL + 'interrupt', terminalRequestSchema, z.undefined(), request),
      close: request => call(TERMINAL_CHANNEL + 'close', terminalRequestSchema, z.undefined(), request),
      reopen: request => call(TERMINAL_CHANNEL + 'reopen', terminalRequestSchema, terminalSnapshotSchema, request),
      onEvent: listener => subscribe(TERMINAL_EVENT, terminalEventSchema, listener),
    }),
    browser: Object.freeze<BrowserBridge>({
      list: request => call(BROWSER_CHANNEL + 'list', toolListRequestSchema, browserListingSchema, request),
      create: request => call(BROWSER_CHANNEL + 'create', browserCreateSchema, browserPageSchema, request),
      navigate: request => call(BROWSER_CHANNEL + 'navigate', browserNavigateSchema, browserPageSchema, request),
      back: request => call(BROWSER_CHANNEL + 'back', browserRequestSchema, browserPageSchema, request),
      forward: request => call(BROWSER_CHANNEL + 'forward', browserRequestSchema, browserPageSchema, request),
      reload: request => call(BROWSER_CHANNEL + 'reload', browserRequestSchema, browserPageSchema, request),
      close: request => call(BROWSER_CHANNEL + 'close', browserRequestSchema, z.undefined(), request),
      mount: request => call(BROWSER_CHANNEL + 'mount', browserMountSchema, z.undefined(), request),
      openLink: request => call(BROWSER_CHANNEL + 'openLink', browserOpenLinkSchema, browserOpenResultSchema, request),
      onEvent: listener => subscribe(BROWSER_EVENT, browserEventSchema, listener),
    }),
    gitChanges: Object.freeze<GitChangesBridge>({
      reviewPullRequest: request => call(GIT_CHANGES_CHANNEL + 'reviewPullRequest', prReviewRequestSchema, prReviewSchema, request),
      draftPullRequestText: request => call(GIT_CHANGES_CHANNEL + 'draftPullRequestText', prDraftRequestSchema, prDraftSchema, request),
      actPullRequest: request => call(GIT_CHANGES_CHANNEL + 'actPullRequest', prActionSchema, prActionResultSchema, request),
      checkpoints: request => call(GIT_CHANGES_CHANNEL + 'checkpoints', toolListRequestSchema, checkpointListingSchema, request),
      inspectCheckpoint: request => call(GIT_CHANGES_CHANNEL + 'inspectCheckpoint', checkpointRequestSchema, checkpointInspectionSchema, request),
      revertCheckpoint: request => call(GIT_CHANGES_CHANNEL + 'revertCheckpoint', checkpointRevertSchema, checkpointSchema, request),
      recoverCheckpoint: request => call(GIT_CHANGES_CHANNEL + 'recoverCheckpoint', checkpointRequestSchema, checkpointSchema, request),
      act: request => call(GIT_CHANGES_CHANNEL + 'act', gitActionSchema, gitListingSchema, request),
      draftCommitMessage: request => call(GIT_CHANGES_CHANNEL + 'draftCommitMessage', gitCommitDraftRequestSchema, gitCommitDraftSchema, request),
      branches: request => call(GIT_CHANGES_CHANNEL + 'branches', toolListRequestSchema, gitBranchesSchema, request),
      list: request => call(GIT_CHANGES_CHANNEL + 'list', toolListRequestSchema, gitListingSchema, request),
      diff: request => call(GIT_CHANGES_CHANNEL + 'diff', gitDiffRequestSchema, gitDiffSchema, request),
      copyPath: request => call(GIT_CHANGES_CHANNEL + 'copyPath', gitDiffRequestSchema, filePathSchema, request),
      reveal: request => call(GIT_CHANGES_CHANNEL + 'reveal', gitDiffRequestSchema, filePathSchema, request),
      watch: request => call(GIT_CHANGES_CHANNEL + 'watch', gitWatchRequestSchema, z.undefined(), request),
      onChanged: listener => subscribe(GIT_CHANGES_EVENT, gitChangedSchema, listener),
    }),
  }
}
