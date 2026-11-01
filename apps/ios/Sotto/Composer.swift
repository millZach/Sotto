import AVFoundation
import Speech
import SwiftUI
import SottoCore

// MARK: - The card

/// The reply box, a thread's and Watcher's alike, in the shape of Claude's iPhone composer (Zach's pick A, November 1,
/// 2026, from `docs/prototypes/ios-claude-composer-prototype.html`): one card holding the photos and files, the words, and
/// a row inside it, the + and the settings pill on the left, the mic and Send on the right. It has no edge in any state
/// and floats over the conversation (#1946) on `ComposerSurface`. At the accessibility text sizes the pill takes a line of
/// its own above the buttons.
struct ComposerCard<Attachments: View, Words: View, Plus: View, Pill: View, Trailing: View>: View {
    @ViewBuilder let attachments: Attachments
    @ViewBuilder let words: Words
    @ViewBuilder let plus: Plus
    @ViewBuilder let pill: Pill
    @ViewBuilder let trailing: Trailing
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            attachments
            words
                .padding(.horizontal, ComposerMetrics.wordsInset)
                .padding(.top, ComposerMetrics.wordsTop)
                .padding(.bottom, 2)
            Group {
                if typeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: ComposerMetrics.gap) {
                        pill
                        HStack(spacing: ComposerMetrics.gap) { plus; Spacer(minLength: 0); trailing }
                    }
                } else {
                    HStack(spacing: ComposerMetrics.gap) { plus; pill; Spacer(minLength: 0); trailing }
                }
            }
            .padding(ComposerMetrics.rowInset)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .composerSurface(in: RoundedRectangle(cornerRadius: ComposerMetrics.radius, style: .continuous))
    }
}

// MARK: - The settings pill

/// What the pill's shield says: asking first, acting without asking on some things, or on everything.
enum PillShield { case asks, grants, full }

/// The settings pill's face: the provider's logo, the model, the effort dimmer after it, and a chevron. A bolt while the
/// speed isn't Standard and a shield while the agent may act without asking keep those in sight, and a dot marks a
/// permission change the agent hasn't confirmed. Drawn the row's height on a soft fill, pressed across 44 points.
struct ComposerPill: View {
    let providerID: String?
    let model: String
    /// The effort in words; nil where the model offers none.
    let effort: String?
    var speed = ThreadSettings.standard
    var shield = PillShield.asks
    var pending = false

    var body: some View {
        HStack(spacing: 6) {
            ProviderLogo(providerID: providerID)
            Text(verbatim: model).foregroundStyle(Palette.ink).lineLimit(1)
            if let effort { Text(verbatim: effort).foregroundStyle(Palette.muted).lineLimit(1).fixedSize() }
            if speed != ThreadSettings.standard {
                HStack(spacing: -3) {
                    Image(systemName: "bolt.fill")
                    if speed == "ultrafast" { Image(systemName: "bolt.fill") }
                }
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Palette.accentText)
            }
            if shield != .asks {
                Image(systemName: shield == .full ? "shield.fill" : "shield.lefthalf.filled")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(shield == .full ? Palette.warningText : Palette.accentText)
            }
            Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(Palette.muted)
            if pending { Circle().fill(Palette.warning).frame(width: 6, height: 6) }
        }
        .font(.sotto(.small, .medium))
        .padding(.horizontal, Space.s3)
        .frame(minHeight: ComposerMetrics.button)
        .background(Palette.fillSoft, in: Capsule())
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .padding(.vertical, -(44 - ComposerMetrics.button) / 2)
    }
}

// MARK: - Dictation

/// The mic in a reply box's row (ADR-0174): a press starts dictation into this box on this iPhone, and while it listens
/// the mic is filled and a press stops it. While another box listens, a press here moves the listening to this one.
struct DictateButton: View {
    @ObservedObject private var dictation = Dictation.shared
    /// The box's draft key, which says which box is listening.
    let key: String
    let words: Binding<String>
    @State private var presses = 0

