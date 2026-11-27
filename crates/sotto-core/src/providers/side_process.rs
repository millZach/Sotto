//! What a side call's client prints (ADR-0026), read as Node's Codex and Grok side calls read it: standard output a line
//! at a time, standard error drained alongside it, both counted against one output limit, and neither kept beyond the
//! line being read nor logged.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

/// Starts `command` on only the host's variables `keys` names (lowercase), in the case the host has them, as Node's
/// allow-lists filter `process.env` for each client Sotto starts.
pub(crate) fn keep_only_environment(command: &mut tokio::process::Command, keys: &[&str]) {
    command.env_clear();
    for (key, value) in std::env::vars_os() {
        if key.to_str().is_some_and(|key| keys.contains(&key.to_ascii_lowercase().as_str())) {
            command.env(key, value);
        }
    }
}

/// The model check Node's Codex and Grok side calls both make, Codex's ``/^[a-z0-9][a-z0-9._:/-]{0,159}$/iu`` and Grok's
/// `IDENTIFIER`: 1 to 160 characters, a letter or digit first, then letters, digits and `._:/-`, in either case.
pub(crate) fn valid_model_id(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric()) && text.len() <= 160 && chars.all(|c| c.is_ascii_alphanumeric() || "._:/-".contains(c))
}

/// The effort check every Node side call makes, ``/^[a-z][a-z0-9_-]{0,31}$/u`` and Grok's `EFFORT`: 1 to 32 characters,
/// a lowercase letter first, then lowercase letters, digits, `_` and `-`.
pub(crate) fn valid_effort(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase()) && text.len() <= 32 && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// The client printed more than its limit, standard output and error together.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OverLimit;

/// A side call's client output, its standard error drained on a task of its own.
pub(crate) struct SideOutput<R> {
    stdout: R,
    buffer: Vec<u8>,
    printed: Arc<AtomicUsize>,
    overflow: Arc<Notify>,
    limit: usize,
    closed: bool,
    /// Whether text after the last line break counts as a line once the output closes, as Node's Codex call reads it.
    /// Node's Grok call drops it.
    last_unbroken_line: bool,
    stderr: JoinHandle<()>,
}

