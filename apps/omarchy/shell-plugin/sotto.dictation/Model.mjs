// The plugin's rules, kept apart from the QML so they read in one place:
// what the state file says, how long a finished dictation stays on screen,
// what the pill and the bar glyph show, and where the pill rests and snaps.
// An ECMAScript module, which QML imports as one shared copy.

export const STATES = ["idle", "starting", "listening", "transcribing", "delivered", "copied", "failed"]
export const EDGES = ["top", "bottom", "left", "right"]

// Sotto writes idle again on its own; these only stop a finished dictation
// from staying on screen if that write never comes.
export const HOLD_MS = { delivered: 1500, copied: 4000 }
export const NOTICE_MS = 5000

export const GLYPH = {
  sand: String.fromCodePoint(0xF051F),
  check: String.fromCodePoint(0xF012C),
  copy: String.fromCodePoint(0xF018F),
  alert: String.fromCodePoint(0xF05D6)
}

export function idle(edge) {
  return { state: "idle", since: 0, updatedAt: 0, detail: "", kept: false, edge: validEdge(edge) ? edge : "top" }
}

export function validEdge(edge) {
  return EDGES.indexOf(String(edge)) !== -1
}

export function finiteNumber(value) {
  var n = Number(value)
  return typeof value === "number" && isFinite(n) ? n : 0
}

