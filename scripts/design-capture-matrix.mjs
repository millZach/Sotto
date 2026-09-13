/**
 * The main window has a dark room (the default every existing install keeps)
 * and a light room, each painted by the theme chosen for that half (ADR-0009,
 * ADR-0011). Application tuples carry the resolved mode, `dark` or `light`;
 * the dense matrix is captured in the dark Ocean default and the light tuples
 * repeat the surfaces a mode change can break. Theme and System captures name
 * their choice in the state. The
 * floating widget is untouched and still follows the system scheme, so widget
 * captures keep `light` and `dark` as the emulated system scheme.
 */
export const DESIGN_CAPTURE_THEME = 'dark'
export const DESIGN_CAPTURE_APP_THEMES = Object.freeze(['dark', 'light'])
/** The built-in themes, in the order Settings shows them; Ocean is the default. */
export const DESIGN_CAPTURE_BUILT_IN_THEMES = Object.freeze(['t3-code', 't3-chat', 'grove', 'ocean', 'ember', 'iris'])
export const DESIGN_CAPTURE_DEFAULT_THEME = 'ocean'
/** The narrowest main window the Phase 1 surfaces are reviewed at. */
export const DESIGN_CAPTURE_MINIMUM_WIDTH = 760
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
  ['settings-providers', 'settings', 'providers'],
  ['settings-agents', 'settings', 'agents'],
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

// The light room repeats every surface family, its feedback and error states,
// the orb, native selects and provider controls.
for (const [id, category, state] of [
  ['onboarding-step-3-openrouter-light', 'onboarding', 'openrouter-key'],
  ['dictate-ready-light', 'dictate', 'ready'],
  ['dictate-listening-light', 'dictate', 'listening'],
  ['dictate-pasted-light', 'dictate', 'success-pasted'],
  ['dictate-error-light', 'dictate', 'error'],
  ['agents-room-light', 'agents', 'overview'],
  ['history-populated-light', 'history', 'populated-feedback'],
  ['settings-feedback-light', 'settings', 'saved-feedback'],
  ['settings-providers-light', 'settings', 'providers'],
  ['settings-capture-light', 'settings', 'capture'],
  ['settings-application-privacy-light', 'settings', 'application-privacy'],
  ['settings-validation-error-light', 'settings', 'validation-error'],
  ['settings-appearance-light', 'settings', 'appearance'],
  ['help-light', 'help', 'overview'],
  ['threads-populated-light', 'threads', 'populated'],
  ['threads-open-running-light', 'threads', 'open-running'],
  ['threads-stopped-light', 'threads', 'stopped-open'],
  ['threads-search-light', 'threads', 'search'],
  ['threads-empty-light', 'threads', 'empty'],
]) add({ id, category, state, theme: 'light' })

add({ id: 'settings-appearance', category: 'settings', state: 'appearance' })
add({ id: 'dictate-reduced-motion-light', category: 'dictate', state: 'listening-reduced-motion', motion: 'reduced', theme: 'light' })

for (const [id, category, state, focusTarget] of [
  ['focus-switch-tab-light', 'dictate', 'focus-switch-tab', 'tab'],
  ['focus-navigation-light', 'dictate', 'focus-navigation', 'navigation'],
  ['focus-input-light', 'history', 'focus-input', 'input'],
  ['focus-switch-light', 'settings', 'focus-switch', 'switch'],
  ['focus-destructive-light', 'history', 'focus-destructive', 'destructive'],
]) add({ id, category, state, focusTarget, theme: 'light' })

// Each built-in theme is applied live, in both rooms, on the surface that
// shows the most of its palette: the ready room's wave, primary action,
// sidebar and current navigation.
for (const theme of DESIGN_CAPTURE_APP_THEMES) {
  for (const builtIn of DESIGN_CAPTURE_BUILT_IN_THEMES.filter((candidate) => candidate !== DESIGN_CAPTURE_DEFAULT_THEME)) {
    add({ id: `theme-${builtIn}-${theme}`, category: 'appearance', state: `theme-${builtIn}`, theme })
  }
  // System mode resolves to whatever Windows reports, emulated on the main window.
  add({ id: `appearance-system-${theme}`, category: 'appearance', state: 'system-settings', theme })
}

for (const theme of DESIGN_CAPTURE_APP_THEMES) {
  for (const [surface, state] of [
    ['dictate', 'dictate-ready'],
    ['agents', 'agents-overview'],
    ['settings', 'settings-full'],
  ]) add({ id: `width-${DESIGN_CAPTURE_MINIMUM_WIDTH}-${surface}-${theme}`, category: 'width', state: `${state}-${DESIGN_CAPTURE_MINIMUM_WIDTH}`, theme })
}

for (const scalePercent of DESIGN_CAPTURE_SCALES) {
  for (const [surface, state] of [
    ['onboarding', 'onboarding-model'],
    ['dictate', 'dictate-ready'],
    ['history', 'history-populated'],
    ['settings', 'settings-full'],
    ['help', 'help-full'],
  ]) add({ id: `scale-${scalePercent}-${surface}`, category: 'scale', state, scalePercent })

  for (const [surface, state] of [
    ['dictate', 'dictate-ready'],
    ['settings', 'settings-full'],
  ]) add({ id: `scale-${scalePercent}-${surface}-light`, category: 'scale', state, scalePercent, theme: 'light' })

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

for (const theme of DESIGN_CAPTURE_APP_THEMES) {
  for (const state of ['split-workspace', 'split-focus-820', 'files-unavailable', 'working-copy-choice']) {
    add({ id: `threads-${state}-${theme}`, category: 'threads', state, theme })
  }
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
