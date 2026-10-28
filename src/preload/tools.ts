import { z } from 'zod'
import { filePathSchema } from '../shared/files'
import { toolListRequestSchema, toolTargetSchema, toolsResultSchema } from '../shared/tools'
import { TERMINAL_CHANNEL, TERMINAL_EVENT, terminalCreateSchema, terminalRequestSchema, terminalWriteSchema, terminalResizeSchema, terminalImageSchema, terminalSnapshotSchema, terminalListingSchema, terminalListRequestSchema, terminalEventSchema, type TerminalBridge } from '../shared/terminal'
import { BROWSER_CHANNEL, BROWSER_EVENT, browserCreateSchema, browserRequestSchema, browserNavigateSchema, browserMountSchema, browserOpenLinkSchema, browserPageSchema, browserListingSchema, browserOpenResultSchema, browserEventSchema, browserTaskSchema, browserShareSchema, browserControlTaskSchema, browserAnswerActionSchema, browserViewportSchema, browserCaptureSchema, browserCaptureResultSchema, browserPointModeSchema, type BrowserBridge } from '../shared/browser'
import { GIT_CHANGES_CHANNEL, GIT_CHANGES_EVENT, gitPathRequestSchema, gitReviewRequestSchema, gitReviewSchema, gitWatchRequestSchema, gitListingSchema, gitChangedSchema, type GitChangesBridge } from '../shared/gitChanges'
import type { IpcRendererAdapter } from './index'
import { checkpointListingSchema, checkpointRequestSchema, checkpointRevertSchema, checkpointSchema, checkpointInspectionSchema } from '../shared/checkpoints'

/** Each channel's answer, built once: building a schema costs far more than parsing with one. */
const voidResult = toolsResultSchema(z.undefined())
const focusedSchema = z.boolean()
const terminalListingResult = toolsResultSchema(terminalListingSchema)
const terminalSnapshotResult = toolsResultSchema(terminalSnapshotSchema)
const browserTasksResult = toolsResultSchema(z.array(browserTaskSchema).max(64))
const browserTaskResult = toolsResultSchema(browserTaskSchema)
const browserPageResult = toolsResultSchema(browserPageSchema)
const browserCaptureResult = toolsResultSchema(browserCaptureResultSchema)
const browserPointResult = toolsResultSchema(z.object({ pointing: z.boolean() }).strict())
const browserListingResult = toolsResultSchema(browserListingSchema)
const browserOpenResult = toolsResultSchema(browserOpenResultSchema)
const checkpointListingResult = toolsResultSchema(checkpointListingSchema)
const checkpointInspectionResult = toolsResultSchema(checkpointInspectionSchema)
const checkpointResult = toolsResultSchema(checkpointSchema)
const gitListingResult = toolsResultSchema(gitListingSchema)
const gitReviewResult = toolsResultSchema(gitReviewSchema)
const filePathResult = toolsResultSchema(filePathSchema)

