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
        guard case .reply(let id, _, let catalog, _) = frame else { XCTFail("Expected reply"); return nil }
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

    // `provider-mode-lists` (ADR-0028's November 1 amendment): each distinct list of provider modes goes once, and a model
    // names its list by its place.
    private let modes = #"[{"id":"mode-ask","name":"Ask","asks":"Before each edit."},{"id":"mode-edit","name":"Edit","allows":"edits"}]"#
    private func listedModels() -> String {
        [#"{"id":"devin-a","name":"A","provider":"Devin","providerId":"devin","ready":true,"providerModeList":0}"#,
         #"{"id":"devin-b","name":"B","provider":"Devin","providerId":"devin","ready":true,"providerModeList":0}"#,
         first].joined(separator: ",")
    }
    private func withLists(_ fields: String, lists: String) -> String {
        fields.replacingOccurrences(of: #""capabilities":"#, with: #""providerModeLists":\#(lists),"capabilities":"#)
    }
    func testAShellPutsEachModelsProviderModesBackFromTheListItNames() throws {
        let fields = withLists(host(catalog(revision: 2, models: listedModels())), lists: "[\(modes)]")
        let listed = try JSONDecoder().decode(Shell.self, from: Data(#"{"hostId":"h","host":\#(fields)}"#.utf8))
        var cache = ModelCatalogCache()
        let whole = try XCTUnwrap(cache.whole(listed))
        XCTAssertNil(whole.host.providerModeLists)
        let models = try XCTUnwrap(whole.host.models)
        XCTAssertEqual(models.map { $0.providerModes?.map(\.id) }, [["mode-ask", "mode-edit"], ["mode-ask", "mode-edit"], nil])
        XCTAssertEqual(models.map(\.providerModeList), [nil, nil, nil])
        // The catalog held for later shells is the one put back.
        cache.hold(listed)
        let named = try shell(revision: 2, models: nil)
        XCTAssertEqual(try XCTUnwrap(cache.whole(named)).host.models, models)
    }
    func testAModelNamingAListThatIsNotThereIsNotShown() throws {
        let fields = withLists(host(catalog(revision: 2, models: listedModels())), lists: "[]")
        let listed = try JSONDecoder().decode(Shell.self, from: Data(#"{"hostId":"h","host":\#(fields)}"#.utf8))
        XCTAssertNil(ModelCatalogCache().whole(listed))
    }
    func testAReplysCatalogIsHeldWithItsProviderModesPutBack() async throws {
        let fields = withLists(host(catalog(revision: 5, models: listedModels())), lists: "[\(modes)]")
        let carried = try await reply(#"{"hostId":"h","host":\#(fields)}"#)
        XCTAssertEqual(carried?.revision, 5)
        XCTAssertEqual(carried?.models.map { $0.providerModes?.count }, [2, 2, nil])
        XCTAssertEqual(carried?.models.compactMap(\.providerModeList), [])
    }
}
