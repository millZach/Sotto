import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { agentCommandSchema, type AgentCommand, type AgentHostSnapshot, type AgentModel } from '../../shared/agents'
import { agentOwletSchema, OWLET_REFUSALS, OWLETS_FOLDER, owletNameProblem, owletProviderAllowed, sameOwletName, type AgentOwlet } from '../../shared/owlets'
import { resolveModel } from '../../shared/modelCatalog'
import { projectFolderKey } from './projectFolders'
import type { AgentHost } from './host'

/**
 * Owlets on this host (ADR-0210): the checks a new or changed owlet passes, and the folder each one lives in. The
 * coordinator runs the commands; this module says what they may do.
 */

/** Where this host keeps every owlet's folder: `owlets` in its data folder, beside Watcher's own workspace. */
export const owletsRoot = (directory: string): string => resolve(join(directory, OWLETS_FOLDER))
/** One owlet's folder, named as the owlet was when it was made. */
export const owletFolder = (directory: string, name: string): string => join(owletsRoot(directory), name)

/**
 * Whether a working folder is inside an owlet's folder, so its provider starts with its own memory off (ADR-0210,
 * decision 4). Every thread working there gets it, whether or not it is the owlet's own.
 */
export function inOwletFolder(directory: string, folder: string | undefined): boolean {
  if (!folder) return false
  const fold = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path
  const path = relative(fold(owletsRoot(directory)), fold(resolve(folder)))
  return path !== '' && !path.startsWith('..') && !isAbsolute(path)
}

type OwletCreate = Extract<AgentCommand, { type: 'create-owlet' }>
type OwletChange = Extract<AgentCommand, { type: 'set-owlet' }>
type Snapshot = Pick<AgentHostSnapshot, 'threads' | 'projects'>

const refuse = (why: keyof typeof OWLET_REFUSALS): never => { throw new Error(OWLET_REFUSALS[why]) }

/** The name and role a command gives, checked, or an error that says what to change. Nothing is made. */
function owletOf(name: string, role: string): AgentOwlet {
  const problem = owletNameProblem(name)
  if (problem) refuse(problem)
  const parsed = agentOwletSchema.safeParse({ name, role })
  return parsed.success ? parsed.data : refuse('role')
}

/** The name an owlet's folder was made with: its project's, which a rename leaves as it was. */
const folderName = (snapshot: Snapshot, projectId: string): string => snapshot.projects.find(project => project.id === projectId)?.title ?? ''

/** A name no other owlet here has; for a new owlet, no other owlet's folder has it either, since a rename keeps the folder. */
function assertNameFree(snapshot: Snapshot, name: string, except?: string, folder = false): void {
  if (snapshot.threads.some(thread => thread.id !== except && thread.owlet
    && (sameOwletName(thread.owlet.name, name) || folder && sameOwletName(folderName(snapshot, thread.projectId), name)))) refuse('taken')
}

/** A new owlet's record and model, once the command passes every check that needs no folder. */
export function checkOwletCreate(snapshot: Snapshot & Pick<AgentHostSnapshot, 'models'>, command: OwletCreate): { owlet: AgentOwlet; model: AgentModel } {
  const owlet = owletOf(command.name, command.role)
  if (snapshot.threads.some(thread => thread.id === command.threadId)) refuse('exists')
  assertNameFree(snapshot, owlet.name, undefined, true)
  const model = resolveModel(snapshot.models, command.modelId)
  if (!model || !owletProviderAllowed(model.providerId)) return refuse('provider')
  return { owlet, model }
}

/** An owlet's changed name and role, keeping what the command leaves out. */
export function checkOwletChange(snapshot: Snapshot, command: OwletChange): AgentOwlet {
  const current = snapshot.threads.find(item => item.id === command.threadId)?.owlet ?? refuse('notOwlet')
  const owlet = owletOf(command.name ?? current.name, command.role ?? current.role)
  assertNameFree(snapshot, owlet.name, command.threadId)
  return owlet
}

/** Makes an owlet's folder before its project is added there; an existing one is used as it is. */
export async function makeOwletFolder(directory: string, name: string): Promise<string> {
  const folder = owletFolder(directory, name)
  await mkdir(folder, { recursive: true })
  return folder
}

