import Foundation

/// Marks over a picture (ADR-0170, part 5): arrows, circles, boxes, pen lines and notes, in the picture's own pixels, as
/// the desktop's editor makes them (`src/renderer/src/agents/markup.ts`). The app draws them over the picture and onto
/// the marked copy that goes into the reply; this is what both drawings share.
public enum MarkTool: String, CaseIterable, Sendable {
    case arrow, ellipse, box, pen, note
}

public enum MarkInk: String, CaseIterable, Sendable {
    case red, amber, plain
}

/// A place on the picture, in its pixels.
public struct MarkPoint: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
}

/// One mark. A pen line keeps each point with the pen's pressure, which widens the line only when a pen drew it.
public struct Mark: Equatable, Identifiable, Sendable {
    public enum Shape: Equatable, Sendable {
        /// Arrow, circle or box: from where the drag began to where it ended.
        case drag(MarkTool, from: MarkPoint, to: MarkPoint)
        case pen(points: [MarkPoint], pressures: [Double], pressed: Bool)
        /// A note's words on a label of its ink, the label's left middle where the user pressed.
        case note(at: MarkPoint, text: String)
    }
    public let id: Int
    public let ink: MarkInk
    public var shape: Shape
    public init(id: Int, ink: MarkInk, shape: Shape) { self.id = id; self.ink = ink; self.shape = shape }

    public var tool: MarkTool {
        switch shape {
        case .drag(let tool, _, _): return tool
        case .pen: return .pen
        case .note: return .note
        }
    }
}

/// The picture's own size, in pixels.
public struct MarkupSize: Equatable, Sendable {
    public let width: Double
    public let height: Double
    public init(width: Double, height: Double) { self.width = width; self.height = height }
    var longer: Double { max(width, height) }
}

public enum Markup {
    /// The longest note, in characters.
    public static let noteMaxLength = 120

    /// How wide a line is on this picture: the same share of its longer side at any size.
    public static func strokeWidth(_ size: MarkupSize) -> Double { size.longer / 200 }

    /// The size a note's words are set in on this picture.
    public static func noteFontSize(_ size: MarkupSize) -> Double { size.longer / 48 }

    /// Whether a drag made a mark rather than a press that slipped: a shape at least an 80th of the picture, a line of
    /// three points, a note with words.
    public static func madeMark(_ mark: Mark, size: MarkupSize) -> Bool {
        switch mark.shape {
        case .drag(_, let from, let to): return hypot(to.x - from.x, to.y - from.y) > size.longer / 80
        case .pen(let points, _, _): return points.count > 2
        case .note(_, let text): return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    /// The arrow's shaft end and the three corners of its head.
    public static func arrow(from: MarkPoint, to: MarkPoint, size: MarkupSize) -> (shaft: MarkPoint, head: [MarkPoint]) {
        let angle = atan2(to.y - from.y, to.x - from.x), length = strokeWidth(size) * 6
        func corner(_ turn: Double) -> MarkPoint { MarkPoint(x: to.x - length * cos(angle + turn), y: to.y - length * sin(angle + turn)) }
        let shaft = MarkPoint(x: to.x - cos(angle) * length * 0.6, y: to.y - sin(angle) * length * 0.6)
        return (shaft, [to, corner(-0.45), corner(0.45)])
    }

    /// How wide a pen line is from a point: wider where a pen pressed harder.
    public static func penWidth(pressure: Double, pressed: Bool, size: MarkupSize) -> Double {
        strokeWidth(size) * (pressed ? 0.5 + pressure * 1.6 : 1)
    }

    /// The rectangle a drag spans, its corner nearest the origin first.
    public static func span(from: MarkPoint, to: MarkPoint) -> (x: Double, y: Double, width: Double, height: Double) {
        (min(from.x, to.x), min(from.y, to.y), abs(to.x - from.x), abs(to.y - from.y))
    }

    /// A note's label, given how wide its words are set.
    public static func noteBox(at: MarkPoint, textWidth: Double, size: MarkupSize) -> (x: Double, y: Double, width: Double, height: Double, radius: Double, textX: Double) {
        let font = noteFontSize(size), height = font * 1.7
        return (at.x, at.y - height / 2, textWidth + font * 1.2, height, font * 0.3, at.x + font * 0.6)
    }

    /// The marked copy's name: the picture's own with "marked up" after it, as the desktop names it. Not translated: it
    /// is the file's name, which the agent reads.
    public static func markedName(_ name: String) -> String {
        var stem = name
        if let dot = stem.lastIndex(of: "."), dot != stem.startIndex { stem = String(stem[..<dot]) }
        stem = stem.trimmingCharacters(in: .whitespaces)
        if stem.isEmpty || stem.hasPrefix(".") { stem = "Picture" }
        return stem + " marked up"
    }
}

/// The marks made so far, with Undo and Redo. Taking a mark off can be undone too.
public struct MarkupHistory: Equatable, Sendable {
    public private(set) var marks: [Mark] = []
    private var past: [[Mark]] = []
    private var future: [[Mark]] = []
    private var nextID = 1
    public init() {}

    public var canUndo: Bool { !past.isEmpty }
    public var canRedo: Bool { !future.isEmpty }

    /// A new mark's number.
    public mutating func newID() -> Int { defer { nextID += 1 }; return nextID }

    /// Keeps the mark when it is one, and says whether it was.
    @discardableResult
    public mutating func add(_ mark: Mark, size: MarkupSize) -> Bool {
        guard Markup.madeMark(mark, size: size) else { return false }
        past.append(marks); marks.append(mark); future = []
        return true
    }
    public mutating func remove(_ id: Int) {
        guard marks.contains(where: { $0.id == id }) else { return }
        past.append(marks); marks.removeAll { $0.id == id }; future = []
    }
    public mutating func undo() {
        guard let last = past.popLast() else { return }
        future.insert(marks, at: 0); marks = last
    }
    public mutating func redo() {
        guard !future.isEmpty else { return }
        past.append(marks); marks = future.removeFirst()
    }
}
