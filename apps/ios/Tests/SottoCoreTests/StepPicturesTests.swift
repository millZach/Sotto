import XCTest
@testable import SottoCore

/// An agent's pictures in its steps (ADR-0170, pictures in steps): which sit in a step's line and which stand as tiles.
final class StepPicturesTests: XCTestCase {
    private func step(_ id: String, pictures: Int, generates: String? = nil) throws -> Activity {
        let digest = String(repeating: "a", count: 64)
        let media = (0..<pictures).map { #"{"id":"m\#($0)","digest":"\#(digest)","kind":"image","mimeType":"image/png","sizeBytes":40,"name":"p\#($0).png","source":"tool"}"# }
        let made = generates.map { #","generates":"\#($0)""# } ?? ""
        let json = #"{"id":"\#(id)","sequence":1,"kind":"tool","status":"completed","title":"Step"\#(made),"media":[\#(media.joined(separator: ","))]}"#
        return try JSONDecoder().decode(Activity.self, from: Data(json.utf8))
    }

    func testAToolsPicturesSitInItsStepAndShownOrMadeOnesStandAsTiles() throws {
        let tool = try step("browser-1", pictures: 2)
        let shown = try step("sotto-shown-1", pictures: 1)
        let made = try step("codex-image", pictures: 1, generates: "image")
        let steps = [tool, shown, made]
        XCTAssertEqual(StepPictures.inSteps(steps).map(\.id), ["browser-1/m0", "browser-1/m1"])
        XCTAssertEqual(StepPictures.inThread(steps).map(\.id), ["sotto-shown-1", "codex-image"])
    }

    func testALineShowsTheNewestThreeAndCountsTheRest() throws {
        let items = StepPictures.inSteps([try step("a", pictures: 3), try step("b", pictures: 2)])
        let line = StepPictures.newest(items)
        XCTAssertEqual(line.shown.map(\.id), ["a/m2", "b/m0", "b/m1"])
        XCTAssertEqual(line.more, 2)
        let few = StepPictures.newest(Array(items.prefix(2)))
        XCTAssertEqual(few.shown.count, 2)
        XCTAssertEqual(few.more, 0)
    }
}
