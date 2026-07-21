export const DESIGN_CAPTURE_THEMES = Object.freeze(['light', 'dark'])
export const DESIGN_CAPTURE_SCALES = Object.freeze([100, 125, 150, 200])

const requirements = []

function add(requirement) {
  requirements.push(Object.freeze({
    scalePercent: 100,
    motion: 'normal',
    focusTarget: 'none',
    source: 'app-review',
    ...requirement,
  }))
}

for (const theme of DESIGN_CAPTURE_THEMES) {
  for (const [id, category, state] of [
    ['onboarding-step-1-welcome', 'onboarding', 'welcome'],
    ['onboarding-step-2-microphone-ready', 'onboarding', 'microphone-ready'],
    ['onboarding-step-3-model', 'onboarding', 'model-ready'],
    ['onboarding-step-4-shortcut', 'onboarding', 'shortcut-paste'],
    ['home-ready', 'home', 'ready'],
    ['home-listening', 'home', 'listening'],
    ['home-success', 'home', 'success-pasted'],
    ['home-processing', 'home', 'processing'],
    ['home-error', 'home', 'error'],
    ['history-populated', 'history', 'populated-feedback'],
    ['history-empty', 'history', 'empty-feedback'],
    ['settings-feedback', 'settings', 'saved-feedback'],
    ['settings-appearance', 'settings', 'appearance'],
    ['settings-capture', 'settings', 'capture'],
    ['settings-transcription', 'settings', 'transcription'],
    ['settings-output', 'settings', 'output'],
    ['settings-application-privacy', 'settings', 'application-privacy'],
    ['settings-validation-error', 'settings', 'validation-error'],
    ['help', 'help', 'overview'],
  ]) add({ id: `${id}-${theme}`, category, state, theme })

  add({
    id: `home-reduced-motion-${theme}`,
    category: 'home', state: 'listening-reduced-motion', theme, motion: 'reduced',
  })

  for (const [id, category, state, focusTarget] of [
    ['focus-navigation', 'home', 'focus-navigation', 'navigation'],
    ['focus-input', 'history', 'focus-input', 'input'],
    ['focus-switch', 'settings', 'focus-switch', 'switch'],
    ['focus-destructive', 'history', 'focus-destructive', 'destructive'],
  ]) add({ id: `${id}-${theme}`, category, state, theme, focusTarget })

  for (const scalePercent of DESIGN_CAPTURE_SCALES) {
    for (const [surface, state] of [
      ['onboarding', 'onboarding-model'],
      ['home', 'home-ready'],
      ['history', 'history-populated'],
      ['settings', 'settings-full'],
      ['help', 'help-full'],
      ['widget', 'widget-listening'],
    ]) add({
      id: `scale-${scalePercent}-${surface}-${theme}`,
      category: 'scale', state, theme, scalePercent,
    })
  }

  for (const [state, capturedState] of [
    ['idle', 'idle-sliver'],
    ['permission', 'requesting-permission'],
    ['cancelled', 'cancelled'],
  ]) add({
    id: `widget-${state}-${theme}`,
    category: 'widget', state: capturedState, theme, motion: 'reduced',
  })

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