impl<R: AsyncRead + Unpin> SideOutput<R> {
    pub(crate) fn new<E: AsyncRead + Unpin + Send + 'static>(stdout: R, stderr: E, limit: usize, last_unbroken_line: bool) -> Self {
        let printed = Arc::new(AtomicUsize::new(0));
        let overflow = Arc::new(Notify::new());
        let stderr = tokio::spawn({
            let printed = Arc::clone(&printed);
            let overflow = Arc::clone(&overflow);
            async move {
                let mut pipe = stderr;
                let mut chunk = [0u8; 8192];
                loop {
                    match pipe.read(&mut chunk).await {
                        Ok(0) => return,
                        Ok(read) => {
                            if printed.fetch_add(read, Ordering::SeqCst) + read > limit {
                                overflow.notify_one();
                                return;
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(_) => return,
                    }
                }
            }
        });
        Self { stdout, buffer: Vec::new(), printed, overflow, limit, closed: false, last_unbroken_line, stderr }
    }

    /// The next line without its line break, `None` once the client has closed its output. Safe to cancel: a line
    /// part-read stays for the next call.
    pub(crate) async fn next_line(&mut self) -> Result<Option<String>, OverLimit> {
        loop {
            // Counted before anything waiting is handed on, as Node fails the call the moment either stream passes it.
            if self.printed.load(Ordering::SeqCst) > self.limit {
                return Err(OverLimit);
            }
            if let Some(at) = self.buffer.iter().position(|byte| *byte == b'\n') {
                let line: Vec<u8> = self.buffer.drain(..=at).collect();
                return Ok(Some(String::from_utf8_lossy(&line[..at]).into_owned()));
            }
            if self.closed {
                let rest = std::mem::take(&mut self.buffer);
                return Ok((self.last_unbroken_line && !rest.is_empty()).then(|| String::from_utf8_lossy(&rest).into_owned()));
            }
            let mut chunk = [0u8; 8192];
            let read = tokio::select! {
                biased;
                () = self.overflow.notified() => return Err(OverLimit),
                read = self.stdout.read(&mut chunk) => read,
            };
            match read {
                Ok(0) => self.closed = true,
                Ok(read) => {
                    if self.printed.fetch_add(read, Ordering::SeqCst) + read > self.limit {
                        return Err(OverLimit);
                    }
                    self.buffer.extend_from_slice(&chunk[..read]);
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => self.closed = true,
            }
        }
    }
}

impl<R> Drop for SideOutput<R> {
    fn drop(&mut self) {
        self.stderr.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    #[test]
    fn checks_the_model_and_effort_as_node_does() {
        for model in ["gpt-5.5", "o3", "Fixture-Model", "a/b:c_d.e", "grok-code-fast-1"] {
            assert!(valid_model_id(model), "{model}");
        }
        for model in ["", "-gpt", "gpt 5", "opus[1m]", &"a".repeat(161)] {
            assert!(!valid_model_id(model), "{model}");
        }
        assert!(valid_effort("low") && valid_effort("x_high-2"));
        assert!(!valid_effort("Low") && !valid_effort("") && !valid_effort("1low") && !valid_effort(&"a".repeat(33)));
    }

    #[test]
    fn reads_lines_and_keeps_or_drops_the_last_unbroken_one() {
        let runtime = runtime();
        runtime.block_on(async {
            let mut kept = SideOutput::new(&b"one\r\n\ntwo\nthree"[..], &b""[..], 100, true);
            let mut lines = Vec::new();
            while let Some(line) = kept.next_line().await.unwrap() {
                lines.push(line);
            }
            assert_eq!(lines, ["one\r", "", "two", "three"]);
            let mut dropped = SideOutput::new(&b"one\nthree"[..], &b""[..], 100, false);
            assert_eq!(dropped.next_line().await, Ok(Some("one".into())));
            assert_eq!(dropped.next_line().await, Ok(None));
        });
    }

    #[test]
    fn counts_standard_output_and_error_together_against_the_limit() {
        let runtime = runtime();
        runtime.block_on(async {
            // Standard output that says nothing and stays open, while the error stream alone passes the limit.
            let (quiet, _open) = tokio::io::duplex(64);
            let mut output = SideOutput::new(quiet, &[b'x'; 21][..], 20, true);
            assert_eq!(output.next_line().await, Err(OverLimit));
            let (quiet, mut open) = tokio::io::duplex(64);
            tokio::io::AsyncWriteExt::write_all(&mut open, b"0123456789\n").await.unwrap();
            // Up to the limit is kept; the next bytes past it stop the read, whichever stream they came on.
            let mut output = SideOutput::new(quiet, &[b'x'; 9][..], 20, true);
            assert_eq!(output.next_line().await, Ok(Some("0123456789".into())));
            tokio::io::AsyncWriteExt::write_all(&mut open, b"more").await.unwrap();
            assert_eq!(output.next_line().await, Err(OverLimit));
            let mut alone = SideOutput::new(&[b'y'; 30][..], &b""[..], 20, true);
            assert_eq!(alone.next_line().await, Err(OverLimit));

            // Lines already read and a closed output are refused too once the error stream has passed the limit.
            let mut waiting = SideOutput::new(&b"one\ntwo\n"[..], &[b'x'; 15][..], 20, true);
            assert_eq!(waiting.next_line().await, Ok(Some("one".into())));
            while waiting.printed.load(Ordering::SeqCst) <= 20 {
                tokio::task::yield_now().await;
            }
            assert_eq!(waiting.next_line().await, Err(OverLimit));
        });
    }
}
