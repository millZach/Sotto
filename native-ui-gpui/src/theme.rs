//! Sotto's default theme ("Sotto", id `t3-code`) in both modes.
//!
//! The roles are read from `tokens.css` at build time (see `build.rs`). The
//! `--tt-*` tokens below are derived from them the way `tokens.css` derives
//! them, at the default Contrast (100%, so the contrast mixes are identities).
//! Each token names the CSS it mirrors.

use gpui::{Hsla, Rgba};

include!(concat!(env!("OUT_DIR"), "/theme_roles.rs"));

/// A colour in OKLab with straight alpha. Mixing happens here, as CSS
/// `color-mix(in oklab, ...)` does.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Lab {
    pub l: f32,
    pub a: f32,
    pub b: f32,
    pub alpha: f32,
}

impl Lab {
    pub fn oklch(l: f32, c: f32, h: f32) -> Self {
        let h = h.to_radians();
        Lab { l, a: c * h.cos(), b: c * h.sin(), alpha: 1.0 }
    }

    /// `color-mix(in oklab, self p, other)`, p in 0..=1.
    pub fn mix(self, p: f32, other: Lab) -> Lab {
        let q = 1.0 - p;
        Lab {
            l: self.l * p + other.l * q,
            a: self.a * p + other.a * q,
            b: self.b * p + other.b * q,
            alpha: self.alpha * p + other.alpha * q,
        }
    }

    /// `color-mix(in srgb, self p, transparent)`: the same colour at alpha p.
    pub fn alpha(self, p: f32) -> Lab {
        Lab { alpha: self.alpha * p, ..self }
    }

    /// `color-mix(in srgb, self p, other)` for two opaque colours.
    pub fn mix_srgb(self, p: f32, other: Lab) -> Lab {
        let (r1, g1, b1) = self.srgb();
        let (r2, g2, b2) = other.srgb();
        let q = 1.0 - p;
        Lab::from_srgb(r1 * p + r2 * q, g1 * p + g2 * q, b1 * p + b2 * q, self.alpha * p + other.alpha * q)
    }

    pub fn srgb(self) -> (f32, f32, f32) {
        let l_ = self.l + 0.396_337_78 * self.a + 0.215_803_76 * self.b;
        let m_ = self.l - 0.105_561_346 * self.a - 0.063_854_17 * self.b;
        let s_ = self.l - 0.089_484_18 * self.a - 1.291_485_5 * self.b;
        let (l, m, s) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
        let r = 4.076_741_7 * l - 3.307_711_6 * m + 0.230_969_94 * s;
        let g = -1.268_438 * l + 2.609_757_4 * m - 0.341_319_38 * s;
        let b = -0.004_196_086_3 * l - 0.703_418_6 * m + 1.707_614_7 * s;
        (gamma(r), gamma(g), gamma(b))
    }

    pub fn from_srgb(r: f32, g: f32, b: f32, alpha: f32) -> Lab {
        let (r, g, b) = (linear(r), linear(g), linear(b));
        let l = 0.412_221_47 * r + 0.536_332_55 * g + 0.051_445_995 * b;
        let m = 0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b;
        let s = 0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b;
        let (l_, m_, s_) = (l.cbrt(), m.cbrt(), s.cbrt());
        Lab {
            l: 0.210_454_26 * l_ + 0.793_617_8 * m_ - 0.004_072_047 * s_,
            a: 1.977_998_5 * l_ - 2.428_592_2 * m_ + 0.450_593_7 * s_,
            b: 0.025_904_037 * l_ + 0.782_771_77 * m_ - 0.808_675_77 * s_,
            alpha,
        }
    }

    pub fn hsla(self) -> Hsla {
        let (r, g, b) = self.srgb();
        Rgba { r: r.clamp(0., 1.), g: g.clamp(0., 1.), b: b.clamp(0., 1.), a: self.alpha.clamp(0., 1.) }.into()
    }

