import SwiftUI
import SceneKit
import SottoCore

/// A 3D model a thread made with Meshy, in that thread on the iPhone (the Meshy plan's ticket 7). Zach's picks on #2497,
/// November 15, 2026, from the prototype kept as the tag `prototype/meshy-iphone`: the desktop's line, with the still
/// picture, the name, and what it is and cost; a tap opens a sheet that turns it and says what it was made from, what it
/// cost, when, its thread and its files on the computer. The USDZ is fetched on the first open and kept in the app's cache
/// only; one past 64 MB shows its still picture and says to turn it on the computer. While it is made, the line shows the
/// step and how far; while its computer is away, what it cost and that the computer isn't connected; a 3D model that was
/// not made says what happened, as on the desktop.
struct ModelLine3d: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    let line: Model3dLine
    /// When its message was written: the time the sheet shows when the computer can't say when it was asked for.
    let createdAt: String?
    var body: some View { ModelLineRow(ref: ref, line: line, createdAt: createdAt, store: model.models3dStore) }
}

/// What the line says and whether it opens, from the view, the computer and the record.
private enum LineState {
    case loading, done(Model3dView), making(Model3dView), failed(Model3dView), filesGone(Model3dView), away(Model3dView?), gone
}

private struct ModelLineRow: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    let line: Model3dLine
    let createdAt: String?
    @ObservedObject var store: Models3dStore
    @State private var still: UIImage?
    @State private var open = false
    @State private var shown = false

    private var state: LineState {
        let view = store.view(ref.hostID, line.id)
        if store.isGone(ref.hostID, line.id) { return .gone }
        if !model.online(ref.hostID) { return .away(view) }
        guard let view else { return .loading }
        switch view.state {
        case "making": return .making(view)
        case "done": return view.filesGone ? .filesGone(view) : .done(view)
        default: return .failed(view)
        }
    }

    var body: some View {
        let state = self.state
        Group {
            switch state {
            case .failed(let view): failedLine(view)
            case .done:
                Button { open = true } label: { row(state) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("Open the 3D model \(line.name)", comment: "%@ is the name of a 3D model, such as Oak barrel."))
                    .accessibilityValue(Text(kind(state)))
            default: row(state).accessibilityElement(children: .combine)
            }
        }
        .onAppear { shown = true }
        .onDisappear { shown = false }
        .task(id: model.online(ref.hostID)) { await model.load3dModel(ref.hostID, line.id) }
        .task(id: isDone(state)) {
            guard isDone(state), still == nil else { return }
            if let data = await model.still3dModel(ref.hostID, line.id, wanted: { shown }) { still = UIImage(data: data) }
        }
        .sheet(isPresented: $open) {
            ModelSheet3d(ref: ref, line: line, createdAt: createdAt, still: still, store: store).environmentObject(model)
        }
    }

    private func isDone(_ state: LineState) -> Bool { if case .done = state { return true }; return false }

    private func row(_ state: LineState) -> some View {
        HStack(spacing: Space.s3) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Palette.overlay)
                if let still, isDone(state) { Image(uiImage: still).resizable().scaledToFill() }
                else { Image(systemName: "cube").font(.title3).foregroundStyle(Palette.muted) }
            }
            .frame(width: 52, height: 52)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: line.name).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink).lineLimit(1)
                Text(kind(state)).font(.sotto(.small)).foregroundStyle(kindInk(state))
                if case .making(let view) = state, let percent = view.percent {
                    ProgressView(value: Double(percent), total: 100).tint(Palette.accent).padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
            if isDone(state) { Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Palette.muted).accessibilityHidden(true) }
        }
        .padding(.vertical, Space.s2).padding(.leading, Space.s2).padding(.trailing, Space.s3)
        .background(Palette.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Palette.hairline, lineWidth: 1))
        .contentShape(Rectangle())
    }

    /// The line under the name.
    private func kind(_ state: LineState) -> String {
        let computer = model.name(ref.hostID)
        switch state {
        case .loading: return String(localized: "3D model · Meshy", comment: "Under a 3D model's name in its thread, before its computer says what it cost.")
        case .done(let view): return Model3dWords.kind(credits: view.credits)
        case .making(let view):
            let step = Model3dWords.step(view)
            guard let percent = view.percent else { return step }
            return step + " · " + (Double(percent) / 100).formatted(.percent)
        case .failed: return ""
        case .filesGone(let view):
            return view.folder.isEmpty
                ? String(localized: "Its files are gone from the thread’s folder on \(computer).", comment: "%@ is the computer's name. They were moved, renamed or deleted.")
                : String(localized: "Its files are gone from \(view.folder) on \(computer).", comment: "%1$@ is a folder in the thread's folder, such as models; %2$@ is the computer's name.")
        case .away(let view):
            guard let view else { return String(localized: "\(computer) isn’t connected", comment: "%@ is the computer's name, as in forge.") }
            return String(localized: "\(view.credits) credits · \(computer) isn’t connected", comment: "A 3D model's line while its computer is away: what it cost, and the computer's name.")
        case .gone: return String(localized: "Sotto no longer holds this 3D model.")
        }
    }

    private func kindInk(_ state: LineState) -> ThemeRole {
        if case .filesGone = state { return Palette.warningText }
        return Palette.muted
    }

    /// A 3D model that was not made, as on the desktop: what happened, and nothing to open.
    private func failedLine(_ view: Model3dView) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("The \(line.name) was not made.", comment: "%@ is the name of a 3D model, such as Oak barrel.").font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
            Text(Model3dWords.failure(view)).font(.sotto(.small)).foregroundStyle(Palette.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, Space.s2 + 2).padding(.horizontal, Space.s3)
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Palette.hairline, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

