import XCTest
@testable import SottoCore

/// Marks over a picture (ADR-0170, part 5), as the iPhone's editor keeps them: the same shapes and sizes as the desktop's.
final class MarkupTests: XCTestCase {
    private let size = MarkupSize(width: 800, height: 400)
    private func point(_ x: Double, _ y: Double) -> MarkPoint { MarkPoint(x: x, y: y) }

    func testADragIsAMarkOnlyOnceItIsMoreThanASlip() {
        XCTAssertFalse(Markup.madeMark(MarkupShape(id: 1, ink: .red, shape: .drag(.box, from: point(0, 0), to: point(5, 5))), size: size))
        XCTAssertTrue(Markup.madeMark(MarkupShape(id: 1, ink: .red, shape: .drag(.box, from: point(0, 0), to: point(20, 0))), size: size))
        XCTAssertFalse(Markup.madeMark(MarkupShape(id: 1, ink: .red, shape: .pen(samples: [PenSample(point(0, 0), pressure: 0.5), PenSample(point(1, 1), pressure: 0.5)], pressed: false)), size: size))
        XCTAssertFalse(Markup.madeMark(MarkupShape(id: 1, ink: .red, shape: .note(at: point(0, 0), text: "  ", scale: 1, on: nil)), size: size))
        XCTAssertTrue(Markup.madeMark(MarkupShape(id: 1, ink: .red, shape: .note(at: point(0, 0), text: "Total", scale: 1, on: nil)), size: size))
    }

    func testLinesAreTheSameShareOfThePictureAtAnySizeAndAPenWidensWithPressure() {
        XCTAssertEqual(Markup.strokeWidth(size), 4)
        XCTAssertEqual(Markup.strokeWidth(MarkupSize(width: 1600, height: 3200)), 16)
        XCTAssertEqual(Markup.penWidth(pressure: 0.9, pressed: false, size: size), 4)
        XCTAssertGreaterThan(Markup.penWidth(pressure: 0.9, pressed: true, size: size), Markup.penWidth(pressure: 0.2, pressed: true, size: size))
    }

    func testAnArrowsHeadIsAtItsEndPointingAlongIt() {
        let (shaft, head) = Markup.arrow(from: point(0, 0), to: point(100, 0), size: size)
        XCTAssertEqual(head[0], point(100, 0))
        XCTAssertLessThan(shaft.x, 100)
        XCTAssertLessThan(head[1].x, 100)
        XCTAssertEqual(head[1].y, -head[2].y, accuracy: 0.0001)
    }

    func testUndoRedoAndTakingAMarkOffWhichCanBeUndoneToo() {
        var history = MarkupHistory()
        let arrow = MarkupShape(id: history.newID(), ink: .red, shape: .drag(.arrow, from: point(0, 0), to: point(100, 100)))
        let box = MarkupShape(id: history.newID(), ink: .amber, shape: .drag(.box, from: point(10, 10), to: point(200, 100)))
        XCTAssertNotEqual(arrow.id, box.id)
        XCTAssertTrue(history.add(arrow, size: size))
        XCTAssertTrue(history.add(box, size: size))
        XCTAssertFalse(history.add(MarkupShape(id: history.newID(), ink: .red, shape: .drag(.box, from: point(0, 0), to: point(1, 1))), size: size))
        XCTAssertEqual(history.marks.map(\.tool), [.arrow, .box])
        history.undo()
        XCTAssertEqual(history.marks.map(\.tool), [.arrow])
        XCTAssertTrue(history.canRedo)
        history.redo()
        XCTAssertEqual(history.marks.map(\.tool), [.arrow, .box])
        history.remove(arrow.id)
        XCTAssertEqual(history.marks.map(\.tool), [.box])
        history.undo()
        XCTAssertEqual(history.marks.map(\.tool), [.arrow, .box])
        // A new mark after an undo clears what could be redone.
        history.undo()
        XCTAssertTrue(history.add(MarkupShape(id: history.newID(), ink: .plain, shape: .note(at: point(5, 5), text: "Here", scale: 1, on: nil)), size: size))
        XCTAssertFalse(history.canRedo)
    }

    func testTheCopyIsNamedAfterThePictureAsOnTheDesktop() {
        XCTAssertEqual(Markup.markedName("checkout.png"), "checkout marked up")
        XCTAssertEqual(Markup.markedName("flow.final.jpeg"), "flow.final marked up")
        XCTAssertEqual(Markup.markedName("Photo 2"), "Photo 2 marked up")
        XCTAssertEqual(Markup.markedName(".png"), "Picture marked up")
    }

    // MARK: Moving marks, as on the desktop

