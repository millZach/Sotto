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

/// What the row of tools picks: a mark to draw, or Move, which picks marks up and never draws.
public enum MarkupTool: Hashable, Sendable {
    case move
    case draw(MarkTool)
    /// In the order the editor shows them.
    public static let all: [MarkupTool] = [.move] + MarkTool.allCases.map { .draw($0) }
}

/// A place on the picture, in its pixels.
public struct MarkPoint: Equatable, Sendable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
}

/// One point of a pen line, with how hard the pen pressed there.
public struct PenSample: Equatable, Sendable {
    public var point: MarkPoint
    public var pressure: Double
    public init(_ point: MarkPoint, pressure: Double) { self.point = point; self.pressure = pressure }
}

/// One shape drawn over the picture, which the interface calls a mark (not the surface **Mark**). A pen line keeps each
/// point with the pen's pressure, which widens the line only when a pen drew it.
public struct MarkupShape: Equatable, Identifiable, Sendable {
    public enum Shape: Equatable, Sendable {
        /// Arrow, circle or box: from where the drag began to where it ended.
        case drag(MarkTool, from: MarkPoint, to: MarkPoint)
        case pen(samples: [PenSample], pressed: Bool)
        /// A note's words in its ink with a thin edge, their left middle where the user pressed, at `scale` of the
        /// picture's usual text size. `on` is the mark it sits on, whose moves it follows, or nil when it is free.
        case note(at: MarkPoint, text: String, scale: Double, on: Int?)
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

    /// The sizes the text buttons step through, as shares of the picture's usual text size.
    public static let noteScales: [Double] = [0.7, 1, 1.4, 1.9, 2.6]

    /// The size a note's words are set in on this picture, at `scale` of the usual size.
    public static func noteFontSize(_ size: MarkupSize, scale: Double = 1) -> Double { size.longer / 48 * scale }

    /// How wide the edge around a note's words is drawn; the words go over it, so half of it shows.
    public static func noteEdgeWidth(_ size: MarkupSize, scale: Double) -> Double { noteFontSize(size, scale: scale) * 0.1 }

    /// The next size up or down from `scale`, staying on the last one at either end.
    public static func nextNoteScale(_ scale: Double, by step: Int) -> Double {
        let nearest = noteScales.indices.min { abs(noteScales[$0] - scale) < abs(noteScales[$1] - scale) } ?? 1
        return noteScales[max(0, min(noteScales.count - 1, nearest + step))]
    }

