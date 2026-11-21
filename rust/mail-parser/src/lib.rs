//! mail-parser — fast MIME parsing for Temp Mail v2 (turjaun.xyz).
//!
//! Pure-Rust core (`parse_email_impl`, `extract_otp_impl`,
//! `extract_links_impl`) with no platform dependencies, compiled two ways:
//!   * `cdylib` via wasm-pack -> WASM used by the Cloudflare Worker and by
//!     Node.js (the `#[wasm_bindgen]` exports at the bottom of the core).
//!   * `rlib` -> linked directly by native Rust binaries/tests.
//!
//! It is a drop-in, much faster replacement for the v1 JavaScript
//! `parseRaw()` in `src/worker-v1-baseline.js`: same output shape
//! (`subject`, `from`, `text`, `html`), same 50_000-char body cap, plus
//! RFC 2047 encoded-word header decoding, recursive multipart handling,
//! and keyword-aware OTP extraction.
//!
//! Decoders (base64, quoted-printable) are implemented by hand so the
//! crate needs no dependencies beyond serde / serde_json / wasm-bindgen.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Maximum characters kept for each of `text` / `html`, matching v1.
pub const MAX_BODY_CHARS: usize = 50_000;

/// Parsed email, serialised to JSON by the WASM `parse_email` export.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ParsedEmail {
    pub subject: String,
    pub from: String,
    pub text: String,
    pub html: String,
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/// Split a raw message (or a MIME part) into its header block and body.
/// Handles `\r\n\r\n`, `\n\n` and mixed separators.
fn split_head_body(raw: &str) -> (&str, &str) {
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // End of a line: look for an empty line following it.
        if bytes[i] == b'\n' {
            let rest = &raw[i + 1..];
            if rest.starts_with('\n') {
                return (&raw[..i], &rest[1..]);
            }
            if rest.starts_with("\r\n") {
                return (&raw[..i], &rest[2..]);
            }
        }
        i += 1;
    }
    // No separator: everything is headers, or everything is body-less.
    if raw.contains(':') {
        (raw, "")
    } else {
        ("", raw)
    }
}

/// Parse a header block into `(lowercase_name, value)` pairs, unfolding
/// continuation lines (lines starting with space/tab) per RFC 5322 §2.2.3.
pub fn parse_headers(head: &str) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> = Vec::new();
    for line in head.lines() {
        if (line.starts_with(' ') || line.starts_with('\t')) && !headers.is_empty() {
            let last = headers.last_mut().expect("checked non-empty");
            last.1.push(' ');
            last.1.push_str(line.trim());
            continue;
        }
        if let Some(idx) = line.find(':') {
            let name = line[..idx].trim().to_ascii_lowercase();
            let value = line[idx + 1..].trim().to_string();
            if !name.is_empty() {
                headers.push((name, value));
            }
        }
    }
    headers
}

/// First value of header `name` (already lowercase), if present.
fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.as_str())
}

// ---------------------------------------------------------------------------
// Manual decoders: base64 + quoted-printable
// ---------------------------------------------------------------------------

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Decode base64, ignoring whitespace and stopping at `=` padding.
/// Invalid characters are skipped (matching the lenient `atob` behaviour
/// of the v1 parser, which ignored failures rather than dropping mail).
pub fn decode_base64(input: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4 + 3);
    let mut acc: u32 = 0;
    let mut nbits: u32 = 0;
    for &b in input.as_bytes() {
        if b == b'=' {
            break;
        }
        let v = match base64_value(b) {
            Some(v) => v,
            None => continue, // whitespace / stray characters
        };
        acc = (acc << 6) | v as u32;
        nbits += 6;
        if nbits >= 8 {
            nbits -= 8;
            out.push((acc >> nbits) as u8);
        }
    }
    out
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Decode quoted-printable: `=XX` hex escapes and soft line breaks
/// (`=\r\n` / `=\n`). When `q_encoding` is true (RFC 2047 header words),
/// `_` also decodes to a space.
pub fn decode_quoted_printable(input: &str, q_encoding: bool) -> Vec<u8> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'=' => {
                // Soft line break.
                if bytes.get(i + 1) == Some(&b'\r') && bytes.get(i + 2) == Some(&b'\n') {
                    i += 3;
                } else if bytes.get(i + 1) == Some(&b'\n') {
                    i += 2;
                } else if let (Some(h), Some(l)) = (
                    bytes.get(i + 1).and_then(|b| hex_value(*b)),
                    bytes.get(i + 2).and_then(|b| hex_value(*b)),
                ) {
                    out.push((h << 4) | l);
                    i += 3;
                } else {
                    out.push(b'=');
                    i += 1;
                }
            }
            b'_' if q_encoding => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    out
}

