import Foundation

/// One block of a message as the thread page draws it. Inline Markdown (emphasis, code spans, links) stays inside each
/// block, so a stray backtick or asterisk can reach no further than the block it is in.
public enum MarkdownBlock: Equatable, Sendable {
    /// `#` through `######`. A paragraph that is only bold text reads as a heading of level 4.
    case heading(level: Int, text: MarkdownInline)
    case paragraph(MarkdownInline)
    /// A run of list items; a nested item has a greater depth.
    case list([MarkdownListItem])
    /// A fenced code block and the language its fence named. Nothing inside it is read as Markdown.
    case code(language: String?, text: String)
    case quote(MarkdownInline)
    case rule
}

/// One item of a list, with its own marker so a nested list may be numbered under bullets.
public struct MarkdownListItem: Equatable, Sendable {
    public enum Marker: Equatable, Sendable {
        case bullet
        /// The number as written, so a list that starts at 3 reads 3, 4, 5.
        case number(Int)
    }
    public let marker: Marker
    /// 0 for a top-level item, 1 for one nested under it, and so on.
    public let depth: Int
    public let text: MarkdownInline
    public init(marker: Marker, depth: Int, text: MarkdownInline) {
        self.marker = marker
        self.depth = depth
        self.text = text
    }
}

/// A block's inline Markdown, with every key chord that ends in a backtick (Ctrl+`, Cmd+Shift+`) set aside first: each
/// is replaced by one private-use character, so its backtick can never open a code span, and put back as a key once
/// the inline Markdown has been read.
public struct MarkdownInline: Equatable, Sendable {
    /// The inline Markdown with each key chord replaced by `placeholder(index)`.
    public let source: String
    /// The key chords, in the order their placeholders appear.
    public let keys: [String]

    public init(_ text: String) {
        let aside = KeyChords.setAside(text)
        source = aside.source
        keys = aside.keys
    }

    /// The text as written, key chords back in place.
    public var text: String {
        var restored = source
        for (index, key) in keys.enumerated() {
            restored = restored.replacingOccurrences(of: Self.placeholder(index), with: key)
        }
        return restored
    }

    /// The character that stands for the key chord at `index`.
    public static func placeholder(_ index: Int) -> String {
        guard let scalar = Unicode.Scalar(UInt32(0xE000 + index)) else { return "" }
        return String(Character(scalar))
    }

    /// The inline Markdown as Foundation reads it, each key chord back in place and marked with `KeyChordAttribute`.
    /// Plain text, chords still marked, when it doesn't parse.
    public func attributed() -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        var result = (try? AttributedString(markdown: source, options: options)) ?? AttributedString(source)
        for (index, key) in keys.enumerated() {
            guard let range = result.range(of: Self.placeholder(index)) else { continue }
            var chord = AttributedString(key)
            // The chord keeps what surrounds it, such as bold, and is marked as a key.
            if let run = result[range].runs.first { chord.mergeAttributes(run.attributes) }
            var mark = AttributeContainer()
            mark[KeyChordAttribute.self] = true
            chord.mergeAttributes(mark)
            result.replaceSubrange(range, with: chord)
        }
        return result
    }
}

/// Marks a key chord such as Ctrl+` in a block's inline text, so the view draws it as a key.
public enum KeyChordAttribute: AttributedStringKey {
    public typealias Value = Bool
    public static let name = "SottoKeyChord"
}

/// Finds key chords that end in a backtick: one or more modifier names joined by `+`, then the backtick key.
enum KeyChords {
    static let modifiers: Set<String> = ["ctrl", "control", "cmd", "command", "mod", "alt", "opt", "option", "shift", "meta"]
    /// Placeholders come from the private-use area; past this many chords the rest are left as written.
    static let limit = 0x1000

    static func setAside(_ text: String) -> (source: String, keys: [String]) {
        guard text.contains("`") else { return (text, []) }
        // Text that already carries private-use characters keeps its chords, so nothing can be mistaken for one.
        if text.unicodeScalars.contains(where: { $0.value >= 0xE000 && $0.value < 0xE000 + UInt32(limit) }) { return (text, []) }
        let chars = Array(text)
        var spans: [(start: Int, end: Int)] = []
        var index = 2
        while index < chars.count {
            if chars[index] == "`", chars[index - 1] == "+", spans.count < limit, let start = chordStart(chars, plus: index - 1) {
                let clear = spans.last.map { start > $0.end } ?? true
                if clear { spans.append((start: start, end: index)) }
            }
            index += 1
        }
        guard !spans.isEmpty else { return (text, []) }
        var source = ""
        var keys: [String] = []
        var cursor = 0
        for span in spans {
            source.append(contentsOf: chars[cursor..<span.start])
            keys.append(String(chars[span.start...span.end]))
            source.append(MarkdownInline.placeholder(keys.count - 1))
            cursor = span.end + 1
        }
        source.append(contentsOf: chars[cursor..<chars.count])
        return (source, keys)
    }

