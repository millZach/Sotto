import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers
import AVFoundation
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
            let data = await model.photoBytes(key) {
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
            guard let data = await model.photoBytes(key, wanted: {
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
        Group {
            if let image {
                Image(decorative: image, scale: 1).resizable().scaledToFill()
            } else {
                ZStack {
                    Rectangle().fill(Palette.raised)
                    if missing { Image(systemName: "photo").font(.title2).foregroundStyle(Palette.muted) }
                    else { ProgressView() }
                }
            }
        }
        .frame(width: size.width, height: size.height)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .onAppear { previews.appeared(key) }
        .onDisappear { previews.disappeared(key) }
        .task(id: key) {
            if image == nil { image = previews.cached(key) }
            if image == nil { image = await previews.thumbnail(key, model: model); missing = image == nil }
        }
    }
    /// At most 220 by 240 points, at the photo's own shape once it is known.
    private var size: CGSize {
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

/// The reply box's + button: Photo library, Camera and Files (ADR-0131). When the box can't take photos, or files, those
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
            // A circle of its own beside the box, as in Messages, the box's height when it holds one line; it takes a
            // press across 44 points.
            Image(systemName: "plus").fontWeight(.semibold).frame(width: ComposerMetrics.height, height: ComposerMetrics.height)
                .foregroundStyle(reason == nil || fileReason == nil ? Palette.ink : Palette.muted)
                .composerSurface(in: Circle(), interactive: true)
                .pressArea(drawn: ComposerMetrics.height)
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
            OpenPhotos.Item(key: PhotoPreviews.Key(ref: ref, messageID: step.id, attachmentID: picture.id, activityID: step.id), name: step.title)
        } }
    }
    var body: some View {
        let items = self.items
        if !items.isEmpty {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: Space.s2), GridItem(.flexible(), spacing: Space.s2)], alignment: .leading, spacing: Space.s2) {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    Button { open(OpenPhotos(ref: ref, id: "pictures-" + (steps.first?.id ?? ""), items: items, index: index)) } label: {
                        AgentPictureTile(key: item.key)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("Open picture \(index + 1) of \(items.count), from \(item.name)", comment: "%1$lld of %2$lld pictures an agent's steps made; %3$@ names the step."))
                }
            }
            .padding(.vertical, Space.s2)
        }
    }
}

/// One of an agent's pictures as a tile, three by two, filled. It shows a placeholder until its thumbnail arrives, and
/// says so when the computer no longer keeps it.
private struct AgentPictureTile: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var previews: PhotoPreviews
    let key: PhotoPreviews.Key
    @State private var image: CGImage?
    @State private var missing = false
    var body: some View {
        Rectangle().fill(Palette.raised)
            .aspectRatio(3 / 2, contentMode: .fit)
            .overlay {
                if let image { Image(decorative: image, scale: 1).resizable().scaledToFill() }
                else if missing { Image(systemName: "photo").font(.title2).foregroundStyle(Palette.muted) }
                else { ProgressView() }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .onAppear { previews.appeared(key) }
            .onDisappear { previews.disappeared(key) }
            .task(id: key) {
                if image == nil { image = previews.cached(key) }
                if image == nil { image = await previews.thumbnail(key, model: model); missing = image == nil }
            }
    }
}