/// The words a 3D model's line and sheet share, as the desktop says them.
private enum Model3dWords {
    static func kind(credits: Int) -> String {
        String(localized: "3D model · Meshy · \(credits) credits", comment: "Under a 3D model's name in its thread: what it is and what it cost.")
    }
    /// The step Meshy is on: two from words, one from a photo, then saving the files.
    static func step(_ view: Model3dView) -> String {
        if view.stage == "files" { return String(localized: "Saving the files", comment: "The step Meshy is on while a 3D model is made.") }
        if view.source == "photo" { return String(localized: "Making the 3D model", comment: "The step Meshy is on while a 3D model is made from a photo.") }
        return view.stage == "texture"
            ? String(localized: "Step 2 of 2: painting the texture", comment: "The step Meshy is on while a 3D model is made.")
            : String(localized: "Step 1 of 2: making the shape", comment: "The step Meshy is on while a 3D model is made.")
    }
    /// What happened to a 3D model that was not made, in the desktop's short words.
    static func failure(_ view: Model3dView) -> String {
        switch view.failure {
        case "refused": return String(localized: "Meshy did not accept the key", comment: "Why a 3D model was not made.")
        case "no-credits": return String(localized: "The Meshy account has no credits left", comment: "Why a 3D model was not made.")
        case "rejected": return String(localized: "Meshy would not make it", comment: "Why a 3D model was not made.")
        case "failed": return String(localized: "Could not finish", comment: "Why a 3D model was not made: Meshy could not finish it.")
        case "too-large": return String(localized: "A file was too large to save", comment: "Why a 3D model was not made.")
        case "folder": return String(localized: "The folder would not take the files", comment: "Why a 3D model was not made.")
        case "no-account": return String(localized: "The Meshy account was removed", comment: "Why a 3D model was not made.")
        case "locked": return String(localized: "The key could not be read", comment: "Why a 3D model was not made.")
        case "expired": return String(localized: "Meshy no longer has it", comment: "Why a 3D model was not made.")
        default: return String(localized: "Sotto lost track of it", comment: "Why a 3D model was not made.")
        }
    }
}

