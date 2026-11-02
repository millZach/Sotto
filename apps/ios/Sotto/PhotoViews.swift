import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers
import AVFoundation
import AVKit
import ImageIO
import SottoCore

// MARK: Sent photos

/// Sent photos as a thread draws them: fetched from their computer when first shown, made small, and kept in
/// memory while the app runs. Nothing is written to disk. A photo that has scrolled away before its turn on
/// the computer comes is never fetched.
@MainActor final class PhotoPreviews: ObservableObject {
    /// A sent photo by its message and attachment; an agent's picture (ADR-0170) by its step, with `attachmentID` its
    /// handle's ID and `messageID` the step's.
    struct Key: Hashable { let ref: ThreadRef; let messageID: String; let attachmentID: String; var activityID: String? = nil }
    private final class Box { let image: CGImage; init(_ image: CGImage) { self.image = image } }
    private let thumbnails: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>(); cache.countLimit = 150; cache.totalCostLimit = 64 * 1024 * 1024; return cache
    }()
    private var loading: [Key: Task<CGImage?, Never>] = [:]
    /// How many thumbnails, and separately how many open viewers, show each photo now.
    private var shown: [Key: Int] = [:]
    private var viewed: [Key: Int] = [:]
    /// The last photo opened full size, so swiping back to it doesn't fetch it again.
    private var opened: (key: Key, image: CGImage)?
    private var openingFull: [Key: Task<CGImage?, Never>] = [:]

    private static func name(_ ref: ThreadRef, _ attachmentID: String, activityID: String? = nil) -> NSString {
        (activityID.map { "\(ref.id)/\($0)/\(attachmentID)" } ?? "\(ref.id)/\(attachmentID)") as NSString
    }
    func cached(_ key: Key) -> CGImage? { thumbnails.object(forKey: Self.name(key.ref, key.attachmentID, activityID: key.activityID))?.image }
    /// Keeps the thumbnails of a reply this iPhone just sent under their staged IDs, which its message's photos
    /// carry, so the thread draws them without asking the computer for them.
    func keep(_ photos: [DraftPhoto], ref: ThreadRef) {
        for photo in photos {
            guard let id = photo.staged?.id, let image = photo.prepared?.thumbnail else { continue }
            thumbnails.setObject(Box(image), forKey: Self.name(ref, id), cost: image.bytesPerRow * image.height)
        }
    }
    func appeared(_ key: Key) { shown[key, default: 0] += 1 }
    func disappeared(_ key: Key) { shown[key] = (shown[key] ?? 1) > 1 ? shown[key]! - 1 : nil }
    /// A closed viewer's full-size photo is never fetched, even while its thumbnail is still in the thread.
    func viewerOpened(_ key: Key) { viewed[key, default: 0] += 1 }
    func viewerClosed(_ key: Key) { viewed[key] = (viewed[key] ?? 1) > 1 ? viewed[key]! - 1 : nil }
    func thumbnail(_ key: Key, model: AppModel) async -> CGImage? {
        if let hit = cached(key) { return hit }
        if let running = loading[key] { return await running.value }
        let task = Task { [weak self] () -> CGImage? in
            let data = await model.photoBytes(key.ref, messageID: key.messageID, attachmentID: key.attachmentID, activityID: key.activityID) {
                (self?.shown[key] ?? 0) > 0
            }
            guard let data, let image = await PhotoPipeline.image(data, edge: PhotoPipeline.thumbnailEdge) else { return nil }
            self?.thumbnails.setObject(Box(image), forKey: PhotoPreviews.name(key.ref, key.attachmentID, activityID: key.activityID), cost: image.bytesPerRow * image.height)
            return image
        }
        loading[key] = task
        let image = await task.value
        loading[key] = nil
        return image
    }
    /// A sent photo at about the size of the screen, for the viewer. Asked for once however often it is opened,
    /// and not at all if the viewer has closed before its turn on the computer comes.
    func full(_ key: Key, model: AppModel) async -> CGImage? {
        if let opened, opened.key == key { return opened.image }
        if let running = openingFull[key] { return await running.value }
        let task = Task { [weak self] () -> CGImage? in
            guard let data = await model.photoBytes(key.ref, messageID: key.messageID, attachmentID: key.attachmentID, activityID: key.activityID, wanted: {
                (self?.viewed[key] ?? 0) > 0
            }), let image = await PhotoPipeline.image(data, edge: PhotoPipeline.screenEdge) else { return nil }
            self?.opened = (key, image)
            return image
        }
        openingFull[key] = task
        let image = await task.value
        openingFull[key] = nil
        return image
    }
}

