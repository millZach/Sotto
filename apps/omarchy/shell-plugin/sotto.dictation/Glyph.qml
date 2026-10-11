import QtQuick
import QtQuick.Shapes
import "Model.mjs" as Model

// One glyph by name. Sotto's mark (its bar and wave without the tile) and
// Try again's arrow are drawn, square-ended like the shell's own strokes;
// the rest are the shell font's Nerd Font glyphs.
Item {
  id: root

  property string name: "sotto"
  property color color: "white"
  property string fontFamily: "monospace"
  property real size: 16

  implicitWidth: size
  implicitHeight: size

  readonly property bool drawn: name === "sotto" || name === "retry"

  // Drawn on a 24-unit grid and scaled to the slot.
  Shape {
    visible: root.drawn
    width: 24
    height: 24
    anchors.centerIn: parent
    scale: root.size / 24
    preferredRendererType: Shape.CurveRenderer

    ShapePath {
      strokeWidth: -1
      fillColor: root.name === "sotto" ? root.color : "transparent"
      PathRectangle { x: 5.6; y: 4.5; width: 2.8; height: 15; radius: 1.4 }
    }
    ShapePath {
      strokeColor: root.name === "sotto" ? root.color : "transparent"
      strokeWidth: 2.5
      capStyle: ShapePath.RoundCap
      fillColor: "transparent"
      PathSvg { path: "M11.3 12c1.2-4.2 2.4-4.2 3.6 0s2.4 4.2 3.6 0" }
    }
    ShapePath {
      strokeColor: root.name === "retry" ? root.color : "transparent"
      strokeWidth: 2.4
      capStyle: ShapePath.FlatCap
      joinStyle: ShapePath.MiterJoin
      fillColor: "transparent"
      PathSvg { path: "M4 12a8 8 0 1 0 2.6-5.9L4 8.5" }
    }
    ShapePath {
      strokeColor: root.name === "retry" ? root.color : "transparent"
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
