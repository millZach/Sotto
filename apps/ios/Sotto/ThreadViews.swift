import SwiftUI
import SottoCore

/// One thread: its messages as a conversation, or its activity, with the reply box under both.
/// A waiting question or permission opens as a sheet; dismissed, the reply box offers it again.
/// Everything here goes to the thread's own computer.
struct ThreadView: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    @State private var pane = Pane.messages
    @State private var open: AgentRequest?
    @State private var setAside: Set<String> = []
    /// The request the sheet was opened for, set aside when the sheet closes without an answer.
    @State private var shown: String?
    enum Pane: String, CaseIterable, Identifiable { case messages = "Messages", activity = "Activity"; var id: String { rawValue } }
    private var thread: ThreadSummary? { model.thread(ref) }
    private var detail: ThreadDetail? { model.detail(for: ref) }
    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 9) {
                Text(thread?.title ?? "Thread").font(.figtree(25, .title2, .semibold))
                    .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                Text("\(Words.provider(thread?.providerId)) · \(model.name(ref.hostID))")
                    .font(.figtree(13, .footnote)).foregroundStyle(Palette.muted)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 22).padding(.vertical, 10)
            HStack(spacing: 24) {
                ForEach(Pane.allCases) { choice in
                    Button { pane = choice } label: {
                        Text(choice.rawValue).font(.figtree(15, .subheadline))
                            .foregroundStyle(pane == choice ? Palette.ink : Palette.muted).frame(minHeight: 44)
                            .overlay(alignment: .bottom) { Rectangle().fill(pane == choice ? Palette.accent : .clear).frame(height: 2) }
                    }.buttonStyle(.plain).accessibilityAddTraits(pane == choice ? .isSelected : [])
                        .accessibilityIdentifier("thread-pane-\(choice.rawValue.lowercased())")
                }
                Spacer(minLength: 0)
            }.padding(.horizontal, 22)
            Divider().overlay(Palette.hairline)
            ComputerBanner(hostID: ref.hostID).padding(.horizontal, 16)
            if let problem = model.detailProblem, model.online(ref.hostID) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(problem).foregroundStyle(Palette.muted)
                    Button("Try again") { Task { await model.select(ref) } }.buttonStyle(PlainStyle(compact: true))
                }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
            }
            switch pane {
            case .messages: MessagesPane(ref: ref, detail: detail)
            case .activity: ActivityPane(detail: detail, online: model.online(ref.hostID))
            }
        }
        .background(Palette.canvas)
        .navigationTitle(model.name(ref.hostID)).navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Palette.canvas, for: .navigationBar)
        .toolbar(.hidden, for: .tabBar)
        .safeAreaInset(edge: .bottom, spacing: 0) { ComposerView(ref: ref) { shown = $0.id; open = $0 } }
        .task(id: ref) { await model.select(ref); offer() }
        .onDisappear { Task { if model.selected == ref { await model.select(nil) } } }
        .onChange(of: thread?.requests.map(\.id)) { _, _ in offer() }
        .sheet(item: $open, onDismiss: { if let shown { setAside.insert(shown) }; shown = nil; offer() }) { request in
            RequestSheet(ref: ref, request: request).presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
        }
    }
    /// Opens the thread's waiting request once; after "Not now" it waits in the reply box.
    private func offer() {
        guard open == nil, let request = thread?.requests.first(where: { !setAside.contains($0.id) }) else { return }
        shown = request.id; open = request
    }
}

// MARK: Messages

