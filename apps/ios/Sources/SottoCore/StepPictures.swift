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

    /// The pictures and videos of these steps that sit in their lines, in the order the steps came.
    public static func inSteps(_ steps: [Activity]) -> [Item] {
        steps.flatMap { step in standInThread(step) ? [] : (step.media ?? []).map { Item(step: step, media: $0) } }
    }

    /// The steps whose pictures stand in the thread as tiles, and the steps still making an image.
    public static func inThread(_ steps: [Activity]) -> [Activity] {
        steps.filter(standInThread)
    }

    /// What a line shows of its pictures: the newest `most`, oldest first, and how many earlier ones its count stands for.
    public static func newest(_ items: [Item]) -> (shown: [Item], more: Int) {
        let shown = Array(items.suffix(most))
        return (shown, items.count - shown.count)
    }
}
