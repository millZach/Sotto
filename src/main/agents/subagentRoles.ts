import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentModel, AgentRuntimeMode } from '../../shared/agents'
import { resolveModel } from '../../shared/modelCatalog'
import { RUNTIME_MODE_ORDER } from '../../shared/newThreadDefaults'
import { capRuntimeMode, roleWork, subagentName, type SubagentRole, type WorkerKind } from '../../shared/workerRoles'
import { compareClientVersions } from './clientVersions'
import type { WorkerRoleSource } from './host'

/**
 * Each provider's own sub-agents follow the worker roles (#1042, ADR-0091). The table itself is `workerRoles.ts`'s; this
 * module turns it into what each client takes at a thread's launch: Claude Code's agent definitions and Codex's role
 * files. Neither holds prompt text, and nothing here logs more than a stable event name.
 */

/** The role table for every adapter on this computer, read when a thread launches and offered again when Settings change. */
export class WorkerRoles implements WorkerRoleSource {
  private readonly listeners = new Set<() => void>()
  constructor(private readonly read: () => readonly SubagentRole[]) {}
  table(): readonly SubagentRole[] { return this.read() }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  /** The user's Settings changed: whoever keeps role files writes them again. */
  changed(): void {
    for (const listener of this.listeners) {
      try { listener() } catch { /* One adapter's failure leaves the others' files current. */ }
    }
  }
}

/** Whether `mode` lets less happen without asking than `than`. */
export function narrowerMode(mode: AgentRuntimeMode, than: AgentRuntimeMode): boolean {
  return RUNTIME_MODE_ORDER.indexOf(mode) < RUNTIME_MODE_ORDER.indexOf(than)
}
/** A role's permission as one thread's sub-agent may have it: never wider than the thread's own (ADR-0004). */
export function subagentMode(role: SubagentRole, threadMode: AgentRuntimeMode): AgentRuntimeMode {
  return capRuntimeMode(role.runtimeMode ?? threadMode, threadMode)
}
/** What a role's sub-agent is told about itself: its kind of work and that it reports back. Never the user's words. */
function roleBrief(role: SubagentRole): string {
  return `You are the ${role.name} worker a Sotto thread started for one part of its work: ${roleWork(role)}. Do the task you were given, then report plainly what you did and what you found.`
}
/** The adapter's own catalog entry for a role's model, when it is ready; a long-context variant is its base model's. */
const ready = (models: readonly AgentModel[], role: SubagentRole): AgentModel | undefined => {
  const model = resolveModel(models, role.model)
  return model?.ready ? model : undefined
}
/** The effort a model offers, as its client takes it; undefined when it offers none or not this one. */
const offered = (model: AgentModel, effort: string | null): string | null | undefined =>
  effort === null ? null : model.reasoningEfforts?.includes(effort) ? effort : undefined

/** One of Claude Code's agent definitions (`AgentDefinition`, `sdk.d.ts`), as `initialize` takes them. */
export interface ClaudeSubagent {
  readonly description: string
  readonly prompt: string
  readonly model: string
  readonly effort?: string
  readonly permissionMode: string
}
const CLAUDE_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
/**
 * One agent per role whose model is a ready Claude model, each held to the thread's own permission. Undefined when no
 * role runs on Claude Code. `modes` is the adapter's own mapping to Claude Code's permission modes.
 */
export function claudeSubagents(table: readonly SubagentRole[], threadMode: AgentRuntimeMode, models: readonly AgentModel[],
  modes: Readonly<Record<AgentRuntimeMode, string>>): { agents: Record<string, ClaudeSubagent>; kinds: ReadonlySet<WorkerKind>; widest: AgentRuntimeMode } | undefined {
  const agents: Record<string, ClaudeSubagent> = {}, kinds = new Set<WorkerKind>()
  let widest: AgentRuntimeMode = 'approval-required'
  for (const role of table) {
    if (role.provider !== 'claude') continue
    const model = ready(models, role)
    const effort = model ? offered(model, role.reasoningEffort) : undefined
    if (!model || effort === undefined || effort !== null && !CLAUDE_EFFORTS.has(effort)) continue
    const mode = subagentMode(role, threadMode)
    if (narrowerMode(widest, mode)) widest = mode
    agents[subagentName(role.kind)] = { description: `${role.name} work: ${roleWork(role)}. Use this agent for that kind of work.`, prompt: roleBrief(role),
      model: role.model, ...(effort ? { effort } : {}), permissionMode: modes[mode] }
    kinds.add(role.kind)
  }
  return kinds.size ? { agents, kinds, widest } : undefined
}

/** The Codex the per-thread agent roles were checked on (codex-roles check, October 14, 2026). */
export const CODEX_ROLES_SINCE = '0.162.1'
/**
 * Whether this Codex takes Sotto's role files. One older than the checked version, or one whose version cannot be read,
 * gets none: its threads are told to name the model and effort in `spawn_agent` instead.
 */