private struct MessagesPane: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    let detail: ThreadDetail?
    @State private var dismissMarker: PendingOperation?
    @State private var viewing: OpenPhotos?
    var body: some View {
        let thread = model.thread(ref)
        let online = model.online(ref.hostID)
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if detail?.earlierAvailable == true || thread?.earlierAvailable == true {
                        Button("Show earlier messages") { Task { await model.earlier(ref) } }
                            .buttonStyle(PlainStyle(compact: true)).frame(maxWidth: .infinity).disabled(!online)
                    }
                    if let detail {
                        ForEach(detail.messages) { message in
                            MessageBubble(message: message, provider: Words.provider(thread?.providerId), ref: ref) { viewing = $0 }.equatable()
                        }
                    } else if model.detailProblem == nil || !online {
                        Text(model.status(ref.hostID) == .unreachable ? "Reconnect to read this thread." : "Reading this thread…")
                            .foregroundStyle(Palette.muted).padding(.vertical, 24)
                    }
                    ForEach(model.pending(for: ref)) { item in
                        UnconfirmedRow(item: item, text: model.submitted[item.id], photos: model.submittedPhotos[item.id] ?? [],
                                       sending: model.isSending(item)) { dismissMarker = item }
                    }
                    if let text = model.failedReplies[ref.id] {
                        let photos = model.failedPhotos[ref.id] ?? []
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Your reply wasn’t sent").fontWeight(.semibold)
                            if !text.isEmpty { Text(text).textSelection(.enabled) }
                            if !photos.isEmpty { Text(photos.count == 1 ? "With 1 photo" : "With \(photos.count) photos").font(.footnote).foregroundStyle(Palette.muted) }
                            Button("Put it back in the reply box") { model.restoreReply(ref) }.buttonStyle(PlainStyle(compact: true))
                                .disabled(!(model.drafts[ref.id] ?? "").isEmpty || !model.photos(ref).isEmpty)
                        }.card()
                    }
                    if let live = detail?.activities?.last(where: { $0.status == "running" && $0.kind != "turn" }) {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text(live.subject ?? live.title).font(.subheadline).lineLimit(1).truncationMode(.middle)
                        }.foregroundStyle(Palette.muted).padding(.leading, 6)
                    }
                    Color.clear.frame(height: 1).id("end")
                }.padding(16)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: detail?.revision) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
        }
        .fullScreenCover(item: $viewing) { PhotoViewer(opened: $0) }
        .confirmationDialog("Stop waiting for confirmation?", isPresented: Binding(get: { dismissMarker != nil }, set: { if !$0 { dismissMarker = nil } }), titleVisibility: .visible) {
            Button("I checked the thread") { if let item = dismissMarker { model.acknowledgeUnknown(item.id) }; dismissMarker = nil }
            Button("Cancel", role: .cancel) { dismissMarker = nil }
        } message: { Text("It may already have reached \(model.name(ref.hostID)). Nothing is sent again.") }
    }
}

private struct MessageBubble: View, Equatable {
    let message: Message
    let provider: String
    let ref: ThreadRef
    let open: (OpenPhotos) -> Void
    /// Drawn again only when what it shows changes; opening a photo is the same action for every message.
    static func == (a: Self, b: Self) -> Bool { a.message == b.message && a.provider == b.provider && a.ref == b.ref }
    var body: some View {
        if message.role == "user" {
            let photos = (message.attachments ?? []).filter(\.hasPreview)
            // Photos stand on their own above the words, the way Messages shows them.
            VStack(alignment: .trailing, spacing: 4) {
                ForEach(Array(photos.enumerated()), id: \.element.id) { index, photo in
                    Button { open(OpenPhotos(ref: ref, messageID: message.id, photos: photos, index: index)) } label: {
                        SentPhotoView(key: PhotoPreviews.Key(ref: ref, messageID: message.id, attachmentID: photo.id), name: photo.name)
                    }.buttonStyle(.plain).accessibilityLabel("Open photo \(photo.name)")
                }
                if !message.text.isEmpty || photos.count != (message.attachments ?? []).count {
                    content.foregroundStyle(Palette.bubbleInk)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(Palette.bubble, in: UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20, bottomTrailingRadius: 6, topTrailingRadius: 20))
                }
            }.frame(maxWidth: .infinity, alignment: .trailing).padding(.leading, 48)
        } else if message.role == "assistant" {
            VStack(alignment: .leading, spacing: 12) {
                Text(provider).font(.figtree(13, .footnote, .semibold)).foregroundStyle(Palette.muted)
                content.lineSpacing(4)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 10)
        } else {
            Text(message.text).font(.footnote).foregroundStyle(Palette.muted).frame(maxWidth: .infinity)
        }
    }
    private var content: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !message.text.isEmpty { Text(Self.rendered(message.text)).textSelection(.enabled) }
            // A user's photo its computer keeps is drawn above; any other image is named.
            ForEach((message.attachments ?? []).filter { message.role != "user" || !$0.hasPreview }) { attachment in
                Label("\(attachment.name) (open on the desktop)", systemImage: "photo").font(.footnote).foregroundStyle(Palette.muted)
            }
        }
    }
    /// Inline Markdown (bold, code, links) as the desktop shows it; plain text if it doesn't parse.
    static func rendered(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
}

