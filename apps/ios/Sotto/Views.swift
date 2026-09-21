import SwiftUI
import SottoCore

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @State private var hostSheet = false
    var body: some View {
        NavigationStack {
            Group {
                if model.saved == nil { PairView() }
                else { ThreadListView() }
            }
            .background(Color("Canvas"))
            .navigationTitle(model.saved == nil ? "Sotto" : "Threads")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color("Canvas"), for: .navigationBar)
            .toolbar {
                if model.saved != nil {
                    ToolbarItem(placement: .topBarTrailing) { Button("Host") { hostSheet = true }.frame(minHeight: 44) }
                }
            }
            .navigationDestination(isPresented: Binding(get: { model.selectedID != nil }, set: { if !$0 { Task { await model.select(nil) } } })) { ThreadView() }
            .sheet(isPresented: $hostSheet) { HostView() }
        }
    }
}

struct PairView: View {
    @EnvironmentObject private var model: AppModel
    @State private var address = ""
    @State private var code = ""
    @FocusState private var focus: Field?
    enum Field { case address, code }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Pair with Forge").font(.custom("Figtree-Regular", size: 28, relativeTo: .title)).fontWeight(.semibold)
                Text("Read the pairing code on Forge and enter it here.").foregroundStyle(Color("Muted"))
                VStack(alignment: .leading, spacing: 8) {
                    Text("Host address").font(.subheadline)
                    TextField("https://forge.your-tailnet.ts.net", text: $address).textContentType(.URL).keyboardType(.URL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().focused($focus, equals: .address)
                        .submitLabel(.next).onSubmit { focus = .code }.fieldSurface().accessibilityLabel("Host address")
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Pairing code").font(.subheadline)
                    TextField("Code from Forge", text: $code).textInputAutocapitalization(.characters).autocorrectionDisabled()
                        .focused($focus, equals: .code).submitLabel(.go).onSubmit { pair() }.fieldSurface().accessibilityLabel("Pairing code")
                }
                Button(model.working ? "Pairing..." : "Pair this iPhone") { pair() }.buttonStyle(ActionStyle())
                    .disabled(model.working || !model.storageReady || address.isEmpty || code.isEmpty)
                if let feedback = model.feedback { Text(feedback).accessibilityAddTraits(.updatesFrequently) }
                Text("Pairing identifies this iPhone. It does not answer permission requests.").font(.subheadline).foregroundStyle(Color("Muted"))
            }.padding(24)
        }.scrollDismissesKeyboard(.interactively)
    }
    private func pair() { focus = nil; Task { await model.pair(address: address, code: code); if model.saved != nil { code = "" } } }
}

struct ThreadListView: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ConnectionFeedback()
                if model.threads.isEmpty {
                    Text(model.working ? "Reading threads..." : "No threads on this host. Start one on the desktop.")
                        .foregroundStyle(Color("Muted")).padding(.vertical, 32)
                }
                ForEach(model.threads) { thread in
                    Button { Task { await model.select(thread.id) } } label: {
                        VStack(alignment: .leading, spacing: 7) {
                            Text(thread.title).fontWeight(.semibold).foregroundStyle(Color("Ink"))
                            Text(project(thread) + " - " + status(thread)).font(.subheadline).foregroundStyle(Color("Muted"))
                        }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.vertical, 18).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                    Divider().overlay(Color("Border").opacity(0.35))
                }
            }.padding(.horizontal, 24)
        }.refreshable { await model.reconnect() }
    }
    private func project(_ thread: ThreadSummary) -> String { model.shell?.host.projects.first { $0.id == thread.projectId }?.title ?? "Project" }
    private func status(_ thread: ThreadSummary) -> String { !thread.requests.isEmpty ? "Needs your answer" : thread.status == "running" ? "Working" : thread.status == "error" ? "Needs attention" : "Ready" }
}

struct ConnectionFeedback: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let feedback = model.feedback { Text(feedback).font(.subheadline).accessibilityAddTraits(.updatesFrequently) }
            if !model.online {
                Button(model.working ? "Connecting..." : "Reconnect") { Task { await model.reconnect() } }
                    .frame(minHeight: 44).disabled(model.working)
            }
        }.padding(.vertical, model.feedback != nil || !model.online ? 12 : 0)
    }
}

