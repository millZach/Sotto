import { AtomicJsonStore } from './atomicJsonStore'
import type { WidgetEdge, WidgetPlacement } from '../windows/widgetPlacementMath'

/**
 * A remembered placement as read from disk: either the current edge shape or a
 * legacy version 1 raw point that callers convert to an edge placement.
 */
export type StoredWidgetPlacement =
  | { readonly kind: 'edge'; readonly edge: WidgetEdge }
  | { readonly kind: 'point'; readonly x: number; readonly y: number }

type WidgetPlacementRecord =
  | { readonly version: 3; readonly placement: WidgetPlacement | null }
  | {
      readonly version: 2
      readonly placement: { readonly edge: WidgetEdge; readonly offset: number } | null
    }
  | {
      readonly version: 1
      readonly placement: { readonly x: number; readonly y: number } | null
    }

const WIDGET_EDGES: readonly WidgetEdge[] = ['top', 'bottom', 'left', 'right']

function isWidgetEdge(input: unknown): input is WidgetEdge {
  return typeof input === 'string' && (WIDGET_EDGES as readonly string[]).includes(input)
}

function parseWidgetPlacementRecord(input: unknown): WidgetPlacementRecord {
  if (typeof input === 'object' && input !== null) {
    const record = input as { version?: unknown; placement?: unknown }
    if (record.version === 3 && typeof record.placement === 'object') {
      const placement = record.placement as { edge?: unknown } | null
      if (placement !== null && isWidgetEdge(placement.edge)) {
        return { version: 3, placement: { edge: placement.edge } }
      }
    }
    if (record.version === 2 && typeof record.placement === 'object') {
      const placement = record.placement as { edge?: unknown; offset?: unknown } | null
      if (
        placement !== null &&
        isWidgetEdge(placement.edge) &&
        typeof placement.offset === 'number' &&
        Number.isFinite(placement.offset) &&
        placement.offset >= 0 &&
        placement.offset <= 1
      ) {
        return {
          version: 2,
          placement: { edge: placement.edge, offset: placement.offset },
        }
      }
    }
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
  return { version: 3, placement: null }
}

/** Remembers where the user dragged the dictation widget, best effort. */
export class WidgetPlacementRepository {
  private readonly store: AtomicJsonStore<WidgetPlacementRecord>

  constructor(filePath: string) {
    this.store = new AtomicJsonStore(filePath, parseWidgetPlacementRecord, () => ({
      version: 3,
      placement: null,
    }))
  }

  async get(): Promise<StoredWidgetPlacement | null> {
    let record: WidgetPlacementRecord
    try {
      record = await this.store.peek()
    } catch {
      return null
    }
    if (record.placement === null) {
      return null
    }
    if (record.version === 3) {
      return { kind: 'edge', ...record.placement }
    }
    if (record.version === 2) {
      const migrated = { edge: record.placement.edge }
      try {
        await this.store.write({ version: 3, placement: migrated })
      } catch {
        // Migration persistence is best effort; the valid edge remains usable.
      }
      return { kind: 'edge', ...migrated }
    }
    return { kind: 'point', ...record.placement }
  }

  async save(placement: WidgetPlacement): Promise<void> {
    const record = parseWidgetPlacementRecord({
      version: 3,
      placement: isWidgetEdge(placement.edge) ? { edge: placement.edge } : null,
    })
    try {
      await this.store.write(record)
    } catch {
      // A placement that cannot persist only costs the default position.
    }
  }
}
