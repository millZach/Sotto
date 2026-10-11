import QtQuick
import qs.Commons

// Seven bars that rise and fall while Sotto listens, in six steps per
// cycle, each a beat behind the last. Low and faint while the microphone
// opens; level and still while listening without motion.
Row {
  id: root

  property bool listening: false
  property bool moving: false
  property color color: "white"
  property int tick: 0

  readonly property var steps: [6, 10, 14, 18, 14, 10]

  spacing: Style.space(3)
  height: Style.space(20)

  Timer {
    interval: 150
    repeat: true
    running: root.moving && root.visible
    onTriggered: root.tick = (root.tick + 1) % 600
  }

  Repeater {
    model: 7

    Rectangle {
      required property int index
      readonly property int step: ((Math.floor(root.tick - index * 0.8) % 6) + 6) % 6
      width: Style.space(4)
      height: Style.space(root.moving ? root.steps[step] : (root.listening ? 12 : 6))
      anchors.verticalCenter: parent.verticalCenter
      color: root.color
      opacity: root.listening ? 1 : 0.45
    }
  }
}