/// A user message's photos its computer keeps, each standing on its own above the words, as in Messages: a press opens
/// them full screen. A thread's and Watcher's conversation draw them the same way.
struct SentPhotoButtons: View {
    let ref: ThreadRef
    let messageID: String
    let photos: [Attachment]
    let open: (OpenPhotos) -> Void
    var body: some View {
        ForEach(Array(photos.enumerated()), id: \.element.id) { index, photo in
            Button { open(OpenPhotos(ref: ref, messageID: messageID, photos: photos, index: index)) } label: {
                SentPhotoView(key: PhotoPreviews.Key(ref: ref, messageID: messageID, attachmentID: photo.id), name: photo.name)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open photo \(photo.name)")
        }
    }
}

/// The photos of one message in a thread, or the pictures of one run of steps: what a press opens full screen.
struct OpenPhotos: Identifiable {
    struct Item: Identifiable { let key: PhotoPreviews.Key; let name: String; var id: String { (key.activityID ?? "") + "/" + key.attachmentID } }
    let ref: ThreadRef; let id: String; let items: [Item]; var index: Int
    init(ref: ThreadRef, messageID: String, photos: [Attachment], index: Int) {
        self.ref = ref; self.id = messageID; self.index = index
        self.items = photos.map { Item(key: PhotoPreviews.Key(ref: ref, messageID: messageID, attachmentID: $0.id), name: $0.name) }
    }
    init(ref: ThreadRef, id: String, items: [Item], index: Int) { self.ref = ref; self.id = id; self.items = items; self.index = index }
}

/// One sent photo in the thread, at its own shape. It shows a placeholder until its thumbnail arrives.
struct SentPhotoView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var previews: PhotoPreviews
    let key: PhotoPreviews.Key
    let name: String
    @State private var image: CGImage?
    @State private var missing = false
    var body: some View {
        // A photo already in memory takes its own shape on its first layout, so a row made again as it scrolls back into
        // view keeps its height rather than growing from the placeholder under the reader.
        let shown = image ?? (ProcessInfo.processInfo.arguments.contains("--diag-no-fix") ? nil : previews.cached(key)) // [DEBUG-snap]
        Group {
            if let shown {
                Image(decorative: shown, scale: 1).resizable().scaledToFill()
            } else {
                ZStack {
                    Rectangle().fill(Palette.raised)
                    if missing { Image(systemName: "photo").font(.title2).foregroundStyle(Palette.muted) }
                    else { ProgressView() }
                }
            }
        }
        .frame(width: Self.size(shown).width, height: Self.size(shown).height)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .onAppear { previews.appeared(key) }
        .onDisappear { previews.disappeared(key) }
        .task(id: key) {
            if image == nil { image = previews.cached(key) }
            if image == nil { image = await previews.thumbnail(key, model: model); missing = image == nil }
        }
    }
    /// At most 220 by 240 points, at the photo's own shape once it is known.
    private static func size(_ image: CGImage?) -> CGSize {
        guard let image, image.width > 0, image.height > 0 else { return CGSize(width: 160, height: 160) }
        let scale = min(220 / Double(image.width), 240 / Double(image.height))
        return CGSize(width: max(60, Double(image.width) * scale), height: max(60, Double(image.height) * scale))
    }
}

