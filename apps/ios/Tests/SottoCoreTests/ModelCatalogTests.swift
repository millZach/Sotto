import XCTest
@testable import SottoCore

/// `model-catalog-revision`: a host names its model catalog by revision and leaves it out of a shell when this
/// connection was already sent it, and the connection puts it back before anything reads the shell.
final class ModelCatalogTests: XCTestCase {
    private let first = #"{"id":"first","name":"First","provider":"Codex","providerId":"codex","ready":true}"#
    private let second = #"{"id":"second","name":"Second","provider":"Claude","providerId":"claude","ready":true}"#
    /// A host's fields, with `catalog` (a revision, models or both, each followed by a comma) spliced in.
    private func host(_ catalog: String) -> String {
        #"{"hostId":"h","name":"Laptop","threads":[],"projects":[],\#(catalog)"capabilities":{"submit":true,"interrupt":true,"questions":true,"permissions":true,"threads":true}}"#
    }
    /// A revision, the models given, or both, as `host(_:)` takes them.
    private func catalog(revision: Int?, models: String?) -> String {
        let named = revision.map { #""modelsRevision":\#($0),"# } ?? ""
        let listed = models.map { #""models":[\#($0)],"# } ?? ""
        return named + listed
    }
    private func shell(revision: Int?, models: String?) throws -> Shell {
        let fields = host(catalog(revision: revision, models: models))
        return try JSONDecoder().decode(Shell.self, from: Data(#"{"hostId":"h","host":\#(fields)}"#.utf8))
    }
    private func hello(revision: Int?, models: String?) throws -> Hello {
        let fields = host(catalog(revision: revision, models: models))
        return try JSONDecoder().decode(Hello.self, from: Data(#"{"hostId":"h","clientId":"phone","capabilities":{"mayAnswer":false},"features":["model-catalog-revision"],"shell":{"hostId":"h","host":\#(fields)}}"#.utf8))
    }
    private func reply(_ result: String) async throws -> CarriedCatalog? {
        let frame = try await Wire.readFrame(Data(#"{"v":1,"id":"reply","ok":true,"result":\#(result)}"#.utf8))
        guard case .reply(let id, _, let catalog) = frame else { XCTFail("Expected reply"); return nil }
        XCTAssertEqual(id, "reply")
        return catalog
    }

    func testAShellNamingTheHeldRevisionGetsTheWholeCatalogBack() throws {
        var cache = ModelCatalogCache()
        let carried = try shell(revision: 3, models: first)
        cache.hold(carried)
        XCTAssertEqual(cache.whole(carried)?.host.models?.map(\.id), ["first"])
        let named = try shell(revision: 3, models: nil)
        XCTAssertNil(named.host.models)
        let restored = try XCTUnwrap(cache.whole(named))
        XCTAssertEqual(restored.host.models?.map(\.id), ["first"])
        XCTAssertEqual(restored.host.modelsRevision, 3)
        XCTAssertEqual(NewThreads.availableModels(restored.host).map(\.id), ["first"])
    }
    func testAShellNamingARevisionThisConnectionWasNeverSentIsNotShownWithoutModels() throws {
        let named = try shell(revision: 4, models: nil)
        XCTAssertNil(ModelCatalogCache().whole(named), "Nothing held yet")
        var cache = ModelCatalogCache()
        cache.hold(try shell(revision: 3, models: first))
        XCTAssertNil(cache.whole(named), "Another revision than the one held")
        XCTAssertNil(cache.whole(try hello(revision: 4, models: nil)))
    }
    func testAChangedCatalogReplacesTheOneHeld() throws {
        var cache = ModelCatalogCache()
        cache.hold(try shell(revision: 3, models: first))
        cache.hold(try shell(revision: 4, models: second))
        XCTAssertEqual(cache.held?.revision, 4)
        XCTAssertEqual(cache.whole(try shell(revision: 4, models: nil))?.host.models?.map(\.id), ["second"])
        XCTAssertNil(cache.whole(try shell(revision: 3, models: nil)))
    }
    func testAShellFromAHostWithoutTheFeatureIsReadAsItCame() throws {
        var cache = ModelCatalogCache()
        let whole = try shell(revision: nil, models: first)
        cache.hold(whole)
        XCTAssertNil(cache.held, "A catalog without a revision is not held")
        XCTAssertNil(whole.host.modelsRevision)
        XCTAssertEqual(cache.whole(whole)?.host.models?.map(\.id), ["first"])
    }
    func testHelloIsPutBackLikeAShell() throws {
        var cache = ModelCatalogCache()
        cache.hold(try shell(revision: 7, models: second))
        let restored = try XCTUnwrap(cache.whole(try hello(revision: 7, models: nil)))
        XCTAssertEqual(restored.shell.host.models?.map(\.id), ["second"])
        XCTAssertEqual(restored.clientId, "phone")
    }
    func testAReplyCarryingACatalogIsReadWithItsEnvelope() async throws {
        let carriedHost = host(catalog(revision: 5, models: first))
        let read = try await reply(#"{"hostId":"h","host":\#(carriedHost)}"#)
        XCTAssertEqual(read?.revision, 5)
        XCTAssertEqual(read?.models.map(\.id), ["first"])
        let helloHost = host(catalog(revision: 6, models: second))
        let greeting = try await reply(#"{"hostId":"h","clientId":"phone","capabilities":{"mayAnswer":false},"shell":{"hostId":"h","host":\#(helloHost)}}"#)
        XCTAssertEqual(greeting?.revision, 6)
        XCTAssertEqual(greeting?.models.map(\.id), ["second"])
        let namedHost = host(catalog(revision: 5, models: nil)), wholeHost = host(catalog(revision: nil, models: first))
        let results = [#"{"hostId":"h","host":\#(namedHost)}"#, #"{"hostId":"h","host":\#(wholeHost)}"#,
                       #"{"threadId":"t","revision":1,"messages":[]}"#, "null"]
        for result in results {
            let carried = try await reply(result)
            XCTAssertNil(carried, result)
        }
    }
    func testAPushedShellKeepsItsCatalogForTheConnection() async throws {
        let pushedHost = host(catalog(revision: 8, models: first))
        let frame = try await Wire.readFrame(Data(#"{"v":1,"event":"shell","state":{"hostId":"h","host":\#(pushedHost)}}"#.utf8))
        guard case .shell(let pushed) = frame else { return XCTFail("Expected shell") }
        var cache = ModelCatalogCache()
        cache.hold(pushed)
        XCTAssertEqual(cache.held?.revision, 8)
        XCTAssertEqual(cache.whole(try shell(revision: 8, models: nil))?.host.models?.map(\.id), ["first"])
    }
}