    /// Where the chord whose last `+` is at `plus` begins, or nil when no modifier name comes before it.
    static func chordStart(_ chars: [Character], plus: Int) -> Int? {
        var plus = plus
        var start: Int?
        while true {
            var cursor = plus - 1
            while cursor >= 0 && chars[cursor].isLetter { cursor -= 1 }
            let word = String(chars[(cursor + 1)..<plus]).lowercased()
            guard !word.isEmpty, modifiers.contains(word) else { break }
            start = cursor + 1
            if cursor >= 1 && chars[cursor] == "+" { plus = cursor } else { break }
        }
        guard let found = start else { return nil }
        if found > 0 {
            let before = chars[found - 1]
            if before.isLetter || before.isNumber || before == "_" { return nil }
        }
        return found
    }
}

/// Splits a message into blocks. Line endings may be `\n`, `\r\n` or `\r`.
public enum Markdown {
    public static func blocks(_ text: String) -> [MarkdownBlock] {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        let lines = normalized.components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            if paragraph.count == 1, let inner = MarkdownLine.boldOnly(paragraph[0]) {
                blocks.append(.heading(level: 4, text: MarkdownInline(inner)))
            } else {
                blocks.append(.paragraph(MarkdownInline(paragraph.joined(separator: "\n"))))
            }
            paragraph = []
        }

        var index = 0
        while index < lines.count {
            let line = lines[index]
            if let fence = MarkdownLine.fence(line) {
                flushParagraph()
                var body: [String] = []
                index += 1
                // An unclosed fence runs to the end of the message, as it does while an agent is still writing it.
                while index < lines.count && !MarkdownLine.closes(lines[index], fence) {
                    body.append(MarkdownLine.dropIndent(lines[index], upTo: fence.indent))
                    index += 1
                }
                index += 1
                while let last = body.last, MarkdownLine.isBlank(last) { body.removeLast() }
                blocks.append(.code(language: fence.language, text: body.joined(separator: "\n")))
                continue
            }
            if MarkdownLine.isBlank(line) {
                flushParagraph()
                index += 1
                continue
            }
            if let heading = MarkdownLine.heading(line) {
                flushParagraph()
                blocks.append(.heading(level: heading.level, text: MarkdownInline(heading.text)))
                index += 1
                continue
            }
            if MarkdownLine.isRule(line) {
                flushParagraph()
                blocks.append(.rule)
                index += 1
                continue
            }
            if let first = MarkdownLine.quote(line) {
                flushParagraph()
                var parts = [first]
                index += 1
                while index < lines.count, let next = MarkdownLine.quote(lines[index]) {
                    parts.append(next)
                    index += 1
                }
                blocks.append(.quote(MarkdownInline(parts.joined(separator: "\n"))))
                continue
            }
            if MarkdownLine.listItem(line) != nil {
                flushParagraph()
                let list = parseList(lines, from: index)
                blocks.append(.list(list.items))
                index = list.next
                continue
            }
            paragraph.append(line.trimmingCharacters(in: .whitespaces))
            index += 1
        }
        flushParagraph()
        return blocks
    }

    /// Reads list items from `start` until something that isn't one of them, and says where that is.
    static func parseList(_ lines: [String], from start: Int) -> (items: [MarkdownListItem], next: Int) {
        var items: [(marker: MarkdownListItem.Marker, depth: Int, lines: [String])] = []
        var indents: [Int] = []
        var baseIndent = 0
        var blankBefore = false
        var index = start
        while index < lines.count {
            let line = lines[index]
            if MarkdownLine.isBlank(line) {
                blankBefore = true
                index += 1
                continue
            }
            if MarkdownLine.isRule(line) || MarkdownLine.fence(line) != nil || MarkdownLine.heading(line) != nil || MarkdownLine.quote(line) != nil { break }
            if let item = MarkdownLine.listItem(line) {
                if let first = items.first {
                    // A top-level item of the other kind starts a list of its own.
                    if item.indent <= baseIndent && isNumbered(item.marker) != isNumbered(first.marker) { break }
                } else {
                    baseIndent = item.indent
                }
                let depth = Self.depth(for: item.indent, in: &indents)
                items.append((marker: item.marker, depth: depth, lines: [item.text]))
                blankBefore = false
                index += 1
                continue
            }
            // A line under an item continues it when it is indented, or comes straight after it.
            if !items.isEmpty && (MarkdownLine.indent(line) > 0 || !blankBefore) {
                items[items.count - 1].lines.append(line.trimmingCharacters(in: .whitespaces))
                blankBefore = false
                index += 1
                continue
            }
            break
        }
        let read = items.map { MarkdownListItem(marker: $0.marker, depth: $0.depth, text: MarkdownInline($0.lines.joined(separator: "\n"))) }
        return (read, index)
    }

    static func isNumbered(_ marker: MarkdownListItem.Marker) -> Bool {
        if case .number = marker { return true }
        return false
    }

    /// The depth of an item indented by `indent`, given the indents of the levels open above it.
    static func depth(for indent: Int, in indents: inout [Int]) -> Int {
        while let last = indents.last, indent < last { indents.removeLast() }
        if let last = indents.last, indent == last { return min(indents.count - 1, 6) }
        indents.append(indent)
        return min(indents.count - 1, 6)
    }
}

