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
        let line = StepPictures.line(items)
        XCTAssertEqual(line.shown.map(\.id), ["a/m2", "b/m0", "b/m1"])
        XCTAssertEqual(line.hidden.map(\.id), ["a/m0", "a/m1"])
        let few = StepPictures.line(Array(items.prefix(2)))
        XCTAssertEqual(few.shown.count, 2)
        XCTAssertTrue(few.hidden.isEmpty)
    }

    func testATurnsWrittenFilesAreTurnedRoundSoTheNewestShow() throws {
        // The computer lists what a turn wrote newest first: m0 is the newest.
        let written = try step("sotto-written-1", pictures: 5)
        XCTAssertEqual(StepPictures.line(StepPictures.inSteps([written])).shown.map(\.media.id), ["m2", "m1", "m0"])
    }

    func testVideosHoldTheLineBeforePictures() throws {
        let digest = String(repeating: "b", count: 64)
        let kinds = ["image", "video", "video", "image", "video", "video"]
        let media = kinds.enumerated().map { index, kind in
            #"{"id":"m\#(index)","digest":"\#(digest)","kind":"\#(kind)","mimeType":"\#(kind == "video" ? "video/webm" : "image/png")","sizeBytes":40,"name":"f\#(index)","source":"file"}"#
        }
        let json = #"{"id":"mixed","sequence":1,"kind":"tool","status":"completed","title":"Step","media":[\#(media.joined(separator: ","))]}"#
        let mixed = try JSONDecoder().decode(Activity.self, from: Data(json.utf8))
        let line = StepPictures.line(StepPictures.inSteps([mixed]))
        XCTAssertEqual(line.shown.map(\.media.id), ["m2", "m4", "m5"])
        XCTAssertEqual(line.hidden.map(\.media.id), ["m0", "m1", "m3"])
    }
}
