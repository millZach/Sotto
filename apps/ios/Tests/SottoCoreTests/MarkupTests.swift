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
        XCTAssertFalse(Markup.madeMark(MarkupShape(id: 1, ink: .red, shape: .note(at: point(0, 0), text: "  ")), size: size))
        XCTAssertTrue(Markup.madeMark(MarkupShape(id: 1, ink: .red, shape: .note(at: point(0, 0), text: "Total")), size: size))
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
        XCTAssertTrue(history.add(MarkupShape(id: history.newID(), ink: .plain, shape: .note(at: point(5, 5), text: "Here")), size: size))
        XCTAssertFalse(history.canRedo)
    }

    func testTheCopyIsNamedAfterThePictureAsOnTheDesktop() {
        XCTAssertEqual(Markup.markedName("checkout.png"), "checkout marked up")
        XCTAssertEqual(Markup.markedName("flow.final.jpeg"), "flow.final marked up")
        XCTAssertEqual(Markup.markedName("Photo 2"), "Photo 2 marked up")
        XCTAssertEqual(Markup.markedName(".png"), "Picture marked up")
    }
}