    /// Whether a drag made a mark rather than a press that slipped: a shape at least an 80th of the picture, a line of
    /// three points, a note with words.
    public static func madeMark(_ mark: MarkupShape, size: MarkupSize) -> Bool {
        switch mark.shape {
        case .drag(_, let from, let to): return hypot(to.x - from.x, to.y - from.y) > size.longer / 80
        case .pen(let samples, _): return samples.count > 2
        case .note(_, let text, _, _): return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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

/// A rectangle on the picture, in its pixels.
public struct MarkBounds: Equatable, Sendable {
    public var x: Double, y: Double, width: Double, height: Double
    public init(x: Double, y: Double, width: Double, height: Double) { self.x = x; self.y = y; self.width = width; self.height = height }
    public func outset(_ by: Double) -> MarkBounds { MarkBounds(x: x - by, y: y - by, width: width + by * 2, height: height + by * 2) }
    func contains(_ point: MarkPoint) -> Bool { point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height }
    func distance(to point: MarkPoint) -> Double { hypot(max(x - point.x, 0, point.x - x - width), max(y - point.y, 0, point.y - y - height)) }
}

/// What can be dragged on a selected mark: the two ends of an arrow, the corners of the rest. A note is sized by the
/// text buttons, so it has none.
public enum MarkHandle: Equatable, Sendable { case start, end, topLeft, topRight, bottomLeft, bottomRight }

/// Moving marks once they are made, as the desktop does (`markup.ts`). `noteWidth` says how wide a note's words are set,
/// which only the app can measure, given the words and their size.
public struct MarkupLayout {
    public let size: MarkupSize
    public let noteWidth: (String, Double) -> Double
    public init(size: MarkupSize, noteWidth: @escaping (String, Double) -> Double) { self.size = size; self.noteWidth = noteWidth }

    /// The rectangle a mark takes up on the picture, not counting the width of its line.
    public func bounds(_ mark: MarkupShape) -> MarkBounds {
        switch mark.shape {
        case .note(let at, let text, let scale, _):
            let font = Markup.noteFontSize(size, scale: scale), height = font * 1.3
            return MarkBounds(x: at.x, y: at.y - height / 2, width: noteWidth(text, font), height: height)
        case .pen(let samples, _):
            let xs = samples.map(\.point.x), ys = samples.map(\.point.y)
            let x = xs.min() ?? 0, y = ys.min() ?? 0
            return MarkBounds(x: x, y: y, width: (xs.max() ?? 0) - x, height: (ys.max() ?? 0) - y)
        case .drag(_, let from, let to):
            let span = Markup.span(from: from, to: to)
            return MarkBounds(x: span.x, y: span.y, width: span.width, height: span.height)
        }
    }

    private func fromSegment(_ point: MarkPoint, _ a: MarkPoint, _ b: MarkPoint) -> Double {
        let dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy
        let along = length > 0 ? max(0, min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0
        return hypot(point.x - a.x - along * dx, point.y - a.y - along * dy)
    }
    /// How far a place is from what a mark draws: its line, or a note's words.
    private func distance(_ mark: MarkupShape, _ point: MarkPoint) -> Double {
        let box = bounds(mark)
        switch mark.shape {
        case .note: return box.distance(to: point)
        case .pen(let samples, _):
            return zip(samples, samples.dropFirst()).map { fromSegment(point, $0.point, $1.point) }.min() ?? .infinity
        case .drag(.box, _, _):
            if !box.contains(point) { return box.distance(to: point) }
            return min(point.x - box.x, box.x + box.width - point.x, point.y - box.y, box.y + box.height - point.y)
        case .drag(.ellipse, _, _):
            // A circle drawn or resized flat is a line, which is only near the places beside it.
            if box.width == 0 || box.height == 0 { return box.distance(to: point) }
            return abs(across(box, point) - 1) * min(box.width, box.height) / 2
        case .drag(_, let from, let to): return fromSegment(point, from, to)
        }
    }
    private func across(_ box: MarkBounds, _ point: MarkPoint) -> Double {
        hypot((point.x - box.x - box.width / 2) / (box.width > 0 ? box.width / 2 : 1), (point.y - box.y - box.height / 2) / (box.height > 0 ? box.height / 2 : 1))
    }
    /// Whether a place is inside a box or a circle.
    private func inside(_ mark: MarkupShape, _ point: MarkPoint) -> Bool {
        switch mark.shape {
        case .drag(.box, _, _): return bounds(mark).contains(point)
        case .drag(.ellipse, _, _):
            let box = bounds(mark)
            return box.width > 0 && box.height > 0 && across(box, point) <= 1
        default: return false
        }
    }
    /// Of the marks around a place, the smallest, so a box inside a box can be reached.
    private func smallest(_ marks: [MarkupShape]) -> MarkupShape? {
        marks.min { let a = bounds($0), b = bounds($1); return a.width * a.height < b.width * b.height }
    }
    private func isNote(_ mark: MarkupShape) -> Bool { mark.tool == .note }

    /// The mark Move picks up at a place: a note's words first, then the newest line within `reach`, then the smallest
    /// box or circle the place is inside, so a note or an arrow on a box can still be reached.
    public func mark(at point: MarkPoint, reach: Double, in marks: [MarkupShape]) -> MarkupShape? {
        let newestFirst = marks.reversed()
        return newestFirst.first { isNote($0) && distance($0, point) <= reach }
            ?? newestFirst.first { !isNote($0) && distance($0, point) <= reach }
            ?? smallest(marks.filter { inside($0, point) })
    }

    /// The mark a note at this place belongs to: the smallest one the place is inside or within `reach` of, and never another note.
    public func holder(at point: MarkPoint, reach: Double, in marks: [MarkupShape]) -> MarkupShape? {
        smallest(marks.filter { !isNote($0) && (inside($0, point) || distance($0, point) <= reach) })
    }

    /// The marks that move together with this one: a note moves alone, and a shape brings the notes on it.
    public func movingWith(_ id: Int, in marks: [MarkupShape]) -> Set<Int> {
        guard let lead = marks.first(where: { $0.id == id }) else { return [] }
        if isNote(lead) { return [id] }
        var moving: Set<Int> = [id]
        for mark in marks { if case .note(_, _, _, let on) = mark.shape, on == id { moving.insert(mark.id) } }
        return moving
    }

    /// `marks` with `moving` shifted by as much of `dx`, `dy` as keeps them on the picture. Anything wider or taller than
    /// the picture keeps its start on it.
    public func move(_ marks: [MarkupShape], _ moving: Set<Int>, dx: Double, dy: Double) -> [MarkupShape] {
        var left = Double.infinity, top = Double.infinity, right = -Double.infinity, bottom = -Double.infinity
        for mark in marks where moving.contains(mark.id) {
            let box = bounds(mark)
            left = min(left, box.x); top = min(top, box.y); right = max(right, box.x + box.width); bottom = max(bottom, box.y + box.height)
        }
        func keep(_ by: Double, _ low: Double, _ high: Double) -> Double { low > high ? low : min(high, max(low, by)) }
        let x = keep(dx, -left, size.width - right), y = keep(dy, -top, size.height - bottom)
        return marks.map { moving.contains($0.id) ? shifted($0, x, y) : $0 }
    }
    private func shifted(_ mark: MarkupShape, _ dx: Double, _ dy: Double) -> MarkupShape {
        var moved = mark
        func by(_ point: MarkPoint) -> MarkPoint { MarkPoint(x: point.x + dx, y: point.y + dy) }
        switch mark.shape {
        case .drag(let tool, let from, let to): moved.shape = .drag(tool, from: by(from), to: by(to))
        case .pen(let samples, let pressed): moved.shape = .pen(samples: samples.map { PenSample(by($0.point), pressure: $0.pressure) }, pressed: pressed)
        case .note(let at, let text, let scale, let on): moved.shape = .note(at: by(at), text: text, scale: scale, on: on)
        }
        return moved
    }

    /// Text on a mark belongs to it and text off every mark is free: `marks` with this note on whatever is under the
    /// middle of its words or, failing that, their start. Placing a note and letting one go both ask this, so a long note
    /// placed near a mark's edge doesn't come off it at the next nudge.
    public func settle(_ marks: [MarkupShape], note id: Int, reach: Double) -> [MarkupShape] {
        guard let note = marks.first(where: { $0.id == id }), case .note(let at, let text, let scale, _) = note.shape else { return marks }
        let box = bounds(note)
        let on = (holder(at: MarkPoint(x: box.x + box.width / 2, y: box.y + box.height / 2), reach: reach, in: marks) ?? holder(at: at, reach: reach, in: marks))?.id
        return marks.map { mark in
            guard mark.id == id else { return mark }
            var settled = mark
            settled.shape = .note(at: at, text: text, scale: scale, on: on)
            return settled
        }
    }

    /// The places a selected mark can be dragged by.
    public func handles(_ mark: MarkupShape) -> [(handle: MarkHandle, point: MarkPoint)] {
        switch mark.shape {
        case .note: return []
        case .drag(.arrow, let from, let to): return [(.start, from), (.end, to)]
        default:
            let box = bounds(mark), right = box.x + box.width, bottom = box.y + box.height
            return [(.topLeft, MarkPoint(x: box.x, y: box.y)), (.topRight, MarkPoint(x: right, y: box.y)),
                    (.bottomLeft, MarkPoint(x: box.x, y: bottom)), (.bottomRight, MarkPoint(x: right, y: bottom))]
        }
    }

    /// `marks` with this mark resized by dragging `handle` to a place, and each note on it moved to keep its place on the
    /// mark and stay on the picture. Nil when that would leave the mark smaller than a slip, so the mark can't be lost to a resize.
    public func resize(_ marks: [MarkupShape], id: Int, handle: MarkHandle, to point: MarkPoint) -> [MarkupShape]? {
        guard let mark = marks.first(where: { $0.id == id }) else { return nil }
        let before = bounds(mark)
        var next = mark
        let left = handle == .topLeft || handle == .bottomLeft, top = handle == .topLeft || handle == .topRight
        let fixed = MarkPoint(x: left ? before.x + before.width : before.x, y: top ? before.y + before.height : before.y)
        switch mark.shape {
        case .note: return nil
        case .drag(.arrow, let from, let to):
            next.shape = handle == .start ? .drag(.arrow, from: point, to: to) : .drag(.arrow, from: from, to: point)
        case .drag(let tool, _, _):
            next.shape = .drag(tool, from: fixed, to: point)
        case .pen(let samples, let pressed):
            let startX = left ? before.x : before.x + before.width, startY = top ? before.y : before.y + before.height
            let acrossX = (point.x - fixed.x) / (startX != fixed.x ? startX - fixed.x : 1), acrossY = (point.y - fixed.y) / (startY != fixed.y ? startY - fixed.y : 1)
            next.shape = .pen(samples: samples.map { PenSample(MarkPoint(x: fixed.x + ($0.point.x - fixed.x) * acrossX, y: fixed.y + ($0.point.y - fixed.y) * acrossY), pressure: $0.pressure) }, pressed: pressed)
        }
        let after = bounds(next)
        guard hypot(after.width, after.height) > size.longer / 80 else { return nil }
        var moved: [Int] = []
        var resized = marks.map { item -> MarkupShape in
            if item.id == id { return next }
            guard case .note(let at, let text, let scale, let on) = item.shape, on == id else { return item }
            var kept = item
            kept.shape = .note(at: keptPlace(at, from: mark, to: next, before: before, after: after), text: text, scale: scale, on: on)
            moved.append(item.id)
            return kept
        }
        for note in moved { resized = move(resized, [note], dx: 0, dy: 0) }
        return resized
    }
    /// Where a note on a resized mark goes. On an arrow it turns and stretches with it, about its start, since the arrow's
    /// rectangle says little about where along it the note sat; on anything else it keeps its share of the rectangle.
    private func keptPlace(_ at: MarkPoint, from mark: MarkupShape, to next: MarkupShape, before: MarkBounds, after: MarkBounds) -> MarkPoint {
        if case .drag(.arrow, let a, let b) = mark.shape, case .drag(.arrow, let c, let d) = next.shape {
            let ux = b.x - a.x, uy = b.y - a.y, vx = d.x - c.x, vy = d.y - c.y
            let length = ux * ux + uy * uy > 0 ? ux * ux + uy * uy : 1
            let cosine = (ux * vx + uy * vy) / length, sine = (ux * vy - uy * vx) / length
            let dx = at.x - a.x, dy = at.y - a.y
            return MarkPoint(x: c.x + dx * cosine - dy * sine, y: c.y + dx * sine + dy * cosine)
        }
        return MarkPoint(x: after.x + (at.x - before.x) / (before.width > 0 ? before.width : 1) * after.width,
                         y: after.y + (at.y - before.y) / (before.height > 0 ? before.height : 1) * after.height)
    }
}

/// The marks made so far, with Undo and Redo. Taking a mark off, moving and resizing can be undone too.
public struct MarkupHistory: Equatable, Sendable {
    public private(set) var marks: [MarkupShape] = []
    private var past: [[MarkupShape]] = []
    private var future: [[MarkupShape]] = []
    private var nextID = 1
    public init() {}

    public var canUndo: Bool { !past.isEmpty }
    public var canRedo: Bool { !future.isEmpty }

    /// A new mark's number.
    public mutating func newID() -> Int { defer { nextID += 1 }; return nextID }

    /// Keeps the mark when it is one, and says whether it was.
    @discardableResult
    public mutating func add(_ mark: MarkupShape, size: MarkupSize) -> Bool {
        guard Markup.madeMark(mark, size: size) else { return false }
        past.append(marks); marks.append(mark); future = []
        return true
    }
    /// Takes a mark off, and the notes on it with it; Undo brings them all back.
    public mutating func remove(_ id: Int) {
        guard marks.contains(where: { $0.id == id }) else { return }
        past.append(marks)
        marks.removeAll { mark in
            if mark.id == id { return true }
            if case .note(_, _, _, let on) = mark.shape, on == id { return true }
            return false
        }
        future = []
    }
    /// Puts in place what a drag made of the marks, as one step of Undo. Nothing changes when nothing moved.
    public mutating func replace(with next: [MarkupShape]) {
        guard next != marks else { return }
        past.append(marks); marks = next; future = []
    }
    /// The same for a drag that began on `base`, and says whether it was kept. If the marks changed while it ran, by Undo
    /// or Delete with a second finger, the change wins: keeping the drag would bring back what was just taken away.
    @discardableResult
    public mutating func replace(with next: [MarkupShape], madeFrom base: [MarkupShape]) -> Bool {
        guard base == marks else { return false }
        replace(with: next)
        return true
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
