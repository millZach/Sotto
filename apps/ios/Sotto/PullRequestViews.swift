import SwiftUI
import SottoCore

/// A thread's pull request in a full-height sheet, from the chip under the thread's title (ADR-0102, variant A): its
/// state, title and branches, three lines that say where it stands, then its summary, checks, reviews and files, with
/// chips that jump to each part and follow the scroll, and babysitting docked at the bottom. GitHub is read through the
/// thread's computer when the sheet opens and when it is pulled to refresh. Read only, but for babysitting.
struct PullRequestSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let ref: ThreadRef
    let url: String
    let number: Int

    private enum Phase: Equatable {
        case reading
        case shown(PullRequestDetail)
        case nothing
        case limited(String)
        case failed(String)
    }
    @State private var phase = Phase.reading
    @State private var part = PullRequestPart.summary
    @State private var toast: String?
    /// Set while a press of the jump chips scrolls, so the chips don't follow the parts it passes on the way.
    @State private var jumping = false

    var body: some View {
        ScrollViewReader { proxy in
            VStack(spacing: 0) {
                header
                if case .shown(let detail) = phase { jumpBar(detail, proxy: proxy) }
                content
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: Space.s2) {
                if model.feedback != nil { FeedbackBanner() }
                if case .shown(let detail) = phase { BabysitDock(ref: ref, detail: detail, toast: $toast) }
            }
            .padding(.horizontal, Space.s3)
            .padding(.bottom, Space.s2)
        }
        .foregroundStyle(Palette.ink)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationBackground { SheetBackdrop(wash: false) }
        .presentationCornerRadius(Radius.xl)
        .toast($toast)
        .task { await load() }
    }

    // MARK: Header and jump chips

    private var header: some View {
        HStack(spacing: Space.s2) {
            Spacer(minLength: 0)
            if let page = PullRequests.openable(url) {
                Button { openURL(page) } label: {
                    Image(systemName: "arrow.up.right.square").font(.system(size: 16, weight: .semibold))
                }
                .buttonStyle(GlassCircleStyle())
                .accessibilityLabel("Open #\(String(number)) on GitHub")
                .accessibilityHint("Opens it in Safari.")
                .accessibilityIdentifier("pull-request-github")
            }
            // Done, trailing, as every sheet that only shows things closes (#1860); Open on GitHub stays beside it.
            Button("Done") { dismiss() }
                .buttonStyle(PillButtonStyle(kind: .ghost, compact: true))
                .keyboardShortcut(.cancelAction)
                .accessibilityIdentifier("pull-request-done")
        }
        .padding(.horizontal, Space.s4)
        .padding(.top, Space.s4)
    }

    private func jumpBar(_ detail: PullRequestDetail, proxy: ScrollViewProxy) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Space.s2) {
                ForEach(PullRequestPart.allCases) { each in
                    Button { jump(to: each, proxy: proxy) } label: {
                        HStack(spacing: 6) {
                            Text(each.title)
                            if each.flagged(detail) { Circle().fill(Palette.danger).frame(width: 7, height: 7).accessibilityHidden(true) }
                        }
                    }
                    .buttonStyle(ChipStyle(selected: part == each))
                    .accessibilityLabel(each.flagged(detail) ? each.flaggedTitle : each.title)
                    .accessibilityHint("Goes to this part of the pull request.")
                    .accessibilityAddTraits(part == each ? .isSelected : [])
                    .accessibilityIdentifier("pull-request-jump-\(each.rawValue)")
                }
            }
            .padding(.horizontal, Space.gutter)
            .padding(.vertical, Space.s2)
        }
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.hairline).frame(height: 1) }
    }

    private func jump(to target: PullRequestPart, proxy: ScrollViewProxy) {
        part = target
        jumping = true
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.3)) { proxy.scrollTo(target, anchor: .top) }
        Task { try? await Task.sleep(nanoseconds: 450_000_000); jumping = false }
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        switch phase {
        case .reading:
            VStack(spacing: Space.s3) {
                ProgressView()
                Text("Reading #\(String(number)) from GitHub…").font(.sotto(.small)).foregroundStyle(Palette.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .combine)
        case .nothing:
            message(String(localized: "This thread has no pull request to show. It may have been unlinked on the computer."), retry: false)
        case .limited(let words), .failed(let words):
            message(words, retry: true)
        case .shown(let detail):
            ScrollView {
                PullRequestBody(ref: ref, detail: detail)
                    .padding(.horizontal, Space.s4)
                    .padding(.top, Space.s4)
                    .padding(.bottom, Space.s8)
            }
            .coordinateSpace(.named(PullRequestBody.space))
            .onPreferenceChange(PartTops.self) { value in follow(value) }
            .refreshable { await load() }
        }
    }

    private func message(_ words: String, retry: Bool) -> some View {
        VStack(alignment: .leading, spacing: Space.s4) {
            Text(words).font(.sotto(.body)).foregroundStyle(Palette.ink).fixedSize(horizontal: false, vertical: true)
                .paragraphDirection()
            if retry {
                Button("Try again") { phase = .reading; Task { await load() } }
                    .buttonStyle(PillButtonStyle(kind: .soft))
            }
            Spacer(minLength: 0)
        }
        .padding(Space.gutter)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// The jump chips follow the scroll: the part whose top has passed under them is the one marked.
    private func follow(_ value: [PullRequestPart: CGFloat]) {
        guard !jumping else { return }
        let passed = PullRequestPart.allCases.filter { (value[$0] ?? .infinity) <= 96 }
        let next = passed.last ?? .summary
        if next != part { part = next }
    }

    private func load() async {
        let next: Phase
        do {
            switch try await model.readPullRequest(ref, url: url) {
            case .detail(let detail): next = .shown(detail)
            case .noPullRequest: next = .nothing
            case .limited(let retryAt):
                let words = Stamp.date(retryAt).map {
                    String(localized: "GitHub is limiting requests from your gh sign-in, so Sotto could not read the pull request. Nothing was lost. Try again after \(PullRequests.clock($0)).", comment: "%@ is a time of day, such as 3:40 PM.")
                } ?? String(localized: "GitHub is limiting requests from your gh sign-in, so Sotto could not read the pull request. Nothing was lost. Try again in a few minutes.")
                next = .limited(words)
            }
        } catch {
            next = .failed(failureWords(error))
        }
        // A refresh that could not read it keeps what the sheet shows, and says why above the dock.
        if case .shown = phase {
            switch next {
            case .limited(let words), .failed(let words): model.feedback = words; return
            default: break
            }
        }
        phase = next
    }
    private func failureWords(_ error: Error) -> String {
        if let refusal = error as? HostRefusal, refusal.failure.code == "unavailable" {
            return PullRequests.readFailureWords(reason: refusal.failure.reason, computer: model.name(ref.hostID))
        }
        return error.localizedDescription
    }
}

