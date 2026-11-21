import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { agentCommandSchema, type AgentCommand, type AgentHostSnapshot, type AgentModel } from '../../shared/agents'
import { agentOwletSchema, OWLETS_FOLDER, OWLETS_PER_HOST_MAX, owletNameProblem, owletProviderAllowed, sameOwletName, type AgentOwlet } from '../../shared/owlets'
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

/** The name and role a command gives, checked, or an error that says what to change. Nothing is made. */
function owletOf(name: string, role: string): AgentOwlet {
  const problem = owletNameProblem(name)
  if (problem) throw new Error(`${problem} Nothing was changed.`)
  const parsed = agentOwletSchema.safeParse({ name, role })
  if (!parsed.success) throw new Error('Keep the role to 200 characters. Nothing was changed.')
  return parsed.data
}

function assertNameFree(snapshot: Pick<AgentHostSnapshot, 'threads'>, name: string, except?: string): void {
  if (snapshot.threads.some(thread => thread.id !== except && thread.owlet && sameOwletName(thread.owlet.name, name))) {
    throw new Error(`An owlet on this computer is already called ${name}. Choose another name. Nothing was changed.`)
  }
}

/** A new owlet's record and model, once the command passes every check that needs no folder. */
export function checkOwletCreate(snapshot: Pick<AgentHostSnapshot, 'threads' | 'models'>, command: OwletCreate): { owlet: AgentOwlet; model: AgentModel } {
  const owlet = owletOf(command.name, command.role)
  if (snapshot.threads.some(thread => thread.id === command.threadId)) throw new Error('This owlet already exists. Nothing was made.')
  if (snapshot.threads.filter(thread => thread.owlet).length >= OWLETS_PER_HOST_MAX) throw new Error(`This computer has ${OWLETS_PER_HOST_MAX} owlets, the most it keeps. Nothing was made.`)
  assertNameFree(snapshot, owlet.name)
  const model = resolveModel(snapshot.models, command.modelId)
  if (!model || !owletProviderAllowed(model.providerId)) throw new Error('An owlet runs on Claude Code or Codex. Choose one of their models. Nothing was made.')
  return { owlet, model }
}

/** An owlet's changed name and role, keeping what the command leaves out. */
export function checkOwletChange(snapshot: Pick<AgentHostSnapshot, 'threads'>, command: OwletChange): AgentOwlet {
  const thread = snapshot.threads.find(item => item.id === command.threadId)
  if (!thread?.owlet) throw new Error('This thread is not an owlet. Nothing changed.')
  const owlet = owletOf(command.name ?? thread.owlet.name, command.role ?? thread.owlet.role)
  assertNameFree(snapshot, owlet.name, thread.id)
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
  host(): Pick<AgentHostSnapshot, 'threads' | 'models' | 'projects'>
  /** Throws when the user who asked may not start a thread in the mode the command names. */
  permit(model: AgentModel): void
  /** Runs one of the owlet's own commands as the user's, quietly; resolves with its refusal, or null. */
  admit(command: AgentCommand, owlet?: AgentOwlet): Promise<string | null>
}

/**
 * Makes an owlet (ADR-0210): its folder, the project for that folder, then its one thread there with a shared working copy,
 * marked with its name and role. Resolves with what to tell the user when it refused or stopped part way, or null.
 */
export async function makeOwlet(maker: OwletMaker, command: OwletCreate): Promise<string | null> {
  try {
    if (!maker.enabled) throw new Error('Owlets are available in Sotto Owl. Nothing was made.')
    const { owlet, model } = checkOwletCreate(maker.host(), command)
    maker.permit(model)
    const admit = async (next: AgentCommand, made?: AgentOwlet): Promise<void> => { const refused = await maker.admit(next, made); if (refused) throw new Error(refused) }
    const path = await makeOwletFolder(maker.directory, owlet.name)
    await admit(agentCommandSchema.parse({ type: 'create-project', provider: model.providerId, title: owlet.name, path, useExisting: true }))
    const project = maker.host().projects.find(item => projectFolderKey(item.path) === projectFolderKey(path) && (!item.providerId || item.providerId === model.providerId))
    if (!project) throw new Error('The owlet\'s folder did not appear as a project. Its folder was kept. Try again.')
    await admit(agentCommandSchema.parse({ type: 'create-thread', threadId: command.threadId, projectId: project.id, title: owlet.name, titleSource: 'user', modelId: command.modelId,
      workingCopy: 'shared', ...(command.reasoningEffort ? { reasoningEffort: command.reasoningEffort } : {}),
      ...(command.runtimeMode ? { runtimeMode: command.runtimeMode } : {}), ...(command.providerMode ? { providerMode: command.providerMode } : {}) }), owlet)
    return null
  } catch (error) { return error instanceof Error ? error.message : 'The owlet could not be made.' }
}

/** An owlet's new name and role on its thread (ADR-0210), in the thread's own lane; throws with what to tell the user. */
export async function changeOwlet(enabled: boolean, snapshot: Pick<AgentHostSnapshot, 'threads'>, host: Pick<AgentHost, 'setThreadOwlet'>, command: OwletChange): Promise<AgentHostSnapshot> {
  if (!enabled) throw new Error('Owlets are available in Sotto Owl. Nothing changed.')
  const owlet = checkOwletChange(snapshot, command)
  if (!host.setThreadOwlet) throw new Error('Owlets are unavailable on this computer. Nothing changed.')
  return host.setThreadOwlet(command.threadId, owlet)
}

/**
 * Where Owlets are off (ADR-0210): every owlet's thread left out and counted in `dormant`, so commands naming it are refused.
 * A snapshot with no owlet comes back as it was, so the update path copies nothing on its account.
 */
export function withoutOwletThreads(snapshot: AgentHostSnapshot, dormant: Set<string>): AgentHostSnapshot {
  let some = false
  for (const thread of snapshot.threads) if (thread.owlet) { some = true; dormant.add(thread.id) }
  return some ? { ...snapshot, threads: snapshot.threads.filter(thread => !thread.owlet) } : snapshot
}
