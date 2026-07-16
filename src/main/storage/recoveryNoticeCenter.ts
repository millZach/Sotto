import { recoveryNoticeSchema, type RecoveryNotice } from '../../shared/recoveryNotice'

export class RecoveryNoticeCenter {
  private readonly notices = new Map<RecoveryNotice['code'], RecoveryNotice>()
  private readonly listeners = new Set<(notice: RecoveryNotice) => void>()

  publish(input: RecoveryNotice): void {
    const notice = Object.freeze(recoveryNoticeSchema.parse(input))
    if (this.notices.has(notice.code)) return
    this.notices.set(notice.code, notice)
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

  subscribe(listener: (notice: RecoveryNotice) => void): () => void {
    this.listeners.add(listener)
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      this.listeners.delete(listener)
    }
  }
}