// Schema v1. Anything else, a version this plugin does not know included,
// reads as idle, so a newer Sotto never leaves a pill on screen that the
// plugin cannot explain.
// JSON or null. Only a malformed file is expected; anything else is a fault.
function parseJson(text) {
  try {
    return JSON.parse(String(text || ""))
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

export function parse(text) {
  var data = parseJson(text)
  if (!data || typeof data !== "object" || data.version !== 1) return idle()
  if (STATES.indexOf(data.state) === -1) return idle(data.edge)
  var detail = typeof data.detail === "string" ? data.detail.replace(/\s+/g, " ").trim() : ""
  return {
    state: data.state,
    since: finiteNumber(data.since),
    updatedAt: finiteNumber(data.updatedAt),
    detail: detail,
    kept: data.kept === true,
    edge: validEdge(data.edge) ? data.edge : "top"
  }
}

// One dictation's state is told apart from the next by when it began.
export function key(record) {
  return record.state + "@" + record.since
}

// What is on screen now: a finished dictation past its hold, or a state the
// user put away, shows as idle.
export function effectiveState(record, now, dismissedKey) {
  if (!record || record.state === "idle") return "idle"
  if (dismissedKey !== "" && dismissedKey === key(record)) return "idle"
  var hold = HOLD_MS[record.state]
  if (hold !== undefined && now - record.since >= hold) return "idle"
  return record.state
}

// When the next hold ends, so a timer can wake for it; 0 when none is pending.
export function nextExpiry(record, now) {
  var hold = record ? HOLD_MS[record.state] : undefined
  if (hold === undefined) return 0
  var at = record.since + hold
  return at > now ? at : 0
}

export function formatElapsed(since, now) {
  if (!since || !isFinite(since) || !isFinite(now)) return "00:00"
  var total = Math.max(0, Math.floor((now - since) / 1000))
  var minutes = Math.min(99, Math.floor(total / 60))
  var seconds = minutes === 99 ? Math.min(59, total - minutes * 60) : total % 60
  return (minutes < 10 ? "0" : "") + minutes + ":" + (seconds < 10 ? "0" : "") + seconds
}

// The pill's words and buttons for one state. `buttons` lists verbs; a
// verb of "dismiss" is the plugin's own and runs no command.
export function pillFor(state, record, notice) {
  if (notice) return { glyph: "alert", tone: "error", message: notice, buttons: [] }
  switch (state) {
  case "starting":
  case "listening":
    return { glyph: "sotto", tone: "live", message: "", buttons: ["stop", "cancel"] }
  case "transcribing":
    return { glyph: "sand", tone: "", message: "Transcribing", buttons: ["cancel"] }
  case "delivered":
    return { glyph: "check", tone: "", message: "Pasted", buttons: [] }
  case "copied":
    return { glyph: "copy", tone: "", message: "Copied, paste with Super+V", buttons: [] }
  case "failed":
    if (record.kept) {
      return { glyph: "retry", tone: "error", message: record.detail || "Transcription failed. Recording kept.", buttons: ["retry", "discard"] }
    }
    return { glyph: "alert", tone: "error", message: record.detail || "Dictation failed. Nothing was kept.", buttons: ["dismiss"] }
  }
  return { glyph: "sotto", tone: "", message: "", buttons: [] }
}

export const BUTTON_TEXT = { stop: "Stop", cancel: "Cancel", retry: "Try again", discard: "Discard", dismiss: "Dismiss" }
export const BUTTON_NAME = {
  stop: "Stop dictation",
  cancel: "Cancel dictation",
  retry: "Try again with the kept recording",
  discard: "Discard the kept recording",
  dismiss: "Dismiss"
}

// The bar glyph. A press always runs toggle, which starts a dictation, stops
// a running one and does nothing while Sotto transcribes; the tooltip says so.
export function barFor(state, record) {
  switch (state) {
  case "starting":
    return { glyph: "sotto", alert: true, time: false, tooltip: "Stop dictation" }
  case "listening":
    return { glyph: "sotto", alert: true, time: true, tooltip: "Stop dictation" }
  case "transcribing":
    return { glyph: "sand", alert: false, time: false, tooltip: "Transcribing" }
  case "delivered":
    return { glyph: "check", alert: false, time: false, tooltip: "Pasted" }
  case "copied":
    return { glyph: "copy", alert: false, time: false, tooltip: "Copied, paste with Super+V" }
  case "failed":
    return record.kept
      ? { glyph: "retry", alert: true, time: false, tooltip: "Start a new dictation and let the kept recording go" }
      : { glyph: "alert", alert: true, time: false, tooltip: "Dictation failed" }
  }
  return { glyph: "sotto", alert: false, time: false, tooltip: "Start dictation" }
}

// The area the pill may use: the screen less the bar's strip, when the bar
// shows on this edge.
export function workArea(width, height, barPosition, barSize) {
  var area = { x: 0, y: 0, width: width, height: height }
  var size = Math.max(0, Number(barSize) || 0)
  if (size === 0) return area
  if (barPosition === "top") { area.y = size; area.height -= size }
  else if (barPosition === "bottom") area.height -= size
  else if (barPosition === "left") { area.x = size; area.width -= size }
  else if (barPosition === "right") area.width -= size
  return area
}

export function verticalEdge(edge) {
  return edge === "left" || edge === "right"
}

// Centred on its edge, `gap` in from the work area, as the Windows pill is
// centred on its edge of the work area.
export function restingPosition(edge, area, width, height, gap) {
  var centreX = area.x + Math.round((area.width - width) / 2)
  var centreY = area.y + Math.round((area.height - height) / 2)
  switch (edge) {
  case "bottom": return { x: centreX, y: area.y + area.height - height - gap }
  case "left": return { x: area.x + gap, y: centreY }
  case "right": return { x: area.x + area.width - width - gap, y: centreY }
  }
  return { x: centreX, y: area.y + gap }
}

// The nearest edge of the work area to the pill where it was let go. Ties
// prefer bottom, top, left, then right, as snapToEdge does on Windows.
export function snapEdge(bounds, area) {
  var distances = {
    bottom: area.y + area.height - (bounds.y + bounds.height),
    top: bounds.y - area.y,
    left: bounds.x - area.x,
    right: area.x + area.width - (bounds.x + bounds.width)
  }
  var priority = ["bottom", "top", "left", "right"]
  var edge = "bottom"
  for (var i = 0; i < priority.length; i++) {
    if (distances[priority[i]] < distances[edge]) edge = priority[i]
  }
  return edge
}

// Hyprland's `animations:enabled`, as `hyprctl -j getoption` prints it: a
// bool under a Lua config, an int under the older one. On unless it plainly
// says off.
export function animationsEnabled(text) {
  var option = parseJson(text)
  if (!option || typeof option !== "object") return true
  if (typeof option.bool === "boolean") return option.bool
  if (typeof option.int === "number") return option.int !== 0
  return true
}

export function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

// The command named by this widget's entry in shell.json, or `sotto`.
export function commandFrom(barConfig, pluginId) {
  var layout = barConfig && barConfig.layout ? barConfig.layout : null
  if (!layout) return "sotto"
  var sections = ["left", "center", "right"]
  for (var i = 0; i < sections.length; i++) {
    var list = layout[sections[i]]
    if (!Array.isArray(list)) continue
    for (var j = 0; j < list.length; j++) {
      var entry = list[j]
      if (entry && entry.id === pluginId) return cleanCommand(entry.command)
    }
  }
  return "sotto"
}

export function cleanCommand(value) {
  var text = typeof value === "string" ? value.trim() : ""
  return text.length > 0 ? text : "sotto"
}

// A command that could not run, or that Sotto did not take, in plain words
// short enough for the pill.
export function failureNotice(verb, started) {
  if (!started) return "Could not run sotto. Check the command path."
  if (verb === "place") return "Sotto did not save this edge. Open Sotto and drag again."
  return "Sotto did not answer. Open Sotto and try again."
}