    /// WCAG relative luminance of the opaque colour.
    pub fn luminance(self) -> f32 {
        let (r, g, b) = self.srgb();
        let lin = |c: f32| {
            let c = c.clamp(0., 1.);
            if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
        };
        0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }

    /// Composite a translucent colour over an opaque one, in sRGB (as the browser does).
    pub fn over(self, base: Lab) -> Lab {
        let (r1, g1, b1) = self.srgb();
        let (r2, g2, b2) = base.srgb();
        let a = self.alpha;
        Lab::from_srgb(r1 * a + r2 * (1. - a), g1 * a + g2 * (1. - a), b1 * a + b2 * (1. - a), 1.0)
    }
}

fn gamma(c: f32) -> f32 {
    if c <= 0.003_130_8 { 12.92 * c } else { 1.055 * c.max(0.).powf(1.0 / 2.4) - 0.055 }
}

fn linear(c: f32) -> f32 {
    if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
}

/// WCAG contrast ratio between two opaque colours.
pub fn contrast(a: Lab, b: Lab) -> f32 {
    let (la, lb) = (a.luminance(), b.luminance());
    let (hi, lo) = if la > lb { (la, lb) } else { (lb, la) };
    (hi + 0.05) / (lo + 0.05)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Dark,
    Light,
}

/// The tokens the screen paints from, as `Lab` so they can still be mixed.
#[derive(Clone, Debug)]
pub struct Tokens {
    pub mode: Mode,
    pub canvas: Lab,
    pub chrome: Lab,
    pub surface: Lab,
    pub surface_elevated: Lab,
    pub surface_overlay: Lab,
    pub sidebar: Lab,
    pub card: Lab,
    pub composer_card: Lab,
    pub text: Lab,
    pub text_2: Lab,
    pub text_quiet: Lab,
    pub text_muted: Lab,
    pub text_hint: Lab,
    pub transcript_muted: Lab,
    pub reading_text: Lab,
    pub reading_text_2: Lab,
    pub rich_strong: Lab,
    pub border_faint: Lab,
    pub reading_hairline: Lab,
    pub field_border: Lab,
    pub border: Lab,
    pub hover: Lab,
    pub hover_strong: Lab,
    pub bubble: Lab,
    pub bubble_text: Lab,
    pub code_bg: Lab,
    pub code_text: Lab,
    pub code_chip: Lab,
    pub accent: Lab,
    pub accent_text: Lab,
    pub accent_surface: Lab,
    pub on_accent: Lab,
    pub focus_ring: Lab,
    pub primary: Lab,
    pub primary_hover: Lab,
    pub primary_contrast: Lab,
    pub pill: Lab,
    pub pill_ink: Lab,
    pub link: Lab,
    pub warning: Lab,
    pub error: Lab,
    pub success: Lab,
    pub selection: Lab,
    pub scrollbar: Lab,
    pub scrollbar_hover: Lab,
    pub table_stripe: Lab,
    pub toolbar_text: Lab,
    pub terminal_bg: Lab,
    pub terminal_fg: Lab,
    pub terminal_cursor: Lab,
    pub terminal_selection: Lab,
    pub diff_added: Lab,
    pub diff_removed: Lab,
    pub diff_edge_added: Lab,
    pub diff_edge_removed: Lab,
    pub syntax_keyword: Lab,
    pub syntax_string: Lab,
    pub syntax_number: Lab,
    pub syntax_type: Lab,
    pub syntax_comment: Lab,
    pub syntax_meta: Lab,
    pub shadow: Lab,
}

fn role(table: &[(&str, f32, f32, f32)], name: &str) -> Lab {
    let (_, l, c, h) = table
        .iter()
        .find(|(key, ..)| *key == name)
        .unwrap_or_else(|| panic!("theme role missing from tokens.css: --theme-{name}"));
    Lab::oklch(*l, *c, *h)
}

