import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import type { AgentHostSnapshot, AgentState } from '../../shared/agents'
import {
  branchCopyAnswerSchema, branchMoveRefusal, branchMoveWords, branchReceiveBeginAnswerSchema, branchReceiveChunkAnswerSchema, branchReceiveFinishAnswerSchema,
  branchReceiveRefAnswerSchema, branchSendBeginAnswerSchema, branchSendChunkAnswerSchema, branchTipsAnswerSchema, type BranchMoved, type BranchMoveReceipt,
  type BranchMoveRefusal, type HostBranchMoveRequest, type SnapshotCarried,
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
  return foldersOfSnapshot(() => view().host)
}
/** Folders read from a host snapshot as its owner holds it, without copying it: the desktop's own threads and projects. */
export function foldersOfSnapshot(view: () => AgentHostSnapshot): BranchMoveFolders {
  return {
    projectFolder: projectId => view().projects.find(project => project.id === projectId)?.path || undefined,
    threadFolder: threadId => {
      const snapshot = view()
      const thread = snapshot.threads.find(item => item.id === threadId)
      if (!thread) return undefined
      return thread.workingDirectory || snapshot.projects.find(project => project.id === thread.projectId)?.path || undefined
    },
  }
}

/** A thread, or a project, on one of the desktop's machines, by Sotto's IDs (ADR-0002). */
export interface BranchStartSource { readonly hostId: string; readonly threadId: string }
export interface BranchStartDestination { readonly hostId: string; readonly projectId: string }

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
/** A landed move with what its snapshot carried, as the sender said, for the receipt; anything else as it is. */
function carrying<T extends { readonly type: string }>(receipt: T, snapshot: SnapshotCarried | undefined): T | BranchMoved {
  return receipt.type === 'moved' && snapshot ? { ...(receipt as unknown as BranchMoved), snapshot } : receipt
}

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
   * given again retries that move, and answers as done when it already landed. `snapshot` is a test run's: uncommitted
   * work goes as a snapshot instead of refusing the move.
   */
  async toHost(input: { readonly threadId: string; readonly hostId: string; readonly projectId: string; readonly moveId?: string; readonly snapshot?: boolean }): Promise<BranchMoveReceipt> {
    const connection = this.connected(input.hostId)
    if ('type' in connection) return connection
    const { host } = connection
    const folder = this.options.folders.threadFolder(input.threadId)
    if (!folder) return branchMoveRefusal('unknown-thread', branchMoveWords.unknownThread)
    const source = await this.options.bundles.sourceOf(folder, input.snapshot === true)
    if ('type' in source) return source
    const moveId = input.moveId ?? this.options.newMoveId?.() ?? randomUUID()
    let staged: PreparedBundle | undefined
    try {
      const tips = answer(branchTipsAnswerSchema, await host.branchMove({ action: 'tips', projectId: input.projectId }))
      if (refused(tips)) return tips
      const prepared = await this.options.bundles.prepare({ repository: folder, moveId, commit: source.commit, bases: tips.tips })
      // The host already has the commit: only its incoming ref is made, and nothing travels.
      if (prepared.type === 'present') {
        return carrying(answer(branchReceiveRefAnswerSchema, await host.branchMove({ action: 'receive-ref', moveId, projectId: input.projectId, branch: source.branch, commit: source.commit })), source.snapshot)
      }
      if (prepared.type !== 'sending') return prepared
      staged = prepared
      const begun = answer(branchReceiveBeginAnswerSchema, await host.branchMove({ action: 'receive-begin', moveId, projectId: input.projectId,
        branch: source.branch, commit: source.commit, size: prepared.size, sha256: prepared.sha256 }))
      if (begun.type !== 'receiving') return carrying(begun, source.snapshot)
      for (let offset = 0; offset < prepared.size;) {
        const chunk = await this.options.bundles.readChunk(prepared.path, offset)
        if (chunk.byteLength === 0) return await this.ended(host, moveId, branchMoveRefusal('failed', branchMoveWords.failed))
        const received = answer(branchReceiveChunkAnswerSchema, await host.branchMove({ action: 'receive-chunk', moveId, offset, data: chunk.toString('base64') }))
        if (refused(received)) return await this.ended(host, moveId, received)
        offset += chunk.byteLength
      }
      return carrying(answer(branchReceiveFinishAnswerSchema, await host.branchMove({ action: 'receive-finish', moveId })), source.snapshot)
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
  async fromHost(input: { readonly hostId: string; readonly threadId: string; readonly projectId: string; readonly moveId?: string; readonly snapshot?: boolean }): Promise<BranchMoveReceipt> {
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
      const sending = answer(branchSendBeginAnswerSchema, await host.branchMove({ action: 'send-begin', moveId, threadId: input.threadId, bases: tips,
        ...input.snapshot ? { snapshot: true } : {} }))
      if (refused(sending)) return sending
      if (sending.type === 'present') return carrying(await this.options.bundles.receiveRef({ repository: folder, moveId, branch: sending.branch, commit: sending.commit }), sending.snapshot)
      const begun = await this.options.bundles.receive({ repository: folder, moveId, branch: sending.branch, commit: sending.commit, size: sending.size, sha256: sending.sha256 })
      if (!(begun instanceof IncomingBundle)) return carrying(begun, sending.snapshot)
      incoming = begun
      while (begun.received < begun.size) {
        const chunk = answer(branchSendChunkAnswerSchema, await host.branchMove({ action: 'send-chunk', moveId, offset: begun.received }))
        if (refused(chunk)) return chunk
        if (!await begun.write(begun.received, Buffer.from(chunk.data, 'base64'))) return branchMoveRefusal('not-whole', branchMoveWords.notWhole)
      }
      incoming = undefined
      return carrying(await this.options.bundles.finish(begun), sending.snapshot)
    } catch {
      return branchMoveRefusal('cut-off', branchMoveWords.cutOff)
    } finally {
      if (incoming) await this.options.bundles.abandon(incoming)
      await host.branchMove({ action: 'end', moveId }).catch(() => undefined)
    }
  }

  /**
   * Moves a thread's branch on one host to a project on another, relayed by this desktop over the two sockets it keeps
   * (ADR-0105 decision 1): the sending host stages its bundle against the receiving host's tips, and each chunk this
   * desktop reads from one it hands to the other. Nothing is written here.
   */
  async betweenHosts(input: { readonly fromHostId: string; readonly threadId: string; readonly toHostId: string; readonly projectId: string; readonly moveId?: string; readonly snapshot?: boolean }): Promise<BranchMoveReceipt> {
    const sender = this.connected(input.fromHostId)
    if ('type' in sender) return sender
    const receiver = this.connected(input.toHostId)
    if ('type' in receiver) return receiver
    const from = sender.host, to = receiver.host
    const moveId = input.moveId ?? this.options.newMoveId?.() ?? randomUUID()
    try {
      const tips = answer(branchTipsAnswerSchema, await to.branchMove({ action: 'tips', projectId: input.projectId }))
      if (refused(tips)) return tips
      const sending = answer(branchSendBeginAnswerSchema, await from.branchMove({ action: 'send-begin', moveId, threadId: input.threadId, bases: tips.tips,
        ...input.snapshot ? { snapshot: true } : {} }))
      if (refused(sending)) return sending
      // The receiving host already has the commit: only its incoming ref is made, and nothing travels.
      if (sending.type === 'present') {
        return carrying(answer(branchReceiveRefAnswerSchema, await to.branchMove({ action: 'receive-ref', moveId, projectId: input.projectId, branch: sending.branch, commit: sending.commit })), sending.snapshot)
      }
      const begun = answer(branchReceiveBeginAnswerSchema, await to.branchMove({ action: 'receive-begin', moveId, projectId: input.projectId,
        branch: sending.branch, commit: sending.commit, size: sending.size, sha256: sending.sha256 }))
      if (begun.type !== 'receiving') return carrying(begun, sending.snapshot)
      for (let offset = 0; offset < sending.size;) {
        const chunk = answer(branchSendChunkAnswerSchema, await from.branchMove({ action: 'send-chunk', moveId, offset }))
        if (refused(chunk)) return chunk
        const bytes = Buffer.byteLength(chunk.data, 'base64')
        if (bytes === 0) return branchMoveRefusal('failed', branchMoveWords.failed)
        const received = answer(branchReceiveChunkAnswerSchema, await to.branchMove({ action: 'receive-chunk', moveId, offset, data: chunk.data }))
        if (refused(received)) return received
        offset += bytes
      }
      return carrying(answer(branchReceiveFinishAnswerSchema, await to.branchMove({ action: 'receive-finish', moveId })), sending.snapshot)
    } catch {
      return branchMoveRefusal('cut-off', branchMoveWords.cutOff)
    } finally {
      // Each side discards what it still holds of this move; one that already finished holds nothing.
      await Promise.all([from, to].map(host => host.branchMove({ action: 'end', moveId }).catch(() => undefined)))
    }
  }

  /** Lands a host thread's branch in a project on that same host, which then starts a worker from it. Nothing crosses. */
  async onHost(input: { readonly hostId: string; readonly threadId: string; readonly projectId: string; readonly moveId?: string; readonly snapshot?: boolean }): Promise<BranchMoveReceipt> {
    const connection = this.connected(input.hostId)
    if ('type' in connection) return connection
    const moveId = input.moveId ?? this.options.newMoveId?.() ?? randomUUID()
    try {
      return answer(branchCopyAnswerSchema, await connection.host.branchMove({ action: 'copy', moveId, threadId: input.threadId, projectId: input.projectId,
        ...input.snapshot ? { snapshot: true } : {} }))
    } catch { return branchMoveRefusal('cut-off', branchMoveWords.cutOff) }
  }

  /** Lands a thread's branch on this computer in a project on this computer, for a worker started here from it. */
  async here(input: { readonly threadId: string; readonly projectId: string; readonly moveId?: string; readonly snapshot?: boolean }): Promise<BranchMoveReceipt> {
    const from = this.options.folders.threadFolder(input.threadId)
    if (!from) return branchMoveRefusal('unknown-thread', branchMoveWords.unknownThread)
    const repository = this.options.folders.projectFolder(input.projectId)
    if (!repository) return branchMoveRefusal('unknown-project', branchMoveWords.unknownProject)
    const source = await this.options.bundles.sourceOf(from, input.snapshot === true)
    if ('type' in source) return source
    return this.options.bundles.copy({ from, source, repository, moveId: input.moveId ?? this.options.newMoveId?.() ?? randomUUID() })
  }

  /** Lets go of a move landed in a project on this computer for a start that was then refused, so no ref holds its commits. */
  async forgetHere(input: { readonly projectId: string; readonly moveId: string }): Promise<void> {
    const repository = this.options.folders.projectFolder(input.projectId)
    if (repository) await this.options.bundles.forget(repository, input.moveId)
  }

  /**
   * Puts a thread's branch where a worker will start from it (ADR-0082 decisions 2 and 4, #1033): into the incoming ref
   * of this move in the destination project, on whichever machine each is, so the worker's new worktree is made from it
   * there. A plain start refuses uncommitted work as a move does; a test run carries it as a snapshot.
   */
  forStart(input: { readonly from: BranchStartSource; readonly to: BranchStartDestination; readonly here: string; readonly moveId: string; readonly snapshot: boolean }): Promise<BranchMoveReceipt> {
    const { from, to, here, moveId, snapshot } = input
    const common = { moveId, snapshot, projectId: to.projectId, threadId: from.threadId }
    if (from.hostId === here) return to.hostId === here ? this.here(common) : this.toHost({ ...common, hostId: to.hostId })
    if (to.hostId === here) return this.fromHost({ ...common, hostId: from.hostId })
    return from.hostId === to.hostId ? this.onHost({ ...common, hostId: from.hostId }) : this.betweenHosts({ ...common, fromHostId: from.hostId, toHostId: to.hostId })
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