    private let wide = MarkupSize(width: 1000, height: 500)
    /// A note's words are as wide as the desktop's estimate: this package can't set type.
    private var layout: MarkupLayout { MarkupLayout(size: wide) { text, font in font * 0.55 * Double(text.count) } }
    private func drag(_ id: Int, _ tool: MarkTool, _ x0: Double, _ y0: Double, _ x1: Double, _ y1: Double) -> MarkupShape {
        MarkupShape(id: id, ink: .red, shape: .drag(tool, from: point(x0, y0), to: point(x1, y1)))
    }
    private func note(_ id: Int, _ x: Double, _ y: Double, _ text: String, on: Int? = nil, scale: Double = 1) -> MarkupShape {
        MarkupShape(id: id, ink: .red, shape: .note(at: point(x, y), text: text, scale: scale, on: on))
    }
    private func at(_ mark: MarkupShape?) -> MarkPoint? {
        guard let mark else { return nil }
        switch mark.shape {
        case .drag(_, let from, _): return from
        case .note(let at, _, _, _): return at
        case .pen(let samples, _): return samples.first?.point
        }
    }
    private func holder(_ mark: MarkupShape?) -> Int? {
        if case .note(_, _, _, let on)? = mark?.shape { return on }
        return nil
    }
    private var scene: [MarkupShape] {
        [drag(1, .box, 100, 100, 400, 300), drag(2, .arrow, 500, 50, 700, 250),
         MarkupShape(id: 3, ink: .amber, shape: .pen(samples: [PenSample(point(600, 400), pressure: 0.5), PenSample(point(650, 420), pressure: 0.5), PenSample(point(700, 410), pressure: 0.5)], pressed: false)),
         note(4, 150, 200, "On the box", on: 1), note(5, 800, 50, "Free")]
    }

    func testMovePicksUpANotesWordsFirstThenALineThenTheSmallestShapeAroundThePlace() {
        XCTAssertEqual(layout.mark(at: point(160, 200), reach: 9, in: scene)?.id, 4)
        XCTAssertEqual(layout.mark(at: point(600, 150), reach: 9, in: scene)?.id, 2)
        XCTAssertEqual(layout.mark(at: point(650, 421), reach: 9, in: scene)?.id, 3)
        XCTAssertEqual(layout.mark(at: point(300, 150), reach: 9, in: scene)?.id, 1)
        XCTAssertNil(layout.mark(at: point(900, 450), reach: 9, in: scene))
        XCTAssertEqual(layout.mark(at: point(290, 150), reach: 9, in: scene + [drag(6, .ellipse, 200, 120, 380, 180)])?.id, 6)
    }

    func testAShapeBringsItsNotesAndANoteMovesAlone() {
        XCTAssertEqual(layout.movingWith(1, in: scene), [1, 4])
        XCTAssertEqual(layout.movingWith(4, in: scene), [4])
        let after = layout.move(scene, layout.movingWith(1, in: scene), dx: 50, dy: 20)
        XCTAssertEqual(at(after[0]), point(150, 120))
        XCTAssertEqual(at(after[3]), point(200, 220))
        XCTAssertEqual(after[1], scene[1])
        XCTAssertEqual(after[4], scene[4])
    }

    func testAMoveStopsAtThePicturesEdgeForTheShapeAndItsNoteTogether() {
        let after = layout.move(scene, layout.movingWith(1, in: scene), dx: -5000, dy: -5000)
        XCTAssertEqual(at(after[0]), point(0, 0))
        XCTAssertEqual(at(after[3]), point(50, 100))
        guard case .pen(let samples, _) = layout.move(scene, [3], dx: 0, dy: 5000)[2].shape else { return XCTFail("a pen line") }
        XCTAssertEqual(samples.map(\.point.y).max(), 500)
    }

    func testANoteLetGoOnAMarkBelongsToItAndOneLetGoOffEveryMarkIsFree() {
        let dropped = layout.move(scene, [5], dx: -600, dy: 150)
        XCTAssertEqual(holder(layout.settle(dropped, note: 5, reach: 9)[4]), 1)
        let away = layout.move(scene, [4], dx: 0, dy: 250)
        XCTAssertNil(holder(layout.settle(away, note: 4, reach: 9)[3]))
        XCTAssertNil(layout.holder(at: point(810, 50), reach: 9, in: [note(5, 800, 50, "Free")]))
    }

