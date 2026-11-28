import { t } from '@lingui/core/macro'
import { z } from 'zod'
import { hostEntityKey, parseHostEntityKey } from '../../shared/clientIdentity'
import {
  SCHEDULED_TASKS_CHANGED, SCHEDULED_TASKS_COMMAND, SCHEDULED_TASKS_READ, scheduledTaskCommandSchema, scheduledTaskResultSchema, scheduledTasksStateSchema,
  type ScheduledTaskCommand, type ScheduledTaskResult, type ScheduledTasksState, type TaskSpec,
} from '../../shared/scheduledTasks'
import { isAuthorizedIpcSender, type IpcMainAdapter, type TrustedIpcSender } from '../ipc/registerIpc'

/** Each call's arguments, checked against schemas built once rather than on every call. */
const noArguments = z.tuple([])
const commandArguments = z.tuple([scheduledTaskCommandSchema])

/** What the window's bridge asks of scheduled tasks in main. */
export interface ScheduledTaskCalls {
  read(): Promise<ScheduledTasksState>
  command(command: ScheduledTaskCommand): Promise<ScheduledTaskResult>
  onChanged(listener: (state: ScheduledTasksState) => void): () => void
}

/**
 * The main window's bridge to scheduled tasks (ADR-0218). The Owl list's startup answer decides whether the handlers
 * exist: stable registers nothing, and no renderer can turn it on. Where this computer hosts no agents there is nothing
 * to run tasks, and the page says so. The window names projects and threads by their host-qualified keys; a task runs on
 * the computer that keeps it, so one naming another machine's is refused. Each answer is checked against its schema on
 * the way out, and none carries a webhook secret.
 */
export function registerScheduledTasksIpc(ipc: IpcMainAdapter, tasks: ScheduledTaskCalls | undefined, senders: () => readonly TrustedIpcSender[],
  localHostId: () => string | undefined, send: (channel: string, payload: unknown) => void): () => void {
  const windowId = (id: string): string => hostEntityKey(localHostId(), id)
  /** This computer's own ID named by a window key, or undefined for one on another machine. */
  const ownId = (key: string): string | undefined => { const parsed = parseHostEntityKey(key); return parsed ? parsed.hostId === localHostId() ? parsed.id : undefined : key }
  const refuse = (): never => { throw new Error(t`Open scheduled tasks in the main Sotto window.`) }

  const ownSpec = (spec: TaskSpec): TaskSpec | undefined => {
    const target = spec.target
    if (target.kind === 'thread') { const threadId = ownId(target.threadId); return threadId ? { ...spec, target: { ...target, threadId } } : undefined }
    const projectId = ownId(target.projectId)
    return projectId ? { ...spec, target: { ...target, projectId } } : undefined
  }
  const windowed = (state: ScheduledTasksState): ScheduledTasksState => ({
    ...state,
    tasks: state.tasks.map(task => ({ ...task, target: task.target.kind === 'thread' ? { ...task.target, threadId: windowId(task.target.threadId) } : { ...task.target, projectId: windowId(task.target.projectId) } })),
    runs: state.runs.map(run => ({ ...run, threadIds: run.threadIds.map(windowId), steps: run.steps.map(step => step.threadId ? { ...step, threadId: windowId(step.threadId) } : step) })),
  })

  ipc.handle(SCHEDULED_TASKS_READ, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) refuse()
    noArguments.parse(args)
    if (!tasks) return scheduledTasksStateSchema.parse(unavailableState())
    return scheduledTasksStateSchema.parse(windowed(await tasks.read()))
  })
  ipc.handle(SCHEDULED_TASKS_COMMAND, async (event, ...args) => {
    if (!isAuthorizedIpcSender(event, senders(), ['main'])) refuse()
    const [command] = commandArguments.parse(args)
    if (!tasks) return scheduledTaskResultSchema.parse({ ok: false, message: unavailableWords() })
    if (command.type !== 'save') return scheduledTaskResultSchema.parse(await tasks.command(command))
    const spec = ownSpec(command.spec)
    if (!spec) return scheduledTaskResultSchema.parse({ ok: false, message: t`A scheduled task runs on the computer that keeps it. Choose a project or thread on this computer. Nothing was saved.` })
    return scheduledTaskResultSchema.parse(await tasks.command({ ...command, spec }))
  })
  const unsubscribe = tasks?.onChanged(state => send(SCHEDULED_TASKS_CHANGED, scheduledTasksStateSchema.parse(windowed(state))))
  return () => {
    unsubscribe?.()
    ipc.removeHandler(SCHEDULED_TASKS_READ); ipc.removeHandler(SCHEDULED_TASKS_COMMAND)
  }
}

function unavailableWords(): string {
  return t`This computer doesn't host agents, so it runs no scheduled tasks. Turn on Run the local host in Settings › Hosts, then restart Sotto.`
}

function unavailableState(): ScheduledTasksState {
  return { available: false, unavailable: unavailableWords(), enabled: false, tasks: [], runs: [], playbooks: [], playbooksFolder: '', webhooks: { listening: false }, credentials: false }
}
