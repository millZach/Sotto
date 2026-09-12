/**
 * The main window is black only ("Crossing"), so every application capture
 * carries the one theme `black`. The floating widget is untouched and still
 * follows the system scheme, so widget captures keep `light` and `dark`.
 */
export const DESIGN_CAPTURE_THEME = 'black'
export const DESIGN_CAPTURE_WIDGET_THEMES = Object.freeze(['light', 'dark'])
export const DESIGN_CAPTURE_SCALES = Object.freeze([100, 125, 150, 200])

const requirements = []

function add(requirement) {
  requirements.push(Object.freeze({
    theme: DESIGN_CAPTURE_THEME,
    scalePercent: 100,
    motion: 'normal',
    focusTarget: 'none',
    source: 'app-review',
    ...requirement,
  }))
}

for (const [id, category, state] of [
  ['onboarding-step-1-welcome', 'onboarding', 'welcome'],
  ['onboarding-step-2-microphone-ready', 'onboarding', 'microphone-ready'],
  ['onboarding-step-3-openrouter', 'onboarding', 'openrouter-key'],
  ['onboarding-step-4-shortcut', 'onboarding', 'shortcut-paste'],
  ['dictate-ready', 'dictate', 'ready'],
  ['dictate-listening', 'dictate', 'listening'],
  ['dictate-pasted', 'dictate', 'success-pasted'],
  ['dictate-processing', 'dictate', 'processing'],
  ['dictate-error', 'dictate', 'error'],
  ['agents-room', 'agents', 'overview'],
  ['agents-wake', 'agents', 'wake'],
  ['agents-listening', 'agents', 'listening'],
  ['agents-attention', 'agents', 'attention'],
  ['agents-session', 'agents', 'session'],
  ['history-populated', 'history', 'populated-feedback'],
  ['history-empty', 'history', 'empty-feedback'],
  ['history-search', 'history', 'search'],
  ['history-off', 'history', 'off'],
  ['settings-key-verified', 'settings', 'key-verified'],
  ['settings-cleanup', 'settings', 'cleanup'],
  ['settings-feedback', 'settings', 'saved-feedback'],
  ['settings-account', 'settings', 'account'],
  ['settings-capture', 'settings', 'capture'],
  ['settings-transcription', 'settings', 'transcription'],
  ['settings-output', 'settings', 'output'],
  ['settings-application-privacy', 'settings', 'application-privacy'],
  ['settings-validation-error', 'settings', 'validation-error'],
  ['help', 'help', 'overview'],
  // Threads captures show clock times; the capture run pins America/Los_Angeles and en-US.
  ['threads-populated', 'threads', 'populated'],
  ['threads-open-running', 'threads', 'open-running'],
  ['threads-stopped', 'threads', 'stopped-open'],
  ['threads-search', 'threads', 'search'],
  ['threads-empty', 'threads', 'empty'],
]) add({ id, category, state })

add({ id: 'dictate-reduced-motion', category: 'dictate', state: 'listening-reduced-motion', motion: 'reduced' })

for (const [id, category, state, focusTarget] of [
  ['focus-switch-tab', 'dictate', 'focus-switch-tab', 'tab'],
  ['focus-navigation', 'dictate', 'focus-navigation', 'navigation'],
  ['focus-input', 'history', 'focus-input', 'input'],
  ['focus-switch', 'settings', 'focus-switch', 'switch'],
  ['focus-destructive', 'history', 'focus-destructive', 'destructive'],
]) add({ id, category, state, focusTarget })

for (const scalePercent of DESIGN_CAPTURE_SCALES) {
  for (const [surface, state] of [
    ['onboarding', 'onboarding-model'],
    ['dictate', 'dictate-ready'],
    ['history', 'history-populated'],
    ['settings', 'settings-full'],
    ['help', 'help-full'],
  ]) add({ id: `scale-${scalePercent}-${surface}`, category: 'scale', state, scalePercent })

  for (const theme of DESIGN_CAPTURE_WIDGET_THEMES) {
    add({ id: `scale-${scalePercent}-widget-${theme}`, category: 'scale', state: 'widget-listening', theme, scalePercent })
  }
}

for (const theme of DESIGN_CAPTURE_WIDGET_THEMES) {
  for (const [state, capturedState] of [
    ['idle', 'idle-sliver'],
    ['permission', 'requesting-permission'],
    ['cancelled', 'cancelled'],
  ]) add({ id: `widget-${state}-${theme}`, category: 'widget', state: capturedState, theme, motion: 'reduced' })

  for (const state of ['listening', 'processing', 'pasted', 'copied', 'error']) add({
    id: `widget-${state}-${theme}`,
    category: 'widget', state, theme, motion: 'reduced', source: 'widget-baseline',
  })
}

export const DESIGN_CAPTURE_REQUIREMENTS = Object.freeze(requirements)

export function designCaptureTupleKey(requirement) {
  return [
    requirement.category,
    requirement.state,
    requirement.theme,
    requirement.scalePercent,
    requirement.motion,
    requirement.focusTarget,
  ].join('|')
}
