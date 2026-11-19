//! Syntax colour with syntect, painted in Sotto's code roles (agents/rich-messages.css).
//!
//! syntect's bundled grammars have no TypeScript, so TypeScript is coloured with the JavaScript
//! grammar. Types and interfaces then read as plain identifiers.

use std::str::FromStr;
use syntect::easy::HighlightLines;
use syntect::highlighting::{Color, ScopeSelectors, StyleModifier, Theme, ThemeItem, ThemeSettings};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

#[derive(Clone, Copy)]
pub struct CodeColors {
    pub text: [u8; 4],
    pub keyword: [u8; 4],
    pub string: [u8; 4],
    pub number: [u8; 4],
    pub title: [u8; 4],
    pub ty: [u8; 4],
    pub comment: [u8; 4],
    pub meta: [u8; 4],
}

pub struct Highlighter {
    syntaxes: SyntaxSet,
    theme: Theme,
}

fn c(rgba: [u8; 4]) -> Color {
    Color { r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3] }
}

fn item(scope: &str, color: [u8; 4]) -> ThemeItem {
    ThemeItem {
        scope: ScopeSelectors::from_str(scope).expect("scope selector"),
        style: StyleModifier { foreground: Some(c(color)), background: None, font_style: None },
    }
}

impl Highlighter {
    pub fn new(colors: CodeColors) -> Self {
        Self { syntaxes: SyntaxSet::load_defaults_newlines(), theme: Self::theme(colors) }
    }

    pub fn set_colors(&mut self, colors: CodeColors) {
        self.theme = Self::theme(colors);
    }

    fn theme(k: CodeColors) -> Theme {
        Theme {
            name: Some("Sotto".into()),
            author: None,
            settings: ThemeSettings { foreground: Some(c(k.text)), ..Default::default() },
            scopes: vec![
                item("comment, punctuation.definition.comment", k.comment),
                item("string, constant.character.escape", k.string),
                item("constant.numeric, constant.language", k.number),
                item("keyword, storage, variable.language", k.keyword),
                item("keyword.operator, punctuation, meta.brace", k.meta),
                item("entity.name.function, entity.name.section, support.function, entity.name.tag, meta.object-literal.key", k.title),
                item("entity.name.type, entity.name.class, support.type, storage.type.rust, entity.other.attribute-name, support.class", k.ty),
                item("variable.parameter, meta.mapping.key string, support.type.property-name", k.ty),
            ],
        }
    }

    /// Lines of (hex colour, text) spans.
    pub fn lines(&self, lang: &str, code: &str) -> Vec<Vec<(String, String)>> {
        let ext = match lang {
            "typescript" | "ts" | "javascript" | "js" | "tsx" => "js",
            "rust" | "rs" => "rs",
            "json" => "json",
            "shell" | "sh" | "bash" | "zsh" => "sh",
            other => other,
        };
        let syntax = self.syntaxes.find_syntax_by_extension(ext).unwrap_or_else(|| self.syntaxes.find_syntax_plain_text());
        let mut hl = HighlightLines::new(syntax, &self.theme);
        let mut out = Vec::new();
        for line in LinesWithEndings::from(code) {
            let spans = hl
                .highlight_line(line, &self.syntaxes)
                .map(|v| {
                    v.into_iter()
                        .map(|(style, text)| {
                            let f = style.foreground;
                            (format!("#{:02x}{:02x}{:02x}", f.r, f.g, f.b), text.trim_end_matches(['\n', '\r']).to_string())
                        })
                        .collect()
                })
                .unwrap_or_else(|_| vec![(String::new(), line.trim_end().to_string())]);
            out.push(spans);
        }
        if code.ends_with('\n') || code.is_empty() {
            out.push(Vec::new());
        }
        out
    }
}
