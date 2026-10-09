import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "Model.mjs" as Model

// The pill's surface on one display. Like the shell's OSD and notifications
// it is a full-screen, click-through layer that never takes keyboard focus;
// only the pill itself takes clicks. Dragging moves the pill inside it, so
// the compositor never stretches a surface that is changing size, and on
// release the pill snaps to the nearest edge, centred on it, and Sotto is
// asked to remember that edge.
PanelWindow {
  id: win

  required property var service

  color: "transparent"
  anchors { top: true; bottom: true; left: true; right: true }
  exclusionMode: ExclusionMode.Ignore
  WlrLayershell.namespace: "sotto-dictation"
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
  // Hyprland moves the pointer to whatever surface it is over, even with a
  // button held, so while the pill is held the whole surface takes the
  // pointer and a quick drag cannot slip out from under it.
  mask: Region {
    x: win.pressed ? 0 : frame.x
    y: win.pressed ? 0 : frame.y
    width: win.pressed ? win.width : frame.width
    height: win.pressed ? win.height : frame.height
  }

  readonly property var area: Model.workArea(width, height, service.barPosition, service.barSize)
  readonly property int gap: Style.gapsOut
  readonly property string edge: service.edge
  readonly property bool upright: Model.verticalEdge(edge)
  readonly property var rest: Model.restingPosition(edge, area, frame.width, frame.height, gap)

  property bool pressed: false
  property bool dragging: false
  property bool snapping: false
  property real pressX: 0
  property real pressY: 0
  property real startX: 0
  property real startY: 0
  property real dragX: 0
  property real dragY: 0
  property string candidateEdge: ""

  function bounds() {
    return { x: frame.x, y: frame.y, width: frame.width, height: frame.height }
  }

  function beginPress(x, y) {
    pressed = true
    snapping = false
    pressX = x
    pressY = y
    startX = frame.x
    startY = frame.y
  }

  function movePress(x, y) {
    if (!pressed) return
    var dx = x - pressX
    var dy = y - pressY
    if (!dragging && Math.sqrt(dx * dx + dy * dy) < Style.space(6)) return
    dragX = Model.clamp(startX + dx, 0, width - frame.width)
    dragY = Model.clamp(startY + dy, 0, height - frame.height)
    dragging = true
    candidateEdge = Model.snapEdge(bounds(), area)
  }

  function endPress() {
    pressed = false
    if (!dragging) return
    var target = Model.snapEdge(bounds(), area)
    snapping = true
    service.place(target)
    dragging = false
    candidateEdge = ""
    snapTimer.restart()
  }

  function cancelPress() {
    pressed = false
    if (!dragging) return
    snapping = true
    dragging = false
    candidateEdge = ""
    snapTimer.restart()
  }

  Timer {
    id: snapTimer
    interval: 220
    onTriggered: win.snapping = false
  }

  // Where the pill will rest if let go now, drawn the way the bar previews
  // its own move to another edge.
  BorderSurface {
    readonly property bool ghostUpright: Model.verticalEdge(win.candidateEdge)
    readonly property int ghostWidth: ghostUpright ? card.height : card.width
    readonly property int ghostHeight: ghostUpright ? card.width : card.height
    readonly property var place: Model.restingPosition(win.candidateEdge, win.area, ghostWidth, ghostHeight, win.gap)

    visible: win.dragging && win.candidateEdge !== ""
    x: place.x
    y: place.y
    width: ghostWidth
    height: ghostHeight
    color: Util.alpha(Color.background, 0.45)
    borderSpec: Border.flat(Color.popups.border, Math.max(1, Style.space(1)))
    radius: Style.cornerRadius
    opacity: 0.8
  }

  Item {
    id: frame

    width: win.upright ? card.height : card.width
    height: win.upright ? card.width : card.height
    x: win.dragging ? win.dragX : win.rest.x
    y: win.dragging ? win.dragY : win.rest.y

    Behavior on x {
      enabled: win.snapping && win.service.motion
      NumberAnimation { duration: 180; easing.type: Easing.OutCubic }
    }
    Behavior on y {
      enabled: win.snapping && win.service.motion
      NumberAnimation { duration: 180; easing.type: Easing.OutCubic }
    }

    // The pill's body is its handle; its buttons sit above and take their
    // own presses.
    MouseArea {
      anchors.fill: parent
      acceptedButtons: Qt.LeftButton
      preventStealing: true
      cursorShape: win.dragging ? Qt.ClosedHandCursor : Qt.OpenHandCursor
      onPressed: function(mouse) {
        var p = mapToItem(null, mouse.x, mouse.y)
        win.beginPress(p.x, p.y)
      }
      onPositionChanged: function(mouse) {
        var p = mapToItem(null, mouse.x, mouse.y)
        win.movePress(p.x, p.y)
      }
      onReleased: win.endPress()
      onCanceled: win.cancelPress()
    }

    PillCard {
      id: card
      anchors.centerIn: parent
      service: win.service
      upright: win.upright
      rotation: win.upright ? 90 : 0
    }
  }
}
