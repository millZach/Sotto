import type { DesignCaptureRequirement } from '../../../scripts/design-capture-matrix.mjs'

export interface CaptureEntry extends DesignCaptureRequirement {
  readonly relativePath: string
  readonly width: number
  readonly height: number
  readonly sha256: string
}

export const repositoryRoot: string
export const baselineRoot: string
export function digest(value: Buffer): string
export function requiredMetadata(fileName: string): DesignCaptureRequirement
export function recordCaptureEntry(entry: CaptureEntry, specFile: string, workerIndex: number): Promise<void>
export function finalizeDesignCaptures(fragmentsRoot: string, updateBaselines: boolean): Promise<void>
