/// Pure parsers matching `src/main/tools/gitReview.ts` and `src/main/files/imagePreview.ts`
/// so Rust's `thread_changes_review` and `thread_file_preview` produce exact TypeScript parity.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumstatEntry {
    pub path: String,
    pub original_path: Option<String>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameStatusEntry {
    pub path: String,
    pub original_path: Option<String>,
    pub status: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RasterImageInfo {
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
}

/// Parses `git diff -z --numstat`: `adds\tdels\tpath\0`, or `adds\tdels\t\0old\0new\0` for a rename.
pub fn parse_numstat_z(output: &str) -> Vec<NumstatEntry> {
    let tokens: Vec<&str> = output.split('\0').collect();
    let mut entries = Vec::new();
    let mut index = 0usize;
    while index < tokens.len() {
        let token = tokens[index].trim_start_matches('\n');
        index += 1;
        let mut parts = token.splitn(3, '\t');
        let Some(adds_raw) = parts.next() else { continue };
        let Some(dels_raw) = parts.next() else { continue };
        let Some(path_raw) = parts.next() else { continue };
        if !(adds_raw == "-" || (!adds_raw.is_empty() && adds_raw.bytes().all(|b| b.is_ascii_digit()))) {
            continue;
        }
        if !(dels_raw == "-" || (!dels_raw.is_empty() && dels_raw.bytes().all(|b| b.is_ascii_digit()))) {
            continue;
        }
        let additions = if adds_raw == "-" {
            None
        } else {
            adds_raw.parse::<u64>().ok()
        };
        let deletions = if dels_raw == "-" {
            None
        } else {
            dels_raw.parse::<u64>().ok()
        };
        let (path, original_path) = if path_raw.is_empty() {
            let orig = tokens.get(index).copied().unwrap_or("");
            index += 1;
            let next_path = tokens.get(index).copied().unwrap_or("");
            index += 1;
            (
                next_path.to_string(),
                if orig.is_empty() {
                    None
                } else {
                    Some(orig.to_string())
                },
            )
        } else {
            (path_raw.to_string(), None)
        };
        if path.is_empty() {
            continue;
        }
        entries.push(NumstatEntry {
            path,
            original_path,
            additions,
            deletions,
        });
    }
    entries
}

/// Parses `git diff -z --name-status`: `M\0path\0`, or `R100\0old\0new\0` for renames/copies.
pub fn parse_name_status_z(output: &str) -> Vec<NameStatusEntry> {
    let tokens: Vec<&str> = output.split('\0').collect();
    let mut entries = Vec::new();
    let mut index = 0usize;
    while index < tokens.len() {
        let code = tokens[index].trim();
        index += 1;
        if code.is_empty() {
            continue;
        }
        let letter = code.as_bytes()[0] as char;
        let status = match letter {
            'M' => "modified",
            'A' | 'C' => "added",
            'D' => "deleted",
            'R' => "renamed",
            'T' => "type-changed",
            'U' => "conflicted",
            _ => "modified",
        };
        if letter == 'R' || letter == 'C' {
            let orig = tokens.get(index).copied().unwrap_or("");
            index += 1;
            let path = tokens.get(index).copied().unwrap_or("");
            index += 1;
            if !path.is_empty() {
                entries.push(NameStatusEntry {
                    path: path.to_string(),
                    original_path: if letter == 'R' && !orig.is_empty() {
                        Some(orig.to_string())
                    } else {
                        None
                    },
                    status,
                });
            }
        } else {
            let path = tokens.get(index).copied().unwrap_or("");
            index += 1;
            if !path.is_empty() {
                entries.push(NameStatusEntry {
                    path: path.to_string(),
                    original_path: None,
                    status,
                });
            }
        }
    }
    entries
}

/// Splits a unified diff patch into one section per file, each starting at `diff --git `.
pub fn split_patch(patch: &str) -> Vec<&str> {
    let mut starts = Vec::new();
    let bytes = patch.as_bytes();
    let needle = b"diff --git ";
    let mut pos = 0usize;
    while pos < bytes.len() {
        let at_line_start = pos == 0 || bytes[pos - 1] == b'\n';
        if at_line_start && bytes[pos..].starts_with(needle) {
            starts.push(pos);
        }
        match bytes[pos..].iter().position(|&b| b == b'\n') {
            Some(nl) => pos += nl + 1,
            None => break,
        }
    }
    let mut sections = Vec::with_capacity(starts.len());
    for i in 0..starts.len() {
        let end = starts.get(i + 1).copied().unwrap_or(patch.len());
        sections.push(&patch[starts[i]..end]);
    }
    sections
}

/// Unquotes a C-quoted path printed by Git.
pub fn unquote_git_path(value: &str) -> String {
    if !value.starts_with('"') || !value.ends_with('"') || value.len() < 2 {
        return value.to_string();
    }
    let body = &value.as_bytes()[1..value.len() - 1];
    let mut out = Vec::with_capacity(body.len());
    let mut i = 0usize;
    while i < body.len() {
        if body[i] != b'\\' {
            out.push(body[i]);
            i += 1;
            continue;
        }
        let Some(&next) = body.get(i + 1) else {
            out.push(b'\\');
            break;
        };
        if (b'0'..=b'7').contains(&next) {
            let mut end = i + 2;
            while end < body.len() && end < i + 4 && (b'0'..=b'7').contains(&body[end]) {
                end += 1;
            }
            if let Ok(s) = std::str::from_utf8(&body[i + 1..end]) {
                if let Ok(oct) = u8::from_str_radix(s, 8) {
                    out.push(oct);
                    i = end;
                    continue;
                }
            }
        }
        let mapped = match next {
            b'a' => Some(7u8),
            b'b' => Some(8),
            b't' => Some(9),
            b'n' => Some(10),
            b'v' => Some(11),
            b'f' => Some(12),
            b'r' => Some(13),
            b'"' => Some(b'"'),
            b'\\' => Some(b'\\'),
            _ => None,
        };
        if let Some(byte) = mapped {
            out.push(byte);
            i += 2;
        } else {
            out.push(b'\\');
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Extracts the file path a patch section belongs to (matching `sectionPath` in `gitReview.ts`).
pub fn section_path(section: &str) -> Option<String> {
    let head_end = section
        .find("\n@@ ")
        .map(|i| i + 1)
        .unwrap_or_else(|| {
            let mut limit = section.len().min(4096);
            while limit > 0 && !section.is_char_boundary(limit) {
                limit -= 1;
            }
            limit
        });
    let head = &section[..head_end];
    let lines: Vec<&str> = head.split('\n').collect();

    let prefixed = |marker: &str, prefix: &str| -> Option<String> {
        let line = lines.iter().find(|l| l.starts_with(marker))?;
        let raw = line[marker.len()..].trim_end_matches('\t');
        let value = unquote_git_path(raw);
        if value == "/dev/null" {
            None
        } else {
            value.strip_prefix(prefix).map(ToString::to_string)
        }
    };

    if let Some(plus) = prefixed("+++ ", "b/") {
        return Some(plus);
    }
    if let Some(renamed) = lines.iter().find(|l| l.starts_with("rename to ")) {
        return Some(unquote_git_path(&renamed["rename to ".len()..]));
    }
    if let Some(minus) = prefixed("--- ", "a/") {
        return Some(minus);
    }
    let header = lines
        .first()
        .and_then(|l| l.strip_prefix("diff --git "))
        .unwrap_or("");
    if header.starts_with('"') {
        // Parse quoted first token, then space, then second token.
        let bytes = header.as_bytes();
        let mut i = 1usize;
        while i < bytes.len() {
            if bytes[i] == b'\\' {
                i += 2;
                continue;
            }
            if bytes[i] == b'"' {
                i += 1;
                break;
            }
            i += 1;
        }
        if bytes.get(i) == Some(&b' ') {
            let second = &header[i + 1..];
            let val = unquote_git_path(second);
            return val.strip_prefix("b/").map(ToString::to_string);
        }
        return None;
    }
    if header.len() >= 5 && (header.len() - 5).is_multiple_of(2) {
        let len = (header.len() - 5) / 2;
        if len > 0
            && header.starts_with("a/")
            && header.is_char_boundary(2 + len)
            && header.is_char_boundary(5 + len)
            && &header[2 + len..5 + len] == " b/"
            && header[2..2 + len] == header[5 + len..]
        {
            return Some(header[2..2 + len].to_string());
        }
    }
    None
}

/// Returns true when Git reports a binary file diff in a section.
pub fn section_is_binary(section: &str) -> bool {
    section.lines().any(|line| {
        (line.starts_with("Binary files ") && line.ends_with(" differ"))
            || line == "GIT binary patch"
    })
}

/// Detects PNG, GIF, WebP, or JPEG raster images strictly from magic bytes (never filenames),
/// returning MIME type and decoded pixel dimensions matching `src/main/files/imagePreview.ts`.
pub fn detect_raster_image(buf: &[u8]) -> Option<RasterImageInfo> {
    // PNG
    if buf.len() >= 33
        && &buf[0..8] == b"\x89PNG\r\n\x1a\n"
        && &buf[12..16] == b"IHDR"
        && u32::from_be_bytes([buf[8], buf[9], buf[10], buf[11]]) == 13
    {
        let width = u32::from_be_bytes([buf[16], buf[17], buf[18], buf[19]]);
        let height = u32::from_be_bytes([buf[20], buf[21], buf[22], buf[23]]);
        return Some(RasterImageInfo {
            mime: "image/png",
            width,
            height,
        });
    }
    // GIF
    if buf.len() >= 13 && (&buf[0..6] == b"GIF87a" || &buf[0..6] == b"GIF89a") {
        let width = u16::from_le_bytes([buf[6], buf[7]]) as u32;
        let height = u16::from_le_bytes([buf[8], buf[9]]) as u32;
        return Some(RasterImageInfo {
            mime: "image/gif",
            width,
            height,
        });
    }
    // WebP
    if buf.len() >= 30 && &buf[0..4] == b"RIFF" && &buf[8..12] == b"WEBP" {
        let kind = &buf[12..16];
        if kind == b"VP8X" {
            let width = 1 + u32::from_le_bytes([buf[24], buf[25], buf[26], 0]);
            let height = 1 + u32::from_le_bytes([buf[27], buf[28], buf[29], 0]);
            return Some(RasterImageInfo {
                mime: "image/webp",
                width,
                height,
            });
        }
        if kind == b"VP8L" && buf[20] == 0x2f {
            let packed = u32::from_le_bytes([buf[21], buf[22], buf[23], buf[24]]);
            let width = 1 + (packed & 0x3fff);
            let height = 1 + ((packed >> 14) & 0x3fff);
            return Some(RasterImageInfo {
                mime: "image/webp",
                width,
                height,
            });
        }
        if kind == b"VP8 " && &buf[23..26] == b"\x9d\x01\x2a" {
            let width = (u16::from_le_bytes([buf[26], buf[27]]) & 0x3fff) as u32;
            let height = (u16::from_le_bytes([buf[28], buf[29]]) & 0x3fff) as u32;
            return Some(RasterImageInfo {
                mime: "image/webp",
                width,
                height,
            });
        }
    }
    // JPEG
    if buf.len() >= 4 && buf[0] == 0xff && buf[1] == 0xd8 {
        let mut offset = 2usize;
        while offset + 4 <= buf.len() && buf[offset] == 0xff {
            while offset < buf.len() && buf[offset] == 0xff {
                offset += 1;
            }
            if offset >= buf.len() {
                break;
            }
            let marker = buf[offset];
            offset += 1;
            if marker == 0xda || marker == 0xd9 {
                break;
            }
            if marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
                continue;
            }
            if offset + 2 > buf.len() {
                break;
            }
            let length = u16::from_be_bytes([buf[offset], buf[offset + 1]]) as usize;
            if length < 2 || offset + length > buf.len() {
                break;
            }
            if matches!(
                marker,
                0xc0 | 0xc1
                    | 0xc2
                    | 0xc3
                    | 0xc5
                    | 0xc6
                    | 0xc7
                    | 0xc9
                    | 0xca
                    | 0xcb
                    | 0xcd
                    | 0xce
                    | 0xcf
            ) && length >= 8
            {
                let height = u16::from_be_bytes([buf[offset + 3], buf[offset + 4]]) as u32;
                let width = u16::from_be_bytes([buf[offset + 5], buf[offset + 6]]) as u32;
                return Some(RasterImageInfo {
                    mime: "image/jpeg",
                    width,
                    height,
                });
            }
            offset += length;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_numstat_name_status_and_patch_sections() {
        let numstat = "10\t2\tsrc/a.ts\x00-\t-\timg.png\x003\t1\t\x00old.ts\x00new.ts\x00";
        let ns = parse_numstat_z(numstat);
        assert_eq!(ns.len(), 3);
        assert_eq!(ns[0].path, "src/a.ts");
        assert_eq!(ns[0].additions, Some(10));
        assert_eq!(ns[1].additions, None);
        assert_eq!(ns[2].original_path.as_deref(), Some("old.ts"));
        assert_eq!(ns[2].path, "new.ts");

        let status = "M\0src/a.ts\0R100\0old.ts\0new.ts\0D\0gone.ts\0";
        let st = parse_name_status_z(status);
        assert_eq!(st.len(), 3);
        assert_eq!(st[0].status, "modified");
        assert_eq!(st[1].status, "renamed");
        assert_eq!(st[1].original_path.as_deref(), Some("old.ts"));
        assert_eq!(st[2].status, "deleted");

        let patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/bin.dat b/bin.dat\nBinary files a/bin.dat and b/bin.dat differ\n";
        let sections = split_patch(patch);
        assert_eq!(sections.len(), 2);
        assert_eq!(section_path(sections[0]).as_deref(), Some("src/a.ts"));
        assert!(!section_is_binary(sections[0]));
        assert_eq!(section_path(sections[1]).as_deref(), Some("bin.dat"));
        assert!(section_is_binary(sections[1]));
    }

    #[test]
    fn detects_png_and_rejects_fake_extension_text() {
        let mut png = vec![0u8; 33];
        png[0..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[8..12].copy_from_slice(&13u32.to_be_bytes());
        png[12..16].copy_from_slice(b"IHDR");
        png[16..20].copy_from_slice(&64u32.to_be_bytes());
        png[20..24].copy_from_slice(&32u32.to_be_bytes());
        assert_eq!(
            detect_raster_image(&png),
            Some(RasterImageInfo {
                mime: "image/png",
                width: 64,
                height: 32
            })
        );
        assert_eq!(detect_raster_image(b"not an image"), None);
    }
}