/// A reply, answer or stop on its way to the thread's computer, or one it hasn't confirmed. While the computer
/// hasn't answered, or says it is still carrying it out, it reads as sending and asks nothing of the user.
/// Only one it couldn't confirm is marked, with what to do. It is never sent again on its own.
private struct UnconfirmedRow: View {
    @EnvironmentObject var model: AppModel
    let item: PendingOperation
    let text: String?
    let photos: [DraftPhoto]
    let sending: Bool
    let dismiss: () -> Void
    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            ForEach(photos) { photo in
                if let thumbnail = photo.prepared?.thumbnail {
                    Image(decorative: thumbnail, scale: 1).resizable().scaledToFit().frame(maxWidth: 220, maxHeight: 240)
                        .clipShape(RoundedRectangle(cornerRadius: 16)).opacity(0.6).padding(.leading, 48)
                }
            }
            if let text, !text.isEmpty {
                Text(text).foregroundStyle(Palette.bubbleInk).padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Palette.bubble.opacity(0.6), in: RoundedRectangle(cornerRadius: 20)).padding(.leading, 48)
            }
            if sending {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text(words.sending)
                }.font(.footnote).foregroundStyle(Palette.muted)
                    .accessibilityElement(children: .combine)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle").accessibilityHidden(true)
                    Text(words.unconfirmed).fixedSize(horizontal: false, vertical: true)
                }.font(.footnote).foregroundStyle(Palette.warning)
                HStack(spacing: 8) {
                    Button("I checked", action: dismiss).buttonStyle(PlainStyle(compact: true))
                    Button("Check again") { Task { await model.checkDelivery(item.hostID) } }.buttonStyle(PlainStyle(compact: true)).disabled(!model.online(item.hostID))
                }
            }
        }.frame(maxWidth: .infinity, alignment: .trailing)
    }
    /// What the row says for its kind: on its way, and unconfirmed.
    private var words: (sending: String, unconfirmed: String) {
        switch item.kind {
        case "answer": return ("Sending your answer…", "Your answer isn’t confirmed. Check the thread before you answer again.")
        case "interrupt": return ("Stopping…", "Stop isn’t confirmed. Check whether the thread is still working.")
        default: return ("Sending…", "Not confirmed. Check the thread before you send it again.")
        }
    }
}

// MARK: Activity

private struct ActivityPane: View {
    let detail: ThreadDetail?
    let online: Bool
    var body: some View {
        let rows = (detail?.activities ?? []).filter { $0.kind != "turn" }.sorted { $0.sequence < $1.sequence }
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if detail == nil { Text(online ? "Reading this thread…" : "Reconnect to read this thread.").foregroundStyle(Palette.muted).padding(.vertical, 24) }
                else if rows.isEmpty { Text("No activity yet.").foregroundStyle(Palette.muted).padding(.vertical, 24) }
                ForEach(rows) { record in
                    ActivityRow(record: record)
                    Divider().overlay(Palette.hairline).padding(.leading, 34)
                }
            }.padding(.horizontal, 16)
        }.defaultScrollAnchor(.bottom)
    }
}

