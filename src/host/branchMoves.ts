import { BranchBundles, IncomingBundle, type PreparedBundle } from '../main/agents/branchBundles'
import type { BranchMoveFolders } from '../main/agents/branchMoves'
import { BRANCH_TRANSFERS_MAX, branchMoveRefusal, branchMoveWords, type HostBranchMoveRequest } from '../shared/branchMoves'

/**
 * A host's side of a branch move (`branch-moves`, ADR-0105 decision 8), for the desktop that asks over the host socket.
 * The desktop is its only caller today; a host link will be the second, for the same requests. Each transfer belongs to
 * the connection that began it: another connection cannot touch it, and when that connection closes, whatever it staged
 * is discarded, so a transfer cut off lands nothing.
 */
interface Transfer { readonly owner: object; readonly incoming?: IncomingBundle; readonly outgoing?: PreparedBundle }

export class HostBranchMoves {
  private readonly transfers = new Map<string, Transfer>()
  private readonly watched = new WeakSet<AbortSignal>()
  constructor(private readonly bundles: BranchBundles, private readonly folders: BranchMoveFolders) {}

  /** Clears what an earlier run staged. */
  start(): Promise<void> { return this.bundles.start() }

  /** One step of a move for the connection `owner`; `gone` ends when that connection closes. */
  async handle(request: HostBranchMoveRequest, owner: object, gone: AbortSignal): Promise<unknown> {
    if (!this.watched.has(gone)) {
      this.watched.add(gone)
      gone.addEventListener('abort', () => { void this.dropAll(owner) }, { once: true })
    }
    if (gone.aborted) return branchMoveRefusal('cut-off', branchMoveWords.cutOff)
    switch (request.action) {
      case 'tips': {
        const folder = this.folders.projectFolder(request.projectId)
        if (!folder) return branchMoveRefusal('unknown-project', branchMoveWords.unknownProject)
        const tips = await this.bundles.tips(folder)
        return Array.isArray(tips) ? { type: 'tips', tips } : tips
      }
      case 'receive-begin': {
        const folder = this.folders.projectFolder(request.projectId)
        if (!folder) return branchMoveRefusal('unknown-project', branchMoveWords.unknownProject)
        if (this.transfers.has(request.moveId) || this.transfers.size >= BRANCH_TRANSFERS_MAX) return branchMoveRefusal('busy', branchMoveWords.busy)
        // Held before anything is awaited, so begins that arrive together count against the limit as they are taken.
        const holding: Transfer = { owner }
        this.transfers.set(request.moveId, holding)
        let begun: Awaited<ReturnType<BranchBundles['receive']>>
        try {
          begun = await this.bundles.receive({ repository: folder, moveId: request.moveId, branch: request.branch, commit: request.commit, size: request.size, sha256: request.sha256 })
        } catch (error) { this.release(request.moveId, holding); throw error }
        if (!(begun instanceof IncomingBundle)) { this.release(request.moveId, holding); return begun }
        if (gone.aborted || this.transfers.get(request.moveId) !== holding) { this.release(request.moveId, holding); await this.bundles.abandon(begun); return branchMoveRefusal('cut-off', branchMoveWords.cutOff) }
        this.transfers.set(request.moveId, { owner, incoming: begun })
        return { type: 'receiving' }
      }
      case 'receive-chunk': {
        const incoming = this.own(request.moveId, owner)?.incoming
        if (!incoming) return branchMoveRefusal('cut-off', branchMoveWords.cutOff)
        const bytes = Buffer.from(request.data, 'base64')
        if (!await incoming.write(request.offset, bytes)) { await this.drop(request.moveId); return branchMoveRefusal('not-whole', branchMoveWords.notWhole) }
        return { type: 'received', bytes: incoming.received }
      }
      case 'receive-finish': {
        const incoming = this.own(request.moveId, owner)?.incoming
        if (!incoming) return branchMoveRefusal('cut-off', branchMoveWords.cutOff)
        const transfer = this.transfers.get(request.moveId)!
        try { return await this.bundles.finish(incoming) } finally { this.release(request.moveId, transfer) }
      }
      case 'receive-ref': {
        const folder = this.folders.projectFolder(request.projectId)
        if (!folder) return branchMoveRefusal('unknown-project', branchMoveWords.unknownProject)
        if (this.transfers.has(request.moveId) || this.transfers.size >= BRANCH_TRANSFERS_MAX) return branchMoveRefusal('busy', branchMoveWords.busy)
        // Nothing is staged, but the move still holds its place while its ref is created.
        const holding: Transfer = { owner }
        this.transfers.set(request.moveId, holding)
        try { return await this.bundles.receiveRef({ repository: folder, moveId: request.moveId, branch: request.branch, commit: request.commit }) }
        finally { this.release(request.moveId, holding) }
      }
      case 'send-begin': {
        const folder = this.folders.threadFolder(request.threadId)
        if (!folder) return branchMoveRefusal('unknown-thread', branchMoveWords.unknownThread)
        if (this.transfers.has(request.moveId) || this.transfers.size >= BRANCH_TRANSFERS_MAX) return branchMoveRefusal('busy', branchMoveWords.busy)
        // Held while the bundle is written, so a second begin for the same move waits its turn rather than racing it.
        const holding: Transfer = { owner }
        this.transfers.set(request.moveId, holding)
        try {
          const source = await this.bundles.branchOf(folder)
          if ('type' in source) { this.release(request.moveId, holding); return source }
          const prepared = await this.bundles.prepare({ repository: folder, moveId: request.moveId, commit: source.commit, bases: request.bases })
          if (prepared.type === 'present') { this.release(request.moveId, holding); return { type: 'present', branch: source.branch, commit: source.commit } }
          if (prepared.type !== 'sending') { this.release(request.moveId, holding); return prepared }
          // Ended while it was written: this attempt removes its own bundle and hold, never a later attempt's.
          if (gone.aborted || this.transfers.get(request.moveId) !== holding) { this.release(request.moveId, holding); await this.bundles.discard(prepared); return branchMoveRefusal('cut-off', branchMoveWords.cutOff) }
          this.transfers.set(request.moveId, { owner, outgoing: prepared })
          return { type: 'sending', branch: source.branch, commit: source.commit, size: prepared.size, sha256: prepared.sha256 }
        } catch (error) { this.release(request.moveId, holding); throw error }
      }
      case 'send-chunk': {
        const outgoing = this.own(request.moveId, owner)?.outgoing
        if (!outgoing || request.offset >= outgoing.size) return branchMoveRefusal('cut-off', branchMoveWords.cutOff)
        return { type: 'chunk', data: (await this.bundles.readChunk(outgoing.path, request.offset)).toString('base64') }
      }
      case 'end':
        if (this.own(request.moveId, owner)) await this.drop(request.moveId)
        return null
    }
  }

  /** The transfer `moveId` names, when `owner` began it. */
  private own(moveId: string, owner: object): Transfer | undefined {
    const transfer = this.transfers.get(moveId)
    return transfer?.owner === owner ? transfer : undefined
  }
  /** Lets go of `moveId` only while `transfer` still holds it, so a later attempt's entry is never removed. */
  private release(moveId: string, transfer: Transfer): void {
    if (this.transfers.get(moveId) === transfer) this.transfers.delete(moveId)
  }
  private async drop(moveId: string): Promise<void> {
    const transfer = this.transfers.get(moveId)
    this.transfers.delete(moveId)
    if (transfer?.incoming) await this.bundles.abandon(transfer.incoming)
    if (transfer?.outgoing) await this.bundles.discard(transfer.outgoing)
  }
  private async dropAll(owner: object): Promise<void> {
    for (const [moveId, transfer] of [...this.transfers]) if (transfer.owner === owner) await this.drop(moveId)
  }
  /** Moves staged now, for tests. */
  get staged(): number { return this.transfers.size }
}
