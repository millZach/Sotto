import SwiftUI
import UniformTypeIdentifiers
import SottoCore

// MARK: Sent files

/// A sent file opened in Quick Look (ADR-0131, October 25 amendment): brought from its computer when pressed, checked
/// against its handle, and written to the temporary copy Quick Look reads. The copy goes when the preview closes, when
/// another opens, when Sotto moves to the background and, for anything a crash left, at the next launch. A copy written
/// for a file no longer wanted is removed by its own folder, never the one being shown.
@MainActor final class SentFiles: ObservableObject {
    struct Key: Hashable { let ref: ThreadRef; let messageID: String; let attachmentID: String }
    struct Fetching: Equatable { let key: Key; var progress: Double }
    /// The file being brought from its computer, and how much of it has come. One at a time: pressing another stops it.
    @Published private(set) var fetching: Fetching?
    /// The opened file's copy, which Quick Look shows while it is set. Closing the preview sets it back to nil.
    @Published var shown: URL? {
        didSet { if let oldValue, oldValue != shown { copies.remove(oldValue) } }
    }
    private let copies = OpenedFileCopies()
    private var task: Task<Void, Never>?
    init() { copies.removeAll() }

    func open(_ key: Key, model: AppModel) {
        guard fetching?.key != key else { return }
        task?.cancel()
        fetching = Fetching(key: key, progress: 0)
        let computer = model.name(key.ref.hostID), copies = self.copies
        task = Task { [weak self] in
            let outcome = await model.sentFile(key.ref, messageID: key.messageID, attachmentID: key.attachmentID,
                                               progress: { [weak self] value in if self?.fetching?.key == key { self?.fetching?.progress = value } },
                                               wanted: { [weak self] in self?.fetching?.key == key })
            guard let self, self.fetching?.key == key else { return }
            switch outcome {
            case .file(let name, let data):
                let url = try? await Task.detached { try copies.write(data, name: name) }.value
                // Sotto went to the background, or another file was pressed, while this one was written.
                guard self.fetching?.key == key else { if let url { copies.remove(url) }; return }
                self.fetching = nil
                if let url { self.shown = url }
                else {
                    model.feedback = String(localized: "This file couldn’t be opened on this iPhone. Nothing was lost. Open it on \(computer).",
                                            comment: "%@ is the computer's name")
                }
            case .notKept:
                self.fetching = nil
                let folder = Interface.isolated(".sotto/attachments")
                model.feedback = String(localized: "This file is no longer kept on \(computer), so it can’t open here. Look for it in the thread’s working folder there, under \(folder).",
                                        comment: "The first %@ is the computer's name; the second is a folder's path, .sotto/attachments, left as it is")
            case .failed:
                self.fetching = nil
                model.feedback = String(localized: "This file couldn’t be brought from \(computer). Nothing was lost. Try again when it’s connected.",
                                        comment: "%@ is the computer's name")
            }
        }
    }
    /// Sotto moving to the background closes the preview and removes its copy, and stops a file still on its way.
    func background() {
        task?.cancel(); task = nil; fetching = nil
        shown = nil
        copies.removeAll()
    }
}

/// A user message's files, each a pill under its photos and above its words. A press brings the file from its computer,
/// with how much has come in place of its size, and opens it in Quick Look.
struct SentFilePills: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var files: SentFiles
    let ref: ThreadRef
    let messageID: String
    let attachments: [Attachment]
    var body: some View {
        ForEach(attachments) { attachment in
            let key = SentFiles.Key(ref: ref, messageID: messageID, attachmentID: attachment.id)
            let progress = files.fetching?.key == key ? files.fetching?.progress : nil
            Button { files.open(key, model: model) } label: {
                FilePill(name: attachment.name, sizeBytes: attachment.sizeBytes, progress: progress)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open \(attachment.name)")
            .accessibilityValue(progress.map { value in
                String(localized: "Getting it from \(model.name(ref.hostID)), \(FilePill.percent(value))",
                       comment: "A sent file on its way from its computer; the first %@ is the computer's name, the second how much has come, such as 40%")
            } ?? "")
        }
    }
}