export function createToolsBridges(renderer: IpcRendererAdapter): { terminal: TerminalBridge; browser: BrowserBridge; gitChanges: GitChangesBridge } {
  const call = async <Result extends z.ZodType>(channel: string, input: z.ZodType, result: Result, payload: unknown): Promise<z.output<Result>> => result.parse(await renderer.invoke(channel, input.parse(payload)))
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
      list: request => call(TERMINAL_CHANNEL + 'list', terminalListRequestSchema, terminalListingResult, request),
      create: request => call(TERMINAL_CHANNEL + 'create', terminalCreateSchema, terminalSnapshotResult, request),
      read: request => call(TERMINAL_CHANNEL + 'read', terminalRequestSchema, terminalSnapshotResult, request),
      write: request => call(TERMINAL_CHANNEL + 'write', terminalWriteSchema, voidResult, request),
      resize: request => call(TERMINAL_CHANNEL + 'resize', terminalResizeSchema, voidResult, request),
      interrupt: request => call(TERMINAL_CHANNEL + 'interrupt', terminalRequestSchema, voidResult, request),
      close: request => call(TERMINAL_CHANNEL + 'close', terminalRequestSchema, voidResult, request),
      reopen: request => call(TERMINAL_CHANNEL + 'reopen', terminalRequestSchema, terminalSnapshotResult, request),
      pasteImage: request => call(TERMINAL_CHANNEL + 'pasteImage', terminalImageSchema, voidResult, request),
      setFocused: focused => call(TERMINAL_CHANNEL + 'focus', focusedSchema, voidResult, focused),
      onEvent: listener => subscribe(TERMINAL_EVENT, terminalEventSchema, listener),
    }),
    browser: Object.freeze<BrowserBridge>({
      tasks: request => call(BROWSER_CHANNEL + 'tasks', toolListRequestSchema, browserTasksResult, request),
      share: request => call(BROWSER_CHANNEL + 'share', browserShareSchema, browserPageResult, request),
      controlTask: request => call(BROWSER_CHANNEL + 'controlTask', browserControlTaskSchema, browserTaskResult, request),
      answerAction: request => call(BROWSER_CHANNEL + 'answerAction', browserAnswerActionSchema, browserTaskResult, request),
      stopGrant: request => call(BROWSER_CHANNEL + 'stopGrant', toolTargetSchema, voidResult, request),
      viewport: request => call(BROWSER_CHANNEL + 'viewport', browserViewportSchema, browserPageResult, request),
      capture: request => call(BROWSER_CHANNEL + 'capture', browserCaptureSchema, browserCaptureResult, request),
      point: request => call(BROWSER_CHANNEL + 'point', browserPointModeSchema, browserPointResult, request),
      list: request => call(BROWSER_CHANNEL + 'list', toolListRequestSchema, browserListingResult, request),
      create: request => call(BROWSER_CHANNEL + 'create', browserCreateSchema, browserPageResult, request),
      navigate: request => call(BROWSER_CHANNEL + 'navigate', browserNavigateSchema, browserPageResult, request),
      back: request => call(BROWSER_CHANNEL + 'back', browserRequestSchema, browserPageResult, request),
      forward: request => call(BROWSER_CHANNEL + 'forward', browserRequestSchema, browserPageResult, request),
      reload: request => call(BROWSER_CHANNEL + 'reload', browserRequestSchema, browserPageResult, request),
      close: request => call(BROWSER_CHANNEL + 'close', browserRequestSchema, voidResult, request),
      mount: request => call(BROWSER_CHANNEL + 'mount', browserMountSchema, voidResult, request),
      openLink: request => call(BROWSER_CHANNEL + 'openLink', browserOpenLinkSchema, browserOpenResult, request),
      onEvent: listener => subscribe(BROWSER_EVENT, browserEventSchema, listener),
    }),
    gitChanges: Object.freeze<GitChangesBridge>({
      checkpoints: request => call(GIT_CHANGES_CHANNEL + 'checkpoints', toolListRequestSchema, checkpointListingResult, request),
      inspectCheckpoint: request => call(GIT_CHANGES_CHANNEL + 'inspectCheckpoint', checkpointRequestSchema, checkpointInspectionResult, request),
      revertCheckpoint: request => call(GIT_CHANGES_CHANNEL + 'revertCheckpoint', checkpointRevertSchema, checkpointResult, request),
      recoverCheckpoint: request => call(GIT_CHANGES_CHANNEL + 'recoverCheckpoint', checkpointRequestSchema, checkpointResult, request),
      list: request => call(GIT_CHANGES_CHANNEL + 'list', toolListRequestSchema, gitListingResult, request),
      review: request => call(GIT_CHANGES_CHANNEL + 'review', gitReviewRequestSchema, gitReviewResult, request),
      copyPath: request => call(GIT_CHANGES_CHANNEL + 'copyPath', gitPathRequestSchema, filePathResult, request),
      reveal: request => call(GIT_CHANGES_CHANNEL + 'reveal', gitPathRequestSchema, filePathResult, request),
      watch: request => call(GIT_CHANGES_CHANNEL + 'watch', gitWatchRequestSchema, voidResult, request),
      onChanged: listener => subscribe(GIT_CHANGES_EVENT, gitChangedSchema, listener),
    }),
  }
}
