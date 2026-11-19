// Generates ui/generated/theme.slint from Sotto's real tokens.css, then compiles the UI.
//
// The theme is read from src/renderer/src/styles/tokens.css (the --theme-* roles of the
// default Sotto theme by night and by day, and the --tt-* derivations), and evaluated with
// themegen/css.rs. A handful of reading-surface colours that live in feature stylesheets
// (syntax colours in agents/rich-messages.css, diff washes in tools/changes.css) are copied
// here as the CSS expressions they are, with their source named, and evaluated the same way.

#[path = "themegen/css.rs"]
mod css;

use std::fmt::Write as _;
use std::path::PathBuf;

/// The --tt-* tokens this screen reads. The Slint property drops the `--tt-` prefix.
const TOKENS: &[&str] = &[
    "canvas", "chrome", "surface", "surface-elevated", "surface-overlay", "surface-sunken", "card",
    "card-inset", "composer-card", "text", "text-2", "text-quiet", "text-muted", "text-hint",
    "transcript-muted", "border-faint", "field-border", "field-border-focus", "border", "hover",
    "hover-strong", "track", "bubble", "bubble-text", "code-bg", "code-border", "code-text", "accent",
    "accent-text", "on-accent", "focus-ring", "primary", "primary-hover", "primary-contrast", "link",
    "accent-wash", "selected", "pill", "pill-ink", "error", "warning", "success", "terminal-background",
    "terminal-foreground", "terminal-cursor", "terminal-selection", "toolbar", "toolbar-text",
    "toolbar-border", "toolbar-control-hover", "accent-surface", "accent-surface-text", "scrollbar",
    "scrollbar-hover", "table-stripe", "provider-claude-mark", "overlay", "kbd", "reading-text", "reading-text-2", "reading-bubble-text",
    "reading-code-text", "reading-hairline", "composer-text-faint", "accent-border", "activity",
];

/// Reading-surface colours from feature stylesheets: (name, dark expression, light expression).
const EXTRA: &[(&str, &str, &str)] = &[
    // agents/rich-messages.css, the .rich-message block
    ("code-keyword", "color-mix(in oklab, var(--tt-primary) 85%, var(--tt-text))", ""),
    ("code-string", "color-mix(in oklab, var(--tt-warning) 70%, var(--tt-code-text))", ""),
    ("code-number", "color-mix(in oklab, var(--tt-error) 70%, var(--tt-code-text))", ""),
    ("code-title", "var(--tt-code-text)", ""),
    ("code-type", "var(--tt-primary-hover)", ""),
    ("code-comment", "var(--tt-text-muted)", ""),
    ("code-meta", "var(--tt-text-muted)", ""),
    ("code-chip", "color-mix(in oklab, var(--tt-text) 5%, transparent)", ""),
    // agents/threads.css and quietComposer.css: the send disc at rest with nothing typed, pointed at, and the effort offer's
    // wash; the speed switch's track (split-chip-effort__speeds).
    ("disc-off", "color-mix(in oklab, var(--tt-pill) 16%, var(--tt-composer-card))", ""),
    ("disc-hover", "color-mix(in oklab, var(--tt-pill) 84%, var(--tt-composer-card))", ""),
    ("offer-wash", "color-mix(in srgb, var(--tt-accent) 10%, transparent)", ""),
    ("speeds-track", "color-mix(in oklab, var(--tt-text) 6%, transparent)", ""),
    // tools/changes.css, .changes-diff__rows (light-dark(): light first, dark second)
    ("diff-added", "color-mix(in srgb, var(--tt-success) 9%, transparent)", "color-mix(in srgb, var(--tt-success) 10%, transparent)"),
    ("diff-removed", "color-mix(in srgb, var(--tt-error) 9%, transparent)", "color-mix(in srgb, var(--tt-error) 9%, transparent)"),
    ("diff-edge-added", "color-mix(in srgb, var(--tt-success) 80%, transparent)", "color-mix(in srgb, var(--tt-success) 60%, transparent)"),
    ("diff-edge-removed", "color-mix(in srgb, var(--tt-error) 80%, transparent)", "color-mix(in srgb, var(--tt-error) 60%, transparent)"),
];