/// A message's photos full screen, one at a time; swipe for the others.
struct PhotoViewer: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var previews: PhotoPreviews
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    @State var opened: OpenPhotos
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Done") { dismiss() }.fontWeight(.semibold).frame(minHeight: 44)
                Spacer()
                if opened.items.count > 1 { Text("\(opened.index + 1) of \(opened.items.count)").foregroundStyle(Palette.muted) }
            }.padding(.horizontal, 20).foregroundStyle(Palette.ink)
            TabView(selection: $opened.index) {
                ForEach(Array(opened.items.enumerated()), id: \.element.id) { index, item in
                    FullPhoto(key: item.key, name: item.name).tag(index)
                }
            }.tabViewStyle(.page(indexDisplayMode: opened.items.count > 1 ? .always : .never))
            Text(opened.items[safe: opened.index]?.name ?? "").font(.footnote).foregroundStyle(Palette.muted)
                .lineLimit(1).truncationMode(.middle).padding(.horizontal, 20).padding(.vertical, 12)
        }
        .background(Palette.canvas)
        // A full-screen cover sits above the root's own cover, so it covers itself while Sotto isn't in front,
        // and the app switcher never shows a photo.
        .overlay {
            if phase != .active {
                Rectangle().fill(Palette.canvas).ignoresSafeArea().overlay(Text("Sotto").font(.title2).foregroundStyle(Palette.ink))
            }
        }
        .accessibilityAction(.escape) { dismiss() }
    }
}

private struct FullPhoto: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var previews: PhotoPreviews
    let key: PhotoPreviews.Key
    let name: String
    @State private var image: CGImage?
    @State private var missing = false
    var body: some View {
        ZStack {
            if let image {
                Image(image, scale: 1, label: Text("Photo: \(name)")).resizable().scaledToFit()
            } else if missing {
                Text("This photo couldn’t be loaded from \(model.name(key.ref.hostID)). Nothing was lost. Try again when it’s connected.", comment: "%@ is the computer’s name.")
                    .multilineTextAlignment(.center).foregroundStyle(Palette.muted).padding(32)
                    .paragraphDirection()
            } else { ProgressView() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { previews.viewerOpened(key) }
        .onDisappear { previews.viewerClosed(key) }
        .task(id: key) { image = await previews.full(key, model: model); missing = image == nil && !Task.isCancelled }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

// MARK: The reply box's photos

/// The photos waiting in a reply box, at their own shape, each with its own Remove button.
struct DraftPhotoStrip: View {
    @EnvironmentObject var model: AppModel
    let box: PhotoBox
    var body: some View {
        let photos = model.photos(box)
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .bottom, spacing: 6) {
                ForEach(Array(photos.enumerated()), id: \.element.id) { index, photo in
                    DraftPhotoView(photo: photo, number: index + 1, count: photos.count,
                                   locked: model.preparingSends.contains(box.id)) { model.removePhoto(photo.id, from: box) }
                }
            }.padding(.top, 2)
        }.frame(height: 92)
    }
}

/// What waits in a reply box above its words, a thread's or Watcher's, as in Messages: the photos across the box, the
/// files under them as pills, and why the last one chosen wasn't added. Nothing while the box holds none of them.
struct DraftAttachments: View {
    @EnvironmentObject var model: AppModel
    let box: PhotoBox
    var body: some View {
        let photos = model.photos(box), files = model.files(box), notice = model.photoNotices[box.id]
        if !photos.isEmpty || !files.isEmpty || notice != nil {
            VStack(alignment: .leading, spacing: Space.s2) {
                if !photos.isEmpty { DraftPhotoStrip(box: box) }
                if !files.isEmpty { DraftFilePills(box: box) }
                if let notice {
                    Text(notice).font(.sotto(.small)).foregroundStyle(Palette.dangerText).fixedSize(horizontal: false, vertical: true)
                        .paragraphDirection()
                        .padding(.horizontal, ComposerMetrics.wordsInset - ComposerMetrics.attachmentsInset)
                        .accessibilityAddTraits(.updatesFrequently)
                }
            }
            .padding([.horizontal, .top], ComposerMetrics.attachmentsInset)
            .padding(.bottom, Space.s2)
        }
    }
}

private struct DraftPhotoView: View {
    let photo: DraftPhoto
    let number: Int
    let count: Int
    let locked: Bool
    let remove: () -> Void
    @State private var removed = 0
    var body: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if let thumbnail = photo.prepared?.thumbnail {
                    Image(decorative: thumbnail, scale: 1).resizable().scaledToFill()
                } else { Rectangle().fill(Palette.surface) }
            }
            .frame(width: width, height: 88)
            .overlay { if photo.preparing || photo.staging { ZStack { Rectangle().fill(Palette.canvas.opacity(0.55)); ProgressView() } } }
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .accessibilityElement()
            .accessibilityLabel("Photo \(number) of \(count)")
            .accessibilityValue(photo.preparing ? String(localized: "Getting it ready", comment: "Accessibility value: a photo in the reply box is being prepared.") : photo.staging ? String(localized: "Sending it to the computer", comment: "Accessibility value: a photo in the reply box is being sent to the computer.") : String(localized: "Ready", comment: "Accessibility value: a photo in the reply box is ready to send."))
            Button {
                removed += 1
                remove()
            } label: {
                Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Palette.canvas)
                    .frame(width: 22, height: 22).background(Palette.ink.opacity(0.85), in: Circle())
                    .frame(width: 44, height: 44, alignment: .topTrailing).padding(4).contentShape(Rectangle())
            }
            .buttonStyle(.plain).sensoryFeedback(.impact(flexibility: .soft), trigger: removed).offset(x: 4, y: -4).disabled(locked)
            .accessibilityLabel("Remove photo \(number)")
        }
    }
    /// The photo's own shape at 88 points tall, between a tall portrait and a wide screenshot.
    private var width: Double {
        guard let thumbnail = photo.prepared?.thumbnail, thumbnail.height > 0 else { return 66 }
        return min(132, max(60, 88 * Double(thumbnail.width) / Double(thumbnail.height)))
    }
}

