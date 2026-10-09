// The plugin's rules, kept apart from the QML so they read in one place:
// what the state file says, how long a finished dictation stays on screen,
// what the pill and the bar glyph show, and where the pill rests and snaps.
// An ECMAScript module, which QML imports as one shared copy.

export const STATES = ["idle", "starting", "listening", "transcribing", "delivered", "copied", "failed"]
export const EDGES = ["top", "bottom", "left", "right"]

// A dictation under way, or a failure still on screen: what a failed command
// must never put away, since Sotto may still be recording or holding it.
export const ACTIVE = ["starting", "listening", "transcribing", "failed"]

// Sotto writes idle again on its own; these only stop a finished dictation
// from staying on screen if that write never comes.
export const HOLD_MS = { delivered: 1500, copied: 4000 }
export const NOTICE_MS = 5000
// How often to look for Sotto's process while the file shows a dictation.
export const PROCESS_CHECK_MS = 3000
// How often to look for a missing state file, and to read again one that
// could not be read. A replaced file is noticed at once through its folder;
// these catch what the watch cannot, and each try at an unreadable file
// costs a line in the shell's log.
export const MISSING_RETRY_MS = 1000
export const UNREADABLE_RETRY_MS = 3000

export const GLYPH = {
  sand: String.fromCodePoint(0xF051F),
  check: String.fromCodePoint(0xF012C),
  copy: String.fromCodePoint(0xF018F),
  alert: String.fromCodePoint(0xF05D6)
}

export function idle(edge) {
  return { state: "idle", since: 0, updatedAt: 0, detail: "", kept: false, edge: validEdge(edge) ? edge : "top", pid: 0 }
}

export function validEdge(edge) {
  return EDGES.indexOf(String(edge)) !== -1
}

export function finiteNumber(value) {
  var n = Number(value)
  return typeof value === "number" && isFinite(n) ? n : 0
}

// Sotto's main process, or 0 when the file names none, as an older Sotto's
// does not.
export function processId(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0
}