/// The parts of the sheet the jump chips go to.
enum PullRequestPart: String, CaseIterable, Identifiable {
    case summary, checks, reviews, files
    var id: String { rawValue }
    var title: String {
        switch self {
        case .summary: return String(localized: "Summary", comment: "A part of a pull request: its description.")
        case .checks: return String(localized: "Checks", comment: "A part of a pull request: its CI checks.")
        case .reviews: return String(localized: "Reviews", comment: "A part of a pull request: its reviews.")
        case .files: return String(localized: "Files", comment: "A part of a pull request: the files it changes.")
        }
    }
    /// Whether the part holds something that failed: a failing check, or a request for changes.
    func flagged(_ detail: PullRequestDetail) -> Bool {
        switch self {
        case .checks: return detail.checks.contains { PullRequests.tone(ofCheck: $0.status) == .failing }
        case .reviews: return detail.reviewDecision == "changes_requested"
        case .summary, .files: return false
        }
    }
    /// The jump chip's name for VoiceOver when the part holds something that failed.
    var flaggedTitle: String {
        switch self {
        case .checks: return String(localized: "Checks, a check failed", comment: "VoiceOver name of a pull request’s Checks chip when a check failed.")
        case .reviews: return String(localized: "Reviews, changes requested", comment: "VoiceOver name of a pull request’s Reviews chip when a reviewer asked for changes.")
        case .summary, .files: return title
        }
    }
}

/// Where each part's top sits in the sheet's scroll.
private struct PartTops: PreferenceKey {
    static var defaultValue: [PullRequestPart: CGFloat] = [:]
    static func reduce(value: inout [PullRequestPart: CGFloat], nextValue: () -> [PullRequestPart: CGFloat]) {
        value.merge(nextValue()) { $1 }
    }
}

// MARK: - The pull request