/** What `makeOwlet` asks of the coordinator on its host. */
export interface OwletMaker {
  readonly enabled: boolean
  /** The host's data folder, where `owlets` is. */
  readonly directory: string
  host(): Snapshot & Pick<AgentHostSnapshot, 'models'>
  /** Throws when the user who asked may not start a thread in the mode the command names. */
  permit(model: AgentModel): void
  /** Runs one of the owlet's own commands as the user's, quietly; resolves with its refusal, or null. */
  admit(command: AgentCommand, owlet?: AgentOwlet): Promise<string | null>
  /** The names of the owlets being made on this host now, folded as `sameOwletName` folds them, so two made at once can't share one. */
  readonly making: Set<string>
}

/**
 * Makes an owlet (ADR-0210): its folder, the project for that folder, then its one thread there with a shared working copy,
 * marked with its name and role. Resolves with what to tell the user when it refused or stopped part way, or null.
 */
export async function makeOwlet(maker: OwletMaker, command: OwletCreate): Promise<string | null> {
  try {
    if (!maker.enabled) refuse('off')
    const { owlet, model } = checkOwletCreate(maker.host(), command)
    maker.permit(model)
    const key = owlet.name.toLocaleLowerCase()
    if (maker.making.has(key)) refuse('taken')
    maker.making.add(key)
    try { await makeIt(maker, command, owlet, model) } finally { maker.making.delete(key) }
    return null
  } catch (error) { return error instanceof Error ? error.message : 'The owlet could not be made.' }
}

async function makeIt(maker: OwletMaker, command: OwletCreate, owlet: AgentOwlet, model: AgentModel): Promise<void> {
  const admit = async (next: AgentCommand, made?: AgentOwlet): Promise<void> => { const refused = await maker.admit(next, made); if (refused) throw new Error(refused) }
  const path = await makeOwletFolder(maker.directory, owlet.name)
  await admit(agentCommandSchema.parse({ type: 'create-project', provider: model.providerId, title: owlet.name, path, useExisting: true }))
  const project = maker.host().projects.find(item => projectFolderKey(item.path) === projectFolderKey(path) && (!item.providerId || item.providerId === model.providerId))
  if (!project) refuse('noProject')
  await admit(agentCommandSchema.parse({ type: 'create-thread', threadId: command.threadId, projectId: project!.id, title: owlet.name, titleSource: 'user', modelId: command.modelId,
    workingCopy: 'shared', ...(command.reasoningEffort ? { reasoningEffort: command.reasoningEffort } : {}),
    ...(command.runtimeMode ? { runtimeMode: command.runtimeMode } : {}), ...(command.providerMode ? { providerMode: command.providerMode } : {}) }), owlet)
}

/** An owlet's new name and role on its thread (ADR-0210), in the thread's own lane; throws with what to tell the user. */
export async function changeOwlet(enabled: boolean, snapshot: Snapshot, host: Pick<AgentHost, 'setThreadOwlet'>, command: OwletChange): Promise<AgentHostSnapshot> {
  if (!enabled) refuse('off')
  const owlet = checkOwletChange(snapshot, command)
  if (!host.setThreadOwlet) return refuse('unavailable')
  return host.setThreadOwlet(command.threadId, owlet)
}

/**
 * Whether a model change keeps an owlet on a provider whose own memory Sotto turns off (ADR-0210, decision 5): throws with
 * what to tell the user when it would not.
 */
export function assertOwletModel(thread: { readonly owlet?: AgentOwlet | undefined }, model: AgentModel | undefined): void {
  if (thread.owlet && !owletProviderAllowed(model?.providerId)) refuse('provider')
}

/**
 * Where Owlets are off (ADR-0210): every owlet's thread left out and counted in `dormant`, so commands naming it are refused.
 * A snapshot with no owlet comes back as it was, so the update path copies nothing on its account.
 */
export function withoutOwletThreads(snapshot: AgentHostSnapshot, dormant: Set<string>): AgentHostSnapshot {
  let some = false
  for (const thread of snapshot.threads) if (thread.owlet) { some = true; dormant.add(thread.id) }
  if (!some) return snapshot
  // An owlet's folder goes with it; a project another thread works in stays.
  const threads = snapshot.threads.filter(thread => !thread.owlet), kept = new Set(threads.map(thread => thread.projectId))
  const gone = new Set(snapshot.threads.filter(thread => thread.owlet && !kept.has(thread.projectId)).map(thread => thread.projectId))
  return { ...snapshot, threads, projects: snapshot.projects.filter(project => !gone.has(project.id)) }
}