// MARK: Choosing photos

/// The reply box's + button, the first in its row: Photo library, Camera and Files (ADR-0131). When the box can't take photos, or files, those
/// choices stay in the menu, unavailable, with the reason beneath them. A thread's box and Watcher's work the same way.
/// Whatever goes into the box, from here, a paste or the share sheet, answers with the same tap.
struct AttachPhotosButton: View {
    @EnvironmentObject var model: AppModel
    let box: PhotoBox
    @State private var choosing = false
    @State private var shooting = false
    @State private var choosingFiles = false
    @State private var picked: [PhotosPickerItem] = []
    var body: some View {
        let reason = self.reason, fileReason = self.fileReason
        Menu {
            Section {
                Button { choosing = true } label: { Label("Photo library", systemImage: "photo.on.rectangle") }
                    .disabled(reason != nil)
                Button { openCamera() } label: { Label("Camera", systemImage: "camera") }
                    .disabled(reason != nil || !CameraPicker.available)
                if let reason { Text(reason) }
            }
            Section {
                Button { choosingFiles = true } label: { Label("Files", systemImage: "folder") }
                    .disabled(fileReason != nil)
                if let fileReason { Text(fileReason) }
            }
        } label: {
            // The first of the row's round buttons, inside the box; it takes a press across 44 points.
            Image(systemName: "plus").fontWeight(.semibold)
                .foregroundStyle(reason == nil || fileReason == nil ? Palette.ink : Palette.muted)
                .composerDisc(Palette.fillSoft)
        }
        .accessibilityLabel(String(localized: "Attach photos or files"))
        .accessibilityHint([reason, fileReason].compactMap { $0 }.first ?? String(localized: "Choose photos from the library, take one with the camera, or choose files."))
        .accessibilityIdentifier(watcher ? "watcher-attach-photos" : "thread-attach-photos")
        .photosPicker(isPresented: $choosing, selection: $picked, maxSelectionCount: max(1, room),
                      selectionBehavior: .ordered, matching: .images, preferredItemEncoding: .current)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            let start = model.photos(box).count
            model.attachPhotos(box, from: items.enumerated().map { offset, item in
                PhotoSource(name: "Photo \(start + offset + 1)") {
                    guard let data = try await item.loadTransferable(type: Data.self) else { throw PhotoPipelineError.unreadable }
                    return data
                }
            })
            picked = []
        }
        // Opened where they are, not copied in: only the files chosen are handed over, each read under its own access.
        .fileImporter(isPresented: $choosingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { pickedFiles(urls) }
        }
        .fullScreenCover(isPresented: $shooting) {
            CameraPicker(shown: $shooting) { image in
                model.attachPhotos(box, from: [PhotoSource(name: "Camera photo") {
                    guard let data = image.jpegData(compressionQuality: 0.95) else { throw PhotoPipelineError.unreadable }
                    return data
                }])
            }.ignoresSafeArea()
        }
        .sensoryFeedback(.selection, trigger: model.attachHaptics[box.id] ?? 0)
    }
    private var watcher: Bool { if case .watcher = box { return true }; return false }
    /// Photos and files count toward the same eight.
    private var room: Int { PhotoLimits.count - model.photos(box).count - model.files(box).count }
    private var reason: String? {
        if let reason = model.photoSupport(box).reason(computer: model.name(box.hostID), watcher: watcher) { return reason }
        if model.preparingSends.contains(box.id) {
            return watcher ? String(localized: "Your message is being sent.", comment: "A message to Watcher is on its way, so its photos can't change")
                : String(localized: "Your reply is being sent.")
        }
        if room > 0 { return nil }
        return model.files(box).isEmpty ? box.photoLimitWords : FileWords.full
    }
    private var fileReason: String? {
        if let reason = model.fileSupport(box).reason(computer: model.name(box.hostID)) { return reason }
        if model.preparingSends.contains(box.id) {
            return watcher ? String(localized: "Your message is being sent.", comment: "A message to Watcher is on its way, so its photos can't change")
                : String(localized: "Your reply is being sent.")
        }
        return room > 0 ? nil : FileWords.full
    }
    private func pickedFiles(_ urls: [URL]) {
        let photos = urls.filter { PhotoLimits.mimeTypes.contains(Files.mimeType(forName: $0.lastPathComponent)) }
        model.attach(box, photos: photos.map { url in
            PhotoSource(name: url.deletingPathExtension().lastPathComponent) { try await Task.detached { try PickedFile.read(url) }.value }
        }, files: urls.filter { !photos.contains($0) }.map(PickedFile.source))
    }
    /// The camera asks for access the first time. Once it has been refused, iOS won't ask again, so say where to turn it on.
    private func openCamera() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .denied, .restricted:
            model.photoNotices[box.id] = String(localized: "Sotto can’t use the camera. Turn it on in Settings › Sotto › Camera.")
        default: shooting = true
        }
    }
}

