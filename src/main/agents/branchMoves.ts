import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import type { AgentState } from '../../shared/agents'
import {
  branchMoveRefusal, branchMoveWords, branchReceiveBeginAnswerSchema, branchReceiveChunkAnswerSchema, branchReceiveFinishAnswerSchema,
  branchSendBeginAnswerSchema, branchSendChunkAnswerSchema, branchTipsAnswerSchema, type BranchMoveReceipt, type BranchMoveRefusal, type HostBranchMoveRequest,
} from '../../shared/branchMoves'
import { BranchBundles, IncomingBundle, type PreparedBundle } from './branchBundles'

/**
 * Branch moves between this desktop and a host it is connected to (ADR-0082, amended by ADR-0105 decision 8), with the
 * desktop as the only caller. The branch travels as a Git bundle in chunks over the host socket the desktop already keeps,
 * so no move opens an SSH session, and nothing touches GitHub. Each move ends in a receipt: the incoming ref it landed
 * in, or a refusal in plain words that says nothing moved. Starting a worker from the moved branch is the next step's.
 *
 * An Owl feature (`cross-machine-work`, ADR-0072): `desktopBranchMoves` makes nothing on stable, so a stable desktop
 * neither offers nor uses a move, whatever a host lists.
 */

/** Where a thread works and where a project lives, by Sotto's own IDs (ADR-0002). */
export interface BranchMoveFolders {
  threadFolder(threadId: string): string | undefined
  projectFolder(projectId: string): string | undefined
}

/** Folders read from a state as its owner last published it, without copying it. */
export function foldersOf(view: () => AgentState): BranchMoveFolders {
  return {
    projectFolder: projectId => view().host.projects.find(project => project.id === projectId)?.path || undefined,
    threadFolder: threadId => {
      const state = view()
      const thread = state.host.threads.find(item => item.id === threadId)
      if (!thread) return undefined
      return thread.workingDirectory || state.host.projects.find(project => project.id === thread.projectId)?.path || undefined
    },
  }
}

/** The part of a connected host's socket a move uses (`SocketHostService`). */
export interface BranchMoveHost {
  readonly supportsBranchMoves: boolean
  branchMove(request: HostBranchMoveRequest): Promise<unknown>
}

export interface DesktopBranchMovesOptions {
  readonly bundles: BranchBundles
  /** This computer's own threads and projects. */
  readonly folders: BranchMoveFolders
  /** The host with this host ID while the desktop is connected to it. */
  readonly host: (hostId: string) => BranchMoveHost | undefined
  /** The host's name as this computer saved it, for the words. */
  readonly hostName: (hostId: string) => string
  readonly newMoveId?: () => string
}

/** Read through `schema`; anything else from the host is a transfer that did not go through. */
function answer<T>(schema: z.ZodType<T>, value: unknown): T | BranchMoveRefusal {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : branchMoveRefusal('failed', branchMoveWords.failed)
}
const refused = (value: { type: string }): value is BranchMoveRefusal => value.type === 'refused'

export class DesktopBranchMoves {
  constructor(private readonly options: DesktopBranchMovesOptions) {}

  private connected(hostId: string): { readonly host: BranchMoveHost } | BranchMoveRefusal {
    const host = this.options.host(hostId)
    if (!host) return branchMoveRefusal('unsupported', branchMoveWords.notConnected(this.options.hostName(hostId)))
    if (!host.supportsBranchMoves) return branchMoveRefusal('unsupported', branchMoveWords.olderHost(this.options.hostName(hostId)))
    return { host }
  }

