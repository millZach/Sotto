import QtQuick
import qs.Commons
import qs.Ui
import "Model.mjs" as Model

// Sotto's glyph in the bar. It rests there, shows what dictation is doing
// while the pill is up, and a press runs `sotto dictation toggle`.
BarWidget {
  id: root
  moduleName: "sotto.dictation"

  readonly property string commandSetting: Model.cleanCommand(root.setting("command", "sotto"))

  // The plugin's service owns the pill. Under a replacement bar a widget
  // cannot reach it, so the glyph then follows the state file on its own.
  property var service: null
  readonly property var dictation: service ? service.dictation : (ownState.item || null)
  readonly property string status: dictation ? dictation.status : "idle"
  readonly property var record: dictation ? dictation.record : Model.idle()
  // Without the service there is no pill to say a command failed or Sotto
  // quit, so the glyph says it for a few seconds instead.
  property string notice: ""
  readonly property var look: notice !== ""
    ? { glyph: "alert", alert: true, time: false, tooltip: notice }
    : Model.barFor(status, record)
  readonly property bool showTime: look.time && !vertical
  readonly property color ink: look.alert ? (bar ? bar.urgent : Color.urgent) : (bar ? bar.barForeground : Color.foreground)
  // The bar shows its shared tooltip only for a target that says it is hovered.
  readonly property bool tooltipHovered: visible && mouse.containsMouse

  function findService() {
    var found = bar && bar.shell && typeof bar.shell.serviceFor === "function"
      ? bar.shell.serviceFor("sotto.dictation") : null
    if (found !== service) service = found
    if (service) service.useCommand(commandSetting)
    return service !== null
  }

  function press() {
    if (service) service.run("toggle")
    else ownCommands.run("toggle")
  }

  onBarChanged: findService()
  onCommandSettingChanged: if (service) service.useCommand(commandSetting)
  Component.onCompleted: findService()

  // The service may load a moment after the widget: look for it often at
  // first, then now and then.
  Timer {
    property int tries: 0
    interval: tries < 40 ? 250 : 5000
    repeat: true
    running: root.service === null
    onTriggered: { tries++; root.findService() }
  }

  Loader {
    id: ownState
    active: root.service === null
    sourceComponent: DictationState { }
  }

  Commands {
    id: ownCommands
    command: root.commandSetting
    onFailed: function(verb, started) {
      root.notice = Model.failureNotice(verb, started, root.status)
      noticeTimer.restart()
    }
  }

  Connections {
    target: ownState.item
    function onLost(text) {
      root.notice = text
      noticeTimer.restart()
    }
  }

  Timer {
    id: noticeTimer
    interval: Model.NOTICE_MS
    onTriggered: root.notice = ""
  }

  implicitWidth: vertical ? barSize : (showTime ? row.implicitWidth + Style.space(12) : Style.bar.iconSlot)
  implicitHeight: vertical ? Style.bar.iconSlot : barSize

  Accessible.role: Accessible.Button
  Accessible.name: look.tooltip
  Accessible.onPressAction: root.press()

  Row {
    id: row
    anchors.centerIn: parent
    spacing: Style.space(6)

    Glyph {
      anchors.verticalCenter: parent.verticalCenter
      name: root.look.glyph
      color: root.ink
      fontFamily: root.bar ? root.bar.fontFamily : Style.font.family
      size: name === "sotto" || name === "retry" ? Style.space(18) : Style.bar.iconFont
    }

    Text {
      visible: root.showTime
      anchors.verticalCenter: parent.verticalCenter
      textFormat: Text.PlainText
      text: root.dictation ? root.dictation.elapsed : "00:00"
      color: root.ink
      font.family: root.bar ? root.bar.fontFamily : Style.font.family
      font.pixelSize: Style.font.body
      renderType: Text.NativeRendering
    }
  }

  MouseArea {
    id: mouse
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    acceptedButtons: Qt.LeftButton
    onClicked: {
      if (root.bar) root.bar.hideTooltip(root)
      root.press()
    }
    onEntered: if (root.bar) root.bar.showTooltip(root, root.look.tooltip)
    onExited: if (root.bar) root.bar.hideTooltip(root)
  }

  onLookChanged: if (tooltipHovered && bar) bar.showTooltip(root, look.tooltip)
}