/// The system camera, for one photo. Nothing is saved to the photo library.
struct CameraPicker: UIViewControllerRepresentable {
    static var available: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }
    @Binding var shown: Bool
    let taken: @MainActor (UIImage) -> Void
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera; picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(shown: $shown, taken: taken) }
    @MainActor final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let shown: Binding<Bool>
        let taken: @MainActor (UIImage) -> Void
        init(shown: Binding<Bool>, taken: @escaping @MainActor (UIImage) -> Void) { self.shown = shown; self.taken = taken }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { taken(image) }
            shown.wrappedValue = false
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { shown.wrappedValue = false }
    }
}

// MARK: An agent's pictures

/// The pictures a run of steps made or looked at (ADR-0170), as tiles two across under the run, whether it is open or
/// folded: a press opens them full screen. Each tile reads its picture from the computer when it first shows, and the
/// thumbnail is made here, as a sent photo's is.
struct AgentPictures: View {
    let ref: ThreadRef
    let steps: [Activity]
    let open: (OpenPhotos) -> Void
    private var items: [OpenPhotos.Item] {
        steps.flatMap { step in (step.media ?? []).filter { $0.kind == "image" }.map { picture in
            OpenPhotos.Item(key: PhotoPreviews.Key(ref: ref, messageID: step.id, attachmentID: picture.id, activityID: step.id), name: AgentPictures.title(of: step))
        } }
    }
    /// The GIFs among the pictures, by their key's ID: each plays in its tile when asked.
    private var gifs: Set<String> {
        Set(steps.flatMap { step in (step.media ?? []).filter { $0.mimeType == "image/gif" }.map { step.id + "/" + $0.id } })
    }
    /// A step's name: the computer's words, or this iPhone's for the step Sotto makes for a turn's written files.
    static func title(of step: Activity) -> String {
        step.id.hasPrefix("sotto-written-")
            ? String(localized: "Pictures and videos it wrote", comment: "The step that holds the pictures and videos an agent wrote in its folder during a turn.")
            : step.title
    }
    /// A video a step's turn wrote (ADR-0170, part 4), by its step and its handle.
    private struct WrittenVideo: Identifiable {
        let step: Activity; let video: Activity.Media
        var id: String { step.id + "/" + video.id }
    }
    /// The videos the steps' turns wrote, each played in its own tile.
    private var videos: [WrittenVideo] {
        steps.flatMap { step in (step.media ?? []).filter { $0.kind == "video" }.map { WrittenVideo(step: step, video: $0) } }
    }
    var body: some View {
        let items = self.items
        let gifs = self.gifs
        let videos = self.videos
        // A step still making an image shows the owl at the easel in its picture's place.
        let making = steps.filter(\.makingImage)
        if !items.isEmpty || !videos.isEmpty || !making.isEmpty {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: Space.s2), GridItem(.flexible(), spacing: Space.s2)], alignment: .leading, spacing: Space.s2) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    AgentPictureCell(item: item, gif: gifs.contains(item.id), number: index + 1, count: items.count) {
                        open(OpenPhotos(ref: ref, id: "pictures-" + (steps.first?.id ?? ""), items: items, index: index))
                    }
                }
                ForEach(Array(videos.enumerated()), id: \.element.id) { index, item in
                    AgentVideoTile(ref: ref, step: item.step, video: item.video, number: index + 1, count: videos.count)
                }
                ForEach(making) { step in OwlEaselTile(startedAt: step.startedAt) }
            }
            .padding(.vertical, Space.s2)
        }
    }
}