    var body: some View {
        let listening = dictation.key == key
        let hint = listening ? String(localized: "Stops listening. What you said stays in the box.") : String(localized: "Turns what you say into words in this box, on this iPhone")
        Button {
            presses += 1
            dictation.toggle(key: key, words: words.wrappedValue) { words.wrappedValue = $0 }
        } label: {
            Image(systemName: "mic").font(.system(size: 15, weight: .semibold))
                .foregroundStyle(listening ? Palette.onAccent : Palette.ink)
                .composerDisc(listening ? AnyShapeStyle(Palette.accent) : AnyShapeStyle(Palette.fillSoft))
        }
        .buttonStyle(PressStyle())
        .sensoryFeedback(.impact(flexibility: .soft), trigger: presses)
        .accessibilityLabel(listening ? String(localized: "Stop dictating") : String(localized: "Dictate"))
        .accessibilityHint(hint)
        .accessibilityIdentifier("dictate")
        .alert(dictation.problem?.title ?? "", isPresented: Binding(get: { dictation.problem?.key == key }, set: { if !$0 { dictation.problem = nil } }),
               presenting: dictation.problem) { problem in
            if problem.kind == .notAllowed {
                Button("Open iOS Settings") { if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) } }
            }
            Button("Close", role: .cancel) {}
        } message: { problem in
            Text(problem.message)
        }
        // A box that leaves the screen stops listening, and keeps what it heard; one still asking iOS never starts.
        .onDisappear { dictation.leave(key) }
    }
}

/// While a box listens, the row's left side says so, where the + and the pill were.
struct ListeningLine: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        HStack(spacing: Space.s2) {
            Image(systemName: "waveform")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Palette.accentText)
                .symbolEffect(.variableColor.iterative, isActive: !reduceMotion)
                .accessibilityHidden(true)
            Text("Listening on this iPhone").font(.sotto(.small)).foregroundStyle(Palette.muted).lineLimit(1)
        }
        .padding(.leading, Space.s2)
        .frame(minHeight: ComposerMetrics.button)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("dictation-listening")
    }
}

/// The Speed submenu in a settings pill's menu, a thread's and Watcher's: Standard first, since the offered speeds are
/// those past it, then each offered speed with what it costs.
struct SpeedMenu: View {
    let speeds: [ModelSpeed]
    let speed: String
    let providerID: String?
    let choose: (String) -> Void
    var body: some View {
        Menu {
            SettingOption(name: ThreadSettings.speedName(ThreadSettings.standard, offered: speeds), chosen: speed == ThreadSettings.standard) {
                choose(ThreadSettings.standard)
            }
            ForEach(speeds, id: \.id) { item in
                SettingOption(name: ThreadSettings.speedName(item.id, offered: speeds), line: ThreadSettings.speedCost(item, providerID: providerID),
                              chosen: item.id == speed) { choose(item.id) }
            }
        } label: {
            Text("Speed", comment: "The thread setting for how fast its agent answers.")
            Text(verbatim: ThreadSettings.speedName(speed, offered: speeds))
        }
    }
}

/// Why dictation couldn't start, or stopped on its own, said once in an alert over the box that asked.
struct DictationProblem: Identifiable {
    enum Kind { case notAllowed, notOnDevice, microphone, interrupted }
    let key: String
    let kind: Kind
    var id: String { key }
    var title: String {
        switch kind {
        case .notAllowed: return String(localized: "Dictation is off for Sotto")
        case .notOnDevice: return String(localized: "Can’t dictate on this iPhone")
        case .microphone: return String(localized: "The microphone didn’t start")
        case .interrupted: return String(localized: "Dictation stopped")
        }
    }
    var message: String {
        switch kind {
        case .notAllowed:
            return String(localized: "Sotto can’t use the microphone or speech recognition. Turn them on in Settings › Sotto.")
        case .notOnDevice:
            return String(localized: "This iPhone can’t recognize speech in its language without sending it to Apple, so Sotto doesn’t dictate here. The keyboard’s own mic key still works.")
        case .microphone:
            return String(localized: "Nothing was heard, and your words are as they were. Try the mic again.")
        case .interrupted:
            return String(localized: "What was heard is in the box. Press the mic to go on.")
        }
    }
}

/// Dictation into a reply box on this iPhone (ADR-0174): Apple's speech recognition on the device only, writing what it
/// hears after the words already in the box. The audio goes from the microphone to the recognizer in memory and is
/// never recorded, kept or sent; what it hears is never logged. It listens only from a press of the mic until the next
/// press, a send, or the box leaving the screen. One box listens at a time, and its words are locked while it does, so
/// nothing typed is written over.
@MainActor final class Dictation: ObservableObject {
    static let shared = Dictation()
    /// The box listening, by its draft's key, until its last words have arrived; nil while nothing listens. It changes
    /// only as listening starts and ends, so what watches it is drawn again only then; what is heard goes straight into
    /// the box's draft.
    @Published private(set) var key: String?
    @Published var problem: DictationProblem?

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var write: ((String) -> Void)?
    /// The box what is heard goes into, from the start until the last words have arrived.
    private var writing: String?
    /// The box's words when listening started; what is heard follows them.
    private var before = ""
    /// Each start's own number, so a result from one that has ended writes nothing.
    private var session = 0
    /// The box whose start is still asking iOS for leave, so leaving it or pressing again can call the start off.
    private var starting: String?
    /// Whether this start has heard anything yet, which says what an error means.
    private var heardAny = false