/// The pull request as one page: its header, where it stands, then each part.
private struct PullRequestBody: View {
    static let space = "pull-request-sheet"
    let ref: ThreadRef
    let detail: PullRequestDetail
    @State private var showPassed = false
    var body: some View {
        VStack(alignment: .leading, spacing: Space.s5) {
            heading
            standing
            part(.summary, aside: nil) { summary }
            part(.checks, aside: PullRequests.rollup(detail.checks)) { checks }
            part(.reviews, aside: PullRequests.reviewLine(detail).title) { reviews }
            part(.files, aside: fileAside) { files }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var heading: some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            HStack(spacing: Space.s2) {
                StatePill(state: detail.shownState)
                Text("#\(String(detail.number))").font(.sotto(.small, .semibold)).foregroundStyle(Palette.muted)
            }
            .accessibilityElement(children: .combine)
            Text(verbatim: detail.title)
                .font(.sotto(.title, .bold)).headingTracking(-0.4)
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("pull-request-title")
            if !detail.headBranch.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.triangle.branch").font(.system(size: 11, weight: .semibold)).accessibilityHidden(true)
                    BranchName(name: detail.headBranch)
                    Text("into", comment: "Between two branch names, as in: feature-branch into main.")
                    BranchName(name: detail.baseBranch)
                }
                .font(.sotto(.caption))
                .foregroundStyle(Palette.muted)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Branch \(Interface.isolated(detail.headBranch)) into \(Interface.isolated(detail.baseBranch))")
            }
        }
    }

    private var standing: some View {
        let lines = [PullRequests.checksLine(detail), PullRequests.reviewLine(detail), PullRequests.mergeLine(detail)]
        return VStack(spacing: 0) {
            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                if index > 0 { Hairline() }
                HStack(alignment: .top, spacing: Space.s3) {
                    ToneMark(tone: line.tone, size: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(line.title).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink)
                        Text(line.detail).font(.sotto(.small)).foregroundStyle(Palette.muted)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, Space.s4).padding(.vertical, Space.s3)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("pull-request-standing-\(index)")
            }
        }
        .sottoCard(.plain)
    }

    private func part<Content: View>(_ which: PullRequestPart, aside: String?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: Space.s2) {
            HStack(alignment: .firstTextBaseline, spacing: Space.s2) {
                Text(which.title).font(.sotto(.small, .semibold)).foregroundStyle(Palette.muted)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: Space.s2)
                if let aside { Text(aside).font(.sotto(.caption)).foregroundStyle(Palette.muted).multilineTextAlignment(.trailing) }
            }
            .padding(.horizontal, Space.s1)
            content()
        }
        .id(which)
        .background(alignment: .top) {
            GeometryReader { proxy in
                Color.clear.preference(key: PartTops.self, value: [which: proxy.frame(in: .named(Self.space)).minY])
            }
        }
    }

    // MARK: Summary

    @ViewBuilder private var summary: some View {
        let description = detail.body.trimmingCharacters(in: .whitespacesAndNewlines)
        Group {
            if description.isEmpty {
                Text("It has no description.").font(.sotto(.body)).foregroundStyle(Palette.muted)
                    .paragraphDirection()
            } else {
                MarkdownText(text: description).equatable().foregroundStyle(Palette.ink)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Space.s4)
        .sottoCard(.plain)
    }

    // MARK: Checks

    @ViewBuilder private var checks: some View {
        let ordered = PullRequests.ordered(detail.checks)
        let notPassed = ordered.filter { PullRequests.tone(ofCheck: $0.status) != .passed }
        let passed = ordered.count - notPassed.count
        // The passed checks fold away while any is not passed; with all passed, they are the list.
        let folds = !notPassed.isEmpty && passed > 0
        let shown = folds && !showPassed ? notPassed : ordered
        if detail.checks.isEmpty {
            Note(words: PullRequests.checksLine(detail).detail)
        } else {
            VStack(spacing: 0) {
                ForEach(Array(shown.enumerated()), id: \.offset) { index, check in
                    if index > 0 { Hairline() }
                    CheckRow(check: check)
                }
                if folds {
                    Hairline()
                    Button {
                        showPassed.toggle()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: showPassed ? "chevron.up" : "chevron.down").font(.system(size: 11, weight: .bold)).accessibilityHidden(true)
                            (showPassed ? Text("Hide passed checks") : passed == 1 ? Text("Show 1 passed", comment: "Shows the one check that passed.") : Text("Show \(passed) passed", comment: "Shows the checks that passed; the number counts them."))
                        }
                        .font(.sotto(.small, .semibold))
                        .foregroundStyle(Palette.accentText)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .padding(.horizontal, Space.s4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(PressStyle())
                    .accessibilityIdentifier("pull-request-passed-checks")
                }
                if detail.checksUnknown { Hairline(); Note(words: String(localized: "GitHub did not let Sotto read every check."), inCard: true) }
            }
            .sottoCard(.plain)
        }
    }

    // MARK: Reviews

    @ViewBuilder private var reviews: some View {
        if detail.reviews.isEmpty {
            Note(words: detail.draft ? String(localized: "Nobody has reviewed it. Reviewers wait until it is ready.") : String(localized: "Nobody has reviewed it yet."))
        } else {
            VStack(spacing: 0) {
                // The newest review first.
                ForEach(Array(detail.reviews.reversed().enumerated()), id: \.offset) { index, review in
                    if index > 0 { Hairline() }
                    ReviewRow(review: review)
                }
            }
            .sottoCard(.plain)
        }
    }

    // MARK: Files

    private var fileAside: String? {
        guard let files = detail.files, let count = PullRequests.fileCount(detail) else { return nil }
        let added = files.reduce(0) { $0 + $1.additions }, removed = files.reduce(0) { $0 + $1.deletions }
        return "\(count), +\(added) −\(removed)"
    }

    @ViewBuilder private var files: some View {
        if let files = detail.files {
            if files.isEmpty {
                Note(words: String(localized: "It changes no files."))
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(PullRequests.ordered(files).enumerated()), id: \.offset) { index, file in
                        if index > 0 { Hairline() }
                        FileRow(file: file)
                    }
                    if let total = detail.changedFiles, total > files.count {
                        Hairline()
                        Note(words: String(localized: "GitHub listed \(files.count) of its \(Self.fileWords(total)). Open it on GitHub for the rest.", comment: "%lld is how many files GitHub listed; %@ counts all the files, such as “40 files”."), inCard: true)
                    }
                }
                .sottoCard(.plain)
            }
        } else {
            Note(words: String(localized: "GitHub did not list the changed files. Open it on GitHub to see them."))
        }
    }

    /// All of a pull request's files, counted: "1 file", "40 files".
    private static func fileWords(_ total: Int) -> String {
        total == 1 ? String(localized: "1 file") : String(localized: "\(total) files")
    }
}