/// Decode a body according to its Content-Transfer-Encoding.
fn decode_transfer(body: &str, encoding: &str) -> String {
    match encoding.trim().to_ascii_lowercase().as_str() {
        "base64" => String::from_utf8_lossy(&decode_base64(body)).into_owned(),
        "quoted-printable" => {
            String::from_utf8_lossy(&decode_quoted_printable(body, false)).into_owned()
        }
        // 7bit / 8bit / binary / absent: pass through.
        _ => body.to_string(),
    }
}

// ---------------------------------------------------------------------------
// RFC 2047 encoded-word header decoding (=?charset?B/Q?...?=)
// ---------------------------------------------------------------------------

/// Decode any RFC 2047 encoded-words in a header value (subjects and
/// display names are the common cases). Unknown charsets fall back to
/// UTF-8 lossy decoding, which covers the overwhelmingly common UTF-8
/// (and ASCII-superset) senders.
pub fn decode_header_value(value: &str) -> String {
    if !value.contains("=?") {
        return value.to_string();
    }
    let mut out = String::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut i = 0;
    let mut last_was_word = false;
    while i < bytes.len() {
        if bytes[i] == b'=' && bytes.get(i + 1) == Some(&b'?') {
            // Try to parse =?charset?enc?text?=
            if let Some(rel_end) = value[i + 2..].find("?=") {
                let inner = &value[i + 2..i + 2 + rel_end];
                let mut parts = inner.splitn(3, '?');
                let _charset = parts.next().unwrap_or("");
                let enc = parts.next().unwrap_or("");
                let text = parts.next().unwrap_or("");
                let decoded = if enc.eq_ignore_ascii_case("B") {
                    String::from_utf8_lossy(&decode_base64(text)).into_owned()
                } else if enc.eq_ignore_ascii_case("Q") {
                    String::from_utf8_lossy(&decode_quoted_printable(text, true)).into_owned()
                } else {
                    String::new()
                };
                if enc.eq_ignore_ascii_case("B") || enc.eq_ignore_ascii_case("Q") {
                    out.push_str(&decoded);
                    i += 2 + rel_end + 2;
                    last_was_word = true;
                    continue;
                }
            }
        }
        // Whitespace between two encoded-words is dropped (RFC 2047 §6.2);
        // all other text is copied verbatim, one char at a time.
        let ch_len = value[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        let ch = &value[i..i + ch_len];
        if !(last_was_word && ch.trim().is_empty() && value[i..].contains("=?")) {
            out.push_str(ch);
        }
        if !ch.trim().is_empty() {
            last_was_word = false;
        }
        i += ch_len;
    }
    out.trim().to_string()
}

// ---------------------------------------------------------------------------
// Content-Type parsing + multipart walking
// ---------------------------------------------------------------------------

struct ContentType {
    mime: String,
    boundary: Option<String>,
}

fn parse_content_type(value: Option<&str>) -> ContentType {
    let value = value.unwrap_or("text/plain");
    let mut segments = value.split(';');
    let mime = segments
        .next()
        .unwrap_or("text/plain")
        .trim()
        .to_ascii_lowercase();
    let mut boundary = None;
    for seg in segments {
        let seg = seg.trim();
        if let Some(eq) = seg.find('=') {
            let (k, v) = (seg[..eq].trim().to_ascii_lowercase(), seg[eq + 1..].trim());
            if k == "boundary" {
                boundary = Some(v.trim_matches('"').to_string());
            }
        }
    }
    ContentType { mime, boundary }
}

/// Strip HTML tags and collapse whitespace (v1 behaviour for HTML-only
/// mail), decoding the handful of entities that carry meaning in text.
fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    let out = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(s: String) -> String {
    if s.chars().count() <= MAX_BODY_CHARS {
        s
    } else {
        s.chars().take(MAX_BODY_CHARS).collect()
    }
}

/// Walk one MIME entity (headers + body), accumulating text/plain into
/// `text` and text/html into `html`. Recurses into multipart/* parts.
fn walk_entity(headers: &[(String, String)], body: &str, text: &mut String, html: &mut String) {
    let ct = parse_content_type(header(headers, "content-type"));
    if ct.mime.starts_with("multipart/") {
        if let Some(boundary) = ct.boundary {
            let delimiter = format!("--{}", boundary);
            for segment in body.split(&delimiter) {
                // Preamble (before first delimiter) and epilogue (the
                // segment starting with "--" after the closing delimiter).
                let segment = segment.strip_prefix("--").map_or(segment, |_| "");
                let segment = segment
                    .strip_prefix("\r\n")
                    .or_else(|| segment.strip_prefix('\n'))
                    .unwrap_or(segment);
                if segment.trim().is_empty() {
                    continue;
                }
                // Drop the single CRLF that precedes the next delimiter.
                let segment = segment
                    .strip_suffix("\r\n")
                    .or_else(|| segment.strip_suffix('\n'))
                    .unwrap_or(segment);
                let (phead, pbody) = split_head_body(segment);
                let pheaders = parse_headers(phead);
                // A segment with no header separator and no ':' is body
                // text of a header-less part; treat it as text/plain.
                if pheaders.is_empty() && !segment.contains(':') {
                    text.push_str(segment);
                    continue;
                }
                walk_entity(&pheaders, pbody, text, html);
            }
        }
        return;
    }
    let encoding = header(headers, "content-transfer-encoding").unwrap_or("");
    let decoded = decode_transfer(body, encoding);
    if ct.mime == "text/html" {
        html.push_str(&decoded);
    } else if ct.mime == "text/plain" || ct.mime.is_empty() {
        text.push_str(&decoded);
    }
    // Other types (attachments etc.) are intentionally not stored.
}

// ---------------------------------------------------------------------------
// Pure-Rust core API (also used natively via the rlib)
// ---------------------------------------------------------------------------

/// Parse a complete raw email. Pure Rust: no WASM / JS involvement.
pub fn parse_email_impl(raw: &str) -> ParsedEmail {
    let (head, body) = split_head_body(raw);
    let headers = parse_headers(head);
    let subject = header(&headers, "subject")
        .map(decode_header_value)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "(no subject)".to_string());
    let from = header(&headers, "from")
        .map(decode_header_value)
        .unwrap_or_default();

    let mut text = String::new();
    let mut html = String::new();
    walk_entity(&headers, body, &mut text, &mut html);
    if text.trim().is_empty() && !html.is_empty() {
        text = strip_html(&html);
    }
    ParsedEmail {
        subject,
        from,
        text: truncate_chars(text),
        html: truncate_chars(html),
    }
}

