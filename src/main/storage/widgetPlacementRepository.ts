import { AtomicJsonStore } from './atomicJsonStore'

export interface WidgetPlacement {
  readonly x: number
  readonly y: number
}

interface WidgetPlacementRecord {
  readonly version: 1
  readonly placement: WidgetPlacement | null
}

function parseWidgetPlacementRecord(input: unknown): WidgetPlacementRecord {
  if (typeof input === 'object' && input !== null) {
    const record = input as { version?: unknown; placement?: unknown }
    if (record.version === 1 && typeof record.placement === 'object') {
      const placement = record.placement as { x?: unknown; y?: unknown } | null
      if (
        placement !== null &&
        Number.isInteger(placement.x) &&
        Number.isInteger(placement.y)
      ) {
        return {
          version: 1,
          placement: { x: placement.x as number, y: placement.y as number },
        }
      }
    }
  }
  return { version: 1, placement: null }
}

/** Remembers where the user dragged the dictation widget, best effort. */
export class WidgetPlacementRepository {
  private readonly store: AtomicJsonStore<WidgetPlacementRecord>

  constructor(filePath: string) {
    this.store = new AtomicJsonStore(filePath, parseWidgetPlacementRecord, () => ({
      version: 1,
      placement: null,
    }))
  }

  async get(): Promise<WidgetPlacement | null> {
    try {
      return (await this.store.peek()).placement
    } catch {
      return null
    }
  }

  async save(placement: WidgetPlacement): Promise<void> {
    const record = parseWidgetPlacementRecord({ version: 1, placement })
    try {
      await this.store.write(record)
    } catch {
      // A placement that cannot persist only costs the default position.
    }
  }
}
