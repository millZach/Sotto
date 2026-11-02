import { isPastePermissionNotice, recoveryNoticeSchema, type PastePermissionNoticeCode, type RecoveryNotice, type RecoveryNoticeEvent } from '../../shared/recoveryNotice'

export class RecoveryNoticeCenter {
  private readonly notices = new Map<RecoveryNotice['code'], RecoveryNotice>()
  private readonly seen = new Set<RecoveryNotice['code']>()
  private readonly listeners = new Set<(notice: RecoveryNoticeEvent) => void>()

  publish(input: RecoveryNotice): void {
    const notice = Object.freeze(recoveryNoticeSchema.parse(input))
    if (this.seen.has(notice.code)) return
    this.seen.add(notice.code)
    this.notices.set(notice.code, notice)
    this.notify(isPastePermissionNotice(notice.code) ? Object.freeze({ ...notice, cleared: false }) : notice)
  }

  /** Dismissed permission failures still need a recovery check before they can notify again. */
  hasUnresolved(code: PastePermissionNoticeCode): boolean {
    return this.seen.has(code)
  }

  resolve(code: PastePermissionNoticeCode): void {
    this.seen.delete(code)
    this.clear(code)
  }

  clear(code: RecoveryNotice['code']): void {
    if (!this.notices.delete(code)) return
    this.notify(Object.freeze({ code, cleared: true }))
  }

  private notify(notice: RecoveryNoticeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(notice)
      } catch {
        // One observer cannot prevent durable recovery or later observers.
      }
    }
  }

  list(): readonly RecoveryNotice[] {
    return Object.freeze([...this.notices.values()])
  }

  subscribe(listener: (notice: RecoveryNoticeEvent) => void): () => void {
    this.listeners.add(listener)
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      this.listeners.delete(listener)
    }
  }
}