impl Tokens {
    pub fn new(mode: Mode) -> Tokens {
        let table = match mode {
            Mode::Dark => DARK_ROLES,
            Mode::Light => LIGHT_ROLES,
        };
        let r = |name: &str| role(table, name);
        let theme_canvas = r("canvas");
        let theme_text = r("text");
        let muted_fg = r("muted-foreground");

        // --tt-text, --tt-text-2, --tt-text-quiet, --tt-text-muted (tokens.css, :root block).
        let text = theme_text;
        let text_2 = theme_text.mix(0.55, muted_fg);
        let text_quiet = muted_fg.mix(0.85, theme_text);
        let text_muted = muted_fg.mix(0.76, theme_text);
        let primary = r("message-action");
        let warning = r("warning-foreground");
        let error = r("error-foreground");
        let success = match mode {
            Mode::Dark => Lab::oklch(0.79, 0.13, 165.),
            Mode::Light => Lab::oklch(0.445, 0.11, 158.),
        };

        // The Sotto theme's own blocks: by night the room is a soft warm ink and the reading surface
        // reads softer inks; by day cards take 7% of the text and the composer 4%.
        let (canvas, bubble, code_bg, reading_text, reading_text_2, transcript_muted, card, composer_card) =
            match mode {
                Mode::Dark => {
                    let lit = |name: &str| role(SOTTO_DARK_LITERALS, name);
                    let canvas = role(SOTTO_DARK_CANVAS, "canvas");
                    (
                        canvas,
                        lit("bubble"),
                        lit("code-bg"),
                        text.mix(0.88, theme_canvas),
                        text_2.mix(0.91, theme_canvas),
                        text_muted.mix(0.91, theme_canvas),
                        r("surface-raised"),
                        r("surface-raised"),
                    )
                }
                Mode::Light => (
                    theme_canvas,
                    r("message-surface"),
                    r("code-background"),
                    text,
                    text_2,
                    text_quiet.mix(0.8, text),
                    theme_text.mix(0.07, theme_canvas),
                    theme_text.mix(0.04, theme_canvas),
                ),
            };
        let bubble_text = r("message-foreground");
        let code_text_root = r("code-foreground");
        let code_text = match mode {
            Mode::Dark => code_text_root.mix(0.82, code_bg),
            Mode::Light => code_text_root,
        };
        let border_faint = r("border");
        let reading_hairline = match mode {
            Mode::Dark => border_faint,
            Mode::Light => border_faint.mix_srgb(0.88, theme_text),
        };
        let accent = r("accent");
        let accent_text = r("update-foreground");
        Tokens {
            mode,
            canvas,
            chrome: canvas,
            surface: r("surface"),
            surface_elevated: r("surface-raised"),
            surface_overlay: r("surface-overlay"),
            sidebar: r("sidebar"),
            card,
            composer_card,
            text,
            text_2,
            text_quiet,
            text_muted,
            text_hint: r("placeholder"),
            transcript_muted,
            reading_text,
            reading_text_2,
            // .rich-message: --rich-strong: color-mix(in oklab, var(--tt-text) 86%, var(--tt-text-2)), on the reading inks.
            rich_strong: reading_text.mix(0.86, reading_text_2),
            border_faint,
            reading_hairline,
            field_border: r("input"),
            border: r("input").mix(0.25, muted_fg),
            hover: r("accent-surface").alpha(0.7),
            hover_strong: r("accent-surface"),
            bubble,
            bubble_text,
            code_bg,
            code_text,
            code_chip: reading_text.alpha(0.05),
            accent,
            accent_text,
            accent_surface: r("accent-surface"),
            on_accent: r("accent-foreground"),
            focus_ring: r("focus"),
            primary,
            primary_hover: r("message-action-hover"),
            primary_contrast: r("message-action-foreground"),
            pill: text,
            pill_ink: theme_canvas,
            link: accent_text,
            warning,
            error,
            success,
            selection: r("accent-surface"),
            scrollbar: r("terminal-scrollbar"),
            scrollbar_hover: r("terminal-scrollbar-hover"),
            table_stripe: text.alpha(0.03),
            toolbar_text: r("toolbar-foreground"),
            terminal_bg: match mode {
                // The terminal sits on the room's own colour, like the Tools panel.
                Mode::Dark => canvas,
                Mode::Light => r("terminal-background"),
            },
            terminal_fg: r("terminal-foreground"),
            terminal_cursor: r("terminal-cursor"),
            terminal_selection: r("terminal-selection"),
            // changes.css: --changes-added / --changes-removed and their edges.
            diff_added: success.alpha(match mode { Mode::Dark => 0.09, Mode::Light => 0.10 }),
            diff_removed: error.alpha(0.09),
            diff_edge_added: success.alpha(match mode { Mode::Dark => 0.8, Mode::Light => 0.6 }),
            diff_edge_removed: error.alpha(match mode { Mode::Dark => 0.8, Mode::Light => 0.6 }),
            // rich-messages.css: the --rich-code-* inks.
            syntax_keyword: primary.mix(0.85, reading_text),
            syntax_string: warning.mix(0.7, code_text),
            syntax_number: error.mix(0.7, code_text),
            syntax_type: r("message-action-hover"),
            syntax_comment: text_muted,
            syntax_meta: text_muted,
            shadow: match mode {
                Mode::Dark => Lab::from_srgb(0., 0., 0., 0.55),
                Mode::Light => Lab::from_srgb(20. / 255., 24. / 255., 22. / 255., 0.18),
            },
        }
    }

