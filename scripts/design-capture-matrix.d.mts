export type DesignCaptureTheme = 'light' | 'dark'
export type DesignCaptureMotion = 'normal' | 'reduced'
export type DesignCaptureFocusTarget = 'none' | 'navigation' | 'input' | 'switch' | 'destructive'
export interface DesignCaptureRequirement {
  readonly id: string
  readonly category: 'onboarding' | 'home' | 'history' | 'settings' | 'help' | 'scale' | 'widget'
  readonly state: string
  readonly theme: DesignCaptureTheme
  readonly scalePercent: 100 | 125 | 150 | 200
  readonly motion: DesignCaptureMotion
  readonly focusTarget: DesignCaptureFocusTarget
  readonly source: 'app-review' | 'widget-baseline'
}
export const DESIGN_CAPTURE_THEMES: readonly DesignCaptureTheme[]
export const DESIGN_CAPTURE_SCALES: readonly (100 | 125 | 150 | 200)[]
export const DESIGN_CAPTURE_REQUIREMENTS: readonly DesignCaptureRequirement[]
export function designCaptureTupleKey(requirement: Omit<DesignCaptureRequirement, 'id' | 'source'>): string