  /**
   * Moves a thread's branch on this computer to a project on a host: the thread's working copy is checked, its branch is
   * bundled against the host's own tips, and the host lands it in `refs/sotto/incoming/<move>/<branch>`. A move ID that is
   * given again retries that move, and answers as done when it already landed.
   */
  async toHost(input: { readonly threadId: string; readonly hostId: string; readonly projectId: string; readonly moveId?: string }): Promise<BranchMoveReceipt> {
    const connection = this.connected(input.hostId)
    if ('type' in connection) return connection
    const { host } = connection
    const folder = this.options.folders.threadFolder(input.threadId)
    if (!folder) return branchMoveRefusal('unknown-thread', branchMoveWords.unknownThread)
    const source = await this.options.bundles.branchOf(folder)
    if ('type' in source) return source
    const moveId = input.moveId ?? this.options.newMoveId?.() ?? randomUUID()
    let staged: PreparedBundle | undefined
    try {
      const tips = answer(branchTipsAnswerSchema, await host.branchMove({ action: 'tips', projectId: input.projectId }))
      if (refused(tips)) return tips
      const prepared = await this.options.bundles.prepare({ repository: folder, moveId, commit: source.commit, bases: tips.tips })
      if (prepared.type !== 'sending') return prepared
      staged = prepared
      const begun = answer(branchReceiveBeginAnswerSchema, await host.branchMove({ action: 'receive-begin', moveId, projectId: input.projectId,
        branch: source.branch, commit: source.commit, size: prepared.size, sha256: prepared.sha256 }))
      if (begun.type !== 'receiving') return begun
      for (let offset = 0; offset < prepared.size;) {
        const chunk = await this.options.bundles.readChunk(prepared.path, offset)
        if (chunk.byteLength === 0) return await this.ended(host, moveId, branchMoveRefusal('failed', branchMoveWords.failed))
        const received = answer(branchReceiveChunkAnswerSchema, await host.branchMove({ action: 'receive-chunk', moveId, offset, data: chunk.toString('base64') }))
        if (refused(received)) return await this.ended(host, moveId, received)
        offset += chunk.byteLength
      }
      return answer(branchReceiveFinishAnswerSchema, await host.branchMove({ action: 'receive-finish', moveId }))
    } catch {
      // The connection dropped or the host did not answer: the host discards what it staged when the connection goes, and
      // is asked to now in case it has not gone.
      return await this.ended(host, moveId, branchMoveRefusal('cut-off', branchMoveWords.cutOff))
    } finally { if (staged) await this.options.bundles.discard(staged) }
  }

  /**
   * Moves a host thread's branch to a project on this computer: the host checks the thread's working copy and bundles its
   * branch against this repository's tips, and this computer lands it in `refs/sotto/incoming/<move>/<branch>`.
   */
  async fromHost(input: { readonly hostId: string; readonly threadId: string; readonly projectId: string; readonly moveId?: string }): Promise<BranchMoveReceipt> {
    const connection = this.connected(input.hostId)
    if ('type' in connection) return connection
    const { host } = connection
    const folder = this.options.folders.projectFolder(input.projectId)
    if (!folder) return branchMoveRefusal('unknown-project', branchMoveWords.unknownProject)
    const tips = await this.options.bundles.tips(folder)
    if (!Array.isArray(tips)) return tips
    const moveId = input.moveId ?? this.options.newMoveId?.() ?? randomUUID()
    let incoming: IncomingBundle | undefined
    try {
      const sending = answer(branchSendBeginAnswerSchema, await host.branchMove({ action: 'send-begin', moveId, threadId: input.threadId, bases: tips }))
      if (refused(sending)) return sending
      const begun = await this.options.bundles.receive({ repository: folder, moveId, branch: sending.branch, commit: sending.commit, size: sending.size, sha256: sending.sha256 })
      if (!(begun instanceof IncomingBundle)) return begun
      incoming = begun
      while (begun.received < begun.size) {
        const chunk = answer(branchSendChunkAnswerSchema, await host.branchMove({ action: 'send-chunk', moveId, offset: begun.received }))
        if (refused(chunk)) return chunk
        if (!await begun.write(begun.received, Buffer.from(chunk.data, 'base64'))) return branchMoveRefusal('not-whole', branchMoveWords.notWhole)
      }
      incoming = undefined
      return await this.options.bundles.finish(begun)
    } catch {
      return branchMoveRefusal('cut-off', branchMoveWords.cutOff)
    } finally {
      if (incoming) await this.options.bundles.abandon(incoming)
      await host.branchMove({ action: 'end', moveId }).catch(() => undefined)
    }
  }

  /** Asks the host to discard what it staged for a move, and answers with `receipt` whether or not it could. */
  private async ended(host: BranchMoveHost, moveId: string, receipt: BranchMoveRefusal): Promise<BranchMoveRefusal> {
    await host.branchMove({ action: 'end', moveId }).catch(() => undefined)
    return receipt
  }
}

/** The desktop's branch moves, or nothing where `cross-machine-work` is off (ADR-0072): main asks once, at start. */
export function desktopBranchMoves(crossMachineWork: boolean, options: DesktopBranchMovesOptions): DesktopBranchMoves | undefined {
  return crossMachineWork ? new DesktopBranchMoves(options) : undefined
}
