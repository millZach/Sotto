import QtQuick
import qs.Commons
import qs.Ui
import "Model.mjs" as Model

// The pill's face, drawn the way the shell draws its OSD: the theme's
// background, the popup border, square corners from Hyprland's rounding,
// and the shell's own bordered buttons.
BorderSurface {
  id: card

  required property var service
  // On a left or right edge the card is turned upright; its glyph is turned
  // back so it still stands the right way up.
  property bool upright: false

  readonly property var dictation: service.dictation
  readonly property string status: dictation.status
  readonly property var look: Model.pillFor(status, dictation.record, service.notice)
  readonly property bool live: service.notice === "" && (status === "starting" || status === "listening")
  readonly property string buttonList: look.buttons.join(" ")

  readonly property color ink: Color.popups.text
  readonly property int pad: Style.space(12)
  // Room for Sotto's longest failure sentence, about 60 characters, on one
  // line. Longer words, such as a command that did not get through, wrap.
  readonly property int maxMessageWidth: Style.space(470)

  color: Util.alpha(Color.background, 0.97)
  borderSpec: Border.surfaceSpec("popups", "border", Color.popups.border, Math.max(1, Style.space(2)))
  radius: Style.cornerRadius
  width: Math.ceil(card.borderLeft + card.pad + row.implicitWidth + card.pad + card.borderRight)
  height: Math.max(Style.space(44), Math.ceil(row.implicitHeight) + 2 * Style.space(8))

  Accessible.role: look.tone === "error" ? Accessible.AlertMessage : Accessible.StatusBar
  Accessible.name: card.live ? "Sotto is listening" : (look.message || "Sotto dictation")

  function press(verb) {
    if (verb === "dismiss") service.dismiss()
    else service.run(verb)
  }

  TextMetrics {
    id: messageMetrics
    font.family: Style.font.family
    font.bold: true
    font.pixelSize: Style.font.subtitle
    text: card.look.message
  }

  Row {
    id: row
    x: card.borderLeft + card.pad
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.space(12)

    Item {
      width: Style.space(20)
      height: Style.space(20)
      anchors.verticalCenter: parent.verticalCenter

      Glyph {
        anchors.centerIn: parent
        rotation: card.upright ? -90 : 0
        name: card.look.glyph
        color: card.look.tone === "error" ? Color.urgent : card.ink
        fontFamily: Style.font.family
        size: name === "sotto" || name === "retry" ? Style.space(22) : Style.font.iconLarge
      }
    }

    LevelBars {
      visible: card.live
      anchors.verticalCenter: parent.verticalCenter
      listening: card.status === "listening"
      moving: listening && card.service.motion
      color: Color.accent
    }

    Text {
      visible: card.live
      width: Math.max(implicitWidth, Style.space(38))
      anchors.verticalCenter: parent.verticalCenter
      textFormat: Text.PlainText
      text: card.dictation.elapsed
      color: card.ink
      font.family: Style.font.family
      font.pixelSize: Style.font.body
    }

    Rectangle {
      id: track
      visible: card.service.notice === "" && card.status === "transcribing" && card.service.motion
      width: Style.space(142)
      height: Math.max(Style.space(6), Style.spacing.sm)
      anchors.verticalCenter: parent.verticalCenter
      color: Util.alpha(card.ink, 0.45)
      clip: true

      // Sotto reports no progress, so the fill travels rather than grows.
      Rectangle {
        width: Math.round(track.width * 0.4)
        height: parent.height
        color: Color.accent

        NumberAnimation on x {
          running: track.visible
          loops: Animation.Infinite
          from: -track.width * 0.4
          to: track.width
          duration: 1200
          easing.type: Easing.InOutSine
        }
      }
    }

    Text {
      visible: card.look.message !== ""
      width: Math.min(Math.ceil(messageMetrics.advanceWidth), card.maxMessageWidth)
      anchors.verticalCenter: parent.verticalCenter
      textFormat: Text.PlainText
      text: card.look.message
      font: messageMetrics.font
      color: card.ink
      wrapMode: Text.Wrap
      maximumLineCount: 3
      elide: Text.ElideRight
    }

    Row {
      visible: card.buttonList !== ""
      anchors.verticalCenter: parent.verticalCenter
      leftPadding: Style.space(4)
      spacing: Style.space(6)

      Repeater {
        model: card.buttonList === "" ? [] : card.buttonList.split(" ")

        Button {
          required property string modelData
          text: Model.BUTTON_TEXT[modelData]
          bordered: true
          foreground: card.ink
          fontSize: Style.font.bodySmall
          horizontalPadding: Style.space(9)
          verticalPadding: 0
          height: Style.space(24)
          Accessible.role: Accessible.Button
          Accessible.name: Model.BUTTON_NAME[modelData]
          Accessible.onPressAction: card.press(modelData)
          onClicked: card.press(modelData)
        }
      }
    }
  }
}
