import Foundation

/// The owl at the easel (ADR-0170): Watcher's owl paints a picture on an easel under the night sky while an agent makes
/// an image. The desktop draws the same scene from `src/renderer/src/agents/owlEasel.ts`; this is its port. A frame is
/// two layers of text the same size: `paint`, the picture as it is painted, and `sketch`, the easel, the owl, its brush
/// and the stars. Nothing here draws; the tile writes the text.
public enum OwlEasel {
    /// The rows a tile's scene uses: coarse, so its characters stay readable in a tile.
    public static let tileRows = 12
    /// Text frames a second while the scene is on screen. Twelve is plenty for text.
    public static let framesPerSecond = 12.0

    public struct Frame: Equatable, Sendable {
        public let paint: String
        public let sketch: String
    }

    /// The grid for a box: its rows fill the height with a little air between lines, and as many columns as then fit.
    /// A character is 0.6 of the font size wide in a mono face, and SwiftUI sets a line about 1.2 of it tall.
    public static func grid(width: Double, height: Double, rows: Int = tileRows) -> (cols: Int, rows: Int, fontSize: Double) {
        let fontSize = height / Double(rows) / 1.2
        return (max(20, Int((width / (fontSize * 0.6)).rounded(.down))), rows, fontSize)
    }

    private static let ramp = Array(" .:-=+*#%@")
    private static let segment = 6

    /// How far along the painting is, `seconds` after the step started. No provider says how far an image has got, so it
    /// slows as it goes and never finishes on its own: the picture arriving ends it.
    public static func progress(seconds: Double, expected: Double = 30) -> Double {
        min(0.97, 1 - exp(-max(0, seconds) / (expected / 3.2)))
    }

    /// The painting's brightness at a point of its unit square: a dusk sky, a sun, a lighthouse and the sea below it.
    private static func light(_ u: Double, _ v: Double) -> Double {
        let horizon = 0.64
        var value: Double
        if v < horizon {
            value = 0.1 + 0.5 * pow(v / horizon, 2.2)
            let dx = (u - 0.3) * 1.1, dy = v - 0.53
            if dx * dx + dy * dy < 0.011 { value = 0.97 }
        } else {
            value = 0.14 + 0.08 * sin(u * 34 + v * 70)
            if abs(u - 0.3) < 0.07 * (1 - (v - horizon) * 2) && sin(v * 140) > 0.1 { value = 0.78 }
        }
        let bx = 0.72 - u, by = v - 0.27
        if bx > 0 && abs(by) < bx * 0.2 && v < horizon { value = max(value, 0.5) }
        if v > 0.3 && v < 0.68 {
            let half = 0.024 + 0.034 * (v - 0.3) / 0.38
            if abs(u - 0.72) < half { value = Int(((v - 0.3) / 0.075).rounded(.down)) % 2 == 1 ? 0.45 : 0.92 }
        }
        if v > 0.23 && v <= 0.3 && abs(u - 0.72) < 0.032 { value = 1 }
        if v > 0.19 && v <= 0.23 && abs(u - 0.72) < 0.03 - (0.23 - v) { value = 0.55 }
        if v > 0.63 && v < 0.74 && u > 0.56 && u < 0.9 && v > 0.66 - 0.05 * cos((u - 0.73) * 9) { value = 0.3 }
        return max(0, min(0.999, value))
    }

    private static func hash(_ x: Int, _ y: Int, _ seed: Double = 1) -> Double {
        let n = sin(Double(x) * 127.1 + Double(y) * 311.7 + seed * 74.7) * 43758.5453
        return n - n.rounded(.down)
    }

    private static func lines(_ cols: Int, _ rows: Int, _ cell: (Int, Int) -> Character) -> String {
        var lines: [String] = []
        lines.reserveCapacity(rows)
        for y in 0..<rows {
            var line = ""
            line.reserveCapacity(cols)
            for x in 0..<cols { line.append(cell(x, y)) }
            lines.append(line)
        }
        return lines.joined(separator: "\n")
    }

    /// One frame of the scene, `cols` by `rows` characters, `progress` of the way painted, `seconds` into it.
    public static func frame(cols: Int, rows: Int, progress: Double, seconds: Double) -> Frame {
        let fx0 = Int((Double(cols) * 0.4).rounded()), fx1 = cols - 2, fy0 = 1, fy1 = rows - 5
        let width = max(1, fx1 - fx0 - 1), height = max(1, fy1 - fy0 - 1)
        var strokes: [(y: Int, x: Int)] = []
        for y in 0..<height { for x in stride(from: 0, to: width, by: segment) { strokes.append((y, x)) } }
        strokes.sort { Double($0.y) + hash($0.x, $0.y) * 6 < Double($1.y) + hash($1.x, $1.y) * 6 }
        let done = Int((max(0, min(1, progress)) * Double(strokes.count)).rounded(.down))
        let painted = Set(strokes.prefix(done).map { $0.y * 1000 + $0.x })
        let last = done > 0 ? strokes[done - 1] : (y: 0, x: 0)
        let owlRow = rows - 5, ox = 1
        // It blinks at the end of each 3.4 seconds, so the still frame reduced motion holds has its eyes open.
        let blink = seconds.truncatingRemainder(dividingBy: 3.4) > 3.25
        let arm = Int((seconds * 4).rounded(.down)) % 2 == 1
        let owl = [" ,___,", blink ? " (-v-)" : " (OvO)", arm ? " (/ \\)_/" : " (/ \\)-~", "  ^ ^"].map { Array($0) }
        let paint = lines(cols, rows) { x, y in
            guard x > fx0, x < fx1, y > fy0, y < fy1 else { return " " }
            let ix = x - fx0 - 1, iy = y - fy0 - 1
            guard painted.contains(iy * 1000 + (ix / segment) * segment) else { return " " }
            return ramp[Int(light(Double(ix) / Double(width), Double(iy) / Double(height)) * 10)]
        }
        let brushY = fy0 + 1 + last.y, brushX = fx0 + 1 + last.x + Int((seconds * 8).truncatingRemainder(dividingBy: Double(segment)))
        let sketch = lines(cols, rows) { x, y in
            if y == brushY && x == brushX { return "/" }
            if (x == fx0 || x == fx1) && y >= fy0 && y <= fy1 { return y == fy0 || y == fy1 ? "+" : "|" }
            if (y == fy0 || y == fy1) && x > fx0 && x < fx1 { return "-" }
            let leg = y - fy1
            if leg > 0 && y < rows - 1 {
                if x == fx0 + 2 - leg { return "/" }
                if x == fx1 - 2 + leg { return "\\" }
                if x == Int((Double(fx0 + fx1) / 2).rounded()) { return "|" }
            }
            if y == rows - 1 { return "_" }
            let oy = y - owlRow
            if oy >= 0 && oy < owl.count && x >= ox && x - ox < owl[oy].count { return owl[oy][x - ox] }
            if y < owlRow - 1 && x < fx0 - 1 {
                let h = hash(x, y)
                if h > 0.95 { return sin(seconds * 2 + h * 40) > 0.3 ? "*" : "." }
                if h > 0.92 { return "." }
            }
            return " "
        }
        return Frame(paint: paint, sketch: sketch)
    }
}