private struct ActivityRow: View {
    let record: Activity
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Group {
                if record.status == "running" { ProgressView().controlSize(.small) }
                else { Image(systemName: icon) }
            }.frame(width: 22).foregroundStyle(tint).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(record.title).font(.subheadline).fontWeight(.semibold).foregroundStyle(record.status == "running" ? Palette.accent : Palette.ink)
                if let subject = record.subject, subject != record.title {
                    Text(subject).font(.system(.footnote, design: .monospaced)).foregroundStyle(Palette.muted).lineLimit(2).truncationMode(.middle)
                }
            }
            Spacer(minLength: 4)
            if let meta { Text(meta).font(.footnote).foregroundStyle(record.status == "failed" ? Palette.danger : Palette.muted) }
        }
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }
    private var icon: String {
        switch record.kind {
        case "command": return "terminal"
        case "file-change": return "doc.text"
        case "tool": return "wrench.and.screwdriver"
        case "reasoning": return "text.bubble"
        case "plan": return "checklist"
        case "subagent": return "person.2"
        case "compaction": return "arrow.down.right.and.arrow.up.left"
        default: return "info.circle"
        }
    }
    private var tint: ThemeRole { record.status == "running" ? Palette.accent : record.status == "failed" ? Palette.danger : Palette.muted }
    private var meta: String? {
        if record.status == "failed" { return record.exitCode.map { "Failed (\($0))" } ?? "Failed" }
        if record.status == "interrupted" { return "Stopped" }
        return Words.duration(record.durationMs)
    }
}

// MARK: Reply box

private struct ComposerView: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    let openRequest: (AgentRequest) -> Void
    var body: some View {
        VStack(spacing: 0) {
            Divider().overlay(Palette.hairline)
            if let request = model.thread(ref)?.requests.first {
                let requests = model.thread(ref)?.requests ?? []
                if requests.count > 1 {
                    Menu {
                        ForEach(requests) { pending in
                            Button(pending.questions?.first?.question ?? pending.text) { openRequest(pending) }
                        }
                    } label: {
                        Label("Review \(requests.count) requests", systemImage: "questionmark.bubble")
                            .frame(maxWidth: .infinity, minHeight: 48)
                    }.buttonStyle(ActionStyle(wide: true)).padding(12).accessibilityIdentifier("thread-requests")
                } else {
                    Button(request.kind == "permission" ? "Review the permission" : "Answer the question") { openRequest(request) }
                        .buttonStyle(ActionStyle(wide: true)).padding(12)
                }
            } else {
                HStack(alignment: .bottom, spacing: 8) {
                    AttachPhotosButton(ref: ref)
                    // Photos wait inside the reply box, above the words, as in Messages.
                    VStack(alignment: .leading, spacing: 8) {
                        if !model.photos(ref).isEmpty { DraftPhotoStrip(ref: ref) }
                        if let notice = model.photoNotices[ref.id] {
                            Text(notice).font(.footnote).foregroundStyle(Palette.danger).fixedSize(horizontal: false, vertical: true)
                                .accessibilityAddTraits(.updatesFrequently)
                        }
                        TextField("Reply", text: Binding(get: { model.drafts[ref.id] ?? "" }, set: { model.drafts[ref.id] = $0 }), axis: .vertical)
                            .lineLimit(1...6).accessibilityLabel("Reply to this thread")
                            // Locked while the reply's photos are staged, so nothing typed now joins it.
                            .disabled(model.preparingSends.contains(ref.id))
                    }
                    .padding(.horizontal, 16).padding(.vertical, 11)
                    .background(Palette.raised, in: RoundedRectangle(cornerRadius: model.photos(ref).isEmpty ? 22 : 18))
                    if model.canInterrupt(ref) {
                        Button { Task { await model.interrupt(ref) } } label: { Image(systemName: "stop.fill").frame(width: 44, height: 44) }
                            .foregroundStyle(Palette.ink).background(Palette.raised, in: Circle())
                            .accessibilityLabel("Stop this turn")
                    } else {
                        let preparing = model.preparingSends.contains(ref.id)
                        Button { Task { await model.send(ref) } } label: {
                            Group {
                                if preparing { ProgressView().tint(Palette.actionInk) }
                                else { Image(systemName: "arrow.up").fontWeight(.semibold) }
                            }.frame(width: 44, height: 44)
                        }
                            .foregroundStyle(Palette.actionInk).background(canSend || preparing ? Palette.action : Palette.raised, in: Circle())
                            .disabled(!canSend).accessibilityLabel(preparing ? "Sending reply" : "Send reply")
                    }
                }.padding(.horizontal, 12).padding(.vertical, 8)
            }
        }.background(Palette.canvas)
    }
    private var canSend: Bool { model.canSendReply(ref) }
}

// MARK: Question and permission sheet