export function codexTakesRoles(version: string | undefined): boolean {
  const found = /\d+\.\d+\.\d+/u.exec(version ?? '')?.[0]
  return found !== undefined && compareClientVersions(found, CODEX_ROLES_SINCE) >= 0
}
/** Codex's sandbox and approval settings for one of Sotto's modes, as the adapter starts a thread on them. */
export interface CodexPolicy { readonly approvalPolicy: string; readonly approvalsReviewer: string; readonly sandbox: string }
/** One `agents.<name>` entry: Codex reads the role's settings from its `config_file`, never inline. */
export interface CodexRoleEntry { readonly description: string; readonly config_file: string }
export type CodexRoleFilesEvent = 'codex-role-file-failed'
const toml = (value: string): string => JSON.stringify(value)
/** A role file's text: a config layer Codex applies to the sub-agent (codex-roles check, October 14). */
export function codexRoleFile(role: SubagentRole, effort: string | null, policy: CodexPolicy): string {
  return [`model = ${toml(role.model)}`, ...(effort ? [`model_reasoning_effort = ${toml(effort)}`] : []),
    `sandbox_mode = ${toml(policy.sandbox)}`, `approval_policy = ${toml(policy.approvalPolicy)}`, `approvals_reviewer = ${toml(policy.approvalsReviewer)}`,
    `developer_instructions = ${toml(roleBrief(role))}`, ''].join('\n')
}

/**
 * Sotto's own Codex role files, under its data folder (`codex-roles/<mode>/sotto_<role>.toml`), never the user's
 * `~/.codex` and never `config.toml`. One folder per permission, so a thread is only ever pointed at files no wider than
 * its own. A launch writes what changed; a Settings change rewrites every folder already in use.
 */
export class CodexRoleFiles {
  private readonly modes = new Set<AgentRuntimeMode>()
  private writing: Promise<unknown> = Promise.resolve()
  constructor(private readonly folder: string, private readonly policy: (mode: AgentRuntimeMode) => CodexPolicy, private readonly log?: (event: CodexRoleFilesEvent) => void) {}
  /**
   * The roles on a ready Codex model, written for a thread on `threadMode`, and the entries that point Codex at them.
   * A role whose model is not ready, whose effort the model does not offer, or whose file could not be written is left out.
   */
  async write(table: readonly SubagentRole[], threadMode: AgentRuntimeMode, models: readonly AgentModel[]): Promise<{ agents: Record<string, CodexRoleEntry>; kinds: ReadonlySet<WorkerKind>; widest: AgentRuntimeMode } | undefined> {
    const work = this.writing.catch(() => undefined).then(() => this.writeNow(table, threadMode, models))
    this.writing = work
    return work
  }
  /** Settings changed: every folder a thread was pointed at gets the new table, for each thread's next load. */
  rewrite(table: readonly SubagentRole[], models: readonly AgentModel[]): Promise<void> {
    const work = this.writing.catch(() => undefined).then(async () => { for (const mode of [...this.modes]) await this.writeNow(table, mode, models) })
    this.writing = work
    return work
  }
  private async writeNow(table: readonly SubagentRole[], threadMode: AgentRuntimeMode, models: readonly AgentModel[]) {
    const agents: Record<string, CodexRoleEntry> = {}, kinds = new Set<WorkerKind>()
    let widest: AgentRuntimeMode = 'approval-required'
    const folder = join(this.folder, threadMode)
    for (const role of table) {
      if (role.provider !== 'codex') continue
      const model = ready(models, role)
      const effort = model ? offered(model, role.reasoningEffort) : undefined
      if (!model || effort === undefined) continue
      const mode = subagentMode(role, threadMode)
      const name = subagentName(role.kind), file = join(folder, `${name}.toml`)
      try { await this.place(folder, file, codexRoleFile(role, effort, this.policy(mode))) }
      catch { this.log?.('codex-role-file-failed'); continue }
      if (narrowerMode(widest, mode)) widest = mode
      agents[name] = { description: `${role.name} work: ${roleWork(role)}.`, config_file: file }
      kinds.add(role.kind)
    }
    this.modes.add(threadMode)
    return kinds.size ? { agents, kinds, widest } : undefined
  }
  /** Written whole and moved into place, so Codex never reads half a file; an unchanged file is left alone. */
  private async place(folder: string, file: string, text: string): Promise<void> {
    if (await readFile(file, 'utf8').catch(() => undefined) === text) return
    await mkdir(folder, { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    try { await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 }); await rename(temporary, file) }
    catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error }
  }
}

/** Codex's own words for one of Sotto's roles it dropped (codex-roles check): Sotto wrote that file, so the fault is Sotto's. */
export function malformedCodexRole(method: string | undefined, params: unknown): boolean {
  if (method !== 'warning' || typeof params !== 'object' || params === null) return false
  const message = (params as { message?: unknown }).message
  return typeof message === 'string' && message.startsWith('Ignoring malformed agent role definition') && message.includes('sotto_')
}
