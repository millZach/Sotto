//! The few icons the screen needs, drawn here as 24px SVG strokes (not copied
//! from any icon set), served to GPUI's `svg()` through an asset source. GPUI
//! tints an SVG with the text colour, so each takes its theme ink.

use gpui::{AssetSource, Result, SharedString};
use std::borrow::Cow;

pub struct Icons;

const STROKE: &str = r#"fill="none" stroke="black" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round""#;

fn icon(path: &str) -> Option<String> {
    let body = match path {
        "icons/attach.svg" => r#"<path d="M20 11.5 12.4 19a5 5 0 0 1-7.1-7.1l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3"/>"#,
        "icons/up.svg" => r#"<path d="M12 19V5M6 11l6-6 6 6"/>"#,
        "icons/stop.svg" => r#"<rect x="7" y="7" width="10" height="10" rx="1.5" fill="black"/>"#,
        "icons/shield.svg" => r#"<path d="M12 3 5 6v5c0 4.4 3 8.3 7 9.5 4-1.2 7-5.1 7-9.5V6z"/>"#,
        "icons/chevron-down.svg" => r#"<path d="m7 10 5 5 5-5"/>"#,
        "icons/spark.svg" => r#"<path d="M12 4v16M4 12h16M6.5 6.5l11 11M17.5 6.5l-11 11"/>"#,
        "icons/gauge.svg" => r#"<path d="M4 16a8 8 0 1 1 16 0"/><path d="m12 16 4-5"/>"#,
        "icons/sun.svg" => r#"<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>"#,
        "icons/moon.svg" => r#"<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>"#,
        "icons/min.svg" => r#"<path d="M6 12h12"/>"#,
        "icons/max.svg" => r#"<rect x="6" y="6" width="12" height="12" rx="1"/>"#,
        "icons/close.svg" => r#"<path d="M6 6l12 12M18 6 6 18"/>"#,
        "icons/terminal.svg" => r#"<path d="m5 8 4 4-4 4M12 17h7"/>"#,
        "icons/globe.svg" => r#"<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>"#,
        "icons/down.svg" => r#"<path d="M12 5v14M6 13l6 6 6-6"/>"#,
        "icons/file.svg" => r#"<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>"#,
        "icons/quote.svg" => r#"<path d="M7 7h4v4c0 2.5-1.5 4.5-4 5M14 7h4v4c0 2.5-1.5 4.5-4 5"/>"#,
        "icons/mark.svg" => r#"<rect x="3" y="3" width="18" height="18" rx="5" fill="black" stroke="none"/>"#,
        _ => return None,
    };
    Some(format!(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" {STROKE}>{body}</svg>"#))
}

impl AssetSource for Icons {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(icon(path).map(|s| Cow::Owned(s.into_bytes())))
    }

    fn list(&self, _path: &str) -> Result<Vec<SharedString>> {
        Ok(Vec::new())
    }
}
