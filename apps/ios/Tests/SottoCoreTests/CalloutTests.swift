import XCTest
@testable import SottoCore

/// Callouts an agent placed on a picture it showed (ADR-0170, part 6), as the iPhone reads and draws them: the same
/// shapes as the desktop's.
final class CalloutTests: XCTestCase {
    func testAPicturesCalloutsAreReadFromItsHandleAndAnOlderComputerSendsNone() throws {
        let digest = String(repeating: "a", count: 64)
        let json = #"{"id":"sotto-shown-1","sequence":0,"kind":"tool","status":"completed","title":"The checkout page","media":[{"id":"m0","digest":"\#(digest)","kind":"image","mimeType":"image/png","sizeBytes":40,"width":1280,"height":800,"name":"checkout.png","source":"file","callouts":[{"n":1,"x":0.6,"y":0.48,"w":0.335,"h":0.115,"note":"The Pay button sits on top of the total."}]},{"id":"m1","digest":"\#(digest)","kind":"image","mimeType":"image/png","sizeBytes":40,"name":"older.png","source":"tool"}]}"#
        let step = try JSONDecoder().decode(Activity.self, from: Data(json.utf8))
        XCTAssertEqual(step.media?[0].callouts, [Activity.Media.Callout(n: 1, x: 0.6, y: 0.48, w: 0.335, h: 0.115, note: "The Pay button sits on top of the total.")])
        XCTAssertNil(step.media?[1].callouts)
    }

    func testACalloutIsAShareOfThePictureOnACopyAndAFixedSizeOnATile() {
        let callout = Activity.Media.Callout(n: 2, x: 0.5, y: 0.25, w: 0.25, h: 0.5, note: "Here")
        let shape = Callouts.shape(callout, size: MarkupSize(width: 1300, height: 800))
        XCTAssertEqual([shape.x, shape.y, shape.width, shape.height], [650, 200, 325, 400])
        XCTAssertEqual(shape.line, 5)
        XCTAssertEqual(shape.radius, 1300 / 55, accuracy: 0.0001)
        XCTAssertEqual(shape.dash, [15, 10])
        let tile = Callouts.shape(callout, size: MarkupSize(width: 1300, height: 800), unit: 4)
        XCTAssertEqual([tile.line, tile.radius], [6, 32])
    }

    func testAPictureFillsATileCutToItAndFitsTheViewerWhole() {
        let wide = MarkupSize(width: 1280, height: 800)
        let filled = Callouts.placement(of: wide, inWidth: 150, height: 100, fills: true)
        XCTAssertEqual(filled.scale, 0.125)
        XCTAssertEqual(filled.x, -5)
        XCTAssertEqual(filled.y, 0)
        let fitted = Callouts.placement(of: wide, inWidth: 390, height: 600, fills: false)
        XCTAssertEqual(fitted.scale, 390.0 / 1280, accuracy: 0.0001)
        XCTAssertEqual(fitted.x, 0)
        XCTAssertEqual(fitted.y, (600 - 800 * 390.0 / 1280) / 2, accuracy: 0.0001)
    }
}
