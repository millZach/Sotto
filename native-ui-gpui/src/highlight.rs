//! Syntax colour with syntect (MIT) and two-face's grammars (MIT OR Apache-2.0),
//! which add TypeScript to syntect's set. Tokens are sorted into the same few
//! classes Sotto's `rich-messages.css` colours, so the theme decides the inks.

use std::{collections::HashMap, ops::Range, sync::OnceLock};
use syntect::parsing::{ParseState, Scope, ScopeStack, ScopeStackOp, SyntaxSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Class {
    Keyword,
    String,
    Number,
    Type,
    Title,
    Comment,
    Meta,
}

fn syntaxes() -> &'static SyntaxSet {
    static SET: OnceLock<SyntaxSet> = OnceLock::new();
    SET.get_or_init(two_face::syntax::extra_newlines)
}

/// Load the grammars on a background thread before the first code block needs them.
pub fn warm() {
    std::thread::spawn(|| {
        // Loading the set is not enough: each grammar compiles its patterns on first use, which
        // cost the first code block of each language over 100 ms on the UI thread.
        for (lang, sample) in [("ts", "const a: number = 1 // x
"), ("rust", "fn a() { let s = \"x\"; }
"), ("json", "{ \"a\": 1 }
"), ("sh", "# x
npm test
")] {
            let _ = highlight(lang, sample);
        }
    });
}

struct Scopes {
    comment: Scope,
    string: Scope,
    numeric: Scope,
    language: Scope,
    keyword: Scope,
    operator: Scope,
    storage: Scope,
    entity_type: Scope,
    support_type: Scope,
    entity_class: Scope,
    function: Scope,
    punctuation: Scope,
    property: Scope,
}

fn scopes() -> &'static Scopes {
    static SCOPES: OnceLock<Scopes> = OnceLock::new();
    SCOPES.get_or_init(|| {
        let s = |name: &str| Scope::new(name).unwrap();
        Scopes {
            comment: s("comment"),
            string: s("string"),
            numeric: s("constant.numeric"),
            language: s("constant.language"),
            keyword: s("keyword"),
            operator: s("keyword.operator"),
            storage: s("storage"),
            entity_type: s("entity.name.type"),
            support_type: s("support.type"),
            entity_class: s("entity.name.class"),
            function: s("entity.name.function"),
            punctuation: s("punctuation"),
            property: s("support.type.property-name"),
        }
    })
}

fn classify(stack: &ScopeStack) -> Option<Class> {
    let s = scopes();
    for scope in stack.as_slice().iter().rev() {
        let is = |prefix: &Scope| prefix.is_prefix_of(*scope);
        if is(&s.comment) {
            return Some(Class::Comment);
        }
        if is(&s.property) {
            return Some(Class::Type);
        }
        if is(&s.string) {
            return Some(Class::String);
        }
        if is(&s.numeric) || is(&s.language) {
            return Some(Class::Number);
        }
        if is(&s.operator) || is(&s.punctuation) {
            return Some(Class::Meta);
        }
        if is(&s.entity_type) || is(&s.support_type) || is(&s.entity_class) {
            return Some(Class::Type);
        }
        if is(&s.keyword) || is(&s.storage) {
            return Some(Class::Keyword);
        }
        if is(&s.function) {
            return Some(Class::Title);
        }
    }
    None
}

/// Classed ranges for a block of code. Unknown languages get none.
pub fn highlight(lang: &str, text: &str) -> Vec<(Range<usize>, Class)> {
    let set = syntaxes();
    let token = match lang {
        "ts" | "typescript" => "ts",
        "sh" | "shell" | "bash" => "sh",
        other => other,
    };
    let Some(syntax) = set.find_syntax_by_token(token) else { return Vec::new() };
    let mut state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut out: Vec<(Range<usize>, Class)> = Vec::new();
    let mut line_start = 0;
    for line in text.split_inclusive('\n') {
        let Ok(ops) = state.parse_line(line, set) else { break };
        let mut cursor = 0;
        let mut apply = |from: usize, to: usize, stack: &ScopeStack, out: &mut Vec<(Range<usize>, Class)>| {
            if to > from
                && let Some(class) = classify(stack)
            {
                let range = line_start + from..line_start + to;
                if let Some(last) = out.last_mut()
                    && last.0.end == range.start
                    && last.1 == class
                {
                    last.0.end = range.end;
                } else {
                    out.push((range, class));
                }
            }
        };
        for (offset, op) in ops {
            apply(cursor, offset, &stack, &mut out);
            cursor = offset;
            match op {
                ScopeStackOp::Push(_) | ScopeStackOp::Pop(_) | ScopeStackOp::Clear(_) | ScopeStackOp::Restore => {
                    let _ = stack.apply(&op);
                }
                ScopeStackOp::Noop => {}
            }
        }
        apply(cursor, line.trim_end_matches('\n').len().max(cursor), &stack, &mut out);
        line_start += line.len();
    }
    out
}

type Classes = Vec<(Range<usize>, Class)>;
type Key = (String, u64);

/// Highlighting off the UI thread. A block's colour is computed on a worker; until it
/// arrives, the block draws with the newest colouring of a shorter version of its own text
/// (a streaming block only grows), so the colour trails the text by a frame or two
/// instead of stalling the frame. Bat's TypeScript grammar took up to 74 ms a block on the
/// UI thread here.
pub struct Cache {
    done: HashMap<Key, std::sync::Arc<Classes>>,
    pending: std::collections::HashSet<Key>,
    recent: Vec<(String, String, std::sync::Arc<Classes>)>,
    to_worker: std::sync::mpsc::Sender<(Key, String, String)>,
    from_worker: std::sync::mpsc::Receiver<(Key, String, String, Option<std::sync::Arc<Classes>>)>,
}

impl Default for Cache {
    fn default() -> Self {
        let (to_worker, jobs) = std::sync::mpsc::channel::<(Key, String, String)>();
        let (results, from_worker) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("highlighter".into())
            .spawn(move || {
                while let Ok(first) = jobs.recv() {
                    // Only the newest request is worth doing; the rest are told they were skipped.
                    let mut batch = vec![first];
                    batch.extend(jobs.try_iter());
                    let newest = batch.pop().unwrap();
                    for (key, lang, text) in batch {
                        if results.send((key, lang, text, None)).is_err() {
                            return;
                        }
                    }
                    let (key, lang, text) = newest;
                    let classes = std::sync::Arc::new(highlight(&lang, &text));
                    if results.send((key, lang, text, Some(classes))).is_err() {
                        return;
                    }
                }
            })
            .expect("the highlighter starts");
        Cache { done: HashMap::new(), pending: Default::default(), recent: Vec::new(), to_worker, from_worker }
    }
}

impl Cache {
    pub fn get(&mut self, lang: &str, text: &str) -> std::sync::Arc<Classes> {
        use std::hash::{Hash, Hasher};
        for (key, lang, text, classes) in self.from_worker.try_iter() {
            self.pending.remove(&key);
            if let Some(classes) = classes {
                self.recent.push((lang, text, classes.clone()));
                if self.recent.len() > 16 {
                    self.recent.remove(0);
                }
                self.done.insert(key, classes);
            }
        }
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        text.hash(&mut hasher);
        let key = (lang.to_string(), hasher.finish());
        if let Some(classes) = self.done.get(&key) {
            return classes.clone();
        }
        if self.done.len() > 256 {
            self.done.clear();
        }
        if self.pending.insert(key.clone()) {
            let _ = self.to_worker.send((key, lang.to_string(), text.to_string()));
        }
        // The newest colouring of an earlier version of this text, which stays valid for that prefix.
        self.recent
            .iter()
            .rev()
            .find(|(l, t, _)| l == lang && text.starts_with(t.as_str()))
            .map(|(_, _, c)| c.clone())
            .unwrap_or_default()
    }

    /// Whether colour is still being worked out, so the transcript draws again when it lands.
    pub fn is_pending(&self) -> bool {
        !self.pending.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_language_in_the_reply_gets_colour() {
        for (lang, text, want) in [
            ("ts", "export const x: number = 4 // four\n", Class::Comment),
            ("rust", "fn main() { let s = \"hi\"; }\n", Class::String),
            ("json", "{ \"a\": 1 }\n", Class::Number),
            ("sh", "# run it\nnpm test\n", Class::Comment),
        ] {
            let classes = highlight(lang, text);
            assert!(classes.iter().any(|(_, c)| *c == want), "{lang}: {classes:?}");
            assert!(classes.iter().any(|(_, c)| *c == Class::Keyword) || lang != "rust", "{lang}: no keyword");
        }
    }
}
