import SwiftUI
import UIKit
import SottoCore

// MARK: Mark up (ADR-0170, part 5)

/// A picture to mark up: the one the viewer holds, its name, and the reply box the marked copy goes into, with the
/// callouts the agent placed on it (part 6) and who placed them.
struct MarkupTarget: Identifiable {
    let id = UUID()
    let image: CGImage
    let name: String
    let box: PhotoBox
    var callouts: [Activity.Media.Callout] = []
    var calloutsBy: String? = nil
}

/// Draws an agent's callouts (ADR-0170, part 6) in a context whose units are the picture's pixels: a dashed box in the
/// accent and a pin carrying its number. `unit`, the picture's pixels to a point, keeps them a fixed size on a tile.
enum CalloutDrawing {
    static func draw(_ callouts: [Activity.Media.Callout], size: MarkupSize, accent: Color, onAccent: Color, unit: Double? = nil, in context: inout GraphicsContext) {
        for callout in callouts {
            let shape = Callouts.shape(callout, size: size, unit: unit)
            let box = Path(roundedRect: CGRect(x: shape.x, y: shape.y, width: shape.width, height: shape.height), cornerRadius: shape.corner)
            context.stroke(box, with: .color(accent), style: StrokeStyle(lineWidth: shape.line, dash: shape.dash.map { CGFloat($0) }))
            context.fill(Path(ellipseIn: CGRect(x: shape.x - shape.radius, y: shape.y - shape.radius, width: shape.radius * 2, height: shape.radius * 2)), with: .color(accent))
            let number = context.resolve(Text(verbatim: "\(callout.n)").font(.custom(Font.figtreeFace(.bold), fixedSize: shape.font)).foregroundStyle(onAccent))
            context.draw(number, at: CGPoint(x: shape.x, y: shape.y), anchor: .center)
        }
    }
}

/// A picture's callouts listed by number, as the viewer and the editor show them under it.
struct CalloutNotes: View {
    let callouts: [Activity.Media.Callout]
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(callouts) { callout in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(verbatim: "\(callout.n)").font(.sotto(.small, .bold)).foregroundStyle(ThemeRole(.onAccent))
                        .frame(minWidth: 22, minHeight: 22).background(Palette.accent, in: Circle())
                        .accessibilityHidden(true)
                    Text(verbatim: callout.note).font(.sotto(.small)).foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true).paragraphDirection()
                }
                .accessibilityElement(children: .combine)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    /// The notes at their own height up to `height`, and scrolling past it, so a few notes take no more room than they need.
    struct Bounded: View {
        let callouts: [Activity.Media.Callout]
        let height: CGFloat
        var body: some View {
            ViewThatFits(in: .vertical) {
                CalloutNotes(callouts: callouts)
                ScrollView { CalloutNotes(callouts: callouts) }
            }
            .frame(maxHeight: height)
        }
    }
}

