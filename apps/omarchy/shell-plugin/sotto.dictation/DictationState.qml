import QtQuick
import Quickshell
import Quickshell.Io
import "Model.mjs" as Model

// Follows Sotto's dictation state file. Sotto writes it atomically, never
// with the transcript in it; a missing file means Sotto is idle or not
// running, and the plugin shows nothing but the bar glyph. A file that
// cannot be read for any other reason keeps what was read before, since
// Sotto may still be recording, and is read again every few seconds. A file
// that outlives Sotto's process was left by a crash: what it shows is not
// happening, so it is put away and `lost` says what went with it.
Item {
  id: root
  visible: false

  readonly property string runtimeDir: Quickshell.env("XDG_RUNTIME_DIR") || ""
  readonly property string path: runtimeDir === "" ? "" : runtimeDir + "/sotto/dictation-state.json"

  property var record: Model.idle()
  // The last read failed for a reason other than a missing file.
  property bool unreadable: false
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

  signal lost(string notice)

  // Sotto's process, while the file shows a dictation and names it. An
  // older Sotto names none, and its file is taken at its word.
  readonly property bool watching: Model.watchesProcess(record) && dismissedKey !== Model.key(record)

  // The notice goes up before the state is put away, so a pill that says
  // Sotto quit stays on the display and surface it was already on.
  function checkProcess(stat) {
    if (!watching || !Model.processGone(stat, record.pid)) return
    var notice = Model.lostNotice(record)
    if (notice !== "") lost(notice)
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

  // `text` is null when the read failed, and `missing` when it failed
  // because there is no file.
  function read(text, missing) {
    var next = Model.afterRead(record, text, missing)
    unreadable = next.unreadable
    if (next.record !== record) record = next.record
    refresh()
  }

  FileView {
    id: file
    path: root.path
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.read(text(), false)
    onLoadFailed: function(error) { root.read(null, error === FileViewError.FileNotFound) }
  }

  // A file that is missing when watching starts is never noticed, and one
  // that cannot be read cannot be watched, so look again until a read
  // succeeds. Once loaded, the watch follows Sotto's atomic replacements
  // and a later removal on its own.
  Timer {
    interval: root.unreadable ? Model.UNREADABLE_RETRY_MS : Model.MISSING_RETRY_MS
    repeat: true
    running: root.path !== "" && (!file.loaded || root.unreadable)
    onTriggered: file.reload()
  }

  // A cheap read of /proc, never a shell, when the file names a process and
  // every few seconds after.
  FileView {
    id: processFile
    path: root.watching ? "/proc/" + root.record.pid + "/stat" : ""
    printErrors: false
    onLoaded: root.checkProcess(text())
    onLoadFailed: function(error) {
      if (error === FileViewError.FileNotFound) root.checkProcess(null)
    }
  }

  Timer {
    interval: Model.PROCESS_CHECK_MS
    repeat: true
    running: root.watching
    onTriggered: processFile.reload()
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
