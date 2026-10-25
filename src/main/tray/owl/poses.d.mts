export const OWL_WIDTH: 18
export const OWL_HEIGHT: 18
export const OWL_FRAME_MS: 80

export interface OwlPose {
  readonly lx: number
  readonly ly: number
  readonly lid: number
  readonly glow: 0 | 1 | 2
  readonly th: number
  readonly thR: number | null
  readonly r: number
  readonly lift: number
  readonly sq: number
  readonly tilt: number
  readonly sm: number
}

/** Where the eyes rest: [lx, ly]. */
export type OwlLook = readonly [lx: number, ly: number]

export interface OwlFlapStep { readonly pose: OwlPose; readonly ms: number }
export interface OwlTimedPose { readonly pose: OwlPose; readonly afterMs: number }

export const REST_POSE: OwlPose
export const LOOK_TARGETS: readonly OwlLook[]
export const LOOK_CHOICES: readonly OwlLook[]
export const FLAP_SEQUENCES: Readonly<Record<'flap' | 'flutter' | 'stretch', readonly OwlFlapStep[]>>

export function lookPose(look: OwlLook): OwlPose
export function glanceSteps(from: OwlLook, to: OwlLook): readonly OwlTimedPose[]
export function blinkSteps(look: OwlLook, double: boolean): { readonly steps: readonly OwlTimedPose[]; readonly lengthMs: number }
export function poseKey(pose: OwlPose): string
export function allOwlPoses(): readonly OwlPose[]
export function owlFrameIndex(pose: OwlPose): number