// MARK: The reply box's files

/// The files waiting in a reply box, a thread's or Watcher's, under its photos, inside the words' column, as on the desktop.
struct DraftFilePills: View {
    @EnvironmentObject var model: AppModel
    let box: PhotoBox
    var body: some View {
        let locked = model.preparingSends.contains(box.id)
        FlowLayout(spacing: Space.s2) {
            ForEach(model.files(box)) { file in
                FilePill(name: file.name, sizeBytes: file.sizeBytes, progress: file.progress, reading: file.reading,
                         remove: { model.removeFile(file.id, from: box) }, locked: locked)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(box.isWatcher ? String(localized: "Files in this message", comment: "The files waiting in the box to Watcher") : String(localized: "Files in this reply"))
    }
}

/// One file on one line: its type, its name cut in the middle so the extension stays, and its size, or while it goes to or
/// comes from its computer how much has gone. In the reply box it ends in its own Remove button.
struct FilePill: View {
    let name: String
    let sizeBytes: Int?
    var progress: Double? = nil
    var reading = false
    var remove: (() -> Void)? = nil
    var locked = false
    @State private var removed = 0
    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: 5) {
                lead.frame(width: 18, height: 18)
                Text(name).font(.sotto(.small)).foregroundStyle(Palette.ink).lineLimit(1).truncationMode(.middle)
                if let detail { Text(detail).font(.sotto(.caption)).foregroundStyle(Palette.muted).monospacedDigit().fixedSize() }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(sizeBytes.flatMap { $0 > 0 ? "\(name), \(Files.size($0))" : nil } ?? name)
            .accessibilityValue(state)
            if let remove {
                Button {
                    removed += 1
                    remove()
                } label: {
                    Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).foregroundStyle(Palette.muted)
                        .frame(width: 40, height: 36).contentShape(Rectangle())
                }
                .buttonStyle(.plain).sensoryFeedback(.impact(flexibility: .soft), trigger: removed).disabled(locked)
                .accessibilityLabel("Remove \(name)")
            }
        }
        .padding(.leading, 8).padding(.trailing, remove == nil ? 12 : 0)
        .frame(minHeight: 36)
        .background(Palette.fillSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.hairline, lineWidth: 1))
    }
    @ViewBuilder private var lead: some View {
        if let progress { ProgressRing(progress: progress) }
        else if reading { ProgressView().controlSize(.mini) }
        else { Image(systemName: Self.symbol(name)).iconFont(14).foregroundStyle(Palette.muted) }
    }
    private var detail: String? {
        if let progress { return Self.percent(progress) }
        return sizeBytes.flatMap { $0 > 0 ? Files.size($0) : nil }
    }
    private var state: String {
        if let progress { return Self.percent(progress) }
        return reading ? String(localized: "file.getting-ready", defaultValue: "Getting it ready",
                                comment: "Accessibility value: a file in the reply box is being read, as a photo is prepared. Said of a file, not a photo.") : ""
    }
    /// How much of a file has gone or come, "40%", in the locale's own way of writing a percentage.
    static func percent(_ progress: Double) -> String {
        min(1, max(0, progress)).formatted(.percent.precision(.fractionLength(0)))
    }
    static func symbol(_ name: String) -> String {
        switch Files.kind(of: name) {
        case .archive: return "doc.zipper"
        case .code: return "chevron.left.forwardslash.chevron.right"
        case .video: return "film"
        case .text: return "doc.text"
        case .other: return "doc"
        }
    }
}

