import SwiftUI
import UIKit
import SottoCore

// MARK: Mark up (ADR-0170, part 5)

/// A picture to mark up: the one the viewer holds, its name, and the reply box the marked copy goes into.
struct MarkupTarget: Identifiable {
    let id = UUID()
    let image: CGImage
    let name: String
    let box: PhotoBox
}

/// The inks as this theme draws them: red and amber are its danger and warning colours, plain its text.
struct MarkupInks {
    let stroke: [MarkInk: ThemeRGB]
    let noteText: [MarkInk: ThemeRGB]
    init(_ theme: ThemeSwatch) {
        let stroke: [MarkInk: ThemeRGB] = [.red: theme.rgb(.danger), .amber: theme.rgb(.warning), .plain: theme.rgb(.ink)]
        self.stroke = stroke
        // A note's words take whichever of the theme's canvas and text reads better on its ink.
        let canvas = theme.rgb(.canvas), text = theme.rgb(.ink)
        noteText = stroke.mapValues { ink in Self.contrast(ink, canvas) >= Self.contrast(ink, text) ? canvas : text }
    }
    private static func luminance(_ colour: ThemeRGB) -> Double {
        func channel(_ value: Double) -> Double { value <= 0.03928 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4) }
        return 0.2126 * channel(colour.red) + 0.7152 * channel(colour.green) + 0.0722 * channel(colour.blue)
    }
    private static func contrast(_ a: ThemeRGB, _ b: ThemeRGB) -> Double {
        let one = luminance(a), two = luminance(b)
        return (max(one, two) + 0.05) / (min(one, two) + 0.05)
    }
}

/// Draws marks in a context whose units are the picture's pixels: the editor's canvas and the marked copy both use it,
/// so the copy is what the user saw.
enum MarkupDrawing {
    static func path(_ mark: MarkupShape, size: MarkupSize) -> (stroke: Path, fill: Path) {
        var stroke = Path(), fill = Path()
        switch mark.shape {
        case .drag(.box, let from, let to):
            let span = Markup.span(from: from, to: to)
            stroke.addRoundedRect(in: CGRect(x: span.x, y: span.y, width: span.width, height: span.height),
                                  cornerSize: CGSize(width: Markup.strokeWidth(size) * 2, height: Markup.strokeWidth(size) * 2))
        case .drag(.ellipse, let from, let to):
            let span = Markup.span(from: from, to: to)
            stroke.addEllipse(in: CGRect(x: span.x, y: span.y, width: span.width, height: span.height))
        case .drag(_, let from, let to):
            let (shaft, head) = Markup.arrow(from: from, to: to, size: size)
            stroke.move(to: CGPoint(x: from.x, y: from.y)); stroke.addLine(to: CGPoint(x: shaft.x, y: shaft.y))
            fill.addLines(head.map { CGPoint(x: $0.x, y: $0.y) }); fill.closeSubpath()
        case .pen, .note:
            break
        }
        return (stroke, fill)
    }