const OTP_KEYWORDS: &[&str] = &[
    "code",
    "otp",
    "verification",
    "verify",
    "verifying",
    "passcode",
    "pin",
    "one-time",
    "one time",
    "security",
    "confirmation",
    "confirm",
    "auth",
];

/// All maximal digit runs of length 4..=8, as (start_byte, digits).
/// Runs longer than 8 digits are rejected whole (they are order /
/// tracking / phone numbers far more often than OTPs).
fn digit_candidates(text: &str) -> Vec<(usize, &str)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            let run = &text[start..i];
            if (4..=8).contains(&run.len()) {
                out.push((start, run));
            }
        } else {
            i += 1;
        }
    }
    out
}

/// Extract a 4–8 digit one-time code. Candidates near a keyword
/// ("code", "otp", "verification", …) within a small window win over
/// earlier unrelated numbers; otherwise the first candidate is used,
/// matching the v1 fallback behaviour.
pub fn extract_otp_impl(text: &str) -> Option<String> {
    let candidates = digit_candidates(text);
    if candidates.is_empty() {
        return None;
    }
    let lower = text.to_ascii_lowercase();
    let mut best: Option<(i32, usize, &str)> = None; // (score, start, digits)
    for &(start, digits) in &candidates {
        let end = start + digits.len();
        let win_start = start.saturating_sub(48);
        let win_end = (end + 24).min(lower.len());
        // Snap the window to char boundaries of the lowercased copy
        // (same byte layout as `text` for ASCII-lowered content; fall
        // back to the full string if a boundary does not line up).
        let window = lower.get(win_start..win_end).unwrap_or(&lower);
        let mut score: i32 = 0;
        for (wi, kw) in OTP_KEYWORDS.iter().enumerate() {
            if window.contains(kw) {
                // Stronger keywords ("otp", "verification") score a bit
                // higher than generic ones ("auth", "confirm").
                score += match *kw {
                    "otp" | "verification" | "passcode" | "one-time" => 30,
                    "code" | "verify" | "verifying" => 20,
                    _ => 10,
                };
                let _ = wi;
            }
        }
        // Prefer the earliest candidate on ties.
        let replace = match best {
            None => true,
            Some((bs, bstart, _)) => score > bs || (score == bs && start < bstart),
        };
        if replace {
            best = Some((score, start, digits));
        }
    }
    best.map(|(_, _, digits)| digits.to_string())
}