/// The sheet a 3D model opens in (Zach's pick): the view that turns on top, then what it was made from, what it cost,
/// when, its thread and its files on the computer. Done or pulling down closes it.
private struct ModelSheet3d: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    let line: Model3dLine
    let createdAt: String?
    let still: UIImage?
    @ObservedObject var store: Models3dStore
    @Environment(\.dismiss) private var dismiss
    @State private var opening: Model3dOpening?
    @State private var scene: SCNScene?
    @State private var progress = 0.0
    @State private var listed: Model3dListed?
    @State private var shown = true

    var body: some View {
        let view = store.view(ref.hostID, line.id)
        let computer = model.name(ref.hostID)
        ScrollView {
            VStack(alignment: .leading, spacing: Space.s4) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: line.name).font(.sotto(.lead, .bold)).foregroundStyle(Palette.ink)
                        if let view { Text(Model3dWords.kind(credits: view.credits)).font(.sotto(.small)).foregroundStyle(Palette.muted) }
                    }
                    Spacer()
                    Button("Done") { dismiss() }.font(.sotto(.body, .semibold)).foregroundStyle(Palette.accentText)
                }
                stage(computer: computer)
                if let view { facts(view, computer: computer) }
            }
            .padding(Space.s4)
        }
        .background(Palette.surface)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .onDisappear { shown = false }
        .task { listed = await model.listed3dModel(ref, line.id) }
        .task(id: view?.id) {
            guard let view, opening == nil else { return }
            let opened = await model.open3dModel(ref.hostID, view, progress: { progress = $0 }, wanted: { shown })
            if case .file(let url) = opened {
                // A scene the file does not make is a file that can't be opened, and is not kept.
                let read = try? SCNScene(url: url, options: [.checkConsistency: true])
                if let read { scene = read; opening = opened } else { try? FileManager.default.removeItem(at: url); opening = .failed }
            } else { opening = opened }
        }
    }

    /// The view that turns, or the still picture with what is happening over it.
    private func stage(computer: String) -> some View {
        ZStack(alignment: .bottom) {
            RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Palette.raised)
            if let scene, case .file = opening {
                ModelScene(scene: scene, label: String(localized: "Turn the \(line.name)", comment: "%@ is the name of a 3D model. Read by VoiceOver on the view that turns."))
                Text("Drag to turn · pinch to zoom").font(.sotto(.caption)).foregroundStyle(Palette.muted).padding(.bottom, Space.s2).accessibilityHidden(true)
            } else {
                if let still { Image(uiImage: still).resizable().scaledToFit().padding(Space.s4).accessibilityHidden(true) }
                VStack(alignment: .leading, spacing: Space.s1) {
                    switch opening {
                    case .tooLarge?: Text("Too large to turn on this iPhone. Turn it on \(computer).", comment: "%@ is the computer's name. A 3D model's USDZ is over 64 MB.")
                    case .failed?: Text("Could not open the 3D model. Its files may have changed on \(computer).", comment: "%@ is the computer's name.")
                    default:
                        Text("Getting the 3D model from \(computer)", comment: "%@ is the computer's name. Its USDZ is fetched to turn it on this iPhone.")
                        ProgressView(value: progress).tint(Palette.accent)
                    }
                }
                .font(.sotto(.small)).foregroundStyle(Palette.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Space.s3)
                .background(Palette.overlay.opacity(0.92), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .padding(Space.s3)
            }
        }
        .frame(height: 330)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    /// What it was made from, what it cost, when, its thread and its files, which stay on the computer.
    private func facts(_ view: Model3dView, computer: String) -> some View {
        let from = listed?.words ?? listed?.photo ?? (view.source == "photo" ? String(localized: "A photo", comment: "What a 3D model was made from, when its file name is not kept.")
            : String(localized: "Words", comment: "What a 3D model was made from, when the words are not kept (Keep local history is off)."))
        let made = Self.date(listed?.askedAt ?? createdAt)
        return VStack(alignment: .leading, spacing: Space.s4) {
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: Space.s4, verticalSpacing: Space.s2) {
                GridRow { Text("Made from", comment: "What a 3D model was made from: its words or a photo.").foregroundStyle(Palette.muted); Text(verbatim: from) }
                GridRow { Text("Cost", comment: "What a 3D model cost, in Meshy's credits.").foregroundStyle(Palette.muted); Text("\(view.credits) credits", comment: "A 3D model's cost in Meshy's credits.") }
                if let made { GridRow { Text("Made", comment: "When a 3D model was asked for.").foregroundStyle(Palette.muted); Text(made.formatted(date: .abbreviated, time: .shortened)) } }
                if let title = model.thread(ref)?.title { GridRow { Text("Thread").foregroundStyle(Palette.muted); Text(verbatim: title) } }
            }
            .font(.sotto(.body))
            VStack(alignment: .leading, spacing: Space.s1) {
                Text("Files on \(computer)", comment: "%@ is the computer's name. A 3D model's files stay there.").font(.sotto(.caption, .semibold)).foregroundStyle(Palette.muted)
                VStack(spacing: 0) {
                    ForEach(Array(view.files.enumerated()), id: \.offset) { index, file in
                        HStack {
                            Text(verbatim: view.folder.isEmpty ? file.name : view.folder + "/" + file.name).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Text(verbatim: file.bytes.map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) } ?? "—").foregroundStyle(Palette.muted)
                        }
                        .font(.sotto(.small))
                        .padding(.horizontal, Space.s3).padding(.vertical, Space.s2 + 1)
                        if index < view.files.count - 1 { Divider().overlay(Palette.hairline) }
                    }
                }
                .background(Palette.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            Text("The files stay on \(computer), in the thread’s folder. This iPhone keeps a copy of the USDZ only to turn it.", comment: "%@ is the computer's name.")
                .font(.sotto(.caption)).foregroundStyle(Palette.muted)
        }
    }

    private static func date(_ text: String?) -> Date? {
        guard let text else { return nil }
        let withFraction = ISO8601DateFormatter(); withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return withFraction.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}

