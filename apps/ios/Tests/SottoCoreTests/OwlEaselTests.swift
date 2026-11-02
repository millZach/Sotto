import XCTest
@testable import SottoCore

/// The owl at the easel (ADR-0170), the scene a tile plays while an agent makes an image.
final class OwlEaselTests: XCTestCase {
    private func painted(_ text: String) -> Int { text.filter { $0 != " " && $0 != "\n" }.count }

    func testAFrameIsTwoLayersTheSizeOfTheTilesGrid() {
        let frame = OwlEasel.frame(cols: 30, rows: OwlEasel.tileRows, progress: 0.5, seconds: 1)
        for layer in [frame.paint, frame.sketch] {
            let lines = layer.split(separator: "\n", omittingEmptySubsequences: false)
            XCTAssertEqual(lines.count, OwlEasel.tileRows)
            XCTAssertEqual(Set(lines.map(\.count)), [30])
        }
    }

    func testItPaintsMoreAsItGoesAndTheStillOwlHasItsEyesOpen() {
        XCTAssertEqual(painted(OwlEasel.frame(cols: 30, rows: 14, progress: 0, seconds: 0).paint), 0)
        XCTAssertLessThan(painted(OwlEasel.frame(cols: 30, rows: 14, progress: 0.3, seconds: 0).paint),
                          painted(OwlEasel.frame(cols: 30, rows: 14, progress: 0.9, seconds: 0).paint))
        let still = OwlEasel.frame(cols: 30, rows: 14, progress: 0.5, seconds: 0).sketch
        XCTAssertTrue(still.contains("(OvO)"))
        XCTAssertTrue(still.contains("+---"))
        XCTAssertTrue(OwlEasel.frame(cols: 30, rows: 14, progress: 0.5, seconds: 3.3).sketch.contains("(-v-)"))
    }

    func testItSlowsAsItGoesAndNeverFinishesOnItsOwn() {
        let at = [0.0, 5, 15, 30, 120, 6000].map { OwlEasel.progress(seconds: $0) }
        XCTAssertEqual(at[0], 0)
        for index in 1..<at.count { XCTAssertGreaterThanOrEqual(at[index], at[index - 1]) }
        XCTAssertLessThan(at.max()!, 1)
    }

    func testAStepMakingAnImageSaysSoUntilItsPictureLands() throws {
        let decoder = JSONDecoder()
        let running = try decoder.decode(Activity.self, from: Data(#"{"id":"codex-image","sequence":1,"kind":"tool","status":"running","title":"Image","generates":"image"}"#.utf8))
        XCTAssertTrue(running.makingImage)
        let landed = try decoder.decode(Activity.self, from: Data(#"{"id":"codex-image","sequence":1,"kind":"tool","status":"completed","title":"Image","generates":"image","media":[{"id":"m0","digest":"\#(String(repeating: "a", count: 64))","kind":"image","mimeType":"image/png","sizeBytes":40,"name":"picture-1.png","source":"generated"}]}"#.utf8))
        XCTAssertFalse(landed.makingImage)
        XCTAssertEqual(landed.media?.first?.source, "generated")
        // A step from a computer that never says decodes as before, and makes nothing.
        XCTAssertFalse(try decoder.decode(Activity.self, from: Data(#"{"id":"s","sequence":0,"kind":"tool","status":"running","title":"Read"}"#.utf8)).makingImage)
    }
}