/// Extract http:// / https:// links, in order, de-duplicated, with
/// trailing sentence punctuation stripped.
pub fn extract_links_impl(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let rest = &text[i..];
        let scheme_len = if rest.starts_with("https://") {
            8
        } else if rest.starts_with("http://") {
            7
        } else {
            i += 1;
            continue;
        };
        let mut end = i + scheme_len;
        while end < bytes.len() {
            let b = bytes[end];
            if b.is_ascii_whitespace()
                || matches!(b, b'<' | b'>' | b'"' | b'\'' | b')' | b']' | b'}')
            {
                break;
            }
            end += 1;
        }
        let mut link = &text[i..end];
        while link.ends_with(|c| matches!(c, '.' | ',' | ';' | ':' | '!' | '?')) {
            link = &link[..link.len() - 1];
        }
        if link.len() > scheme_len && !out.iter().any(|l| l == link) {
            out.push(link.to_string());
        }
        i = end.max(i + 1);
    }
    out
}

// ---------------------------------------------------------------------------
// WASM exports (wasm-bindgen). Return types are kept to String /
// Option<String> / Vec<String>, all of which wasm-bindgen maps cleanly
// to JS string / string|null / string[].
// ---------------------------------------------------------------------------

/// Parse a raw email, returning a JSON string:
/// `{"subject": "...", "from": "...", "text": "...", "html": "..."}`.
#[wasm_bindgen]
pub fn parse_email(raw: &str) -> String {
    let parsed = parse_email_impl(raw);
    serde_json::to_string(&parsed).unwrap_or_else(|_| {
        "{\"subject\":\"(no subject)\",\"from\":\"\",\"text\":\"\",\"html\":\"\"}".to_string()
    })
}

/// Extract a 4–8 digit OTP, preferring codes near keywords such as
/// "code" / "otp" / "verification". Returns null in JS when none found.
#[wasm_bindgen]
pub fn extract_otp(text: &str) -> Option<String> {
    extract_otp_impl(text)
}

/// Extract links, returned to JS as an array of strings.
#[wasm_bindgen]
pub fn extract_links(text: &str) -> Vec<String> {
    extract_links_impl(text)
}