struct ThreadView: View {
    @EnvironmentObject private var model: AppModel
    @State private var dismissMarker: PendingOperation?
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 26) {
                ConnectionFeedback()
                if model.detail?.earlierAvailable == true || model.selected?.earlierAvailable == true {
                    Button("Show earlier messages") { Task { await model.earlier() } }.frame(minHeight: 44).disabled(!model.online)
                }
                ForEach(model.detail?.messages ?? []) { message in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(message.role == "user" ? "You" : (["claude": "Claude Code", "codex": "Codex", "grok": "Grok Build", "devin": "Devin"][model.selected?.providerId ?? ""] ?? "Agent"))
                            .font(.subheadline).foregroundStyle(Color("Muted"))
                        Text(message.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        ForEach(message.attachments ?? []) { attachment in
                            Label(attachment.name + " (view on desktop)", systemImage: "paperclip").font(.subheadline).foregroundStyle(Color("Muted"))
                        }
                    }.padding(message.role == "user" ? 14 : 0)
                        .background(message.role == "user" ? Color("Raised") : .clear, in: RoundedRectangle(cornerRadius: 12))
                }
                if model.detail == nil { Text(model.online ? "Reading this thread..." : "Reconnect to read this thread.").foregroundStyle(Color("Muted")) }
                if let id = model.selectedID, let text = model.failedReplies[id] {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Reply was not sent").fontWeight(.semibold)
                        Text(text).textSelection(.enabled)
                        Button("Restore reply") { model.restoreReply() }.frame(minHeight: 44).disabled(!(model.drafts[id] ?? "").isEmpty)
                    }.padding(16).background(Color("Raised"), in: RoundedRectangle(cornerRadius: 12))
                }
                ForEach(model.selectedPending) { item in
                    VStack(alignment: .leading, spacing: 10) {
                        if let text = model.submitted[item.id] { Text(text).textSelection(.enabled) }
                        Text("Delivery unconfirmed. Nothing will be sent again automatically.").font(.subheadline)
                        Button("Check delivery") { Task { await model.checkDelivery() } }.frame(minHeight: 44).disabled(!model.online)
                        Button("I checked the thread") { dismissMarker = item }.frame(minHeight: 44)
                    }.padding(16).background(Color("Raised"), in: RoundedRectangle(cornerRadius: 12))
                }
                ForEach(model.selected?.requests ?? []) { request in
                    RequestView(request: request).id(request.id)
                }
            }.padding(24)
        }
        .background(Color("Canvas")).scrollDismissesKeyboard(.interactively)
        .navigationTitle(model.selected?.title ?? "Thread").navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom, spacing: 0) { ComposerView() }
        .confirmationDialog("Dismiss this unconfirmed action?", isPresented: Binding(get: { dismissMarker != nil }, set: { if !$0 { dismissMarker = nil } }), titleVisibility: .visible) {
            Button("Dismiss without resending") { if let item = dismissMarker { model.acknowledgeUnknown(item.id) }; dismissMarker = nil }
            Button("Cancel", role: .cancel) { dismissMarker = nil }
        } message: { Text("It may already have reached the host. Check its messages and current request before choosing to send anything else.") }
    }
}

struct ComposerView: View {
    @EnvironmentObject private var model: AppModel
    var body: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Reply to this thread", text: Binding(get: { model.drafts[model.selectedID ?? ""] ?? "" }, set: { model.drafts[model.selectedID ?? ""] = $0 }), axis: .vertical)
                    .lineLimit(1...6).fieldSurface().accessibilityLabel("Reply to this thread")
                if model.canInterrupt { Button("Interrupt") { Task { await model.interrupt() } }.frame(minHeight: 44) }
                else { Button("Send") { Task { await model.send() } }.buttonStyle(ActionStyle())
                    .disabled(!model.canSend || (model.drafts[model.selectedID ?? ""] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
            }.padding(12)
        }.background(Color("Canvas"))
    }
}

