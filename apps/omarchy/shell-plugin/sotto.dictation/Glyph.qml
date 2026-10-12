import QtQuick
import QtQuick.Shapes
import "Model.mjs" as Model

// One glyph by name. Sotto's mark (the owl without its tile) and Try again's
// arrow are drawn; the rest are the shell font's Nerd Font glyphs.
Item {
  id: root

  property string name: "sotto"
  property color color: "white"
  property string fontFamily: "monospace"
  property real size: 16

  implicitWidth: size
  implicitHeight: size

  readonly property bool drawn: name === "sotto" || name === "retry"

  // The owl from build/tray-template.svg, Sotto's mark simplified for 16
  // pixels: the head with its eyes cut through and larger pupils, without
  // the beak. Drawn on that file's 16-unit grid and scaled to the slot, so
  // at 16 px it lands on whole pixels.
  Shape {
    visible: root.name === "sotto"
    width: 16
    height: 16
    anchors.centerIn: parent
    scale: root.size / 16
    preferredRendererType: Shape.CurveRenderer

    ShapePath {
      strokeWidth: -1
      fillColor: root.color
      fillRule: ShapePath.OddEvenFill
      PathSvg { path: "M1.27 4.8C0.84 3.93 0.73 2.31 1.49 1.22C1.63 0.95 1.93 0.68 2.06 1.22C2.12 2.03 2.71 2.9 3.93 2.9C5.83 2.2 10.17 1.76 12.94 3.34C13.69 3.28 14.4 2.71 14.45 1.82C14.51 1.57 14.73 1.57 14.83 1.98C15.32 2.58 15.54 4.26 14.94 5.56C15.38 6.1 15.7 7.46 15.7 9.63C15.76 12.12 15.29 13.37 13.97 14.24C12.75 15.19 10.17 15.24 8 15.24C5.8 15.24 3.23 15.19 2.01 14.24C0.68 13.37 0.22 12.12 0.27 9.63C0.24 7.19 0.52 5.83 1.27 4.8ZM1.84 8.95C1.82 7.05 2.25 6.07 3.66 6.07C5.34 6.02 6.75 6.21 6.73 8.54C6.73 10.44 6.1 11.31 4.34 11.31C2.58 11.34 1.82 10.58 1.84 8.95ZM9.33 9.22C9.33 8.14 9.63 7.67 10.44 7.46L13.1 6.92C13.8 6.78 14.13 7.46 14.13 8.81C14.16 10.71 13.69 11.34 11.66 11.34C10.17 11.34 9.33 10.71 9.33 9.22Z" }
    }
    ShapePath {
      strokeWidth: -1
      fillColor: root.color
      PathSvg { path: "M4.1 8.22a1.19 1.19 0 1 0 2.38 0a1.19 1.19 0 1 0 -2.38 0ZM9.6 8.87a1.19 1.19 0 1 0 2.38 0a1.19 1.19 0 1 0 -2.38 0Z" }
    }
  }

  // Try again's arrow, square-ended like the shell's own strokes, on a
  // 24-unit grid scaled to the slot.
  Shape {
    visible: root.name === "retry"
    width: 24
    height: 24
    anchors.centerIn: parent
    scale: root.size / 24
    preferredRendererType: Shape.CurveRenderer

    ShapePath {
      strokeColor: root.color
      strokeWidth: 2.4
      capStyle: ShapePath.FlatCap
      joinStyle: ShapePath.MiterJoin
      fillColor: "transparent"
      PathSvg { path: "M4 12a8 8 0 1 0 2.6-5.9L4 8.5" }
    }
    ShapePath {
      strokeColor: root.color
      strokeWidth: 2.4
      capStyle: ShapePath.FlatCap
      joinStyle: ShapePath.MiterJoin
      fillColor: "transparent"
      PathSvg { path: "M4 3.5v5h5" }
    }
  }

  Text {
    visible: !root.drawn
    anchors.centerIn: parent
    textFormat: Text.PlainText
    text: Model.GLYPH[root.name] || ""
    color: root.color
    font.family: root.fontFamily
    font.pixelSize: root.size
    renderType: Text.NativeRendering
  }
}