/// The whole request: its context and every choice. Nothing is chosen for the user, and a question
/// is sent only when they press Send answer.
private struct RequestSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) var dismiss
    let ref: ThreadRef
    let request: AgentRequest
    @State private var answers: [String: QuestionAnswer] = [:]
    @State private var choice: String?
    @State private var text = ""
    private var thread: ThreadSummary? { model.thread(ref) }
    private var computer: String { model.name(ref.hostID) }
    /// The request as the computer holds it now; nil once it is answered or replaced.
    private var current: AgentRequest? { thread?.requests.first { $0.id == request.id } }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let current, let thread {
                    Text(title(current, thread)).font(.figtree(22, .title2, .bold)).accessibilityAddTraits(.isHeader)
                    Text(thread.title).font(.subheadline).foregroundStyle(Palette.muted)
                    if let context = current.context {
                        if let command = context.command { CommandBox(command: command) }
                        if let cwd = context.cwd { Text("in \(cwd) on \(computer)").font(.footnote).foregroundStyle(Palette.muted) }
                        if let details = context.details { Text(details).font(.subheadline).textSelection(.enabled) }
                    }
                    if current.kind == "permission" && current.context?.command == nil { Text(current.text).textSelection(.enabled) }
                    if !current.supported {
                        Text("This request can’t be answered here. Check the thread, or answer it on \(computer).").font(.subheadline).foregroundStyle(Palette.muted)
                    } else if !model.mayAnswer(ref.hostID) {
                        Text("This iPhone can’t answer on \(computer) yet. Turn on Can answer for it in Sotto on \(computer), or answer there.").font(.subheadline).foregroundStyle(Palette.muted)
                    } else if current.kind == "permission" {
                        permission(current, thread)
                    } else {
                        question(current, thread)
                    }
                    if !current.supported || !model.mayAnswer(ref.hostID) || current.kind == "permission" {
                        Button("Not now") { dismiss() }.buttonStyle(PlainStyle(wide: true))
                    }
                    if let feedback = model.feedback { Text(feedback).font(.subheadline).accessibilityAddTraits(.updatesFrequently) }
                } else {
                    Text("This request was answered or changed.").fontWeight(.semibold)
                    Button("Close") { dismiss() }.buttonStyle(PlainStyle(wide: true))
                }
            }.padding(20)
        }
        .background(Palette.surface)
        .onChange(of: current == nil && model.pending(for: ref).isEmpty) { _, gone in if gone { dismiss() } }
    }
    private func title(_ request: AgentRequest, _ thread: ThreadSummary) -> String {
        if request.kind == "permission" {
            return request.context?.command != nil ? "Allow \(Words.provider(thread.providerId)) to run this command?" : "\(Words.provider(thread.providerId)) is asking permission"
        }
        if let questions = request.questions, questions.count == 1 { return questions[0].question }
        return request.text
    }
    @ViewBuilder private func permission(_ request: AgentRequest, _ thread: ThreadSummary) -> some View {
        let enabled = model.canAnswer(request, in: ref)
        VStack(spacing: 8) {
            if let choices = request.permissionChoices {
                let ordered: [PermissionChoice] = choices.sorted { Self.rank($0) < Self.rank($1) }
                ForEach(ordered) { option in
                    if option.kind == "allow-once" {
                        Button { send(request, choice: option.id, thread) } label: { choiceLabel(option) }.buttonStyle(ActionStyle(wide: true))
                    } else {
                        Button { send(request, choice: option.id, thread) } label: { choiceLabel(option) }.buttonStyle(PlainStyle(wide: true))
                    }
                }
            } else {
                Button { send(request, choice: "allow", thread) } label: { Text("Allow").frame(maxWidth: .infinity) }.buttonStyle(ActionStyle(wide: true))
                Button { send(request, choice: "deny", thread) } label: { Text("Deny").frame(maxWidth: .infinity) }.buttonStyle(PlainStyle(wide: true))
            }
        }.disabled(!enabled)
    }
    @ViewBuilder private func question(_ request: AgentRequest, _ thread: ThreadSummary) -> some View {
        let enabled = model.canAnswer(request, in: ref)
        VStack(alignment: .leading, spacing: 8) {
            Group {
                if let questions = request.questions, !questions.isEmpty {
                    ForEach(questions) { item in questionField(item, showsTitle: questions.count > 1) }
                } else if !request.options.isEmpty {
                    ForEach(request.options) { option in
                        Button { choice = option.id } label: { optionLabel(option, chosen: choice == option.id) }
                            .buttonStyle(ChoiceStyle(chosen: choice == option.id))
                            .accessibilityAddTraits(choice == option.id ? .isSelected : [])
                    }
                } else {
                    TextField("Your answer", text: $text, axis: .vertical).lineLimit(2...8).fieldSurface().accessibilityLabel("Your answer")
                }
            }.disabled(!enabled)
            HStack(spacing: 8) {
                Button("Not now") { dismiss() }.buttonStyle(PlainStyle(wide: true))
                Button("Send answer") {
                    Task {
                        if request.questions?.isEmpty == false { await model.answer(request, in: ref, answers: answers) }
                        else if !request.options.isEmpty { await model.answer(request, in: ref, choice: choice) }
                        else { await model.answer(request, in: ref, text: text) }
                    }
                }.buttonStyle(ActionStyle(wide: true)).disabled(!enabled || !ready(request))
            }.padding(.top, 6)
        }
    }
    private func ready(_ request: AgentRequest) -> Bool {
        if let questions = request.questions, !questions.isEmpty {
            return questions.allSatisfy { q in
                // A required question this iPhone can't answer blocks sending; its reason says why.
                if q.unavailableReason != nil { return q.required == false }
                let chosen = !(answers[q.id]?.optionIds.isEmpty ?? true)
                let written = !(answers[q.id]?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                return q.required == false || chosen || written
            }
        }
        if !request.options.isEmpty { return choice != nil }
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    /// Sends against the request as the computer holds it now, never the copy the sheet opened with.
    private func send(_ current: AgentRequest, choice: String, _ thread: ThreadSummary) { Task { await model.answer(current, in: ref, choice: choice) } }
    /// Allow once first, then the other allows, then deny and the rest.
    private static func rank(_ choice: PermissionChoice) -> Int {
        if choice.kind == "allow-once" { return 0 }
        return choice.kind.hasPrefix("allow-") ? 1 : 2
    }
    private func choiceLabel(_ option: PermissionChoice) -> some View {
        VStack(spacing: 2) {
            Text(option.label)
            if let description = option.description { Text(description).font(.footnote).fontWeight(.regular) }
        }.frame(maxWidth: .infinity)
    }
    private func optionLabel(_ option: RequestOption, chosen: Bool) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(option.label).fontWeight(.semibold)
                if let description = option.description { Text(description).font(.footnote).foregroundStyle(Palette.muted) }
            }
            Spacer(minLength: 4)
            if chosen { Image(systemName: "checkmark").foregroundStyle(Palette.accent).accessibilityHidden(true) }
        }
    }
    private func questionField(_ item: Question, showsTitle: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if showsTitle { Text(item.question).fontWeight(.semibold) }
            if let reason = item.unavailableReason { Text(reason).font(.footnote).foregroundStyle(Palette.muted) }
            ForEach(item.options) { option in
                let chosen = answers[item.id]?.optionIds.contains(option.id) == true
                Button {
                    var answer = answers[item.id] ?? QuestionAnswer()
                    if item.multiSelect { if chosen { answer.optionIds.removeAll { $0 == option.id } } else { answer.optionIds.append(option.id) } }
                    else { answer.optionIds = chosen && item.required == false ? [] : [option.id]; answer.text = nil }
                    answers[item.id] = answer
                } label: { optionLabel(option, chosen: chosen) }
                    .buttonStyle(ChoiceStyle(chosen: chosen))
                    .accessibilityAddTraits(chosen ? .isSelected : [])
                    .disabled(item.unavailableReason != nil)
            }
            if item.allowFreeText {
                TextField("Write your own answer", text: Binding(get: { answers[item.id]?.text ?? "" }, set: { value in
                    var answer = answers[item.id] ?? QuestionAnswer(); answer.text = value
                    if !item.multiSelect && !value.isEmpty { answer.optionIds = [] }
                    answers[item.id] = answer
                }), axis: .vertical).lineLimit(1...6).fieldSurface().accessibilityLabel("Your own answer to: \(item.question)")
            }
        }
    }
}