// MARK: - Rows and marks

private struct CheckRow: View {
    @Environment(\.openURL) private var openURL
    let check: PullRequestDetail.Check
    var body: some View {
        let tone = PullRequests.tone(ofCheck: check.status)
        let link = PullRequests.openable(check.url)
        let row = HStack(spacing: Space.s3) {
            ToneMark(tone: tone, size: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: check.name).font(.sotto(.body)).foregroundStyle(Palette.ink).lineLimit(2)
                if let description = check.description, !description.isEmpty {
                    Text(description).font(.sotto(.caption)).foregroundStyle(Palette.muted).lineLimit(2)
                }
            }
            Spacer(minLength: Space.s2)
            if let duration = PullRequests.duration(check) {
                Text(duration).font(.sotto(.caption)).monospacedDigit().foregroundStyle(Palette.muted)
            }
            if link != nil {
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .bold)).foregroundStyle(Palette.muted).accessibilityHidden(true)
            }
        }
        .padding(.horizontal, Space.s4).padding(.vertical, Space.s2)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        let words = [check.name, PullRequests.checkWord(check.status), PullRequests.spokenDuration(check)].compactMap { $0 }.joined(separator: ", ")
        if let link {
            Button { openURL(link) } label: { row }
                .buttonStyle(PressStyle())
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(words)
                .accessibilityHint("Opens the check on GitHub.")
                .accessibilityIdentifier("pull-request-check")
                .accessibilityAddTraits(.isLink)
        } else {
            row.accessibilityElement(children: .ignore).accessibilityLabel(words).accessibilityIdentifier("pull-request-check")
        }
    }
}