private struct ProgressRing: View {
    let progress: Double
    var body: some View {
        ZStack {
            Circle().stroke(Palette.hairline, lineWidth: 2.5)
            Circle().trim(from: 0, to: max(0.02, min(1, progress)))
                .stroke(Palette.accent, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .padding(2)
        .accessibilityHidden(true)
    }
}

// MARK: Choosing files

/// Files chosen in the Files app, opened where they are rather than copied into Sotto (ADR-0131): each is read under its
/// own security-scoped access, which is given back as soon as its bytes are in memory.
enum PickedFile {
    static func source(_ url: URL) -> FileSource {
        FileSource(name: url.lastPathComponent, sizeBytes: size(url)) { try await Task.detached { try PickedFile.read(url) }.value }
    }
    /// The size the Files app gives, read before anything else so a file past the limits is never read at all.
    static func size(_ url: URL) -> Int? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize
    }
    /// The file's bytes, through a file coordinator, which first downloads a file that is only in iCloud. A folder, or a file
    /// larger than any reply can carry, is not read.
    static func read(_ url: URL) throws -> Data {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        var failure: NSError?
        var result: Result<Data, Error> = .failure(CocoaError(.fileReadUnknown))
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &failure) { readable in
            result = Result {
                let values = try readable.resourceValues(forKeys: [.fileSizeKey, .isDirectoryKey])
                if values.isDirectory == true { throw CocoaError(.fileReadUnknown) }
                if (values.fileSize ?? 0) > FileLimits.bytesEach { throw ClientError.rejected(FileWords.tooLarge) }
                return try Data(contentsOf: readable)
            }
        }
        if let failure { throw failure }
        return try result.get()
    }
}

// MARK: Pasting

extension View {
    /// A paste into this text field attaches what was copied as a photo or a file, as if chosen from the + menu, and leaves
    /// copied words to paste as words. Put it on the box's text field.
    func pasteAttaches(to box: PhotoBox) -> some View { background(PasteAttacher(box: box)) }
}

/// SwiftUI's text field has no paste hook on iOS, so this finds the text view under it, the one that begins editing over it, and
/// answers its pastes: words as the field would, and photos and files into the box. The pasteboard's contents are read only
/// when the user pastes, never on focus, so iOS asks nothing.
private struct PasteAttacher: UIViewRepresentable {
    @EnvironmentObject var model: AppModel
    let box: PhotoBox
    func makeUIView(context: Context) -> Marker { Marker(coordinator: context.coordinator) }
    func updateUIView(_ view: Marker, context: Context) { context.coordinator.box = box; context.coordinator.model = model }
    func makeCoordinator() -> Coordinator { Coordinator(box: box, model: model) }

    /// Sits behind the field, the same size. When a text view begins editing over it, that is the field.
    final class Marker: UIView {
        let coordinator: Coordinator
        private var observers: [NSObjectProtocol] = []
        init(coordinator: Coordinator) {
            self.coordinator = coordinator
            super.init(frame: .zero)
            isUserInteractionEnabled = false; isAccessibilityElement = false
            for name in [UITextView.textDidBeginEditingNotification, UITextField.textDidBeginEditingNotification] {
                observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                    MainActor.assumeIsolated { self?.began(note.object as? UIView) }
                })
            }
        }
        required init?(coder: NSCoder) { nil }
        deinit { observers.forEach(NotificationCenter.default.removeObserver) }
        private func began(_ field: UIView?) {
            guard let field, let window, field.window === window else { return }
            let mine = convert(bounds, to: window), theirs = field.convert(field.bounds, to: window)
            guard mine.insetBy(dx: -4, dy: -4).contains(CGPoint(x: theirs.midX, y: theirs.midY)) else { return }
            coordinator.take(field)
        }
    }

    @MainActor final class Coordinator: NSObject {
        var box: PhotoBox
        weak var model: AppModel?
        init(box: PhotoBox, model: AppModel) { self.box = box; self.model = model }
        func take(_ field: UIView) {
            objc_setAssociatedObject(field, &PasteHook.key, self, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
            PasteHook.install(on: type(of: field))
        }
        /// Attaches what was copied when it holds a photo or a file. False leaves the paste to the field: words.
        func paste() -> Bool {
            let all = UIPasteboard.general.itemProviders.compactMap { provider in
                SharedItemKind(types: provider.registeredTypeIdentifiers, suggestedName: provider.suggestedName).map { (provider, $0) }
            }
            let items = all.filter { $0.1 != .words }
            guard !items.isEmpty, let model else { return false }
            // Words copied with a photo, a caption say, go in the field after what is there.
            if let words = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines), !words.isEmpty,
               all.contains(where: { $0.1 == .words }) {
                let draft = model.drafts[box.id] ?? ""
                model.drafts[box.id] = draft.isEmpty ? words : draft + " " + words
            }
            var photos: [PhotoSource] = [], files: [FileSource] = []
            for (provider, kind) in items {
                let name = provider.suggestedName
                switch kind {
                case .photo(let type):
                    let stem = ((name ?? "") as NSString).deletingPathExtension
                    photos.append(PhotoSource(name: stem.isEmpty ? "Pasted photo" : stem) { try await provider.data(as: type) })
                case .file(let type):
                    files.append(FileSource(name: SharedItemKind.name(name, type: type, fallback: "Pasted file"), sizeBytes: nil) { try await provider.data(as: type) })
                case .words: break
                }
            }
            model.attach(box, photos: photos, files: files)
            return true
        }
    }
}