// The JSON in `text`, or undefined when it holds none. Only text that is not
// JSON is expected; anything else is a fault.
function parseJson(text) {
  try {
    return JSON.parse(String(text || ""))
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

// Schema v1. Anything else, a version this plugin does not know included,
// reads as idle, so a newer Sotto never leaves a pill on screen that the
// plugin cannot explain. Fields it does not know are ignored.
export function parse(text) {
  return fromData(parseJson(text))
}

function fromData(data) {
  if (!data || typeof data !== "object" || data.version !== 1) return idle()
  if (STATES.indexOf(data.state) === -1) return idle(data.edge)
  var detail = typeof data.detail === "string" ? data.detail.replace(/\s+/g, " ").trim() : ""
  return {
    state: data.state,
    since: finiteNumber(data.since),
    updatedAt: finiteNumber(data.updatedAt),
    detail: detail,
    kept: data.kept === true,
    edge: validEdge(data.edge) ? data.edge : "top",
    pid: processId(data.pid)
  }
}

export const UNREADABLE = "Could not read Sotto's dictation state. Trying again."

// What a read of the state file leaves the plugin with. `text` is what was
// read, or null when the read failed, and `missing` says the file does not
// exist. Only a missing file is the contract's idle. Any other failure, or
// text that is not JSON at all, keeps the last state, its buttons and its
// process check, since Sotto may still be recording, and marks it
// unreadable until a read succeeds.
export function afterRead(previous, text, missing) {
  var last = previous || idle()
  if (text === null || text === undefined) {
    return missing ? { record: idle(), unreadable: false } : { record: last, unreadable: true }
  }
  var data = parseJson(text)
  if (data === undefined) return { record: last, unreadable: true }
  return { record: fromData(data), unreadable: false }
}

// One dictation's state is told apart from the next by when it began.
export function key(record) {
  return record.state + "@" + record.since
}

// Whether `next` begins a dictation: Sotto starting or listening under a new
// key, except listening after the same dictation's start. States written
// within 50 ms of each other can arrive as one, so a new dictation is read
// from the change of key rather than from an idle in between.
export function startsDictation(previous, next) {
  if (!next || (next.state !== "starting" && next.state !== "listening")) return false
  if (!previous) return true
  if (key(previous) === key(next)) return false
  return !(previous.state === "starting" && next.state === "listening")
}

// Rule A: the display the pill shows on, by name. A new dictation takes the
// focused display and keeps it until it ends, even when the pill was already
// up for the one before; a pill that appears without one, such as a notice,
// takes the focused display too. "" while nothing shows.
export function displayFor(current, previous, next, shown, focused) {
  if (startsDictation(previous, next)) return focused
  if (!shown) return ""
  return current !== "" ? current : focused
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

// Whether to look for Sotto's process: while the file shows anything but
// idle and names the process.
export function watchesProcess(record) {
  return !!record && record.state !== "idle" && record.pid > 0
}

// Whether Sotto's process has gone, from `/proc/<pid>/stat`: null when that
// file does not exist, or its text. A process that has exited but not been
// reaped yet is gone too. Text that names another process, or that cannot
// be read, decides nothing.
export function processGone(stat, pid) {
  if (stat === null || stat === undefined) return true
  var text = String(stat)
  if (text.indexOf(String(pid) + " (") !== 0) return false
  var close = text.lastIndexOf(")")
  var state = close === -1 ? "" : text.charAt(close + 2)
  return state === "Z" || state === "X" || state === "x"
}

// What to say when Sotto's process is gone but the file still shows a
// dictation. Audio lives only in Sotto's memory, so a recording went with
// it. A finished dictation was already delivered and goes quietly.
export function lostNotice(record) {
  switch (record ? record.state : "idle") {
  case "starting":
  case "listening":
  case "transcribing":
    return "Sotto quit. This dictation was lost. Open Sotto to dictate again."
  case "failed":
    return record.kept
      ? "Sotto quit. The kept recording was lost. Open Sotto to dictate again."
      : "Sotto quit. Open Sotto to dictate again."
  }
  return ""
}

export function formatElapsed(since, now) {
  if (!since || !isFinite(since) || !isFinite(now)) return "00:00"
  var total = Math.max(0, Math.floor((now - since) / 1000))
  var minutes = Math.min(99, Math.floor(total / 60))
  var seconds = minutes === 99 ? Math.min(59, total - minutes * 60) : total % 60
  return (minutes < 10 ? "0" : "") + minutes + ":" + (seconds < 10 ? "0" : "") + seconds
}

// The pill's buttons for one state, as verbs. A verb of "dismiss" is the
// plugin's own and runs no command.
export function buttonsFor(state, record) {
  switch (state) {
  case "starting":
  case "listening":
    return ["stop", "cancel"]
  case "transcribing":
    return ["cancel"]
  case "failed":
    return record && record.kept ? ["retry", "discard"] : ["dismiss"]
  }
  return []
}

// The words over the pill's state: first what the user must act on, a
// command that did not get through or Sotto quitting; then a state file
// that could not be read, while there is a state on screen to keep.
export function noticeFor(notice, unreadable, state) {
  if (notice) return notice
  return unreadable && state !== "idle" ? UNREADABLE : ""
}

// The pill's words and buttons for one state. A notice takes the words and
// keeps the state's buttons, so a command that did not get through can be
// pressed again; a notice that Sotto quit, `lost`, has only Dismiss.
// Sotto's `detail` is shown word for word, and says whether a failed
// recording was kept; the plugin's own words, used without one, say so too.
export function pillFor(state, record, notice, lost) {
  if (notice) return { glyph: "alert", tone: "error", message: notice, buttons: lost ? ["dismiss"] : buttonsFor(state, record) }
  var buttons = buttonsFor(state, record)
  switch (state) {
  case "starting":
  case "listening":
    return { glyph: "sotto", tone: "live", message: "", buttons: buttons }
  case "transcribing":
    return { glyph: "sand", tone: "", message: "Transcribing", buttons: buttons }
  case "delivered":
    return { glyph: "check", tone: "", message: "Pasted", buttons: buttons }
  case "copied":
    return { glyph: "copy", tone: "", message: "Copied, paste with Super+V", buttons: buttons }
  case "failed":
    if (record.kept) return { glyph: "retry", tone: "error", message: record.detail || "Transcription failed. Recording kept.", buttons: buttons }
    return { glyph: "alert", tone: "error", message: record.detail || "Dictation failed. Nothing was kept.", buttons: buttons }
  }
  return { glyph: "sotto", tone: "", message: "", buttons: buttons }
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
// With nothing on screen and a state file that could not be read, only the
// glyph says so, since a pill would announce itself unasked.
export function barFor(state, record, unreadable) {
  if (unreadable && state === "idle") {
    return { glyph: "alert", alert: true, time: false, tooltip: "Start dictation. " + UNREADABLE }
  }
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

// The longest the pill may be along its edge, a gap clear of each end: the
// work area's width on the top and bottom, its height on the sides, where
// the pill stands upright.
export function maxLength(edge, area, gap) {
  var room = verticalEdge(edge) ? area.height : area.width
  return Math.max(0, Math.floor(room - 2 * gap))
}

// How long the pill's words may run on one line: what its length leaves
// after the glyph and buttons, `fixed`, at most `preferred`, and at least
// `minimum`. Longer words wrap.
export function messageWidth(length, fixed, preferred, minimum) {
  return Math.max(minimum, Math.min(preferred, Math.floor(length - fixed)))
}

// Sotto's words laid out for the pill: on one line when they fit `width`,
// and otherwise broken between sentences, each line taking whole sentences
// while they fit. A sentence longer than `width` is left for the text to
// wrap. `measure` gives a string's width; `width` in the result is the
// widest line's, at most `width`.
export function sentenceLines(message, width, measure) {
  var text = String(message || "")
  var whole = measure(text)
  if (text === "" || whole <= width) return { text: text, width: whole }
  var words = text.split(" ")
  var sentences = []
  var current = []
  for (var i = 0; i < words.length; i++) {
    current.push(words[i])
    if (/[.!?]$/.test(words[i]) || i === words.length - 1) {
      sentences.push(current.join(" "))
      current = []
    }
  }
  var lines = []
  var line = ""
  for (var j = 0; j < sentences.length; j++) {
    var joined = line === "" ? sentences[j] : line + " " + sentences[j]
    if (line !== "" && measure(joined) > width) {
      lines.push(line)
      line = sentences[j]
    } else {
      line = joined
    }
  }
  lines.push(line)
  var widest = 0
  for (var k = 0; k < lines.length; k++) widest = Math.max(widest, measure(lines[k]))
  return { text: lines.join("\n"), width: Math.min(widest, width) }
}

// Centred on its edge, `gap` in from the work area, as the Windows pill is
// centred on its edge of the work area. A pill longer than the room starts
// at the area's start, so its glyph and words stay on screen.
export function restingPosition(edge, area, width, height, gap) {
  var centreX = area.x + Math.max(0, Math.round((area.width - width) / 2))
  var centreY = area.y + Math.max(0, Math.round((area.height - height) / 2))
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

// A command that did not get through, in plain words for the pill. While a
// dictation is under way the pill keeps its buttons and says what to do in
// Sotto, since the recording may still be running or still be kept.
export function failureNotice(verb, started, state) {
  var recording = state === "starting" || state === "listening"
  if (verb === "place") return "Sotto did not save this edge. Open Sotto and drag again."
  if (verb === "stop" || (verb === "toggle" && recording)) {
    return "Stop did not get through. Recording may still be running. Open Sotto to stop it."
  }
  if (verb === "cancel") {
    return recording
      ? "Cancel did not get through. Recording may still be running. Open Sotto to cancel it."
      : "Cancel did not get through. Open Sotto to cancel."
  }
  if (verb === "retry") return "Try again did not get through. Recording kept. Open Sotto to try again."
  if (verb === "discard") return "Discard did not get through. Recording kept. Open Sotto to discard it."
  if (!started) return "Could not run sotto. Check the command path."
  return "Sotto did not answer. Open Sotto and try again."
}

// A notice about a dictation still on screen stays until Sotto writes
// another state or the user presses again; any other lasts NOTICE_MS.
export function noticeHolds(verb, state) {
  return verb !== "place" && ACTIVE.indexOf(state) !== -1
}