/// A USDZ turned in SceneKit, on this iPhone alone: drag to turn, pinch to zoom, double-tap to put it back. It turns slowly
/// by itself until touched, unless Reduce Motion is on. No See it in your room (no AR) in this version.
private struct ModelScene: UIViewRepresentable {
    let scene: SCNScene
    let label: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView(frame: .zero)
        view.backgroundColor = .clear
        view.allowsCameraControl = true
        view.autoenablesDefaultLighting = true
        view.antialiasingMode = .multisampling4X
        // The model sits under a node of its own, which turns until the first touch.
        let turning = SCNNode()
        for child in scene.rootNode.childNodes { turning.addChildNode(child) }
        scene.rootNode.addChildNode(turning)
        if !reduceMotion { turning.runAction(.repeatForever(.rotateBy(x: 0, y: .pi * 2, z: 0, duration: 16))) }
        context.coordinator.turning = turning
        view.scene = scene
        let touch = UILongPressGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.touched(_:)))
        touch.minimumPressDuration = 0; touch.cancelsTouchesInView = false; touch.delegate = context.coordinator
        view.addGestureRecognizer(touch)
        view.isAccessibilityElement = true
        view.accessibilityLabel = label
        view.accessibilityTraits = .allowsDirectInteraction
        return view
    }

    func updateUIView(_ view: SCNView, context: Context) {
        if reduceMotion { context.coordinator.turning?.removeAllActions() }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var turning: SCNNode?
        @objc func touched(_ recognizer: UIGestureRecognizer) {
            if recognizer.state == .began { turning?.removeAllActions() }
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
}
