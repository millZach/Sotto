import QtQuick
import Quickshell
import Quickshell.Io
import "Model.mjs" as Model

// Follows Sotto's dictation state file. Sotto writes it atomically, never
// with the transcript in it; a missing file means Sotto is idle or not
// running, and the plugin shows nothing but the bar glyph.
Item {
  id: root
  visible: false

  readonly property string runtimeDir: Quickshell.env("XDG_RUNTIME_DIR") || ""
  readonly property string path: runtimeDir === "" ? "" : runtimeDir + "/sotto/dictation-state.json"

  property var record: Model.idle()
  // The dictation the user put away (Dismiss, or a command Sotto never took)
  // stays hidden until Sotto moves on to another.
  property string dismissedKey: ""
  property double now: Date.now()

  // The state on screen, as opposed to the one in the file.
  readonly property string status: Model.effectiveState(record, now, dismissedKey)
  readonly property bool active: status !== "idle"
  readonly property string elapsed: Model.formatElapsed(record.since, now)

  function dismiss() {
    dismissedKey = Model.key(record)
  }

  function refresh() {
    now = Date.now()
    var expiry = Model.nextExpiry(record, now)
    if (expiry > 0) {
      holdTimer.interval = Math.max(1, expiry - now)
      holdTimer.restart()
    } else {
      holdTimer.stop()
    }
  }

  function apply(text) {
    record = Model.parse(text)
    refresh()
  }

  FileView {
    id: file
    path: root.path
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.apply(text())
    onLoadFailed: root.apply("")
  }

  // A file that is missing when watching starts is never noticed, so look
  // for it once a second until it appears. Once loaded, the watch follows
  // Sotto's atomic replacements and a later removal on its own.
  Timer {
    interval: 1000
    repeat: true
    running: root.path !== "" && !file.loaded
    onTriggered: file.reload()
  }

  Timer {
    id: holdTimer
    repeat: false
    onTriggered: root.refresh()
  }

  // A quarter-second tick keeps the listening timer within a beat of the
  // second, and runs only while Sotto listens.
  Timer {
    interval: 250
    repeat: true
    running: root.status === "listening"
    onTriggered: root.now = Date.now()
  }
}
