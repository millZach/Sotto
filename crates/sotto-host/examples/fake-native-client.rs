//! A stand-in for a provider's native `.exe`, for the Rust host's integration tests on Windows, where the host finds
//! Claude Code only by its `.exe` name, as Node does (`tests/integration/rustHostProviders.test.ts`). Copied in as
//! `claude.exe`, it runs the program and leading arguments named one per line in the `.launch` file beside it, then
//! its own arguments, on its own standard streams, and exits as that program does.

use std::process::{Command, ExitCode};

fn main() -> ExitCode {
    let Ok(own) = std::env::current_exe() else { return ExitCode::FAILURE };
    let Ok(launch) = std::fs::read_to_string(own.with_extension("launch")) else { return ExitCode::FAILURE };
    let mut lines = launch.lines().filter(|line| !line.is_empty());
    let Some(program) = lines.next() else { return ExitCode::FAILURE };
    match Command::new(program).args(lines).args(std::env::args_os().skip(1)).status() {
        Ok(status) => ExitCode::from(status.code().and_then(|code| u8::try_from(code).ok()).unwrap_or(1)),
        Err(_) => ExitCode::FAILURE,
    }
}
