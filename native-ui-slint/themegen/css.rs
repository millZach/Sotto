// A small evaluator for the subset of CSS colour syntax Sotto's tokens.css uses:
// var() with fallbacks, color-mix() in oklab and srgb, oklch(), rgb(), #hex,
// white, black and transparent. It is shared by build.rs (which generates the
// Slint theme) and by the contrast report. `oklch(from ...)` (relative colour)
// is not supported; the tokens that use it are not needed by this screen.

use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}

impl Rgba {
    pub fn to_u8(self) -> [u8; 4] {
        let c = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        [c(self.r), c(self.g), c(self.b), c(self.a)]
    }
    pub fn hex(self) -> String {
        let [r, g, b, a] = self.to_u8();
        if a == 255 { format!("#{r:02x}{g:02x}{b:02x}") } else { format!("#{r:02x}{g:02x}{b:02x}{a:02x}") }
    }
    /// Source-over composite of `self` on an opaque `under`.
    pub fn over(self, under: Rgba) -> Rgba {
        let a = self.a;
        Rgba { r: self.r * a + under.r * (1.0 - a), g: self.g * a + under.g * (1.0 - a), b: self.b * a + under.b * (1.0 - a), a: 1.0 }
    }
    pub fn luminance(self) -> f64 {
        let lin = |v: f64| if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
        0.2126 * lin(self.r) + 0.7152 * lin(self.g) + 0.0722 * lin(self.b)
    }
}

pub fn contrast(fg: Rgba, bg: Rgba) -> f64 {
    let fg = fg.over(bg);
    let (a, b) = (fg.luminance(), bg.luminance());
    let (hi, lo) = if a > b { (a, b) } else { (b, a) };
    (hi + 0.05) / (lo + 0.05)
}

fn srgb_to_linear(v: f64) -> f64 {
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}
fn linear_to_srgb(v: f64) -> f64 {
    if v <= 0.0031308 { 12.92 * v } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}

/// OKLab (L, a, b) to gamma-encoded sRGB, clamped into gamut.
fn oklab_to_srgb(l: f64, a: f64, b: f64) -> (f64, f64, f64) {
    let l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    let m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    let s_ = l - 0.0894841775 * a - 1.2914855480 * b;
    let (l3, m3, s3) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
    let r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
    let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
    let bb = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3;
    (
        linear_to_srgb(r).clamp(0.0, 1.0),
        linear_to_srgb(g).clamp(0.0, 1.0),
        linear_to_srgb(bb).clamp(0.0, 1.0),
    )
}

fn srgb_to_oklab(c: Rgba) -> (f64, f64, f64) {
    let (r, g, b) = (srgb_to_linear(c.r), srgb_to_linear(c.g), srgb_to_linear(c.b));
    let l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    let m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    let s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    let (l_, m_, s_) = (l.cbrt(), m.cbrt(), s.cbrt());
    (
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    )
}

/// The declarations of one CSS rule block, by custom property name.
pub type Decls = HashMap<String, String>;

/// Reads the body of the first rule whose selector text is exactly `selector`.
pub fn block(css: &str, selector: &str) -> Decls {
    let start = css
        .find(&format!("{selector} {{"))
        .unwrap_or_else(|| panic!("tokens.css has no block for {selector}"));
    let body_start = start + selector.len() + 2;
    let mut depth = 1;
    let mut end = body_start;
    for (i, ch) in css[body_start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = body_start + i;
                    break;
                }
            }
            _ => {}
        }
    }
    let body = strip_comments(&css[body_start..end]);
    let mut out = Decls::new();
    for decl in body.split(';') {
        let decl = decl.trim();
        if let Some(rest) = decl.strip_prefix("--") {
            if let Some((name, value)) = rest.split_once(':') {
                out.insert(format!("--{}", name.trim()), value.trim().to_string());
            }
        }
    }
    out
}