/// Same as `extract_links`, but as a serde JSON string
/// (e.g. `"[\"https://example.com\"]"`) for hosts that prefer to pass
/// strings across the boundary, such as some Node.js WASM loaders.
#[wasm_bindgen]
pub fn extract_links_json(text: &str) -> String {
    serde_json::to_string(&extract_links_impl(text)).unwrap_or_else(|_| "[]".to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn otp_prefers_code_near_keyword() {
        let text = "Order 1234 shipped. Your verification code is 482910. Thanks";
        assert_eq!(extract_otp_impl(text).as_deref(), Some("482910"));
    }

    #[test]
    fn otp_near_otp_keyword() {
        let text = "Use OTP 7712 to sign in. Ref 99887766.";
        // 7712 sits next to "OTP"; the 8-digit ref does not.
        assert_eq!(extract_otp_impl(text).as_deref(), Some("7712"));
    }

    #[test]
    fn otp_fallback_is_first_candidate() {
        assert_eq!(
            extract_otp_impl("Call 5551234 now").as_deref(),
            Some("5551234")
        );
    }

    #[test]
    fn otp_rejects_short_and_long_runs() {
        assert_eq!(extract_otp_impl("pin 123 here"), None);
        assert_eq!(extract_otp_impl("id 123456789 here"), None);
        assert_eq!(extract_otp_impl("no digits at all"), None);
    }

    #[test]
    fn headers_unfold_continuation_lines() {
        let headers = parse_headers("Subject: A very long\r\n\tsubject line\r\nFrom: a@b.c");
        assert_eq!(header(&headers, "subject"), Some("A very long subject line"));
        assert_eq!(header(&headers, "from"), Some("a@b.c"));
    }

    #[test]
    fn parses_simple_plain_mail() {
        let raw = "Subject: Hello 123456\r\nFrom: Sender <s@example.com>\r\nContent-Type: text/plain\r\n\r\nYour code is 123456";
        let mail = parse_email_impl(raw);
        assert_eq!(mail.subject, "Hello 123456");
        assert_eq!(mail.from, "Sender <s@example.com>");
        assert!(mail.text.contains("Your code is 123456"));
        assert_eq!(mail.html, "");
    }

    #[test]
    fn parses_base64_body() {
        // "SGVsbG8gV29ybGQ=" == "Hello World"
        let raw = "Subject: B64\r\nFrom: a@b.c\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\nSGVsbG8gV29ybGQ=";
        let mail = parse_email_impl(raw);
        assert_eq!(mail.text, "Hello World");
    }

    #[test]
    fn parses_quoted_printable_body() {
        let raw = "Subject: QP\r\nFrom: a@b.c\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\ncaf=C3=A9 time=\r\ntable";
        let mail = parse_email_impl(raw);
        assert_eq!(mail.text, "café timetable");
    }

    #[test]
    fn parses_multipart_text_and_html() {
        let raw = concat!(
            "Subject: Multi\r\nFrom: a@b.c\r\n",
            "Content-Type: multipart/alternative; boundary=\"XYZ\"\r\n\r\n",
            "--XYZ\r\nContent-Type: text/plain\r\n\r\nplain body\r\n",
            "--XYZ\r\nContent-Type: text/html\r\n\r\n<p>html body</p>\r\n",
            "--XYZ--\r\n"
        );
        let mail = parse_email_impl(raw);
        assert!(mail.text.contains("plain body"), "text was: {:?}", mail.text);
        assert!(mail.html.contains("html body"), "html was: {:?}", mail.html);
    }

    #[test]
    fn html_only_mail_derives_text() {
        let raw = "Subject: H\r\nFrom: a@b.c\r\nContent-Type: text/html\r\n\r\n<p>Hello <b>there</b></p>";
        let mail = parse_email_impl(raw);
        assert!(mail.html.contains("<b>there</b>"));
        assert_eq!(mail.text, "Hello there");
    }

    #[test]
    fn encoded_word_subject_decodes() {
        // =?UTF-8?B?SGVsbG8=?= == "Hello"
        assert_eq!(decode_header_value("=?UTF-8?B?SGVsbG8=?= World"), "Hello World");
        // =?UTF-8?Q?caf=C3=A9?= == "café"
        assert_eq!(decode_header_value("=?UTF-8?Q?caf=C3=A9?="), "café");
    }

    #[test]
    fn links_extracted_deduped_and_trimmed() {
        let text = "See https://example.com/a, then http://x.io/b. Again https://example.com/a";
        assert_eq!(
            extract_links_impl(text),
            vec!["https://example.com/a".to_string(), "http://x.io/b".to_string()]
        );
        assert_eq!(
            extract_links_json("go https://a.b/c"),
            "[\"https://a.b/c\"]"
        );
    }

    #[test]
    fn parse_email_json_shape() {
        let raw = "Subject: Hi\r\nFrom: a@b.c\r\n\r\nbody";
        let json = parse_email(raw);
        let v: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(v["subject"], "Hi");
        assert_eq!(v["from"], "a@b.c");
        assert_eq!(v["text"], "body");
        assert_eq!(v["html"], "");
    }
}