    func testACornerOrAnArrowsEndResizesTakingTheNotesAlongAndCantLoseTheMark() throws {
        let wider = try XCTUnwrap(layout.resize(scene, id: 1, handle: .bottomRight, to: point(700, 300)))
        XCTAssertEqual(layout.bounds(wider[0]), MarkBounds(x: 100, y: 100, width: 600, height: 200))
        XCTAssertEqual(try XCTUnwrap(at(wider[3])).x, 200, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(layout.resize(scene, id: 2, handle: .end, to: point(900, 450)))[1], drag(2, .arrow, 500, 50, 900, 450))
        let pen = try XCTUnwrap(layout.resize(scene, id: 3, handle: .bottomRight, to: point(800, 420)))[2]
        XCTAssertEqual(layout.bounds(pen), MarkBounds(x: 600, y: 400, width: 200, height: 20))
        XCTAssertNil(layout.resize(scene, id: 1, handle: .bottomRight, to: point(101, 101)))
        XCTAssertNil(layout.resize(scene, id: 4, handle: .bottomRight, to: point(700, 300)))
        XCTAssertEqual(layout.handles(scene[0]).count, 4)
        XCTAssertEqual(layout.handles(scene[1]).count, 2)
        XCTAssertEqual(layout.handles(scene[3]).count, 0)
    }

    func testANoteTurnsWithItsArrowAndAResizedMarksNotesStayOnThePicture() throws {
        let turned = try XCTUnwrap(layout.resize([drag(1, .arrow, 100, 100, 300, 100), note(2, 200, 100, "Mid", on: 1)], id: 1, handle: .end, to: point(100, 300)))
        XCTAssertEqual(try XCTUnwrap(at(turned[1])).x, 100, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(at(turned[1])).y, 200, accuracy: 0.001)
        let wider = try XCTUnwrap(layout.resize([scene[0], note(4, 380, 200, "A note too long to fit", on: 1, scale: 2.6)], id: 1, handle: .bottomRight, to: point(990, 490)))
        let words = layout.bounds(wider[1])
        XCTAssertLessThanOrEqual(words.x + words.width, 1000)
    }

    func testACircleDrawnOrResizedFlatIsTheLineItIs() {
        let flat = drag(1, .ellipse, 100, 100, 300, 100)
        XCTAssertNil(layout.mark(at: point(800, 400), reach: 9, in: [flat]))
        XCTAssertNil(layout.holder(at: point(800, 400), reach: 9, in: [flat]))
        XCTAssertEqual(layout.mark(at: point(200, 104), reach: 9, in: [flat])?.id, 1)
    }

    func testALongNoteStaysOnTheMarkItWasPlacedOnWhicheverPartIsOverTheMark() {
        let long = note(2, 380, 200, "A note long enough to run past the box")
        XCTAssertEqual(holder(layout.settle([scene[0], long], note: 2, reach: 9)[1]), 1)
    }

    func testTextStepsThroughItsSizesAndStaysAtEitherEnd() {
        XCTAssertEqual(Markup.nextNoteScale(1, by: 1), 1.4)
        XCTAssertEqual(Markup.nextNoteScale(1, by: -1), 0.7)
        XCTAssertEqual(Markup.nextNoteScale(0.7, by: -1), 0.7)
        XCTAssertEqual(Markup.nextNoteScale(2.6, by: 1), 2.6)
        XCTAssertEqual(Markup.noteFontSize(wide, scale: 1.4), 1000.0 / 48 * 1.4, accuracy: 0.0001)
    }

    func testADragKeepsItsMarksOnlyIfNothingChangedThemWhileItRan() {
        var history = MarkupHistory()
        for mark in scene { history.add(mark, size: wide) }
        // Let go with the marks as the drag found them: kept, as one step of Undo.
        var base = history.marks
        XCTAssertTrue(history.replace(with: layout.move(base, [1, 4], dx: 10, dy: 10), madeFrom: base))
        history.undo()
        XCTAssertEqual(history.marks, scene)
        // A second finger takes the shape off during the drag: it stays off, and Undo still brings it back.
        base = history.marks
        history.remove(1)
        let removed = history
        XCTAssertFalse(history.replace(with: layout.move(base, [1, 4], dx: 10, dy: 10), madeFrom: base))
        XCTAssertEqual(history, removed)
        // Undo during a drag stays undone, with Redo still there.
        history.undo()
        base = history.marks
        history.undo()
        XCTAssertFalse(history.replace(with: layout.move(base, [2], dx: 10, dy: 10), madeFrom: base))
        XCTAssertTrue(history.canRedo)
    }

    func testUndoStepsBackAMoveAndTakingAShapeOffTakesItsNotesWhichUndoBringsBack() {
        var history = MarkupHistory()
        for mark in scene { history.add(mark, size: wide) }
        let moved = layout.move(history.marks, [1, 4], dx: 10, dy: 10)
        history.replace(with: moved)
        XCTAssertEqual(history.marks, moved)
        history.undo()
        XCTAssertEqual(history.marks, scene)
        history.redo()
        // Letting go without moving is no step of Undo.
        let steps = history
        history.replace(with: history.marks)
        XCTAssertEqual(history, steps)
        history.remove(1)
        XCTAssertEqual(history.marks.map(\.id), [2, 3, 5])
        history.undo()
        XCTAssertEqual(history.marks.map(\.id), [1, 2, 3, 4, 5])
    }
}
