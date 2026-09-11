/** The application is black only; the untouched widget still follows the system scheme. */
export type DesignCaptureAppTheme = 'black'
export type DesignCaptureWidgetTheme = 'light' | 'dark'
export type DesignCaptureTheme = DesignCaptureAppTheme | DesignCaptureWidgetTheme
export type DesignCaptureMotion = 'normal' | 'reduced'
export type DesignCaptureFocusTarget = 'none' | 'tab' | 'navigation' | 'input' | 'switch' | 'destructive'
export interface DesignCaptureRequirement {
  readonly id: string
  readonly category: 'onboarding' | 'dictate' | 'agents' | 'history' | 'settings' | 'help' | 'threads' | 'scale' | 'widget'
  readonly state: string
  readonly theme: DesignCaptureTheme
  readonly scalePercent: 100 | 125 | 150 | 200
  readonly motion: DesignCaptureMotion
  readonly focusTarget: DesignCaptureFocusTarget
  readonly source: 'app-review' | 'widget-baseline'
}
export const DESIGN_CAPTURE_THEME: DesignCaptureAppTheme
export const DESIGN_CAPTURE_WIDGET_THEMES: readonly DesignCaptureWidgetTheme[]
export const DESIGN_CAPTURE_SCALES: readonly (100 | 125 | 150 | 200)[]
export const DESIGN_CAPTURE_REQUIREMENTS: readonly DesignCaptureRequirement[]
export function designCaptureTupleKey(requirement: Omit<DesignCaptureRequirement, 'id' | 'source'>): string