    /// Every mark, in a graphics context scaled so one unit is one of the picture's pixels.
    static func draw(_ marks: [MarkupShape], size: MarkupSize, inks: MarkupInks, in context: inout GraphicsContext) {
        let line = Markup.strokeWidth(size)
        let style = StrokeStyle(lineWidth: line, lineCap: .round, lineJoin: .round)
        for mark in marks {
            let ink = inks.stroke[mark.ink]!.color
            switch mark.shape {
            case .pen(let samples, let pressed):
                for (from, to) in zip(samples, samples.dropFirst()) {
                    var piece = Path()
                    piece.move(to: CGPoint(x: from.point.x, y: from.point.y))
                    piece.addLine(to: CGPoint(x: to.point.x, y: to.point.y))
                    let width = Markup.penWidth(pressure: from.pressure, pressed: pressed, size: size)
                    context.stroke(piece, with: .color(ink), style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
                }
            case .note(let at, let text):
                let words = context.resolve(Text(verbatim: text).font(.system(size: Markup.noteFontSize(size), weight: .semibold))
                    .foregroundStyle(inks.noteText[mark.ink]!.color))
                let measured = words.measure(in: CGSize(width: size.width, height: size.height))
                let box = Markup.noteBox(at: at, textWidth: measured.width, size: size)
                context.fill(Path(roundedRect: CGRect(x: box.x, y: box.y, width: box.width, height: box.height), cornerRadius: box.radius), with: .color(ink))
                context.draw(words, at: CGPoint(x: box.textX, y: at.y), anchor: .leading)
            case .drag:
                let (stroke, fill) = path(mark, size: size)
                context.stroke(stroke, with: .color(ink), style: style)
                context.fill(fill, with: .color(ink))
            }
        }
    }

    /// The picture with its marks drawn on it, at the size the viewer holds it, as a PNG. Nil when it could not be made.
    @MainActor static func copy(_ image: CGImage, marks: [MarkupShape], inks: MarkupInks) -> Data? {
        let size = MarkupSize(width: Double(image.width), height: Double(image.height))
        let renderer = ImageRenderer(content: Canvas { context, _ in
            context.draw(Image(decorative: image, scale: 1), in: CGRect(x: 0, y: 0, width: size.width, height: size.height))
            MarkupDrawing.draw(marks, size: size, inks: inks, in: &context)
        }.frame(width: size.width, height: size.height))
        renderer.scale = 1
        guard let drawn = renderer.uiImage else { return nil }
        return drawn.pngData()
    }
}

/// Marks a picture up on the iPhone (ADR-0170, part 5): arrow, circle, box, pen and note in red, amber or the theme's
/// text, with Undo and Redo, and Add to reply, which puts a copy with the marks on it into the thread's reply box, or
/// Watcher's, the way a chosen photo goes in. The picture in the thread stays as it was. Once an Apple Pencil has drawn,
/// or when Only Draw with Apple Pencil is on, the pen draws and a finger moves and zooms the picture, until
/// Draw with a finger too says otherwise.
struct MarkupEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.sottoTheme) private var theme
    @Environment(\.scenePhase) private var phase
    let target: MarkupTarget
    let onAdded: () -> Void
    @State private var history = MarkupHistory()
    @State private var tool: MarkTool = .arrow
    @State private var ink: MarkInk = .red
    @State private var live: MarkupShape?
    @State private var notice: String?
    @State private var pencilDraws = MarkupEditor.prefersPencil
    @State private var fingerDraws = false
    @State private var zoom: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var notePlace: MarkPoint?
    @State private var noteText = ""
    @State private var adding = false

    /// Only Draw with Apple Pencil, where this iOS says it.
    private static var prefersPencil: Bool {
        if #available(iOS 17.5, *) { return UIPencilInteraction.prefersPencilOnlyDrawing }
        return false
    }
    private var size: MarkupSize { MarkupSize(width: Double(target.image.width), height: Double(target.image.height)) }
    private var inks: MarkupInks { MarkupInks(theme) }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Cancel") { dismiss() }.frame(minHeight: 44)
                Spacer()
                Text("Mark up").fontWeight(.semibold)
                Spacer()
                Button("Add to reply") { add() }.fontWeight(.semibold).frame(minHeight: 44)
                    .disabled(adding)
                    .accessibilityHint(Text("The marked copy goes into your reply. The picture in the thread stays as it was."))
            }
            .padding(.horizontal, 20).foregroundStyle(Palette.ink)
            if pencilDraws {
                Group {
                    if fingerDraws { Text("Pen and finger both draw") } else { Text("Pen draws · finger moves the picture") }
                }
                .font(.footnote).foregroundStyle(Palette.muted).padding(.bottom, 6)
            }
            GeometryReader { room in stage(in: room.size) }
                .clipped()
            if let notice {
                Text(notice).font(.footnote).foregroundStyle(Palette.ink).multilineTextAlignment(.center)
                    .padding(.horizontal, 20).padding(.top, 8).paragraphDirection()
                    .accessibilityAddTraits(.updatesFrequently)
            }
            palette.padding(.vertical, 10)
        }
        .background(Palette.canvas)
        .overlay {
            if phase != .active {
                Rectangle().fill(Palette.canvas).ignoresSafeArea().overlay(Text("Sotto").font(.title2).foregroundStyle(Palette.ink))
            }
        }
        .alert("Note", isPresented: Binding(get: { notePlace != nil }, set: { if !$0 { notePlace = nil } })) {
            TextField("Type a note", text: $noteText)
            Button("Add") { placeNote() }
            Button("Cancel", role: .cancel) { notePlace = nil; noteText = "" }
        }
        .accessibilityAction(.escape) { dismiss() }
        .onChange(of: notice) { _, words in if let words { UIAccessibility.post(notification: .announcement, argument: words) } }
    }

    // MARK: The picture

    private func fitted(in room: CGSize) -> CGSize {
        let scale = min(room.width / size.width, room.height / size.height)
        return CGSize(width: size.width * scale, height: size.height * scale)
    }

    private func stage(in room: CGSize) -> some View {
        let fit = fitted(in: room)
        let marks = history.marks, drawing = live, inks = self.inks, size = self.size
        return ZStack {
            ZStack {
                Image(decorative: target.image, scale: 1).resizable().scaledToFit()
                Canvas { context, canvas in
                    context.scaleBy(x: canvas.width / size.width, y: canvas.height / size.height)
                    MarkupDrawing.draw(marks + (drawing.map { [$0] } ?? []), size: size, inks: inks, in: &context)
                }
                .allowsHitTesting(false)
            }
            .frame(width: fit.width, height: fit.height)
            .scaleEffect(zoom)
            .offset(offset)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("Picture to mark up"))
            .accessibilityValue(Text(verbatim: target.name))
            .accessibilityAddTraits(.isImage)
            MarkupTouches(fingerMoves: pencilDraws && !fingerDraws,
                          began: { point, force, pencil in began(at: picturePoint(point, room: room, fit: fit), force: force, pencil: pencil) },
                          moved: { point, force in moved(to: picturePoint(point, room: room, fit: fit), force: force) },
                          ended: { point in ended(at: picturePoint(point, room: room, fit: fit)) },
                          cancelled: { live = nil },
                          panned: { delta in offset = CGSize(width: offset.width + delta.width, height: offset.height + delta.height) },
                          pinched: { scale, anchor in pinch(scale, around: anchor, room: room) })
                .accessibilityHidden(true)
        }
        .frame(width: room.width, height: room.height)
    }

    /// A place in the room, as a pixel of the picture under the current zoom and offset.
    private func picturePoint(_ point: CGPoint, room: CGSize, fit: CGSize) -> MarkPoint {
        let centred = CGPoint(x: (point.x - room.width / 2 - offset.width) / zoom, y: (point.y - room.height / 2 - offset.height) / zoom)
        let x = (centred.x + fit.width / 2) / fit.width * size.width, y = (centred.y + fit.height / 2) / fit.height * size.height
        return MarkPoint(x: min(size.width, max(0, x)), y: min(size.height, max(0, y)))
    }

    private func pinch(_ scale: CGFloat, around anchor: CGPoint, room: CGSize) {
        let next = min(6, max(1, zoom * scale)), applied = next / zoom
        let from = CGSize(width: anchor.x - room.width / 2, height: anchor.y - room.height / 2)
        offset = next == 1 ? .zero : CGSize(width: (offset.width - from.width) * applied + from.width, height: (offset.height - from.height) * applied + from.height)
        zoom = next
    }

    // MARK: Drawing

    private func began(at point: MarkPoint, force: Double?, pencil: Bool) {
        if pencil && !pencilDraws { pencilDraws = true }
        notice = nil
        let id = history.newID()
        switch tool {
        case .note: live = nil
        case .pen: live = MarkupShape(id: id, ink: ink, shape: .pen(samples: [PenSample(point, pressure: force ?? 0.5)], pressed: force != nil))
        default: live = MarkupShape(id: id, ink: ink, shape: .drag(tool, from: point, to: point))
        }
    }
    private func moved(to point: MarkPoint, force: Double? = nil) {
        guard var mark = live else { return }
        switch mark.shape {
        case .pen(var samples, let pressed):
            samples.append(PenSample(point, pressure: force ?? samples.last?.pressure ?? 0.5))
            mark.shape = .pen(samples: samples, pressed: pressed)
        case .drag(let kind, let from, _): mark.shape = .drag(kind, from: from, to: point)
        case .note: break
        }
        live = mark
    }
    private func ended(at point: MarkPoint) {
        if tool == .note { noteText = ""; notePlace = point; return }
        moved(to: point)
        if let mark = live { history.add(mark, size: size) }
        live = nil
    }
    private func placeNote() {
        defer { notePlace = nil; noteText = "" }
        guard let place = notePlace else { return }
        let words = String(noteText.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Markup.noteMaxLength))
        history.add(MarkupShape(id: history.newID(), ink: ink, shape: .note(at: place, text: words)), size: size)
    }

    // MARK: Add to reply

    private func add() {
        guard !history.marks.isEmpty else { notice = String(localized: "Draw on the picture first. Nothing was added."); return }
        if let refusal = model.markedCopyRefusal(target.box) { notice = refusal; return }
        guard let data = MarkupDrawing.copy(target.image, marks: history.marks, inks: inks) else {
            notice = String(localized: "Couldn’t make the marked copy. Nothing was added, and your marks are still here. Try again.")
            return
        }
        adding = true
        Task {
            // The editor stays open until the copy is in the box, so a refusal keeps the marks.
            let refusal = await model.attachMarkedCopy(target.box, name: Markup.markedName(target.name), data: data)
            adding = false
            if let refusal { notice = refusal; return }
            onAdded()
            dismiss()
        }
    }

    // MARK: The tools

    private var palette: some View {
        let tools = HStack(spacing: 2) {
            ForEach(MarkTool.allCases, id: \.self) { item in
                Button { tool = item } label: {
                    Image(systemName: Self.symbol(item)).frame(width: 44, height: 44)
                        .background(tool == item ? AnyShapeStyle(Palette.accent.opacity(0.18)) : AnyShapeStyle(Color.clear), in: Circle())
                }
                .foregroundStyle(tool == item ? Palette.accentText : Palette.ink)
                .accessibilityLabel(Text(Self.name(item)))
                .accessibilityAddTraits(tool == item ? .isSelected : [])
            }
        }
        let rest = HStack(spacing: 2) {
            ForEach(MarkInk.allCases, id: \.self) { item in
                Button { ink = item } label: {
                    Circle().fill(inks.stroke[item]!.color).frame(width: 22, height: 22)
                        .overlay(Circle().strokeBorder(Palette.ink, lineWidth: ink == item ? 2 : 0).padding(-4))
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel(Text(Self.inkName(item)))
                .accessibilityAddTraits(ink == item ? .isSelected : [])
            }
            Button { history.undo() } label: { Image(systemName: "arrow.uturn.backward").frame(width: 44, height: 44) }
                .disabled(!history.canUndo).accessibilityLabel(Text("Undo"))
            Button { history.redo() } label: { Image(systemName: "arrow.uturn.forward").frame(width: 44, height: 44) }
                .disabled(!history.canRedo).accessibilityLabel(Text("Redo"))
            if pencilDraws {
                Button { fingerDraws.toggle() } label: { Image(systemName: "hand.point.up.left").frame(width: 44, height: 44) }
                    .foregroundStyle(fingerDraws ? Palette.accentText : Palette.ink)
                    .accessibilityLabel(Text("Draw with a finger too"))
                    .accessibilityAddTraits(fingerDraws ? .isSelected : [])
            }
        }
        .foregroundStyle(Palette.ink)
        // One row where it fits, as on a Duo unfolded; two on a narrower iPhone.
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) { tools; Divider().frame(height: 24); rest }
            VStack(spacing: 4) { tools; rest }
        }
        .padding(.horizontal, 12)
    }

    private static func symbol(_ tool: MarkTool) -> String {
        switch tool {
        case .arrow: return "arrow.up.right"
        case .ellipse: return "circle"
        case .box: return "square"
        case .pen: return "pencil.tip"
        case .note: return "textformat"
        }
    }
    private static func name(_ tool: MarkTool) -> LocalizedStringKey {
        switch tool {
        case .arrow: return LocalizedStringKey("Arrow")
        case .ellipse: return LocalizedStringKey("Circle")
        case .box: return LocalizedStringKey("Box")
        case .pen: return LocalizedStringKey("Pen")
        case .note: return LocalizedStringKey("Note")
        }
    }
    private static func inkName(_ ink: MarkInk) -> LocalizedStringKey {
        switch ink {
        case .red: return LocalizedStringKey("Red ink")
        case .amber: return LocalizedStringKey("Amber ink")
        case .plain: return LocalizedStringKey("Plain ink")
        }
    }
}

