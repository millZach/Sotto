import UIKit
import UniformTypeIdentifiers
import SottoCore

/// Share to Sotto (ADR-0157): takes what the share sheet hands over, writes it to the App Group's inbox and opens Sotto,
/// which puts it in Watcher's box. Nothing leaves this iPhone here; the app sends it only when the user presses Send.
final class ShareViewController: UIViewController {
    private let label = UILabel()
    private let done = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0.25)
        let card = UIView()
        card.backgroundColor = .secondarySystemBackground
        card.layer.cornerRadius = 20
        card.layer.cornerCurve = .continuous
        label.text = ShareWords.saving
        label.numberOfLines = 0
        label.textAlignment = .center
        label.font = .preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        done.setTitle(ShareWords.done, for: .normal)
        done.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        done.isHidden = true
        done.addAction(UIAction { [weak self] _ in self?.finish() }, for: .primaryActionTriggered)
        let stack = UIStackView(arrangedSubviews: [label, done])
        stack.axis = .vertical; stack.spacing = 12
        for item in [card, stack] { item.translatesAutoresizingMaskIntoConstraints = false }
        card.addSubview(stack); view.addSubview(card)
        NSLayoutConstraint.activate([
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor), card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.widthAnchor.constraint(lessThanOrEqualToConstant: 320),
            card.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 20), stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -20),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 20), stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -20),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Task { await share() }
    }

    private func share() async {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: ShareInbox.appGroup) else {
            return show(ShareWords.failed)
        }
        let share = ShareInbox.folder(in: container).appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: share, withIntermediateDirectories: true)
            var words: [String] = [], files: [String] = []
            for provider in providers {
                guard let kind = SharedItemKind(types: provider.registeredTypeIdentifiers, suggestedName: provider.suggestedName) else { continue }
                switch kind {
                case .words:
                    if let text = await Self.words(provider), !text.isEmpty, !words.contains(text) { words.append(text) }
                case .photo(let type), .file(let type):
                    guard files.count < ShareInbox.itemsMax else { continue }
                    let fallback = kind == .photo(type) ? "Shared photo" : "Shared file"
                    let name = ShareInbox.safeName(SharedItemKind.name(provider.suggestedName, type: type, fallback: fallback), taken: Set(files))
                    if (try? await Self.copy(provider, type: type, to: share.appendingPathComponent(name))) != nil { files.append(name) }
                }
            }
            guard !words.isEmpty || !files.isEmpty else {
                try? FileManager.default.removeItem(at: share)
                return show(ShareWords.nothing)
            }
            // Written last: a folder without it is a share still being written.
            try ShareInbox.write(ShareInbox.Manifest(words: words.joined(separator: "\n"), files: files, sharedAt: Date()), to: share)
        } catch {
            try? FileManager.default.removeItem(at: share)
            return show(ShareWords.failed)
        }
        if await openSotto() { finish() } else { show(ShareWords.openSotto) }
    }

    private func show(_ words: String) {
        label.text = words
        done.isHidden = false
    }

    private func finish() { extensionContext?.completeRequest(returningItems: nil) }

    /// The share extension has no `UIApplication.shared`; the app it belongs to is found up the responder chain. When iOS
    /// declines, the share waits in the inbox and Sotto takes it the next time it comes forward.
    private func openSotto() async -> Bool {
        var responder: UIResponder? = self
        while let current = responder {
            if let application = current as? UIApplication { return await application.open(ShareInbox.openURL) }
            responder = current.next
        }
        return false
    }

    private static func words(_ provider: NSItemProvider) async -> String? {
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
           let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
            return url.absoluteString
        }
        guard provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) else { return nil }
        let item = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier)
        return ((item as? String) ?? (item as? Data).flatMap { String(data: $0, encoding: .utf8) })?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Copies the item's file as it came, without holding it all in memory: an extension has little.
    private static func copy(_ provider: NSItemProvider, type: String, to destination: URL) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                guard let url else { return continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown)) }
                continuation.resume(with: Result { try FileManager.default.copyItem(at: url, to: destination) })
            }
        }
    }
}
