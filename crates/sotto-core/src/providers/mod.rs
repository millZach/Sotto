pub mod acp;
pub mod claude;
pub mod claude_history;
pub mod codex;
pub mod muse;
pub mod opencode;

pub use acp::{AcpAdapter, AcpAdapterConfig, AcpFlavor};
pub use claude::{ClaudeAdapter, ClaudeAdapterConfig};
pub use claude_history::{
    claude_project_dir, fork_claude_session, read_claude_session_transcript, ClaudeTranscriptMessage,
};
pub use codex::{CodexAdapter, CodexAdapterConfig};
pub use muse::{MuseAdapter, MuseAdapterConfig};
pub use opencode::{OpenCodeAdapter, OpenCodeAdapterConfig};

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}