/// The owl at the easel (ADR-0170) in the tile of an image a step is still making. It draws twelve frames a second only
/// while it is on screen and the app is in front, holds one still frame under Reduce Motion, and is gone, timeline and
/// all, the moment the picture lands.
private struct OwlEaselTile: View {
    let startedAt: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var shown = false
    @State private var began: Date?
    var body: some View {
        let still = reduceMotion || !shown || scenePhase != .active
        Rectangle().fill(Palette.raised)
            .aspectRatio(1.5, contentMode: .fit)
            .overlay {
                GeometryReader { box in
                    TimelineView(.animation(minimumInterval: 1 / OwlEasel.framesPerSecond, paused: still)) { context in
                        scene(in: box.size, at: reduceMotion ? nil : context.date)
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("Making the image", comment: "A tile standing in for an image an agent is still making."))
            .onAppear { shown = true; if began == nil { began = startedAt.flatMap(Stamp.date) ?? Date() } }
            .onDisappear { shown = false }
    }

    /// One frame sized to the tile: the scene's rows fill its height and its columns its width. `at` nil is the still frame.
    private func scene(in size: CGSize, at date: Date?) -> some View {
        let grid = OwlEasel.grid(width: Double(size.width), height: Double(max(1, size.height)))
        let seconds = date.map { max(0, $0.timeIntervalSince(began ?? $0)) } ?? 0
        let frame = OwlEasel.frame(cols: grid.cols, rows: grid.rows, progress: date == nil ? 0.5 : OwlEasel.progress(seconds: seconds), seconds: seconds)
        let font = Font.system(size: max(1, grid.fontSize), design: .monospaced)
        return ZStack {
            Text(verbatim: frame.sketch).foregroundStyle(Palette.muted)
            Text(verbatim: frame.paint).foregroundStyle(Palette.accent)
        }
        .font(font)
        .lineSpacing(0)
        .fixedSize()
        .frame(width: size.width, height: size.height)
    }
}

/// One of an agent's pictures in its grid: a press opens the viewer. A GIF (ADR-0170, part 4) shows its first frame still
/// and has a button of its own that plays it in the tile until it is pressed again or scrolls away.
private struct AgentPictureCell: View {
    let item: OpenPhotos.Item
    let gif: Bool
    let number: Int
    let count: Int
    let open: () -> Void
    @State private var playing = false
    var body: some View {
        ZStack(alignment: .topTrailing) {
            Button(action: open) { AgentPictureTile(key: item.key, playing: gif && playing) }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Open picture \(number) of \(count), from \(item.name)", comment: "%1$lld of %2$lld pictures an agent's steps made; %3$@ names the step."))
            if gif {
                Button { playing.toggle() } label: {
                    Image(systemName: playing ? "pause.circle.fill" : "play.circle.fill").font(.title2).foregroundStyle(Palette.muted)
                        .padding(Space.s2).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(playing ? Text("Stop GIF \(number)", comment: "%lld is the place of an agent's GIF among the pictures of one run.")
                                            : Text("Play GIF \(number)", comment: "%lld is the place of an agent's GIF among the pictures of one run."))
            }
        }
        .onDisappear { playing = false }
    }
}

/// A GIF's frames at tile size and how long each shows, decoded off the main actor; at most 300 frames, each at most
/// 480 points on its longer side, so a large GIF stays small in memory. Never changed once made, so it crosses tasks freely.
private struct GIFFrames: @unchecked Sendable {
    let images: [CGImage]; let delays: [Double]
    var duration: Double { delays.reduce(0, +) }
    init?(data: Data) {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let count = min(CGImageSourceGetCount(source), 300)
        let options = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 480, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary
        var images: [CGImage] = [], delays: [Double] = []
        for index in 0..<count {
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, index, options) else { continue }
            let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]
            let gif = properties?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
            let delay = (gif?[kCGImagePropertyGIFUnclampedDelayTime] as? Double) ?? (gif?[kCGImagePropertyGIFDelayTime] as? Double) ?? 0.1
            images.append(image); delays.append(max(0.02, delay))
        }
        guard images.count > 1 else { return nil }
        self.images = images; self.delays = delays
    }
    /// The frame showing `seconds` into the loop.
    func frame(at seconds: Double) -> CGImage {
        var left = seconds.truncatingRemainder(dividingBy: duration)
        for (index, delay) in delays.enumerated() { if left < delay { return images[index] }; left -= delay }
        return images[images.count - 1]
    }
}

/// A video an agent wrote (ADR-0170, part 4), in a tile the size of a picture's. It is fetched from its computer only when
/// it is tapped, plays only then, and pauses the moment it scrolls away. One larger than this iPhone fetches says it
/// plays on the desktop.
private struct AgentVideoTile: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    let step: Activity
    let video: Activity.Media
    let number: Int
    let count: Int
    @State private var player: AVPlayer?
    @State private var progress: Double?
    @State private var problem: Problem?
    @State private var shown = false
    private enum Problem { case tooLarge, unplayable }
    var body: some View {
        Rectangle().fill(Palette.raised)
            .aspectRatio(1.5, contentMode: .fit)
            .overlay {
                if let player { VideoPlayer(player: player) }
                else if let problem {
                    Text(problem == .tooLarge
                         ? String(localized: "Too large to play on this iPhone. Play it on the desktop.", comment: "On a tile of a video an agent wrote that is over the size this iPhone fetches.")
                         : String(localized: "Could not play. The file may have changed or been removed on its computer. Ask the agent to write it again.", comment: "On a tile of a video an agent wrote that could not be fetched or played."))
                        .font(.footnote).foregroundStyle(Palette.muted).multilineTextAlignment(.center).padding(Space.s2)
                } else if let progress { ProgressView(value: progress).padding(Space.s3) }
                else {
                    Button(action: start) {
                        Image(systemName: "play.circle.fill").font(.largeTitle).foregroundStyle(Palette.muted)
                            .frame(maxWidth: .infinity, maxHeight: .infinity).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("Play video \(number) of \(count), from \(AgentPictures.title(of: step))", comment: "%1$lld of %2$lld videos an agent's steps wrote; %3$@ names the step."))
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .onAppear { shown = true }
            // Scrolled away, it pauses at once; its fetch, if any, stops asking for parts.
            .onDisappear { shown = false; player?.pause() }
    }
    private func start() {
        guard AgentVideos.playsHere(sizeBytes: video.sizeBytes ?? 0) else { problem = .tooLarge; return }
        progress = 0
        Task {
            let outcome = await model.agentVideo(ref, activityID: step.id, mediaID: video.id, progress: { progress = $0 }, wanted: { shown })
            progress = nil
            guard case .file(let url) = outcome else { problem = .unplayable; return }
            let made = AVPlayer(url: url)
            player = made
            if shown { made.play() }
        }
    }
}

/// One of an agent's pictures as a tile, three by two, filled. It shows a placeholder until its thumbnail arrives, and
/// says so when the computer no longer keeps it.
private struct AgentPictureTile: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var previews: PhotoPreviews
    let key: PhotoPreviews.Key
    /// A GIF asked to play: its whole bytes are fetched and its frames drawn in the tile, from the first.
    var playing = false
    @State private var image: CGImage?
    @State private var missing = false
    @State private var frames: GIFFrames?
    @State private var began = Date()
    var body: some View {
        Rectangle().fill(Palette.raised)
            .aspectRatio(1.5, contentMode: .fit)
            .overlay {
                if playing, let frames {
                    TimelineView(.animation) { context in
                        Image(decorative: frames.frame(at: context.date.timeIntervalSince(began)), scale: 1).resizable().scaledToFill()
                    }
                } else if let image { Image(decorative: image, scale: 1).resizable().scaledToFill() }
                else if missing { Image(systemName: "photo").font(.title2).foregroundStyle(Palette.muted) }
                else { ProgressView() }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .onAppear { previews.appeared(key) }
            // A tile that scrolls away lets go of its picture; the shared cache keeps the thumbnail for its return.
            .onDisappear { previews.disappeared(key); image = nil }
            .task(id: key) {
                if image == nil { image = previews.cached(key) }
                guard image == nil else { return }
                let read = await previews.thumbnail(key, model: model)
                // A read that ends after the tile left draws nothing into it.
                guard !Task.isCancelled else { return }
                image = read; missing = read == nil
            }
            .task(id: playing) {
                guard playing else { frames = nil; return }
                let data = await model.photoBytes(key.ref, messageID: key.messageID, attachmentID: key.attachmentID, activityID: key.activityID, wanted: { playing })
                guard !Task.isCancelled, let data else { return }
                let decoded = await Task.detached { GIFFrames(data: data) }.value
                guard !Task.isCancelled, playing else { return }
                began = Date(); frames = decoded
            }
    }
}