/// How one line of a message reads.
enum MarkdownLine {
    struct Fence {
        let marker: Character
        let length: Int
        let indent: Int
        let language: String?
    }

    struct Item {
        let indent: Int
        let marker: MarkdownListItem.Marker
        let text: String
    }

    /// Leading spaces, a tab counting as four.
    static func indent(_ line: String) -> Int {
        var count = 0
        for character in line {
            if character == " " { count += 1 } else if character == "\t" { count += 4 } else { break }
        }
        return count
    }

    static func isBlank(_ line: String) -> Bool { line.trimmingCharacters(in: .whitespaces).isEmpty }

    static func content(_ line: String) -> Substring { line.drop(while: { $0 == " " || $0 == "\t" }) }

    static func fence(_ line: String) -> Fence? {
        let rest = content(line)
        guard let mark = rest.first, mark == "`" || mark == "~" else { return nil }
        let length = rest.prefix(while: { $0 == mark }).count
        guard length >= 3 else { return nil }
        let info = rest.dropFirst(length).trimmingCharacters(in: .whitespaces)
        // A backtick fence's info can't hold a backtick; such a line is inline code, not a fence.
        if mark == "`" && info.contains("`") { return nil }
        let language = info.split(separator: " ").first.map { String($0) }
        return Fence(marker: mark, length: length, indent: indent(line), language: language)
    }

    static func closes(_ line: String, _ fence: Fence) -> Bool {
        let rest = content(line)
        let length = rest.prefix(while: { $0 == fence.marker }).count
        return length >= fence.length && rest.dropFirst(length).trimmingCharacters(in: .whitespaces).isEmpty
    }

    static func dropIndent(_ line: String, upTo count: Int) -> String {
        var removed = 0
        var position = line.startIndex
        while removed < count && position < line.endIndex && line[position] == " " {
            removed += 1
            position = line.index(after: position)
        }
        return String(line[position...])
    }

    static func heading(_ line: String) -> (level: Int, text: String)? {
        guard indent(line) <= 3 else { return nil }
        let rest = content(line)
        let level = rest.prefix(while: { $0 == "#" }).count
        guard level >= 1 && level <= 6 else { return nil }
        let after = rest.dropFirst(level)
        guard after.isEmpty || after.first == " " || after.first == "\t" else { return nil }
        var title = after.trimmingCharacters(in: .whitespaces)
        // An optional closing run of #s, after a space.
        if title.hasSuffix("#") {
            if let last = title.lastIndex(where: { $0 != "#" }) {
                if title[last] == " " { title = String(title[...last]).trimmingCharacters(in: .whitespaces) }
            } else {
                title = ""
            }
        }
        return (level, title)
    }

    static func isRule(_ line: String) -> Bool {
        guard indent(line) <= 3 else { return false }
        let marks = line.filter { $0 != " " && $0 != "\t" }
        guard marks.count >= 3, let first = marks.first, first == "-" || first == "*" || first == "_" else { return false }
        return marks.allSatisfy { $0 == first }
    }

    static func quote(_ line: String) -> String? {
        guard indent(line) <= 3 else { return nil }
        let rest = content(line)
        guard rest.first == ">" else { return nil }
        var body = rest.dropFirst()
        if body.first == " " { body = body.dropFirst() }
        return String(body)
    }

    static func listItem(_ line: String) -> Item? {
        let rest = content(line)
        guard let first = rest.first else { return nil }
        if first == "-" || first == "*" || first == "+" {
            let after = rest.dropFirst()
            guard after.isEmpty || after.first == " " || after.first == "\t" else { return nil }
            return Item(indent: indent(line), marker: .bullet, text: after.trimmingCharacters(in: .whitespaces))
        }
        let digits = rest.prefix(while: { $0 >= "0" && $0 <= "9" })
        guard !digits.isEmpty && digits.count <= 9 else { return nil }
        let after = rest.dropFirst(digits.count)
        guard let delimiter = after.first, delimiter == "." || delimiter == ")" else { return nil }
        let body = after.dropFirst()
        guard body.isEmpty || body.first == " " || body.first == "\t" else { return nil }
        return Item(indent: indent(line), marker: .number(Int(String(digits)) ?? 1), text: body.trimmingCharacters(in: .whitespaces))
    }

    /// The words of a line that is only bold text, such as `**Not asked for**`.
    static func boldOnly(_ line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        for mark in ["**", "__"] {
            guard trimmed.count > 4, trimmed.hasPrefix(mark), trimmed.hasSuffix(mark) else { continue }
            let inner = String(trimmed.dropFirst(2).dropLast(2))
            guard !inner.contains(mark), let first = inner.first, let last = inner.last, first != " ", last != " " else { continue }
            return inner
        }
        return nil
    }
}