/// The touches over the picture: one draws, with the pen's force when an Apple Pencil draws. When `fingerMoves`, a
/// finger moves the picture and two zoom it, and only the pen draws.
private struct MarkupTouches: UIViewRepresentable {
    let fingerMoves: Bool
    let began: (CGPoint, Double?, Bool) -> Void
    let moved: (CGPoint, Double?) -> Void
    let ended: (CGPoint) -> Void
    let cancelled: () -> Void
    let panned: (CGSize) -> Void
    let pinched: (CGFloat, CGPoint) -> Void

    func makeUIView(context: Context) -> TouchView {
        let view = TouchView()
        view.isMultipleTouchEnabled = true
        let pan = UIPanGestureRecognizer(target: view, action: #selector(TouchView.pan(_:)))
        pan.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
        let pinch = UIPinchGestureRecognizer(target: view, action: #selector(TouchView.pinch(_:)))
        pinch.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
        view.addGestureRecognizer(pan); view.addGestureRecognizer(pinch)
        view.recognizers = [pan, pinch]
        return view
    }
    func updateUIView(_ view: TouchView, context: Context) {
        view.owner = self
        view.recognizers.forEach { $0.isEnabled = fingerMoves }
    }

    final class TouchView: UIView {
        var owner: MarkupTouches?
        var recognizers: [UIGestureRecognizer] = []
        private weak var drawing: UITouch?

        private func draws(_ touch: UITouch) -> Bool { touch.type == .pencil || !(owner?.fingerMoves ?? false) }
        private func force(_ touch: UITouch) -> Double? {
            touch.type == .pencil && touch.maximumPossibleForce > 0 ? Double(touch.force / touch.maximumPossibleForce) : nil
        }
        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
            guard drawing == nil, let touch = touches.first(where: draws) else { return }
            drawing = touch
            owner?.began(touch.location(in: self), force(touch), touch.type == .pencil)
        }
        override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
            guard let touch = drawing, touches.contains(touch) else { return }
            // Every sample the pen made since the last frame, so a quick line keeps its shape.
            for sample in event?.coalescedTouches(for: touch) ?? [touch] { owner?.moved(sample.location(in: self), force(sample)) }
        }
        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
            guard let touch = drawing, touches.contains(touch) else { return }
            drawing = nil
            owner?.ended(touch.location(in: self))
        }
        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
            guard let touch = drawing, touches.contains(touch) else { return }
            drawing = nil
            owner?.cancelled()
        }
        @objc func pan(_ gesture: UIPanGestureRecognizer) {
            let moved = gesture.translation(in: self)
            gesture.setTranslation(.zero, in: self)
            owner?.panned(CGSize(width: moved.x, height: moved.y))
        }
        @objc func pinch(_ gesture: UIPinchGestureRecognizer) {
            owner?.pinched(gesture.scale, gesture.location(in: self))
            gesture.scale = 1
        }
    }
}
