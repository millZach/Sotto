import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import "Model.mjs" as Model

// The plugin's one long-lived part. It follows Sotto's state file, runs the
// dictation command, and shows the pill while Sotto dictates: on the display
// Hyprland has focused when each dictation starts, until it ends.
Item {
  id: root
  visible: false

  // Injected by omarchy-shell: this plugin's scoped shell facade.
  property var shell: null
  property var manifest: null

  property alias dictation: dictationState

  // The bar widget hands over its live setting; until it does, read the
  // widget's entry in shell.json.
  property string commandSetting: ""
  readonly property string command: commandSetting !== ""
    ? commandSetting : Model.commandFrom(shell ? shell.barConfig : null, "sotto.dictation")

  function useCommand(value) {
    commandSetting = Model.cleanCommand(value)
  }

  // The bar's strip, which the pill keeps clear of on the bar's edge.
  readonly property var barState: shell ? shell.bar : null
  readonly property string barPosition: barState ? String(barState.position || "top") : "top"
  readonly property int barSize: barState && !barState.barHidden ? Math.max(0, barState.barSize || 0) : 0

  // A drag's edge holds until the pill closes or Sotto reports an edge of
  // its own, which is newer.
  property string draggedEdge: ""
  readonly property string savedEdge: dictation.record.edge
  readonly property string edge: draggedEdge !== "" ? draggedEdge : savedEdge
  onSavedEdgeChanged: draggedEdge = ""

  // What to say when a command did not get through. A notice about a
  // dictation still on screen keeps the pill and its buttons, and stays
  // until Sotto writes another state or the user presses again; any other
  // lasts a few seconds. A failed command never puts a dictation away.
  // A notice that Sotto quit stays until it is dismissed or Sotto is back.
  property string notice: ""
  property bool noticeLost: false
  property string noticeShownFor: ""

  readonly property bool shown: dictation.active || notice !== ""
  // The display the pill is on, by name, chosen by Model.displayFor.
  property string pillScreenName: ""
  readonly property var pillScreen: screenNamed(pillScreenName)
  property var lastRecord: null

  // Omarchy has no reduced-motion setting, so Hyprland's animations switch
  // stands in for one: with it off, the level bars and the transcribing
  // track hold still and the pill does not glide to its edge.
  property bool motion: true

  Process {
    id: motionProbe
    command: ["hyprctl", "-j", "getoption", "animations:enabled"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.motion = Model.animationsEnabled(text)
    }
  }

  function screenNamed(name) {
    var screens = Quickshell.screens
    for (var i = 0; i < screens.length; i++) {
      if (screens[i] && name !== "" && screens[i].name === name) return screens[i]
    }
    return null
  }

  function focusedName() {
    var monitor = Hyprland.focusedMonitor
    var name = monitor ? String(monitor.name || "") : ""
    if (screenNamed(name) !== null) return name
    var screens = Quickshell.screens
    return screens.length > 0 && screens[0] ? String(screens[0].name) : ""
  }

  onShownChanged: {
    pillScreenName = Model.displayFor(pillScreenName, dictation.record, dictation.record, shown, focusedName())
    if (shown) motionProbe.running = true
    else draggedEdge = ""
  }

  Component.onCompleted: {
    motionProbe.running = true
    lastRecord = dictation.record
    if (shown) pillScreenName = focusedName()
  }

  Connections {
    target: Quickshell
    function onScreensChanged() {
      if (root.shown && root.screenNamed(root.pillScreenName) === null) root.pillScreenName = root.focusedName()
    }
  }

  function run(verb, argument) {
    endNotice()
    commands.run(verb, argument)
  }

  function place(edge) {
    if (!Model.validEdge(edge)) return
    draggedEdge = edge
    commands.run("place", edge)
  }

  function dismiss() {
    endNotice()
    dictation.dismiss()
  }

  function showNotice(verb, started) {
    var state = dictation.status
    noticeShownFor = Model.key(dictation.record)
    noticeLost = false
    notice = Model.failureNotice(verb, started, state)
    if (Model.noticeHolds(verb, state)) noticeTimer.stop()
    else noticeTimer.restart()
  }

  function showLost(text) {
    noticeTimer.stop()
    noticeShownFor = Model.key(dictation.record)
    noticeLost = true
    notice = text
  }

  function endNotice() {
    noticeTimer.stop()
    noticeShownFor = ""
    noticeLost = false
    notice = ""
  }

  Connections {
    target: root.dictation
    function onRecordChanged() {
      var record = root.dictation.record
      root.pillScreenName = Model.displayFor(root.pillScreenName, root.lastRecord, record, root.shown, root.focusedName())
      root.lastRecord = record
      if (root.notice !== "" && Model.key(record) !== root.noticeShownFor) root.endNotice()
    }
    function onLost(text) { root.showLost(text) }
  }

  DictationState {
    id: dictationState
  }

  Commands {
    id: commands
    command: root.command
    onFailed: function(verb, started) { root.showNotice(verb, started) }
  }

  Timer {
    id: noticeTimer
    interval: Model.NOTICE_MS
    onTriggered: root.endNotice()
  }

  LazyLoader {
    active: root.shown && root.pillScreen !== null

    Pill {
      service: root
      screen: root.pillScreen
    }
  }
}