private struct ReviewRow: View {
    @Environment(\.openURL) private var openURL
    let review: PullRequestDetail.Review
    var body: some View {
        let approved = review.state == "approved"
        let link = PullRequests.openable(review.url)
        let words = approved ? String(localized: "Approved", comment: "A pull request review that approved it.") : String(localized: "Asked for changes", comment: "A pull request review that asked for changes.")
        let spoken = approved ? String(localized: "\(review.author), approved", comment: "VoiceOver name of a review; %@ is the reviewer’s GitHub name.")
            : String(localized: "\(review.author), asked for changes", comment: "VoiceOver name of a review; %@ is the reviewer’s GitHub name.")
        let row = HStack(spacing: Space.s3) {
            ToneMark(tone: approved ? .passed : .failing, size: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: review.author).font(.sotto(.body)).foregroundStyle(Palette.ink).lineLimit(1)
                Text(words).font(.sotto(.caption)).foregroundStyle(Palette.muted)
            }
            Spacer(minLength: Space.s2)
            if link != nil {
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .bold)).foregroundStyle(Palette.muted).accessibilityHidden(true)
            }
        }
        .padding(.horizontal, Space.s4).padding(.vertical, Space.s2)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        if let link {
            Button { openURL(link) } label: { row }
                .buttonStyle(PressStyle())
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(spoken)
                .accessibilityHint("Opens the review on GitHub.")
                .accessibilityAddTraits(.isLink)
        } else {
            row.accessibilityElement(children: .ignore).accessibilityLabel(spoken)
        }
    }
}

private struct FileRow: View {
    let file: PullRequestDetail.File
    var body: some View {
        HStack(spacing: Space.s3) {
            Image(systemName: "doc").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.muted).frame(width: 18).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.name).font(.system(.subheadline, design: .monospaced)).foregroundStyle(Palette.ink).lineLimit(1).truncationMode(.middle)
                Text(file.folder ?? String(localized: "The top folder")).font(.sotto(.caption)).foregroundStyle(Palette.muted).lineLimit(1).truncationMode(.head)
            }
            Spacer(minLength: Space.s2)
            HStack(spacing: 6) {
                Text("+\(file.additions)").foregroundStyle(Palette.accentText)
                Text("−\(file.deletions)").foregroundStyle(Palette.dangerText)
            }
            .font(.sotto(.caption, .semibold)).monospacedDigit()
            .fixedSize()
        }
        .padding(.horizontal, Space.s4).padding(.vertical, Space.s2)
        .frame(minHeight: 52)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(Interface.isolated(file.path)), \(file.additions) added, \(file.deletions) removed")
    }
}

/// A line's mark, in the colour of how it stands.
struct ToneMark: View {
    let tone: PullRequests.Tone
    var size: CGFloat = 18
    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(color)
            .frame(width: size + 2)
            .accessibilityHidden(true)
    }
    private var symbol: String {
        switch tone {
        case .failing: return "xmark.circle"
        case .running: return "clock"
        case .passed: return "checkmark.circle"
        case .quiet: return "minus.circle"
        }
    }
    private var color: ThemeRole {
        switch tone {
        case .failing: return Palette.dangerText
        case .running: return Palette.warningText
        case .passed: return Palette.accentText
        case .quiet: return Palette.muted
        }
    }
}

/// The chip's dot for the checks: failing, running or passed.
struct ChecksDot: View {
    let tone: PullRequests.Tone
    var body: some View {
        Circle().fill(color).frame(width: 7, height: 7).accessibilityHidden(true)
    }
    private var color: ThemeRole {
        switch tone {
        case .failing: return Palette.danger
        case .running: return Palette.warning
        case .passed: return Palette.accent
        case .quiet: return Palette.muted
        }
    }
}

/// Open, Draft, Merged or Closed, in the pill the prototype draws.
private struct StatePill: View {
    let state: String
    @Environment(\.sottoTheme) private var theme
    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: state == "merged" ? "arrow.triangle.merge" : "arrow.triangle.pull").font(.system(size: 11, weight: .bold)).accessibilityHidden(true)
            Text(word)
        }
        .font(.sotto(.caption, .bold))
        .foregroundStyle(foreground)
        .padding(.horizontal, 9)
        .frame(minHeight: 24)
        .background(Capsule().fill(fill))
        .accessibilityLabel(word)
    }
    private var word: String {
        switch state {
        case "draft": return String(localized: "Draft", comment: "A pull request’s state: a draft.")
        case "merged": return String(localized: "Merged", comment: "A pull request’s state: merged.")
        case "closed": return String(localized: "Closed", comment: "A pull request’s state: closed without merging.")
        default: return String(localized: "Open", comment: "A pull request’s state: open.")
        }
    }
    private var foreground: Color {
        switch state {
        case "merged": return theme.color(.onAccent)
        case "closed": return theme.color(.dangerText)
        case "draft": return theme.color(.muted)
        default: return theme.color(.accentText)
        }
    }
    private var fill: Color {
        switch state {
        case "merged": return theme.color(.accent)
        case "closed": return theme.color(.danger).opacity(0.14)
        case "draft": return theme.color(.fillSoft)
        default: return theme.color(.accent).opacity(0.16)
        }
    }
}