/// Text on surface pairs that must reach 4.5:1, checked in both modes.
const CONTRAST: &[(&str, &str)] = &[
    ("text", "canvas"), ("text", "surface"), ("text", "card"), ("text-2", "canvas"),
    ("transcript-muted", "canvas"), ("reading-text", "canvas"), ("reading-text-2", "canvas"),
    ("reading-bubble-text", "bubble"), ("reading-code-text", "code-bg"), ("text-muted", "canvas"), ("text-quiet", "composer-card"),
    ("text-hint", "composer-card"), ("text", "composer-card"), ("bubble-text", "bubble"),
    ("code-text", "code-bg"), ("link", "canvas"), ("accent-text", "canvas"),
    ("terminal-foreground", "terminal-background"), ("toolbar-text", "toolbar"),
    ("accent-surface-text", "accent-surface"), ("primary-contrast", "primary"), ("pill-ink", "pill"),
    ("code-keyword", "code-bg"), ("code-string", "code-bg"), ("code-number", "code-bg"),
    ("code-type", "code-bg"), ("code-comment", "code-bg"), ("text", "diff-added"),
    ("text", "diff-removed"), ("text", "surface-elevated"), ("text-muted", "surface-elevated"),
];

const SIZES: &[&str] = &[
    "type-micro", "type-caption", "type-small", "type-body", "type-reading", "type-lead",
    "type-heading", "type-figure", "type-title", "radius-mark", "radius-tag", "radius-control",
    "radius-row", "radius-inset", "radius-card", "radius-overlay",
];

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let tokens_path = manifest.join("../src/renderer/src/styles/tokens.css");
    println!("cargo:rerun-if-changed={}", tokens_path.display());
    println!("cargo:rerun-if-changed=themegen/css.rs");
    let css_text = std::fs::read_to_string(&tokens_path).expect("read tokens.css");

    // The roles of Sotto's default theme (id `t3-code`) come from palettes.ts, as appearance.ts writes them.
    let palettes_path = manifest.join("../src/shared/themes/palettes.ts");
    println!("cargo:rerun-if-changed={}", palettes_path.display());
    let palettes = std::fs::read_to_string(&palettes_path).expect("read palettes.ts");
    let roles_dark = palette_roles(&palettes, "SOTTO_DARK_THEME_COLORS");
    let roles_light = palette_roles(&palettes, "SOTTO_LIGHT_THEME_COLORS");
    // tokens.css: the derivations for both modes, then the default theme's own blocks.
    let defaults = css::block(&css_text, ":root"); // contrast settings at 100%
    let common = css::block(&css_text, ":root, [data-theme-scope]");
    let common_light = css::block(&css_text, ":root[data-theme='light'], [data-theme-scope='light']");
    let own_dark = css::block(&css_text, ":root[data-theme='dark'][data-theme-id='t3-code']");
    let own_dark_room = css::block(&css_text, ":root[data-theme='dark'][data-theme-id='t3-code'] .app-shell:not(:has(.watcher-room))");
    let own_light = css::block(&css_text, ":root[data-theme='light'][data-theme-id='t3-code']");

    let mut dark = defaults.clone();
    dark.extend(roles_dark);
    dark.extend(common.clone());
    dark.extend(own_dark);
    dark.extend(own_dark_room);
    let mut light = defaults;
    light.extend(roles_light);
    light.extend(common.clone());
    light.extend(common_light);
    light.extend(own_light);
    for (name, d, l) in EXTRA {
        dark.insert(format!("--tt-{name}"), d.to_string());
        light.insert(format!("--tt-{name}"), if l.is_empty() { d } else { l }.to_string());
    }

    let names: Vec<&str> = TOKENS.iter().copied().chain(EXTRA.iter().map(|e| e.0)).collect();
    let mut slint = String::new();
    writeln!(slint, "// Generated by native-ui-slint/build.rs from src/shared/themes/palettes.ts (Sotto, id t3-code) and src/renderer/src/styles/tokens.css. Do not edit.").unwrap();
    writeln!(slint, "// Sotto's default theme: `dark` picks the night half, otherwise the day half.").unwrap();
    writeln!(slint, "export global Theme {{\n    in-out property <bool> dark: true;").unwrap();
    let mut report = String::from("# Contrast of the generated theme (WCAG 2 ratio, alpha composited over the surface)\n\n| Mode | Text | Surface | Ratio | 4.5:1 |\n| --- | --- | --- | --- | --- |\n");
    let mut failures = 0;
    let mut resolved = Vec::new();
    for name in &names {
        let key = format!("--tt-{name}");
        let d = css::eval(&key, &dark).unwrap_or_else(|e| panic!("dark {e}"));
        let l = css::eval(&key, &light).unwrap_or_else(|e| panic!("light {e}"));
        writeln!(slint, "    out property <color> {name}: self.dark ? {} : {};", d.hex(), l.hex()).unwrap();
        resolved.push((*name, d, l));
    }
    for size in SIZES {
        let v = common.get(&format!("--tt-{size}")).unwrap_or_else(|| panic!("--tt-{size} missing"));
        let px: f64 = v.trim_end_matches("px").parse().unwrap_or_else(|_| panic!("--tt-{size} is {v}"));
        writeln!(slint, "    out property <length> {size}: {px}px;").unwrap();
    }
    writeln!(slint, "}}").unwrap();

    let get = |n: &str, dark_mode: bool| {
        let (_, d, l) = resolved.iter().find(|(name, _, _)| *name == n).unwrap_or_else(|| panic!("{n} not resolved"));
        if dark_mode { *d } else { *l }
    };
    for dark_mode in [true, false] {
        for (fg, bg) in CONTRAST {
            let mut surface = get(bg, dark_mode);
            if surface.a < 1.0 {
                // Washes (diff lines) sit on the code block.
                surface = surface.over(get("code-bg", dark_mode));
            }
            let ratio = css::contrast(get(fg, dark_mode), surface);
            let ok = ratio >= 4.5;
            if !ok {
                failures += 1;
            }
            writeln!(report, "| {} | {fg} | {bg} | {ratio:.2} | {} |", if dark_mode { "dark" } else { "light" }, if ok { "pass" } else { "FAIL" }).unwrap();
        }
    }
    writeln!(report, "\n{failures} pair(s) under 4.5:1.").unwrap();

    let generated = manifest.join("ui/generated");
    std::fs::create_dir_all(&generated).unwrap();
    write_if_changed(&generated.join("theme.slint"), &slint);
    write_if_changed(&generated.join("contrast.md"), &report);

    let config = slint_build::CompilerConfiguration::new().with_style("fluent".into());
    slint_build::compile_with_config("ui/app.slint", config).expect("compile the Slint UI");
}

/// Reads `export const NAME: ThemeColors = { role: 'oklch(...)', ... }` as --theme-* declarations.
fn palette_roles(source: &str, name: &str) -> css::Decls {
    let start = source.find(&format!("export const {name}: ThemeColors = {{")).unwrap_or_else(|| panic!("{name} missing"));
    let body = &source[start..];
    let body = &body[body.find('{').unwrap() + 1..body.find("\n}").unwrap()];
    let mut out = css::Decls::new();
    for line in body.lines() {
        let Some((key, value)) = line.trim().trim_end_matches(',').split_once(':') else { continue };
        let kebab: String = key.trim().chars().flat_map(|c| if c.is_ascii_uppercase() { vec!['-', c.to_ascii_lowercase()] } else { vec![c] }).collect();
        out.insert(format!("--theme-{kebab}"), value.trim().trim_matches('\'').to_string());
    }
    assert!(out.len() >= 57, "{name} has {} roles", out.len());
    out
}

fn write_if_changed(path: &std::path::Path, content: &str) {
    if std::fs::read_to_string(path).ok().as_deref() != Some(content) {
        std::fs::write(path, content).unwrap();
    }
}
