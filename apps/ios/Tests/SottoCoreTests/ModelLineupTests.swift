import XCTest
@testable import SottoCore

/// ADR-0171: a Claude Code or Codex menu leads with the newest model of each line and keeps the older ones under Legacy,
/// as the computer marks them; a thread moved off a retired model carries a note after the last message before the move.
final class ModelLineupTests: XCTestCase {
    private func models(_ json: String) throws -> [ThreadModel] {
        try JSONDecoder().decode([ThreadModel].self, from: Data(json.utf8))
    }

    func testLegacyModelsGoApartInTheComputersOrder() throws {
        let catalog = try models(#"""
        [{"id":"opus","name":"Opus 5.5","provider":"Claude Code","providerId":"claude","ready":true},
         {"id":"opus-5","name":"Opus 5","provider":"Claude Code","providerId":"claude","ready":true,"legacy":true},
         {"id":"sonnet","name":"Sonnet 5.5","provider":"Claude Code","providerId":"claude","ready":true},
         {"id":"sonnet-4-6","name":"Sonnet 4.6","provider":"Claude Code","providerId":"claude","ready":true,"legacy":true}]
        """#)
        let lineup = ModelLineup.split(catalog)
        XCTAssertEqual(lineup.latest.map(\.id), ["opus", "sonnet"])
        XCTAssertEqual(lineup.legacy.map(\.id), ["opus-5", "sonnet-4-6"])
    }

    func testAnOlderComputersModelsAllLead() throws {
        let catalog = try models(#"[{"id":"a","name":"GPT-6-Sol","provider":"Codex","providerId":"codex","ready":true}]"#)
        XCTAssertEqual(ModelLineup.split(catalog).latest.map(\.id), ["a"])
        XCTAssertTrue(ModelLineup.split(catalog).legacy.isEmpty)
    }

    func testTheNoteFollowsTheLastMessageWrittenBeforeTheMove() throws {
        let messages = try JSONDecoder().decode([Message].self, from: Data(#"""
        [{"id":"m1","role":"user","text":"a","createdAt":"2026-10-30T10:00:00.000Z"},
         {"id":"m2","role":"assistant","text":"b","createdAt":"2026-10-30T10:01:00.000Z"},
         {"id":"m3","role":"user","text":"c","createdAt":"2026-10-31T09:00:00.000Z"}]
        """#.utf8))
        let moved = ModelMoved(from: "Opus 5.5 with 1M context", to: "Opus 5.5", at: "2026-10-31T08:00:00.000Z")
        XCTAssertEqual(moved.anchor(in: messages), "m2")
        XCTAssertNil(ModelMoved(from: "a", to: "b", at: "2026-10-29T08:00:00.000Z").anchor(in: messages))
    }

    func testAThreadDecodesItsMove() throws {
        let thread = try JSONDecoder().decode(ThreadSummary.self, from: Data(#"""
        {"id":"t","projectId":"p","title":"T","status":"idle","requests":[],
         "modelMoved":{"from":"Opus 5.5 with 1M context","to":"Opus 5.5","at":"2026-10-31T08:00:00.000Z"}}
        """#.utf8))
        XCTAssertEqual(thread.modelMoved?.to, "Opus 5.5")
    }
}