/// The inks as this theme draws them: red and amber are its danger and warning colours, plain its text.
struct MarkupInks {
    let stroke: [MarkInk: ThemeRGB]
    let noteEdge: [MarkInk: ThemeRGB]
    init(_ theme: ThemeSwatch) {
        let stroke: [MarkInk: ThemeRGB] = [.red: theme.rgb(.danger), .amber: theme.rgb(.warning), .plain: theme.rgb(.ink)]
        self.stroke = stroke
        // The edge around a note's words is black or white, whichever stands further from its ink, as on the desktop.
        // The picture under the words could be anything, and one of the two is always at least 4.5:1 on any ink.
        noteEdge = stroke.mapValues { ink in
            let white = ThemeRGB(1, 1, 1), black = ThemeRGB(0, 0, 0)
            return Self.contrast(ink, white) >= Self.contrast(ink, black) ? white : black
        }
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
            case .note(let at, let text, let scale, _):
                func resolved(_ colour: Color) -> GraphicsContext.ResolvedText {
                    context.resolve(Text(verbatim: text).font(.custom(Font.figtreeFace(.semibold), fixedSize: Markup.noteFontSize(size, scale: scale))).foregroundStyle(colour))
                }
                // The edge is the words drawn in a ring around their place, with the words over it. No label: only the
                // words sit on the picture. SwiftUI has no stroked text, and this is what a Canvas and the copy both draw.
                let edge = resolved(inks.noteEdge[mark.ink]!.color), reach = Markup.noteEdgeWidth(size, scale: scale) / 2
                for step in 0..<16 {
                    let angle = Double(step) / 16 * 2 * .pi
                    context.draw(edge, at: CGPoint(x: at.x + cos(angle) * reach, y: at.y + sin(angle) * reach), anchor: .leading)
                }
                context.draw(resolved(ink), at: CGPoint(x: at.x, y: at.y), anchor: .leading)
            case .drag:
                let (stroke, fill) = path(mark, size: size)
                context.stroke(stroke, with: .color(ink), style: style)
                context.fill(fill, with: .color(ink))
            }
        }
    }

    /// The selected mark's outline, the mark it sits on if it is a note, and its handles, which no copy carries. `unit` is
    /// the picture's pixels to a point on screen, so they keep their size as the picture is zoomed.
    static func drawSelection(_ mark: MarkupShape, marks: [MarkupShape], layout: MarkupLayout, unit: Double, accent: Color, surface: Color, in context: inout GraphicsContext) {
        func around(_ item: MarkupShape, dash: [CGFloat]) {
            let box = layout.bounds(item).outset(6 * unit)
            context.stroke(Path(CGRect(x: box.x, y: box.y, width: box.width, height: box.height)), with: .color(accent),
                           style: StrokeStyle(lineWidth: 1.5 * unit, dash: dash.map { $0 * CGFloat(unit) }))
        }
        around(mark, dash: [5, 4])
        if case .note(_, _, _, let on?) = mark.shape, let holder = marks.first(where: { $0.id == on }) { around(holder, dash: [2, 4]) }
        for (_, point) in layout.handles(mark) {
            let dot = Path(ellipseIn: CGRect(x: point.x - 5 * unit, y: point.y - 5 * unit, width: 10 * unit, height: 10 * unit))
            context.fill(dot, with: .color(surface))
            context.stroke(dot, with: .color(accent), lineWidth: 1.5 * unit)
        }
    }

    /// The picture with its marks drawn on it, at the size the viewer holds it, as a PNG. Nil when it could not be made.
    @MainActor static func copy(_ image: CGImage, marks: [MarkupShape], inks: MarkupInks,
                                callouts: [Activity.Media.Callout] = [], accent: Color = .clear, onAccent: Color = .clear) -> Data? {
        let size = MarkupSize(width: Double(image.width), height: Double(image.height))
        let renderer = ImageRenderer(content: Canvas { context, _ in
            context.draw(Image(decorative: image, scale: 1), in: CGRect(x: 0, y: 0, width: size.width, height: size.height))
            // The agent's callouts a copy keeps go under the user's own marks, as the editor showed them.
            CalloutDrawing.draw(callouts, size: size, accent: accent, onAccent: onAccent, in: &context)
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
/// Draw with a finger too says otherwise. The Move tool selects a mark, with a finger or the pen: it can then be dragged,
/// resized by its handles, sized if it is text, or deleted. The drawing tools only ever draw, so a stroke across a mark
/// stays a stroke, and with Move a finger on the empty picture still moves it. Text on a mark belongs to it and follows
/// it, and text off every mark is free.
struct MarkupEditor: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.sottoTheme) private var theme
    @Environment(\.scenePhase) private var phase
    let target: MarkupTarget
    let onAdded: () -> Void
    @State private var history = MarkupHistory()
    @State private var tool: MarkupTool = .draw(.arrow)
    @State private var ink: MarkInk = .red
    @State private var live: MarkupShape?
    @State private var selectedID: Int?
    /// A move or resize under way, and what the marks are while it lasts.
    @State private var dragging: MarkDrag?
    @State private var shownMarks: [MarkupShape]?
    /// The size the next note is set in, and the last the user chose.
    @State private var noteScale = 1.0
    @State private var notice: String?
    @State private var pencilDraws = MarkupEditor.prefersPencil
    @State private var fingerDraws = false
    @State private var zoom: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var notePlace: MarkPoint?
    /// How near a mark the note's press counted as on it, in the picture's pixels.
    @State private var noteReach = 0.0
    @State private var noteText = ""
    @State private var adding = false
    /// The agent's callouts (part 6): shown while marking, and kept in the copy, unless the user says otherwise.
    @State private var showCallouts = true
    @State private var keepCallouts = true
    /// The callouts the copy carries: shown and kept, as the user sees them.
    private var keptCallouts: [Activity.Media.Callout] { showCallouts && keepCallouts ? target.callouts : [] }

    /// Only Draw with Apple Pencil, where this iOS says it.
    private static var prefersPencil: Bool {
        if #available(iOS 17.5, *) { return UIPencilInteraction.prefersPencilOnlyDrawing }
        return false
    }
    private var size: MarkupSize { MarkupSize(width: Double(target.image.width), height: Double(target.image.height)) }
    private var inks: MarkupInks { MarkupInks(theme) }
    /// Sets a note's words in the face and at the size the canvas does, to say how wide they are.
    private var layout: MarkupLayout {
        MarkupLayout(size: size) { text, font in
            let face = UIFont(name: Font.figtreeFace(.semibold), size: font) ?? .systemFont(ofSize: font, weight: .semibold)
            return Double(ceil((text as NSString).size(withAttributes: [.font: face]).width))
        }
    }
    private var selected: MarkupShape? { selectedID.flatMap { id in history.marks.first { $0.id == id } } }
    private var moving: Bool { tool == .move }

    /// A drag on a mark: where it began and the marks as they were, for a move, or the handle, for a resize.
    private enum MarkDrag {
        case move(from: MarkPoint, base: [MarkupShape], ids: Set<Int>, lead: Int, travelled: Bool)
        case resize(base: [MarkupShape], id: Int, handle: MarkHandle)
    }

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
                .font(.sotto(.small)).foregroundStyle(Palette.muted).padding(.bottom, 6)
            }
            GeometryReader { room in stage(in: room.size) }
                .clipped()
            if !target.callouts.isEmpty { calloutsPanel }
            markRow
            if let notice {
                Text(notice).font(.sotto(.small)).foregroundStyle(Palette.ink).multilineTextAlignment(.center)
                    .padding(.horizontal, 20).padding(.top, 8).paragraphDirection()
                    .accessibilityAddTraits(.updatesFrequently)
            }
            palette.padding(.vertical, 10)
        }
        .background(Palette.canvas)
        .overlay {
            if phase != .active {
                Rectangle().fill(Palette.canvas).ignoresSafeArea().overlay(Text("Sotto").font(.sotto(.title, .semibold)).foregroundStyle(Palette.ink))
            }
        }
        .alert("Note", isPresented: Binding(get: { notePlace != nil }, set: { if !$0 { notePlace = nil } })) {
            TextField("Type a note", text: $noteText)
            Button("Add") { placeNote() }
            Button("Cancel", role: .cancel) { notePlace = nil; noteText = "" }
        }
        .accessibilityAction(.escape) { dismiss() }
        .onChange(of: notice) { _, words in if let words { UIAccessibility.post(notification: .announcement, argument: words) } }
        // Undo or Delete with a second finger stops a drag on the spot, rather than showing the drag until it lifts.
        .onChange(of: history.marks) { _, _ in if dragging != nil { dragging = nil; shownMarks = nil } }
    }

    // MARK: The picture

    private func fitted(in room: CGSize) -> CGSize {
        let scale = min(room.width / size.width, room.height / size.height)
        return CGSize(width: size.width * scale, height: size.height * scale)
    }

    private func stage(in room: CGSize) -> some View {
        let fit = fitted(in: room)
        let marks = shownMarks ?? history.marks, drawing = live, inks = self.inks, size = self.size, layout = self.layout
        let picked = selectedID.flatMap { id in marks.first { $0.id == id } }
        let surface = theme.rgb(.canvas).color, currentZoom = zoom
        let callouts = showCallouts ? target.callouts : [], accent = theme.rgb(.accent).color, onAccent = theme.rgb(.onAccent).color
        return ZStack {
            ZStack {
                Image(decorative: target.image, scale: 1).resizable().scaledToFit()
                Canvas { context, canvas in
                    context.scaleBy(x: canvas.width / size.width, y: canvas.height / size.height)
                    CalloutDrawing.draw(callouts, size: size, accent: accent, onAccent: onAccent, in: &context)
                    MarkupDrawing.draw(marks + (drawing.map { [$0] } ?? []), size: size, inks: inks, in: &context)
                    if let picked {
                        MarkupDrawing.drawSelection(picked, marks: marks, layout: layout, unit: size.width / Double(canvas.width) / Double(currentZoom), accent: accent, surface: surface, in: &context)
                    }
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
                          grabs: { point in moving && grabs(picturePoint(point, room: room, fit: fit), unit: pictureUnit(fit)) },
                          elsewhere: { if moving { selectedID = nil } },
                          began: { point, force, pencil in began(at: picturePoint(point, room: room, fit: fit), force: force, pencil: pencil, unit: pictureUnit(fit)) },
                          moved: { point, force in moved(to: picturePoint(point, room: room, fit: fit), force: force, unit: pictureUnit(fit)) },
                          ended: { point in ended(at: picturePoint(point, room: room, fit: fit), unit: pictureUnit(fit)) },
                          cancelled: { live = nil; dragging = nil; shownMarks = nil },
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

    /// The picture's pixels to a point on screen, under the current zoom.
    private func pictureUnit(_ fit: CGSize) -> Double { size.width / Double(fit.width) / Double(zoom) }
    /// How near a press must be to count as on a line, in the picture's pixels. A finger or a pen, it is the same reach.
    private func reach(_ unit: Double) -> Double { 18 * unit }
    private func handle(at point: MarkPoint, unit: Double) -> MarkHandle? {
        guard let selected else { return nil }
        return layout.handles(selected).first { hypot($0.point.x - point.x, $0.point.y - point.y) <= 22 * unit }?.handle
    }
    /// Whether a press here would pick something up, rather than move the picture.
    private func grabs(_ point: MarkPoint, unit: Double) -> Bool {
        handle(at: point, unit: unit) != nil || layout.mark(at: point, reach: reach(unit), in: history.marks) != nil
    }

    private func pinch(_ scale: CGFloat, around anchor: CGPoint, room: CGSize) {
        let next = min(6, max(1, zoom * scale)), applied = next / zoom
        let from = CGSize(width: anchor.x - room.width / 2, height: anchor.y - room.height / 2)
        offset = next == 1 ? .zero : CGSize(width: (offset.width - from.width) * applied + from.width, height: (offset.height - from.height) * applied + from.height)
        zoom = next
    }

    // MARK: Drawing

    private func began(at point: MarkPoint, force: Double?, pencil: Bool, unit: Double) {
        if pencil && !pencilDraws { pencilDraws = true }
        notice = nil
        guard case .draw(let drawn) = tool else {
            if let grip = handle(at: point, unit: unit), let selected {
                dragging = .resize(base: history.marks, id: selected.id, handle: grip)
                return
            }
            let mark = layout.mark(at: point, reach: reach(unit), in: history.marks)
            selectedID = mark?.id
            if let mark { dragging = .move(from: point, base: history.marks, ids: layout.movingWith(mark.id, in: history.marks), lead: mark.id, travelled: false) }
            return
        }
        let id = history.newID()
        switch drawn {
        case .note: live = nil
        case .pen: live = MarkupShape(id: id, ink: ink, shape: .pen(samples: [PenSample(point, pressure: force ?? 0.5)], pressed: force != nil))
        default: live = MarkupShape(id: id, ink: ink, shape: .drag(drawn, from: point, to: point))
        }
    }
    private func moved(to point: MarkPoint, force: Double? = nil, unit: Double) {
        switch dragging {
        case .move(let from, let base, let ids, let lead, let travelled):
            let now = travelled || hypot(point.x - from.x, point.y - from.y) > 4 * unit
            guard now else { return }
            if !travelled { dragging = .move(from: from, base: base, ids: ids, lead: lead, travelled: true) }
            shownMarks = layout.move(base, ids, dx: point.x - from.x, dy: point.y - from.y)
            return
        case .resize(let base, let id, let grip):
            if let next = layout.resize(base, id: id, handle: grip, to: point) { shownMarks = next }
            return
        case nil: break
        }
        extendLive(to: point, force: force)
    }
    private func extendLive(to point: MarkPoint, force: Double? = nil) {
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
    private func ended(at point: MarkPoint, unit: Double) {
        if let drag = dragging {
            dragging = nil
            finish(drag, unit: unit)
            return
        }
        guard case .draw(let drawn) = tool else { return }
        if drawn == .note {
            noteText = ""; notePlace = point; noteReach = reach(unit)
            return
        }
        extendLive(to: point)
        if let mark = live { history.add(mark, size: size) }
        live = nil
    }
    /// Keeps what a move or a resize came to. A note let go takes up with whatever is under it now, and says so, since
    /// nothing else shows it.
    private func finish(_ drag: MarkDrag, unit: Double) {
        defer { shownMarks = nil }
        guard let shown = shownMarks else { return }
        switch drag {
        case .resize(let base, _, _): history.replace(with: shown, madeFrom: base)
        case .move(_, let base, _, let lead, _):
            let settled = layout.settle(shown, note: lead, reach: reach(unit))
            guard history.replace(with: settled, madeFrom: base) else { return }
            let was = holderID(base.first { $0.id == lead }), now = holderID(settled.first { $0.id == lead })
            if base.first(where: { $0.id == lead })?.tool == .note, was != now { notice = noteMovedWords(now, in: settled) }
        }
    }
    private func holderID(_ mark: MarkupShape?) -> Int? {
        if case .note(_, _, _, let on)? = mark?.shape { return on }
        return nil
    }
    private func noteMovedWords(_ on: Int?, in marks: [MarkupShape]) -> String {
        switch on.flatMap({ id in marks.first { $0.id == id } })?.tool {
        case .box: return String(localized: "The note now moves with the box.")
        case .ellipse: return String(localized: "The note now moves with the circle.")
        case .arrow: return String(localized: "The note now moves with the arrow.")
        case .pen: return String(localized: "The note now moves with the pen line.")
        default: return String(localized: "The note is free now. It stays where you put it.")
        }
    }
    private func placeNote() {
        defer { notePlace = nil; noteText = "" }
        guard let place = notePlace else { return }
        let words = String(noteText.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Markup.noteMaxLength))
        let note = MarkupShape(id: history.newID(), ink: ink, shape: .note(at: place, text: words, scale: noteScale, on: nil))
        guard !words.isEmpty else { return }
        // The words stay on the picture, however near its edge they were pressed, and on what they were pressed on.
        let placed = layout.move([note], [note.id], dx: 0, dy: 0)[0]
        if let settled = layout.settle(history.marks + [placed], note: note.id, reach: noteReach).last { history.add(settled, size: size) }
    }

    // MARK: A selected mark, and text

    /// What can be done to the selected mark: size its text, or the next note's while Note is picked, and delete it.
    /// Always there and in one place, so the picture doesn't jump when a mark is selected.
    private var markRow: some View {
        let note: (scale: Double, id: Int)? = {
            if case .note(_, _, let scale, _)? = selected?.shape, let id = selectedID { return (scale, id) }
            return nil
        }()
        let sizing = note != nil || tool == .draw(.note), current = note?.scale ?? noteScale
        return HStack(spacing: 6) {
            Button { stepNoteSize(-1) } label: { Image(systemName: "textformat.size.smaller").frame(width: 44, height: 44) }
                .disabled(!sizing || current <= (Markup.noteScales.first ?? 0)).accessibilityLabel(Text("Make the text smaller"))
            Button { stepNoteSize(1) } label: { Image(systemName: "textformat.size.larger").frame(width: 44, height: 44) }
                .disabled(!sizing || current >= (Markup.noteScales.last ?? 0)).accessibilityLabel(Text("Make the text larger"))
            Button {
                if let id = selectedID { history.remove(id); selectedID = nil }
            } label: { Label("Delete", systemImage: "trash").font(.sotto(.small)).frame(minHeight: 44).padding(.horizontal, 10) }
                .disabled(selected == nil).accessibilityLabel(Text("Delete the selected mark"))
        }
        .foregroundStyle(Palette.ink)
        .padding(.top, 4)
    }
    private func stepNoteSize(_ by: Int) {
        var current = noteScale, text: (id: Int, at: MarkPoint, words: String, on: Int?)?
        if case .note(let at, let words, let scale, let on)? = selected?.shape, let id = selectedID { current = scale; text = (id, at, words, on) }
        let next = Markup.nextNoteScale(current, by: by)
        noteScale = next
        guard let text, next != current else { return }
        let sized = history.marks.map { mark -> MarkupShape in
            guard mark.id == text.id else { return mark }
            var kept = mark
            kept.shape = .note(at: text.at, text: text.words, scale: next, on: text.on)
            return kept
        }
        history.replace(with: layout.move(sized, [text.id], dx: 0, dy: 0))
    }

    // MARK: Add to reply

    private func add() {
        guard !history.marks.isEmpty || !keptCallouts.isEmpty else { notice = String(localized: "Draw on the picture first. Nothing was added."); return }
        if let refusal = model.markedCopyRefusal(target.box) { notice = refusal; return }
        guard let data = MarkupDrawing.copy(target.image, marks: history.marks, inks: inks, callouts: keptCallouts,
                                            accent: theme.rgb(.accent).color, onAccent: theme.rgb(.onAccent).color) else {
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

    // MARK: The agent's callouts

    /// The callouts listed under the picture, with Show callouts and Keep the callouts in the copy (ADR-0170, part 6).
    private var calloutsPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Callouts from \(target.calloutsBy ?? "")").font(.sotto(.small, .semibold)).foregroundStyle(Palette.muted)
                .accessibilityAddTraits(.isHeader)
            CalloutNotes.Bounded(callouts: target.callouts, height: 96)
            Toggle("Show callouts", isOn: $showCallouts).font(.sotto(.small))
            Toggle("Keep the callouts in the copy", isOn: Binding(get: { keepCallouts && showCallouts }, set: { keepCallouts = $0 }))
                .font(.sotto(.small)).disabled(!showCallouts)
        }
        .tint(Palette.accent)
        .padding(.horizontal, 20).padding(.top, 8)
    }

    // MARK: The tools

    private var palette: some View {
        let tools = HStack(spacing: 2) {
            ForEach(MarkupTool.all, id: \.self) { item in
                Button { tool = item; if item != .move { selectedID = nil } } label: {
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
            Button { history.undo(); keepSelection() } label: { Image(systemName: "arrow.uturn.backward").frame(width: 44, height: 44) }
                .disabled(!history.canUndo).accessibilityLabel(Text("Undo"))
            Button { history.redo(); keepSelection() } label: { Image(systemName: "arrow.uturn.forward").frame(width: 44, height: 44) }
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

    /// A mark Undo or Redo took away can't stay selected.
    private func keepSelection() { if selected == nil { selectedID = nil } }

    private static func symbol(_ tool: MarkupTool) -> String {
        switch tool {
        case .move: return "arrow.up.and.down.and.arrow.left.and.right"
        case .draw(.arrow): return "arrow.up.right"
        case .draw(.ellipse): return "circle"
        case .draw(.box): return "square"
        case .draw(.pen): return "pencil.tip"
        case .draw(.note): return "textformat"
        }
    }
    private static func name(_ tool: MarkupTool) -> LocalizedStringKey {
        switch tool {
        case .move: return LocalizedStringKey("Move")
        case .draw(.arrow): return LocalizedStringKey("Arrow")
        case .draw(.ellipse): return LocalizedStringKey("Circle")
        case .draw(.box): return LocalizedStringKey("Box")
        case .draw(.pen): return LocalizedStringKey("Pen")
        case .draw(.note): return LocalizedStringKey("Note")
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
/// finger moves the picture and two zoom it, and only the pen draws. With the Move tool, a finger on what `grabs` says
/// can be picked up takes it rather than the picture, and a press on nothing is `elsewhere`.
private struct MarkupTouches: UIViewRepresentable {
    let fingerMoves: Bool
    let grabs: (CGPoint) -> Bool
    let elsewhere: () -> Void
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
        // A finger that starts moving the picture can be joined by a second that zooms it, and the other way round.
        pan.delegate = view; pinch.delegate = view
        view.addGestureRecognizer(pan); view.addGestureRecognizer(pinch)
        view.recognizers = [pan, pinch]
        return view
    }
    func updateUIView(_ view: TouchView, context: Context) {
        view.owner = self
        view.recognizers.forEach { $0.isEnabled = fingerMoves }
    }

    final class TouchView: UIView, UIGestureRecognizerDelegate {
        var owner: MarkupTouches?
        var recognizers: [UIGestureRecognizer] = []
        func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            recognizers.contains(gesture) && recognizers.contains(other)
        }
        // A finger on a mark moves the mark, so the picture's recognizers never see it.
        func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            !(owner?.grabs(touch.location(in: self)) ?? false)
        }
        private weak var drawing: UITouch?

        private func draws(_ touch: UITouch) -> Bool {
            touch.type == .pencil || !(owner?.fingerMoves ?? false) || (owner?.grabs(touch.location(in: self)) ?? false)
        }
        private func force(_ touch: UITouch) -> Double? {
            touch.type == .pencil && touch.maximumPossibleForce > 0 ? Double(touch.force / touch.maximumPossibleForce) : nil
        }
        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
            guard drawing == nil, let touch = touches.first(where: draws) else {
                if drawing == nil { owner?.elsewhere() }
                return
            }
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