struct RequestView: View {
    @EnvironmentObject private var model: AppModel
    let request: AgentRequest
    @State private var answers: [String: QuestionAnswer] = [:]
    @State private var text = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Divider()
            Text(request.text).fontWeight(.semibold).textSelection(.enabled)
            if let context = request.context {
                if let tool = context.toolName { Text(tool).font(.subheadline).foregroundStyle(Color("Muted")) }
                if let command = context.command { Text(command).font(.system(.body, design: .monospaced)).textSelection(.enabled) }
                if let cwd = context.cwd { Text(cwd).font(.subheadline).textSelection(.enabled) }
                if let details = context.details { Text(details).textSelection(.enabled) }
            }
            if !request.supported { Text("This request cannot be answered here. Check its delivery or answer in the provider's app.").font(.subheadline) }
            else if !model.mayAnswer { Text("This iPhone can read requests. Allow answers for this client on the host to respond here.").font(.subheadline) }
            else if request.kind == "permission" { permissionActions }
            else if let questions = request.questions, !questions.isEmpty {
                ForEach(questions) { question in questionField(question) }
                Button("Send answers") { Task { await model.answer(request, answers: answers) } }.buttonStyle(ActionStyle()).disabled(!model.canAnswer(request))
            } else if !request.options.isEmpty {
                ForEach(request.options) { option in
                    Button(option.label) { Task { await model.answer(request, choice: option.id) } }.buttonStyle(ChoiceStyle()).disabled(!model.canAnswer(request))
                }
            } else {
                TextField("Your answer", text: $text, axis: .vertical).fieldSurface().accessibilityLabel("Your answer")
                Button("Send answer") { Task { await model.answer(request, text: text) } }.buttonStyle(ActionStyle()).disabled(!model.canAnswer(request) || text.isEmpty)
            }
        }.onChange(of: request) { _, _ in answers = [:]; text = "" }
    }
    @ViewBuilder private var permissionActions: some View {
        if let choices = request.permissionChoices {
            ForEach(choices) { choice in
                Button { Task { await model.answer(request, choice: choice.id) } } label: {
                    VStack(alignment: .leading, spacing: 5) { Text(choice.label); if let description = choice.description { Text(description).font(.subheadline).foregroundStyle(Color("Muted")) } }
                }.buttonStyle(ChoiceStyle()).disabled(!model.canAnswer(request))
            }
        } else {
            Button("Allow") { Task { await model.answer(request, choice: "allow") } }.buttonStyle(ActionStyle()).disabled(!model.canAnswer(request))
            Button("Deny") { Task { await model.answer(request, choice: "deny") } }.buttonStyle(ChoiceStyle()).disabled(!model.canAnswer(request))
        }
    }
    private func questionField(_ question: Question) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(question.question)
            if let reason = question.unavailableReason { Text(reason).font(.subheadline) }
            ForEach(question.options) { option in
                let chosen = answers[question.id]?.optionIds.contains(option.id) == true
                Button {
                    var answer = answers[question.id] ?? QuestionAnswer()
                    if question.multiSelect { if chosen { answer.optionIds.removeAll { $0 == option.id } } else { answer.optionIds.append(option.id) } }
                    else { answer.optionIds = chosen && question.required == false ? [] : [option.id]; answer.text = nil }
                    answers[question.id] = answer
                } label: {
                    HStack { VStack(alignment: .leading, spacing: 4) { Text(option.label); if let description = option.description { Text(description).font(.subheadline).foregroundStyle(Color("Muted")) } }; Spacer(); if chosen { Image(systemName: "checkmark").accessibilityHidden(true) } }
                }.buttonStyle(ChoiceStyle()).accessibilityAddTraits(chosen ? .isSelected : []).disabled(!model.canAnswer(request) || question.unavailableReason != nil)
            }
            if question.allowFreeText {
                TextField("Write your answer", text: Binding(get: { answers[question.id]?.text ?? "" }, set: { value in
                    var answer = answers[question.id] ?? QuestionAnswer(); answer.text = value
                    if !question.multiSelect && !value.isEmpty { answer.optionIds = [] }; answers[question.id] = answer
                }), axis: .vertical).fieldSurface().accessibilityLabel("Your answer to: " + question.question)
            }
        }
    }
}

struct HostView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var confirmForget = false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Text(model.saved?.address ?? "Host").textSelection(.enabled)
                    Text(model.online ? "Connected" : "Not connected").foregroundStyle(Color("Muted"))
                    Button("Reconnect") { Task { await model.reconnect() } }.buttonStyle(ActionStyle()).disabled(model.working)
                    Button("Forget this host", role: .destructive) { confirmForget = true }.frame(minHeight: 44).disabled(model.working)
                    if let feedback = model.feedback { Text(feedback).font(.subheadline) }
                    Text("Forget revokes this iPhone's access. Threads stay on the host.").font(.subheadline).foregroundStyle(Color("Muted"))
                }.padding(24)
            }.background(Color("Canvas")).navigationTitle("Host").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.frame(minHeight: 44) } }
                .confirmationDialog("Forget this host?", isPresented: $confirmForget, titleVisibility: .visible) {
                    Button("Revoke access and forget", role: .destructive) { Task { await model.forgetHost(); if model.saved == nil { dismiss() } } }
                } message: { Text("If the host is offline, connection details will be kept so you can retry revocation.") }
        }
    }
}

struct ActionStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.fontWeight(.semibold).padding(.horizontal, 16).padding(.vertical, 10).frame(minHeight: 44)
            .foregroundStyle(Color("ActionInk")).background(Color("Action"), in: RoundedRectangle(cornerRadius: 10)).opacity(!enabled ? 0.55 : configuration.isPressed ? 0.75 : 1)
    }
}
struct ChoiceStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(12)
            .foregroundStyle(Color("Ink")).background(Color("Raised"), in: RoundedRectangle(cornerRadius: 10)).opacity(!enabled ? 0.55 : configuration.isPressed ? 0.75 : 1)
    }
}
extension View {
    func fieldSurface() -> some View { padding(12).frame(minHeight: 48).background(Color("Surface"), in: RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(Color("Border"), lineWidth: 0.5)) }
}
