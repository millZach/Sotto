/// What a reply box holds while the user dictates into it on the iPhone (ADR-0174): the words it held when listening
/// started, then everything heard since, with one space between them where neither side brings its own. The recognizer
/// sends the whole of what it has heard each time, revised as it goes, so each result replaces the last one's words
/// rather than adding to them.
public enum DictatedWords {
    public static func join(_ before: String, _ heard: String) -> String {
        guard !heard.isEmpty else { return before }
        guard let last = before.last else { return heard }
        if last.isWhitespace || heard.first?.isWhitespace == true { return before + heard }
        return before + " " + heard
    }
}
