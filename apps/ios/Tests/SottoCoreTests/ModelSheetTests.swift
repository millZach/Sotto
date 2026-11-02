import XCTest
@testable import SottoCore

/// The reply box's model sheet (ADR-0166, amended November 1, 2026): favorites starred on this iPhone, and providers that
/// start closed with one open at a time.
final class ModelSheetTests: XCTestCase {
    private func models(_ json: String) throws -> [ThreadModel] {
        try JSONDecoder().decode([ThreadModel].self, from: Data(json.utf8))
    }

    private var catalog: [ThreadModel] {
        get throws {
            try models(#"""
            [{"id":"sol","name":"GPT-6.1 Sol","provider":"Codex","providerId":"codex","ready":true},
             {"id":"astra","name":"GPT-6 Astra","provider":"Codex","providerId":"codex","ready":true},
             {"id":"opus","name":"Opus 5.5","provider":"Claude Code","providerId":"claude","ready":true},
             {"id":"sonnet","name":"Sonnet 5.5","provider":"Claude Code","providerId":"claude","ready":true}]
            """#)
        }
    }

    func testAStarGoesOnInTheOrderStarredAndComesOff() throws {
        let all = try catalog
        var saved = ""
        saved = ModelFavorites.toggled(saved, all[2])
        saved = ModelFavorites.toggled(saved, all[0])
        XCTAssertEqual(ModelFavorites.read(saved), [ModelFavorite(provider: "claude", model: "opus"), ModelFavorite(provider: "codex", model: "sol")])
        saved = ModelFavorites.toggled(saved, all[2])
        XCTAssertEqual(ModelFavorites.read(saved), [ModelFavorite(provider: "codex", model: "sol")])
    }

    func testTextThatNoLongerReadsKeepsNoFavorites() {
        XCTAssertEqual(ModelFavorites.read(""), [])
        XCTAssertEqual(ModelFavorites.read("not json"), [])
        XCTAssertEqual(ModelFavorites.read(#"[{"provider":"codex"}]"#), [])
    }

    func testFavoritesListOnlyWhatTheSheetOffersAndLeaveOutTheOneInUse() throws {
        let all = try catalog
        let saved = [ModelFavorite(provider: "claude", model: "sonnet"), ModelFavorite(provider: "codex", model: "astra"),
                     ModelFavorite(provider: "codex", model: "sol"), ModelFavorite(provider: "codex", model: "gone")]
        // Watcher's sheet offers every provider: starred order, without the model in use or one no longer listed.
        XCTAssertEqual(ModelFavorites.offered(saved, in: all, current: "sol").map(\.id), ["sonnet", "astra"])
        // A Codex thread's sheet offers only Codex's models.
        let codex = all.filter { $0.providerId == "codex" }
        XCTAssertEqual(ModelFavorites.offered(saved, in: codex, current: "sol").map(\.id), ["astra"])
    }

    func testTheSameIdUnderAnotherProviderIsAnotherFavorite() throws {
        let twins = try models(#"""
        [{"id":"auto","name":"Auto","provider":"Cursor","providerId":"cursor","ready":true},
         {"id":"auto","name":"Auto","provider":"OpenCode","providerId":"opencode","ready":true}]
        """#)
        let saved = ModelFavorites.toggled("", twins[1])
        XCTAssertEqual(ModelFavorites.offered(ModelFavorites.read(saved), in: twins, current: nil).map(\.providerId), ["opencode"])
    }

    func testProvidersStartClosedAndOneOpensAtATime() {
        var folds = ModelFolds()
        XCTAssertNil(folds.provider)
        folds.toggleLegacy()
        XCTAssertFalse(folds.legacy, "Legacy opens only inside an open provider")
        folds.toggle("codex")
        XCTAssertEqual(folds.provider, "codex")
        folds.toggleLegacy()
        XCTAssertTrue(folds.legacy)
        folds.toggle("claude")
        XCTAssertEqual(folds.provider, "claude", "Opening another provider closes the first")
        XCTAssertFalse(folds.legacy, "And its Legacy with it")
        folds.toggle("claude")
        XCTAssertNil(folds.provider, "Pressed again, it closes")
    }
}
