import SwiftUI
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

/// The files waiting in a thread's reply box, under its photos, inside the words' column, as on the desktop.
struct DraftFilePills: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    var body: some View {
        let locked = model.preparingSends.contains(ref.id)
        FlowLayout(spacing: Space.s2) {
            ForEach(model.files(ref)) { file in
                FilePill(name: file.name, sizeBytes: file.sizeBytes, progress: file.progress, reading: file.reading,
                         remove: { model.removeFile(file.id, from: ref) }, locked: locked)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Files in this reply")
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
                Button(action: remove) {
                    Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).foregroundStyle(Palette.muted)
                        .frame(width: 40, height: 36).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(locked)
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
        else { Image(systemName: Self.symbol(name)).font(.system(size: 14)).foregroundStyle(Palette.muted) }
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