fn strip_comments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("/*") {
        out.push_str(&rest[..i]);
        match rest[i..].find("*/") {
            Some(j) => rest = &rest[i + j + 2..],
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// Substitutes every var() in `value` from `env`, recursively.
pub fn substitute(value: &str, env: &Decls, depth: usize) -> Result<String, String> {
    if depth > 40 {
        return Err(format!("var() loop in {value}"));
    }
    let Some(i) = value.find("var(") else { return Ok(value.to_string()) };
    let open = i + 3;
    let close = matching_paren(value, open).ok_or_else(|| format!("unbalanced var() in {value}"))?;
    let inner = &value[open + 1..close];
    let (name, fallback) = match split_top(inner).as_slice() {
        [n] => (n.trim().to_string(), None),
        [n, f, ..] => (n.trim().to_string(), Some(f.trim().to_string())),
        _ => return Err(format!("empty var() in {value}")),
    };
    let replacement = match env.get(&name) {
        Some(v) => substitute(v, env, depth + 1)?,
        None => match fallback {
            Some(f) => substitute(&f, env, depth + 1)?,
            None => return Err(format!("{name} is not defined")),
        },
    };
    let joined = format!("{}{}{}", &value[..i], replacement, &value[close + 1..]);
    substitute(&joined, env, depth + 1)
}

fn matching_paren(s: &str, open: usize) -> Option<usize> {
    let mut depth = 0;
    for (i, ch) in s[open..].char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(open + i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Splits on commas that are not inside parentheses.
fn split_top(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0;
    let mut last = 0;
    for (i, ch) in s.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                out.push(&s[last..i]);
                last = i + 1;
            }
            _ => {}
        }
    }
    out.push(&s[last..]);
    out
}

fn number(s: &str) -> Result<f64, String> {
    let s = s.trim();
    if let Some(p) = s.strip_suffix('%') {
        return p.trim().parse::<f64>().map(|v| v / 100.0).map_err(|e| format!("{s}: {e}"));
    }
    s.parse::<f64>().map_err(|e| format!("{s}: {e}"))
}

/// Parses a fully substituted colour expression.
pub fn color(expr: &str) -> Result<Rgba, String> {
    let e = expr.trim();
    match e {
        "white" => return Ok(Rgba { r: 1.0, g: 1.0, b: 1.0, a: 1.0 }),
        "black" => return Ok(Rgba { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }),
        "transparent" => return Ok(Rgba { r: 0.0, g: 0.0, b: 0.0, a: 0.0 }),
        _ => {}
    }
    if let Some(hex) = e.strip_prefix('#') {
        let v = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).map(|x| x as f64 / 255.0).map_err(|x| x.to_string());
        return match hex.len() {
            6 => Ok(Rgba { r: v(0)?, g: v(2)?, b: v(4)?, a: 1.0 }),
            8 => Ok(Rgba { r: v(0)?, g: v(2)?, b: v(4)?, a: v(6)? }),
            _ => Err(format!("unsupported hex {e}")),
        };
    }
    let open = e.find('(').ok_or_else(|| format!("not a colour: {e}"))?;
    let name = e[..open].trim();
    let close = matching_paren(e, open).ok_or_else(|| format!("unbalanced {e}"))?;
    let inner = &e[open + 1..close];
    match name {
        "oklch" => {
            if inner.trim_start().starts_with("from ") {
                return Err("relative oklch(from ...) is not supported".into());
            }
            let (chan, alpha) = match inner.split_once('/') {
                Some((c, a)) => (c, number(a)?),
                None => (inner, 1.0),
            };
            let parts: Vec<&str> = chan.split_whitespace().collect();
            if parts.len() != 3 {
                return Err(format!("oklch needs three channels: {e}"));
            }
            let l = number(parts[0])?;
            let c = number(parts[1])?;
            let h = number(parts[2])?.to_radians();
            let (r, g, b) = oklab_to_srgb(l, c * h.cos(), c * h.sin());
            Ok(Rgba { r, g, b, a: alpha })
        }
        "rgb" | "rgba" => {
            let (chan, alpha) = match inner.split_once('/') {
                Some((c, a)) => (c.to_string(), number(a)?),
                None => (inner.replace(',', " "), 1.0),
            };
            let p: Vec<f64> = chan.split_whitespace().map(|x| number(x).map(|v| if x.ends_with('%') { v } else { v / 255.0 })).collect::<Result<_, _>>()?;
            if p.len() < 3 {
                return Err(format!("rgb needs three channels: {e}"));
            }
            Ok(Rgba { r: p[0], g: p[1], b: p[2], a: if p.len() == 4 { p[3] } else { alpha } })
        }
        "color-mix" => {
            let args = split_top(inner);
            if args.len() != 3 {
                return Err(format!("color-mix needs a space and two colours: {e}"));
            }
            let space = args[0].trim().strip_prefix("in ").ok_or("color-mix needs `in <space>`")?.trim();
            let (c1, p1) = colour_and_percent(args[1])?;
            let (c2, p2) = colour_and_percent(args[2])?;
            let (p1, p2) = match (p1, p2) {
                (None, None) => (0.5, 0.5),
                (Some(a), None) => (a, 1.0 - a),
                (None, Some(b)) => (1.0 - b, b),
                (Some(a), Some(b)) => (a, b),
            };
            let sum = p1 + p2;
            if sum <= 0.0 {
                return Err(format!("color-mix percentages sum to zero: {e}"));
            }
            let (w1, w2) = (p1 / sum, p2 / sum);
            let alpha_scale = if sum < 1.0 { sum } else { 1.0 };
            let a = c1.a * w1 + c2.a * w2;
            let mixed = if a <= 0.0 {
                Rgba { r: 0.0, g: 0.0, b: 0.0, a: 0.0 }
            } else {
                match space {
                    "srgb" => Rgba {
                        r: (c1.r * c1.a * w1 + c2.r * c2.a * w2) / a,
                        g: (c1.g * c1.a * w1 + c2.g * c2.a * w2) / a,
                        b: (c1.b * c1.a * w1 + c2.b * c2.a * w2) / a,
                        a,
                    },
                    "oklab" => {
                        let (l1, a1, b1) = srgb_to_oklab(c1);
                        let (l2, a2, b2) = srgb_to_oklab(c2);
                        let l = (l1 * c1.a * w1 + l2 * c2.a * w2) / a;
                        let aa = (a1 * c1.a * w1 + a2 * c2.a * w2) / a;
                        let bb = (b1 * c1.a * w1 + b2 * c2.a * w2) / a;
                        let (r, g, b) = oklab_to_srgb(l, aa, bb);
                        Rgba { r, g, b, a }
                    }
                    other => return Err(format!("unsupported mixing space {other}")),
                }
            };
            Ok(Rgba { a: mixed.a * alpha_scale, ..mixed })
        }
        "light-dark" => Err("light-dark() must be resolved by the caller".into()),
        other => Err(format!("unsupported colour function {other}()")),
    }
}

fn colour_and_percent(arg: &str) -> Result<(Rgba, Option<f64>), String> {
    let arg = arg.trim();
    // The percentage, when present, is the last whitespace-separated token outside parentheses.
    if arg.ends_with('%') {
        if let Some(i) = arg.rfind(|c: char| c.is_whitespace()) {
            let (c, p) = arg.split_at(i);
            if !c.trim().is_empty() && !p.contains(')') {
                return Ok((color(c)?, Some(number(p)?)));
            }
        }
    }
    Ok((color(arg)?, None))
}

pub fn eval(name: &str, env: &Decls) -> Result<Rgba, String> {
    let value = env.get(name).ok_or_else(|| format!("{name} is not defined"))?;
    let substituted = substitute(value, env, 0)?;
    color(&substituted).map_err(|e| format!("{name}: {e}"))
}