    /// Every text ink the screen uses, against the surface it sits on, with its WCAG ratio.
    pub fn contrast_report(&self) -> Vec<(&'static str, f32)> {
        let on = |ink: Lab, surface: Lab| contrast(if ink.alpha < 1. { ink.over(surface) } else { ink }, surface);
        let diff_add_surface = self.diff_added.over(self.code_bg);
        vec![
            ("reading text on canvas", on(self.reading_text, self.canvas)),
            ("reading text-2 (prose) on canvas", on(self.reading_text_2, self.canvas)),
            ("headings on canvas", on(self.rich_strong, self.canvas)),
            ("transcript muted on canvas", on(self.transcript_muted, self.canvas)),
            ("bubble text on bubble", on(self.bubble_text, self.bubble)),
            ("code text on code well", on(self.code_text, self.code_bg)),
            ("keyword on code well", on(self.syntax_keyword, self.code_bg)),
            ("string on code well", on(self.syntax_string, self.code_bg)),
            ("number on code well", on(self.syntax_number, self.code_bg)),
            ("type on code well", on(self.syntax_type, self.code_bg)),
            ("comment on code well", on(self.syntax_comment, self.code_bg)),
            ("code text on added line", on(self.code_text, diff_add_surface)),
            ("link on canvas", on(self.link, self.canvas)),
            ("composer text on composer card", on(self.text, self.composer_card)),
            ("composer hint on composer card", on(self.text_hint, self.composer_card)),
            ("chip text on composer card", on(self.text_quiet, self.composer_card)),
            ("pill ink on pill", on(self.pill_ink, self.pill)),
            ("strip text on chrome", on(self.toolbar_text, self.chrome)),
            ("terminal text on terminal", on(self.terminal_fg, self.terminal_bg)),
            ("accent text on canvas", on(self.accent_text, self.canvas)),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_text_ink_meets_four_and_a_half_to_one() {
        for mode in [Mode::Dark, Mode::Light] {
            let tokens = Tokens::new(mode);
            for (name, ratio) in tokens.contrast_report() {
                println!("{mode:?}: {name}: {ratio:.2}:1");
                assert!(ratio >= 4.5, "{mode:?}: {name} is {ratio:.2}:1");
            }
        }
    }

    #[test]
    fn oklch_white_round_trips() {
        let (r, g, b) = Lab::oklch(1.0, 0.0, 0.0).srgb();
        assert!((r - 1.).abs() < 1e-3 && (g - 1.).abs() < 1e-3 && (b - 1.).abs() < 1e-3);
    }
}