/// The text view class under SwiftUI's field offers Paste for a copied photo or file, which it otherwise refuses, and hands
/// it to the box marked on that field. A field without a box, or a paste of words, goes on as before. Installed once a class.
@MainActor private enum PasteHook {
    static var key = 0
    private static var installed = Set<ObjectIdentifier>()
    private static let pasteSelector = #selector(UIResponderStandardEditActions.paste(_:))
    /// Whether the pasteboard holds something only a box can take. Reads its types alone, so iOS asks nothing.
    private static var holdsAttachment: Bool {
        let types = UIPasteboard.general.types
        guard let kind = SharedItemKind(types: types, suggestedName: nil) else { return false }
        return kind != .words
    }
    static func install(on base: AnyClass) {
        guard installed.insert(ObjectIdentifier(base)).inserted else { return }
        let canSelector = #selector(UIResponder.canPerformAction(_:withSender:))
        if let method = class_getInstanceMethod(base, canSelector) {
            typealias Can = @convention(c) (AnyObject, Selector, Selector, Any?) -> Bool
            let original = unsafeBitCast(method_getImplementation(method), to: Can.self)
            let block: @convention(block) (AnyObject, Selector, Any?) -> Bool = { view, action, sender in
                if action == pasteSelector, objc_getAssociatedObject(view, &key) != nil,
                   MainActor.assumeIsolated({ holdsAttachment }) { return true }
                return original(view, canSelector, action, sender)
            }
            let imp = imp_implementationWithBlock(block)
            if !class_addMethod(base, canSelector, imp, method_getTypeEncoding(method)) { method_setImplementation(method, imp) }
        }
        if let method = class_getInstanceMethod(base, pasteSelector) {
            typealias Paste = @convention(c) (AnyObject, Selector, Any?) -> Void
            let original = unsafeBitCast(method_getImplementation(method), to: Paste.self)
            let block: @convention(block) (AnyObject, Any?) -> Void = { view, sender in
                if let coordinator = objc_getAssociatedObject(view, &key) as? PasteAttacher.Coordinator,
                   MainActor.assumeIsolated({ coordinator.paste() }) { return }
                original(view, pasteSelector, sender)
            }
            let imp = imp_implementationWithBlock(block)
            if !class_addMethod(base, pasteSelector, imp, method_getTypeEncoding(method)) { method_setImplementation(method, imp) }
        }
    }
}

extension NSItemProvider {
    /// The item's bytes as `type`, from a copy, a paste or the share sheet.
    func data(as type: String) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            _ = loadDataRepresentation(forTypeIdentifier: type) { data, error in
                if let data { continuation.resume(returning: data) } else { continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown)) }
            }
        }
    }
}