    /// Starts listening into this box, or stops it if it is the one listening or about to.
    func toggle(key: String, words: String, write: @escaping (String) -> Void) {
        if self.key == key { stop(); return }
        if starting == key { session += 1; starting = nil; return }
        cancel()
        session += 1
        starting = key
        let started = session
        Task { await start(key: key, words: words, write: write, session: started) }
    }

    /// Stops listening and lets the last words heard arrive; the box stays locked until they have, or two seconds pass.
    func stop() {
        guard key != nil else { return }
        endAudio()
        task?.finish()
        let ending = session
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            if self?.session == ending { self?.cancel() }
        }
    }

    /// The box is leaving the screen: it stops listening, and a start still asking iOS is called off.
    func leave(_ key: String) {
        if self.key == key { stop() }
        if starting == key { session += 1; starting = nil }
    }

    /// Stops listening and writes nothing more, as a send does: what was heard is already in the box.
    func cancel(_ key: String? = nil) {
        guard let writing, key == nil || key == writing else { return }
        session += 1
        task?.cancel()
        tearDown()
    }

    private func start(key: String, words: String, write: @escaping (String) -> Void, session started: Int) async {
        let allowed = await Self.allowed()
        // Called off while iOS asked: the box left the screen, its mic was pressed again, or another box's was.
        guard session == started else { return }
        starting = nil
        guard allowed else { problem = DictationProblem(key: key, kind: .notAllowed); return }
        guard let recognizer = SFSpeechRecognizer(), recognizer.supportsOnDeviceRecognition else {
            problem = DictationProblem(key: key, kind: .notOnDevice)
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        let audio = AVAudioSession.sharedInstance()
        do {
            try audio.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audio.setActive(true, options: .notifyOthersOnDeactivation)
            let input = engine.inputNode
            input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0), block: Self.feed(request))
            engine.prepare()
            try engine.start()
        } catch {
            engine.inputNode.removeTap(onBus: 0)
            try? audio.setActive(false, options: .notifyOthersOnDeactivation)
            problem = DictationProblem(key: key, kind: .microphone)
            return
        }
        self.request = request
        self.write = write
        self.before = words
        self.writing = key
        self.key = key
        task = recognizer.recognitionTask(with: request, resultHandler: Self.results { [weak self] heard, failed, done in
            Task { @MainActor in self?.heard(heard, failed: failed, done: done, session: started) }
        })
    }

    private func heard(_ heard: String?, failed: Bool, done: Bool, session from: Int) {
        guard from == session else { return }
        if let heard, !heard.isEmpty {
            heardAny = true
            write?(DictatedWords.join(before, heard))
        }
        // A start that ends in an error says so: nothing heard, or listening cut short with what was heard kept.
        if failed, let writing { problem = DictationProblem(key: writing, kind: heardAny ? .interrupted : .microphone) }
        if done { tearDown() }
    }

    private func endAudio() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
    }

    private func tearDown() {
        endAudio()
        request = nil
        task = nil
        write = nil
        writing = nil
        heardAny = false
        before = ""
        key = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Asks, the first time, for speech recognition and the microphone; true once both are allowed.
    private static func allowed() async -> Bool {
        let speech = await withCheckedContinuation { done in SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) } }
        guard speech == .authorized else { return false }
        return await AVAudioApplication.requestRecordPermission()
    }

    /// The microphone's tap, built outside the main actor since the audio thread calls it: each buffer to the recognizer.
    nonisolated private static func feed(_ request: SFSpeechAudioBufferRecognitionRequest) -> AVAudioNodeTapBlock {
        { buffer, _ in request.append(buffer) }
    }

    /// The recognizer's results, read where it calls from: the words so far, whether it failed, and whether it has
    /// finished.
    nonisolated private static func results(_ hear: @escaping @Sendable (String?, Bool, Bool) -> Void) -> (SFSpeechRecognitionResult?, Error?) -> Void {
        { result, error in hear(result?.bestTranscription.formattedString, error != nil, error != nil || result?.isFinal == true) }
    }
}
