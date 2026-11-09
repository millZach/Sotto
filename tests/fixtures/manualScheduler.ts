/** A clock for one owner's deadlines; advancing it leaves provider I/O and the process clock alone. */
export class ManualScheduler {
  private clock: number
  private readonly timers = new Set<{ at: number; run: () => void }>()

  constructor(now = Date.now()) { this.clock = now }
  readonly now = (): number => this.clock
  readonly schedule = (run: () => void, delay: number): (() => void) => {
    const timer = { at: this.clock + delay, run }
    this.timers.add(timer)
    return () => { this.timers.delete(timer) }
  }

  /** Drain each deadline's admitted work before looking for another deadline it may have made. */
  async advance(ms: number, drained: () => Promise<void>): Promise<void> {
    const end = this.clock + ms
    for (;;) {
      await drained()
      const timer = [...this.timers].sort((a, b) => a.at - b.at).find(item => item.at <= end)
      if (timer) {
        this.clock = timer.at
        this.timers.delete(timer)
        timer.run()
      } else if (this.clock < end) this.clock = end
      else return
    }
  }
}