private struct BranchName: View {
    let name: String
    var body: some View {
        Text(verbatim: name)
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(Palette.ink)
            .lineLimit(1).truncationMode(.middle)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Palette.fillSoft, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

private struct Hairline: View {
    var body: some View { Rectangle().fill(Palette.hairline).frame(height: 1).padding(.leading, 48).accessibilityHidden(true) }
}

/// A quiet sentence where a part has nothing to list, on its own card or inside one.
private struct Note: View {
    let words: String
    var inCard = false
    var body: some View {
        let text = Text(words).font(.sotto(.small)).foregroundStyle(Palette.muted)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, Space.s4).padding(.vertical, Space.s3)
            .paragraphDirection()
        if inCard { text } else { text.sottoCard(.plain) }
    }
}

// MARK: - Babysitting

/// Babysitting docked at the bottom of the sheet (ADR-0061): Babysit pull request, or the line with Stop babysitting,
/// on a computer that offers it; nothing to babysit once it merged or closed.
private struct BabysitDock: View {
    @EnvironmentObject var model: AppModel
    let ref: ThreadRef
    let detail: PullRequestDetail
    @Binding var toast: String?
    @State private var pressing = false
    @State private var presses = 0

    var body: some View {
        if model.offersBabysitting(ref.hostID) {
            let marks = model.babysitting(ref)
            let state = PullRequests.babysitState(babysitting: marks.current, ended: marks.ended, detail: detail,
                                                  agent: Words.provider(model.thread(ref)?.providerId))
            card(state)
        }
    }

    @ViewBuilder private func card(_ state: PullRequests.BabysitState) -> some View {
        let waiting = pressing || model.babysitPress(ref) != nil
        let shape = RoundedRectangle(cornerRadius: Radius.lg, style: .continuous)
        VStack(alignment: .leading, spacing: Space.s3) {
            switch state {
            case .babysitting(let title, let words):
                line(icon: "alarm", tone: .passed, title: title, words: words)
                Button { press(false) } label: { (waiting ? Text("Stopping…") : Text("Stop babysitting")).frame(maxWidth: .infinity) }
                    .buttonStyle(PillButtonStyle(kind: .soft, wide: true))
                    .disabled(waiting || !model.canChangeBabysitting(ref))
                    .accessibilityLabel("Stop babysitting #\(String(detail.number))")
                    .accessibilityIdentifier("stop-babysitting")
            case .offered(let words):
                line(icon: "alarm", tone: .quiet, title: nil, words: words)
                Button { press(true) } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "alarm").accessibilityHidden(true)
                        (waiting ? Text("Starting…", comment: "Babysitting a pull request is starting.") : Text("Babysit pull request"))
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(PillButtonStyle(kind: .primary, wide: true))
                .disabled(waiting || !model.canChangeBabysitting(ref))
                .accessibilityLabel("Babysit pull request #\(String(detail.number))")
                .accessibilityIdentifier("babysit-pull-request")
            case .finished(let title, let words):
                line(icon: "alarm", tone: .quiet, title: title, words: words)
            }
        }
        .padding(.horizontal, Space.s4).padding(.vertical, Space.s3)
        .glass(in: shape, strong: true)
        .sensoryFeedback(.impact(weight: .medium), trigger: presses)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("pull-request-babysit")
    }

    private func line(icon: String, tone: PullRequests.Tone, title: String?, words: String) -> some View {
        HStack(alignment: .top, spacing: Space.s3) {
            Image(systemName: icon).font(.system(size: 17, weight: .semibold))
                .foregroundStyle(tone == .passed ? Palette.accentText : Palette.muted)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                if let title { Text(title).font(.sotto(.body, .semibold)).foregroundStyle(Palette.ink) }
                Text(words).font(.sotto(.small)).foregroundStyle(Palette.muted)
                    .paragraphDirection()
            }
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    private func press(_ on: Bool) {
        guard !pressing else { return }
        presses += 1
        pressing = true
        Task {
            await model.setBabysitting(on, url: detail.url, in: ref)
            pressing = false
            let key = PullRequests.key(detail.url)
            let now = model.babysitting(ref).current.contains { PullRequests.key($0.url) == key }
            // Said only once the computer's thread agrees; a refusal shows above as feedback instead.
            if now == on { toast = on ? String(localized: "Babysitting #\(String(detail.number))", comment: "%@ is the pull request’s number.") : String(localized: "Stopped babysitting #\(String(detail.number))", comment: "%@ is the pull request’s number.") }
        }
    }
}
