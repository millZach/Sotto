import Foundation

/// An agent's pictures in its steps (ADR-0170, pictures in steps; Zach's pick A on
/// the prototype tagged prototype/pictures-in-steps, November 9, 2026). A step's pictures sit small at the end of its line,
/// the newest three with a count for the rest, and a folded run's line shows the newest of all its steps'. Only the pictures
/// an agent showed through `sotto_media`, and an image the user asked it to make, stand in the thread as tiles.
public enum StepPictures {
    /// How many of a line's pictures it shows before a count stands for the rest.
    public static let most = 3
    /// The ID every step an agent showed pictures in through `sotto_media` starts with, as the desktop's `SHOWN_STEP_PREFIX`.
    public static let shownStepPrefix = "sotto-shown-"
    /// The ID of the step that holds a turn's written files, as the desktop's `WRITTEN_STEP_PREFIX`.
    public static let writtenStepPrefix = "sotto-written-"

    /// One picture or video in a step, with the step it belongs to.
    public struct Item: Identifiable, Equatable, Sendable {
        public let step: Activity
        public let media: Activity.Media
        public var id: String { step.id + "/" + media.id }
    }

    /// Whether a step's pictures stand in the thread as tiles rather than in its line.
    public static func standInThread(_ step: Activity) -> Bool {
        step.id.hasPrefix(shownStepPrefix) || step.generates == "image"
    }

    /// The pictures and videos of these steps that sit in their lines, oldest first: in the order the steps came, and within
    /// a step in the order it made them. A turn's written files arrive newest first, so they are turned round.
    public static func inSteps(_ steps: [Activity]) -> [Item] {
        steps.flatMap { step -> [Item] in
            guard !standInThread(step) else { return [] }
            let media = step.id.hasPrefix(writtenStepPrefix) ? Array((step.media ?? []).reversed()) : (step.media ?? [])
            return media.map { Item(step: step, media: $0) }
        }
    }

    /// The steps whose pictures stand in the thread as tiles, and the steps still making an image.
    public static func inThread(_ steps: [Activity]) -> [Activity] {
        steps.filter(standInThread)
    }

    /// What a line shows of its pictures, in order, and what its count stands for. The newest `most` show, but a video comes
    /// before a picture: the viewer reaches every picture of the line from any of them, and a video only from its own mark.
    public static func line(_ items: [Item]) -> (shown: [Item], hidden: [Item]) {
        guard items.count > most else { return (items, []) }
        var kept = Set<String>()
        for item in items.reversed() where item.media.kind == "video" && kept.count < most { kept.insert(item.id) }
        for item in items.reversed() where kept.count < most { kept.insert(item.id) }
        return (items.filter { kept.contains($0.id) }, items.filter { !kept.contains($0.id) })
    }
}
