//! Shared PATH augmentation and CLI binary discovery for native providers and tools.
//!
//! Mirrors `src/main/agents/cliLookup.ts`, `src/main/app/guiPath.ts`, and provider-specific
//! lookup modules (`subscriptionClaude.ts`, `subscriptionCodex.ts`, `grokRpc.ts`, `devinRpc.ts`,
//! `cursorRpc.ts`, `hermesRpc.ts`, `museClientInstall.ts`, `opencodeLookup.ts`,
//! `antigravityLookup.ts`, `ghCommand.ts`).
//!
//! A remote `sotto-host` started via non-login SSH, systemd, or self-update frequently inherits
//! a bare `PATH=/usr/local/bin:/usr/bin:/bin`, missing user-installed binaries in `~/.local/bin`,
//! mise/asdf/nvm/fnm/volta/Homebrew, npm global prefixes, cargo, bun, pnpm, etc.
//!
//! Privacy: nothing in this module logs paths, usernames, or environment values.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::{Command as StdCommand, Stdio};
#[cfg(unix)]
use std::sync::{Mutex, OnceLock};
#[cfg(unix)]
use std::time::{Duration, Instant};

/// Every native provider adapter registered by `sotto-host`.
pub const NATIVE_PROVIDER_IDS: &[&str] = &[
    "codex",
    "claude",
    "grok",
    "devin",
    "muse",
    "opencode",
    "cursor",
    "hermes",
    "antigravity",
];

const DISPATCHERS: &[&str] = &["mise", "volta-shim"];
const WRAPPER_READ_BYTES: usize = 4 * 1024;
#[cfg(unix)]
const LOGIN_SHELL_MARKER: &str = "__SOTTO_LOGIN_PATH__";
#[cfg(unix)]
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(4);
#[cfg(unix)]
const LOGIN_SHELL_MAX_BYTES: usize = 64 * 1024;

#[cfg(unix)]
static LOGIN_SHELL_CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct CliLookupOptions {
    pub env: HashMap<String, String>,
    pub home: Option<PathBuf>,
    pub windows: bool,
    pub macos: bool,
    /// When `Some`, overrides login-shell probing (used in tests to avoid spawning a shell).
    pub login_shell_path: Option<Option<String>>,
}

impl Default for CliLookupOptions {
    fn default() -> Self {
        Self::from_process_env()
    }
}

impl CliLookupOptions {
    pub fn from_process_env() -> Self {
        let env: HashMap<String, String> = std::env::vars().collect();
        let windows = cfg!(windows);
        let macos = cfg!(target_os = "macos");
        let home = resolve_home_dir(&env, windows);
        Self {
            env,
            home,
            windows,
            macos,
            login_shell_path: None,
        }
    }

    pub fn env_get_ci(&self, name: &str) -> Option<&str> {
        if let Some(v) = self.env.get(name) {
            return Some(v.as_str());
        }
        self.env
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    fn path_value(&self) -> Option<&str> {
        self.env_get_ci("PATH")
    }

    fn path_delimiter(&self) -> char {
        if self.windows { ';' } else { ':' }
    }

    fn effective_home(&self) -> Option<PathBuf> {
        self.home
            .clone()
            .or_else(|| resolve_home_dir(&self.env, self.windows))
    }

    fn resolve_login_shell_path(&self) -> Option<String> {
        if let Some(ref overridden) = self.login_shell_path {
            return overridden.clone();
        }
        if self.windows {
            return None;
        }
        #[cfg(unix)]
        {
            probe_login_shell_path(&self.env)
        }
        #[cfg(not(unix))]
        {
            None
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedCli {
    pub executable: PathBuf,
    pub prefix_args: Vec<String>,
    pub augmented_path: String,
}

impl ResolvedCli {
    pub fn apply_tokio(&self, cmd: &mut tokio::process::Command) {
        if !self.augmented_path.is_empty() {
            cmd.env("PATH", &self.augmented_path);
        }
    }

    pub fn apply_std(&self, cmd: &mut std::process::Command) {
        if !self.augmented_path.is_empty() {
            cmd.env("PATH", &self.augmented_path);
        }
    }
}

#[derive(Debug, Clone)]
pub struct CliSpec {
    pub name: String,
    pub alt_names: Vec<String>,
    pub first: Vec<PathBuf>,
    pub last: Vec<PathBuf>,
    pub follow_realpath: bool,
    pub prefer_codex_vendor: bool,
    pub prefer_muse_maker: bool,
    /// Only `<name>.exe` on Windows, as Node's lookup looks: npm's `.cmd` and `.bat` launchers are passed over, since
    /// Windows starts a batch file only through a shell.
    pub exe_only: bool,
}

impl CliSpec {
    pub fn simple(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            alt_names: Vec::new(),
            first: Vec::new(),
            last: Vec::new(),
            follow_realpath: false,
            prefer_codex_vendor: false,
            prefer_muse_maker: false,
            exe_only: false,
        }
    }
}

fn resolve_home_dir(env: &HashMap<String, String>, windows: bool) -> Option<PathBuf> {
    let get = |key: &str| -> Option<&str> {
        env.get(key)
            .or_else(|| env.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v))
            .map(String::as_str)
            .filter(|v| !v.is_empty())
    };
    if windows {
        if let Some(up) = get("USERPROFILE") {
            return Some(PathBuf::from(up));
        }
        if let (Some(drive), Some(path)) = (get("HOMEDRIVE"), get("HOMEPATH")) {
            return Some(PathBuf::from(format!("{drive}{path}")));
        }
        if let Some(home) = get("HOME") {
            return Some(PathBuf::from(home));
        }
    } else if let Some(home) = get("HOME") {
        return Some(PathBuf::from(home));
    }
    None
}

fn absolute_path(val: Option<&str>) -> Option<PathBuf> {
    let raw = val?.trim();
    if raw.is_empty() {
        return None;
    }
    let p = PathBuf::from(raw);
    p.is_absolute().then_some(p)
}

fn split_path_entries(value: Option<&str>, delimiter: char) -> Vec<PathBuf> {
    let Some(raw) = value else {
        return Vec::new();
    };
    raw.split(delimiter)
        .map(|s| s.trim().trim_matches('"'))
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .collect()
}

fn normalize_folder_key(path: &Path, windows: bool) -> String {
    let raw = path.to_string_lossy();
    let trimmed = raw.trim_end_matches(['/', '\\']);
    if windows {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed.to_string()
    }
}

fn same_folder(a: &Path, b: &Path, windows: bool) -> bool {
    normalize_folder_key(a, windows) == normalize_folder_key(b, windows)
}

fn list_dir_entries(dir: &Path) -> Vec<String> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        if let Ok(ft) = entry.file_type() {
            if ft.is_dir() || ft.is_symlink() {
                if let Some(name) = entry.file_name().to_str() {
                    out.push(name.to_string());
                }
            }
        }
    }
    out
}

fn numeric_parts(name: &str) -> Vec<u64> {
    let mut parts = Vec::new();
    let mut cur: Option<u64> = None;
    for b in name.bytes() {
        if b.is_ascii_digit() {
            let d = (b - b'0') as u64;
            cur = Some(cur.unwrap_or(0).saturating_mul(10).saturating_add(d));
        } else if let Some(n) = cur.take() {
            parts.push(n);
        }
    }
    if let Some(n) = cur {
        parts.push(n);
    }
    parts
}

/// Sorts version folder names newest-first (`v24.1.0` before `v22.9.0`).
pub fn newest_first(names: &[String]) -> Vec<String> {
    let mut out = names.to_vec();
    out.sort_by(|a, b| {
        let x = numeric_parts(a);
        let y = numeric_parts(b);
        let len = x.len().max(y.len());
        for i in 0..len {
            let xv = x.get(i).copied();
            let yv = y.get(i).copied();
            if xv != yv {
                return yv.cmp(&xv);
            }
        }
        a.cmp(b)
    });
    out
}

fn named_first(tools: &[String], name: &str) -> Vec<String> {
    let rank = |tool: &str| -> u8 {
        if tool == name {
            0
        } else if tool.ends_with(&format!("-{name}")) || tool.contains(name) {
            1
        } else {
            2
        }
    };
    let mut out = tools.to_vec();
    out.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.cmp(b)));
    out
}

pub fn mise_data_folder(opts: &CliLookupOptions, home: &Path) -> Option<PathBuf> {
    if let Some(own) = absolute_path(opts.env_get_ci("MISE_DATA_DIR")) {
        return Some(own);
    }
    if !opts.windows {
        let xdg = absolute_path(opts.env_get_ci("XDG_DATA_HOME"))
            .unwrap_or_else(|| home.join(".local").join("share"));
        return Some(xdg.join("mise"));
    }
    absolute_path(opts.env_get_ci("LOCALAPPDATA")).map(|local| local.join("mise"))
}

fn npm_prefixes(opts: &CliLookupOptions, home: &Path) -> Vec<PathBuf> {
    let mut prefixes = Vec::new();
    if let Some(p) = absolute_path(opts.env_get_ci("npm_config_prefix")) {
        prefixes.push(p);
    }
    if let Ok(text) = fs::read_to_string(home.join(".npmrc")) {
        for line in text.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("prefix") {
                let rest = rest.trim_start();
                if let Some(val) = rest.strip_prefix('=') {
                    let cleaned = val.trim().trim_matches(|c| c == '"' || c == '\'');
                    let expanded = if let Some(sub) = cleaned.strip_prefix("~/") {
                        home.join(sub)
                    } else {
                        PathBuf::from(cleaned)
                    };
                    if expanded.is_absolute() {
                        prefixes.push(expanded);
                    }
                    break;
                }
            }
        }
    }
    prefixes
}

fn npm_folders(opts: &CliLookupOptions, home: &Path) -> Vec<PathBuf> {
    let prefixes = npm_prefixes(opts, home);
    if opts.windows {
        let mut out = prefixes;
        if let Some(appdata) = absolute_path(opts.env_get_ci("APPDATA")) {
            out.push(appdata.join("npm"));
        }
        return out;
    }
    let mut out: Vec<PathBuf> = prefixes.into_iter().map(|p| p.join("bin")).collect();
    out.push(home.join(".npm-global").join("bin"));
    out.push(home.join(".local").join("share").join("npm").join("bin"));
    out
}

fn user_bin_folders(opts: &CliLookupOptions, home: &Path) -> Vec<PathBuf> {
    let mut folders = vec![home.join(".local").join("bin")];
    let cargo = absolute_path(opts.env_get_ci("CARGO_HOME")).unwrap_or_else(|| home.join(".cargo"));
    folders.push(cargo.join("bin"));
    let bun = absolute_path(opts.env_get_ci("BUN_INSTALL")).unwrap_or_else(|| home.join(".bun"));
    folders.push(bun.join("bin"));

    if let Some(pnpm) = absolute_path(opts.env_get_ci("PNPM_HOME")) {
        folders.push(pnpm);
    }
    if opts.windows {
        if let Some(local) = absolute_path(opts.env_get_ci("LOCALAPPDATA")) {
            folders.push(local.join("pnpm"));
            folders.push(local.join("Yarn").join("bin"));
        }
    } else {
        let xdg_data = absolute_path(opts.env_get_ci("XDG_DATA_HOME"))
            .unwrap_or_else(|| home.join(".local").join("share"));
        folders.push(xdg_data.join("pnpm"));
        if opts.macos {
            folders.push(home.join("Library").join("pnpm"));
        }
        folders.push(home.join(".yarn").join("bin"));
    }
    folders
}

fn manager_folders(name: &str, opts: &CliLookupOptions, home: &Path) -> Vec<PathBuf> {
    let mut folders = Vec::new();
    if let Some(mise_data) = mise_data_folder(opts, home) {
        let installs = mise_data.join("installs");
        for tool in named_first(&list_dir_entries(&installs), name) {
            let tool_dir = installs.join(&tool);
            let latest = tool_dir.join("latest");
            let mut version_roots = Vec::new();
            if latest.exists() {
                version_roots.push(latest);
            }
            for ver in newest_first(&list_dir_entries(&tool_dir)) {
                if ver != "latest" {
                    version_roots.push(tool_dir.join(ver));
                }
            }
            for root in version_roots {
                folders.push(root.join("bin"));
                folders.push(root.clone());
                folders.push(root.join("node_modules").join(".bin"));
                if tool == name {
                    for unpacked in list_dir_entries(&root) {
                        if unpacked != "bin" && unpacked != "node_modules" {
                            folders.push(root.join(&unpacked).join("bin"));
                            folders.push(root.join(&unpacked));
                        }
                    }
                }
            }
        }
    }
    if opts.windows {
        return folders;
    }

    let asdf = absolute_path(opts.env_get_ci("ASDF_DATA_DIR")).unwrap_or_else(|| home.join(".asdf"));
    let asdf_installs = asdf.join("installs");
    for tool in named_first(&list_dir_entries(&asdf_installs), name) {
        for ver in newest_first(&list_dir_entries(&asdf_installs.join(&tool))) {
            folders.push(asdf_installs.join(&tool).join(ver).join("bin"));
        }
    }

    let nvm = absolute_path(opts.env_get_ci("NVM_DIR")).unwrap_or_else(|| home.join(".nvm"));
    let nvm_nodes = nvm.join("versions").join("node");
    for ver in newest_first(&list_dir_entries(&nvm_nodes)) {
        folders.push(nvm_nodes.join(ver).join("bin"));
    }

    let mut fnm_homes = Vec::new();
    if let Some(f) = absolute_path(opts.env_get_ci("FNM_DIR")) {
        fnm_homes.push(f);
    }
    fnm_homes.push(home.join(".local").join("share").join("fnm"));
    if opts.macos {
        fnm_homes.push(home.join("Library").join("Application Support").join("fnm"));
    }
    fnm_homes.push(home.join(".fnm"));
    for fnm in fnm_homes {
        folders.push(fnm.join("aliases").join("default").join("bin"));
        let versions = fnm.join("node-versions");
        for ver in newest_first(&list_dir_entries(&versions)) {
            folders.push(versions.join(ver).join("installation").join("bin"));
        }
    }

    let volta = absolute_path(opts.env_get_ci("VOLTA_HOME")).unwrap_or_else(|| home.join(".volta"));
    let packages = volta.join("tools").join("image").join("packages");
    for entry in named_first(&list_dir_entries(&packages), name) {
        if entry.starts_with('@') {
            for scoped in list_dir_entries(&packages.join(&entry)) {
                folders.push(packages.join(&entry).join(scoped).join("bin"));
            }
        } else {
            folders.push(packages.join(&entry).join("bin"));
        }
    }
    let volta_nodes = volta.join("tools").join("image").join("node");
    for ver in newest_first(&list_dir_entries(&volta_nodes)) {
        folders.push(volta_nodes.join(ver).join("bin"));
    }

    if let Some(hb) = absolute_path(opts.env_get_ci("HOMEBREW_PREFIX")) {
        folders.push(hb.join("bin"));
    }
    if opts.macos {
        folders.push(PathBuf::from("/opt/homebrew/bin"));
        folders.push(PathBuf::from("/opt/homebrew/sbin"));
    }
    folders.push(PathBuf::from("/usr/local/bin"));
    folders.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin"));
    folders.push(home.join(".linuxbrew").join("bin"));

    folders
}

fn shim_folders(opts: &CliLookupOptions, home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(mise) = mise_data_folder(opts, home) {
        out.push(mise.join("shims"));
    }
    if !opts.windows {
        let asdf = absolute_path(opts.env_get_ci("ASDF_DATA_DIR"))
            .unwrap_or_else(|| home.join(".asdf"));
        out.push(asdf.join("shims"));
    }
    out
}

pub fn is_dispatcher(real: &Path) -> bool {
    let Some(stem) = real.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    let lower = stem.to_ascii_lowercase();
    let stripped = lower.strip_suffix(".exe").unwrap_or(&lower);
    DISPATCHERS.contains(&stripped)
}

/// Returns true if `path` is a `#!` script invoking `mise x`, `mise exec`, `rtx x`, `rtx exec`, or
/// `asdf exec` (e.g. Omarchy's `~/.local/bin/claude` wrapper).
pub fn runs_through_manager(path: &Path) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut buf = [0u8; WRAPPER_READ_BYTES];
    let Ok(n) = file.read(&mut buf) else {
        return false;
    };
    if n < 2 || &buf[..2] != b"#!" {
        return false;
    }
    let text = String::from_utf8_lossy(&buf[..n]);
    for line in text.lines().skip(1) {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let tokens: Vec<&str> = trimmed
            .split(|c: char| c.is_whitespace() || matches!(c, ';' | '&' | '|' | '(' | '`' | '"' | '\''))
            .filter(|t| !t.is_empty())
            .collect();
        for pair in tokens.windows(2) {
            let cmd = pair[0].rsplit('/').next().unwrap_or(pair[0]);
            let sub = pair[1];
            if ((cmd == "mise" || cmd == "rtx") && (sub == "x" || sub == "exec"))
                || (cmd == "asdf" && sub == "exec")
            {
                return true;
            }
        }
    }
    false
}

fn is_executable_file(path: &Path, windows: bool) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    if windows {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        (meta.permissions().mode() & 0o111) != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn is_native_binary(path: &Path, windows: bool) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut head = [0u8; 4];
    if file.read_exact(&mut head).is_err() {
        return false;
    }
    if windows {
        head[0] == 0x4d && head[1] == 0x5a
    } else {
        matches!(
            head,
            [0x7f, b'E', b'L', b'F']
                | [0xcf, 0xfa, 0xed, 0xfe]
                | [0xfe, 0xed, 0xfa, 0xcf]
                | [0xfe, 0xed, 0xfa, 0xce]
                | [0xce, 0xfa, 0xed, 0xfe]
                | [0xca, 0xfe, 0xba, 0xbe]
                | [0xbe, 0xba, 0xfe, 0xca]
        )
    }
}

fn codex_vendor_candidates(folder: &Path, windows: bool, macos: bool) -> Vec<PathBuf> {
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    let triple = if windows {
        format!(
            "{}-pc-windows-msvc",
            if arch == "arm64" { "aarch64" } else { "x86_64" }
        )
    } else if macos {
        format!(
            "{}-apple-darwin",
            if arch == "arm64" { "aarch64" } else { "x86_64" }
        )
    } else {
        format!(
            "{}-unknown-linux-musl",
            if arch == "arm64" { "aarch64" } else { "x86_64" }
        )
    };
    let platform = if windows {
        "win32"
    } else if macos {
        "darwin"
    } else {
        "linux"
    };
    let pkg = format!("codex-{platform}-{arch}");
    let file = if windows { "codex.exe" } else { "codex" };
    let mut scopes = Vec::new();
    if windows {
        scopes.push(folder.join("node_modules").join("@openai"));
    } else if folder.file_name().and_then(|s| s.to_str()) == Some("bin") {
        if let Some(parent) = folder.parent() {
            scopes.push(parent.join("lib").join("node_modules").join("@openai"));
        }
    } else if folder.file_name().and_then(|s| s.to_str()) == Some(".bin")
        && folder
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            == Some("node_modules")
    {
        if let Some(nm) = folder.parent() {
            scopes.push(nm.join("@openai"));
        }
    }
    let mut out = Vec::new();
    for scope in scopes {
        out.push(
            scope
                .join("codex")
                .join("node_modules")
                .join("@openai")
                .join(&pkg)
                .join("vendor")
                .join(&triple)
                .join("bin")
                .join(file),
        );
        out.push(
            scope
                .join(&pkg)
                .join("vendor")
                .join(&triple)
                .join("bin")
                .join(file),
        );
        out.push(
            scope
                .join("codex")
                .join("vendor")
                .join(&triple)
                .join("bin")
                .join(file),
        );
    }
    out
}

fn muse_maker_binary(folder: &Path, windows: bool) -> Option<PathBuf> {
    let version = fs::read_to_string(folder.join(".muse-version")).ok()?;
    let version = version.trim();
    if version.is_empty() || version.len() > 64 || version.contains(['/', '\\']) {
        return None;
    }
    let suffix = if windows { ".exe" } else { "" };
    let candidate = folder.join(format!("muse-bin-{version}{suffix}"));
    if is_executable_file(&candidate, windows) && is_native_binary(&candidate, windows) {
        Some(candidate)
    } else {
        None
    }
}

fn candidate_filenames(name: &str, alt_names: &[String], windows: bool, exe_only: bool) -> Vec<String> {
    let mut names = Vec::new();
    let all = std::iter::once(name).chain(alt_names.iter().map(String::as_str));
    for n in all {
        if windows {
            names.push(format!("{n}.exe"));
            if !exe_only {
                names.push(format!("{n}.cmd"));
                names.push(format!("{n}.bat"));
            }
        } else {
            names.push(n.to_string());
        }
    }
    names
}

#[cfg(unix)]
fn probe_login_shell_path(env: &HashMap<String, String>) -> Option<String> {
    let shell = env
        .get("SHELL")
        .filter(|s| s.starts_with('/') && !s.ends_with("/false") && !s.ends_with("/nologin"))
        .map(String::as_str)
        .unwrap_or("/bin/sh");
    let home = env.get("HOME").map(String::as_str).unwrap_or("");
    let cache_key = format!("{shell}\0{home}");
    let cache = LOGIN_SHELL_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some(cached) = guard.get(&cache_key) {
            return cached.clone();
        }
    }

    let result = run_login_shell_probe(shell, env);
    if let Ok(mut guard) = cache.lock() {
        guard.insert(cache_key, result.clone());
    }
    result
}

#[cfg(unix)]
fn run_login_shell_probe(shell: &str, env: &HashMap<String, String>) -> Option<String> {
    let script = format!("printf '\\n{LOGIN_SHELL_MARKER}'; printenv PATH");
    let mut cmd = StdCommand::new(shell);
    cmd.args(["-l", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    cmd.env_clear();
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;

    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 2048];
        while buf.len() < LOGIN_SHELL_MAX_BYTES {
            match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(found) = extract_marker_path(&buf) {
                        let _ = tx.send(Some(found));
                        return;
                    }
                }
            }
        }
        let _ = tx.send(extract_marker_path(&buf));
    });

    let deadline = Instant::now() + LOGIN_SHELL_TIMEOUT;
    let remaining = deadline.saturating_duration_since(Instant::now());
    let answer = rx.recv_timeout(remaining).ok().flatten();
    let _ = child.kill();
    let _ = child.wait();
    answer
}

#[cfg(unix)]
fn extract_marker_path(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.len() < 2 {
        return None;
    }
    // Check completed lines (every line except the trailing unterminated segment).
    for line in lines[..lines.len() - 1].iter().rev() {
        let line = line.trim_end_matches('\r');
        if let Some(rest) = line.strip_prefix(LOGIN_SHELL_MARKER) {
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Builds an augmented `PATH` string containing:
/// 1. `ahead` directories (e.g., the resolved executable's dir + Node's dir),
/// 2. inherited `PATH` directories,
/// 3. login shell `PATH` directories (POSIX) + existing standard user tool directories.
pub fn build_augmented_path(
    ahead: &[PathBuf],
    opts: &CliLookupOptions,
    include_shims_fallback: bool,
) -> String {
    let delimiter = opts.path_delimiter();
    let mut seen: HashSet<String> = HashSet::new();
    let mut ordered: Vec<String> = Vec::new();
    let mut push_dir = |dir: &Path| {
        if !dir.is_absolute() {
            return;
        }
        let key = normalize_folder_key(dir, opts.windows);
        if key.is_empty() || !seen.insert(key) {
            return;
        }
        ordered.push(dir.to_string_lossy().into_owned());
    };

    for dir in ahead {
        push_dir(dir);
    }
    for dir in split_path_entries(opts.path_value(), delimiter) {
        push_dir(&dir);
    }
    if let Some(login) = opts.resolve_login_shell_path() {
        for dir in split_path_entries(Some(&login), delimiter) {
            if dir.is_dir() {
                push_dir(&dir);
            }
        }
    }
    if let Some(home) = opts.effective_home() {
        let mut extras = user_bin_folders(opts, &home);
        extras.push(home.join(".opencode").join("bin"));
        extras.push(home.join(".grok").join("bin"));
        extras.push(home.join(".codex").join("bin"));
        extras.extend(npm_folders(opts, &home));
        if include_shims_fallback {
            extras.extend(shim_folders(opts, &home));
        }
        if !opts.windows {
            if opts.macos {
                extras.push(PathBuf::from("/opt/homebrew/bin"));
                extras.push(PathBuf::from("/opt/homebrew/sbin"));
            }
            extras.push(PathBuf::from("/usr/local/bin"));
            extras.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin"));
            extras.push(home.join(".linuxbrew").join("bin"));
        }
        for dir in extras {
            if dir.is_dir() {
                push_dir(&dir);
            }
        }
    }
    ordered.join(&delimiter.to_string())
}

/// Augments the current process's `PATH` environment variable once at startup (must be called while
/// single-threaded, before spawning Tokio worker threads).
pub fn augment_current_process_path() {
    let opts = CliLookupOptions::from_process_env();
    let augmented = build_augmented_path(&[], &opts, true);
    if !augmented.is_empty() {
        std::env::set_var("PATH", augmented);
    }
}

/// Searches for a CLI binary across user directories, PATH, login shell PATH, and version
/// managers, returning its resolved path plus an augmented `PATH` for child processes.
pub fn find_cli(spec: &CliSpec, opts: &CliLookupOptions) -> Option<ResolvedCli> {
    let delimiter = opts.path_delimiter();
    let home = opts.effective_home();
    let inherited = split_path_entries(opts.path_value(), delimiter);
    let shims = home
        .as_deref()
        .map(|h| shim_folders(opts, h))
        .unwrap_or_default();

    let mut stages: Vec<Vec<PathBuf>> = Vec::new();
    stages.push(spec.first.clone());
    stages.push(inherited.clone());
    if let Some(login) = opts.resolve_login_shell_path() {
        stages.push(split_path_entries(Some(&login), delimiter));
    }
    if let Some(ref h) = home {
        stages.push(user_bin_folders(opts, h));
        stages.push(manager_folders(&spec.name, opts, h));
        stages.push(npm_folders(opts, h));
    }
    stages.push(spec.last.clone());

    let filenames = candidate_filenames(&spec.name, &spec.alt_names, opts.windows, spec.exe_only);
    let mut tried: HashSet<String> = HashSet::new();
    let mut skipped_fallbacks: Vec<PathBuf> = Vec::new();

    for stage in stages {
        for folder in stage {
            if !folder.is_absolute() {
                continue;
            }
            if shims.iter().any(|s| same_folder(s, &folder, opts.windows)) {
                continue;
            }
            let key = normalize_folder_key(&folder, opts.windows);
            if !tried.insert(key) {
                continue;
            }

            if spec.prefer_codex_vendor {
                for vendor_bin in codex_vendor_candidates(&folder, opts.windows, opts.macos) {
                    if is_executable_file(&vendor_bin, opts.windows)
                        && is_native_binary(&vendor_bin, opts.windows)
                    {
                        let real = fs::canonicalize(&vendor_bin).unwrap_or(vendor_bin);
                        if !is_dispatcher(&real) {
                            return Some(finish_resolved(real, Vec::new(), &spec.name, &inherited, opts));
                        }
                    }
                }
            }

            if spec.prefer_muse_maker {
                if let Some(maker_bin) = muse_maker_binary(&folder, opts.windows) {
                    return Some(finish_resolved(
                        maker_bin,
                        Vec::new(),
                        &spec.name,
                        &inherited,
                        opts,
                    ));
                }
            }

            for file in &filenames {
                let candidate = folder.join(file);
                if !is_executable_file(&candidate, opts.windows) {
                    continue;
                }
                let real = fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
                if is_dispatcher(&real) || runs_through_manager(&real) {
                    skipped_fallbacks.push(candidate);
                    continue;
                }
                let chosen = if spec.follow_realpath { real } else { candidate };
                return Some(finish_resolved(chosen, Vec::new(), &spec.name, &inherited, opts));
            }
        }
    }

    // Fallback stage: only reached when stages 1-7 found no direct binary.
    // Checks shim directories (e.g. `~/.local/share/mise/shims`) and skipped manager wrappers,
    // invoking them by their shim/wrapper path (never dereferencing to the dispatcher binary).
    for shim_dir in shims {
        for file in &filenames {
            let candidate = shim_dir.join(file);
            if is_executable_file(&candidate, opts.windows) {
                return Some(finish_resolved(candidate, Vec::new(), &spec.name, &inherited, opts));
            }
        }
    }
    for candidate in skipped_fallbacks {
        if is_executable_file(&candidate, opts.windows) {
            return Some(finish_resolved(candidate, Vec::new(), &spec.name, &inherited, opts));
        }
    }

    None
}

fn finish_resolved(
    executable: PathBuf,
    prefix_args: Vec<String>,
    name: &str,
    inherited: &[PathBuf],
    opts: &CliLookupOptions,
) -> ResolvedCli {
    let mut ahead = Vec::new();
    if let Some(parent) = executable.parent() {
        if !inherited.iter().any(|p| same_folder(p, parent, opts.windows)) {
            ahead.push(parent.to_path_buf());
        }
    }
    if name != "node" {
        if let Some(node_dir) = find_node_dir_once(opts) {
            if !inherited.iter().any(|p| same_folder(p, &node_dir, opts.windows))
                && !ahead.iter().any(|p| same_folder(p, &node_dir, opts.windows))
            {
                ahead.push(node_dir);
            }
        }
    }
    let augmented_path = build_augmented_path(&ahead, opts, true);
    ResolvedCli {
        executable,
        prefix_args,
        augmented_path,
    }
}

fn find_node_dir_once(opts: &CliLookupOptions) -> Option<PathBuf> {
    let node = find_cli(&CliSpec::simple("node"), opts)?;
    node.executable.parent().map(Path::to_path_buf)
}

fn antigravity_configured_binary(data_directory: &Path, home: Option<&Path>, windows: bool) -> Option<PathBuf> {
    let raw = fs::read_to_string(data_directory.join("agents.json")).ok()?;
    let val: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let path_str = val
        .get("configuration")
        .and_then(|c| c.get("antigravityBinaryPath"))
        .and_then(serde_json::Value::as_str)?
        .trim();
    if path_str.is_empty() {
        return None;
    }
    let expanded = if let Some(rest) = path_str.strip_prefix("~/").or_else(|| path_str.strip_prefix("~\\")) {
        home?.join(rest)
    } else if path_str == "~" {
        home?.to_path_buf()
    } else {
        PathBuf::from(path_str)
    };
    let name_ok = |p: &Path| {
        p.file_name()
            .and_then(|s| s.to_str())
            .map(|s| {
                let lower = s.to_ascii_lowercase();
                matches!(
                    lower.as_str(),
                    "agy" | "agy.exe" | "antigravity" | "antigravity.exe"
                )
            })
            .unwrap_or(false)
    };
    let real = fs::canonicalize(&expanded).unwrap_or_else(|_| expanded.clone());
    if (name_ok(&expanded) || name_ok(&real)) && is_executable_file(&expanded, windows) {
        Some(expanded)
    } else {
        None
    }
}

fn antigravity_managed_binary(data_directory: &Path, windows: bool, macos: bool) -> Option<PathBuf> {
    let platform = if windows {
        "win32"
    } else if macos {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    let root = data_directory
        .join("antigravity")
        .join("runtime")
        .join(format!("{platform}-{arch}"));
    let active_raw = fs::read_to_string(root.join("active.json")).ok()?;
    let active: serde_json::Value = serde_json::from_str(&active_raw).ok()?;
    let version = active.get("version").and_then(serde_json::Value::as_str)?;
    if version.is_empty() || version.contains(['/', '\\']) {
        return None;
    }
    let exe_name = if windows { "agy.exe" } else { "antigravity" };
    let candidate = root.join("versions").join(version).join(exe_name);
    is_executable_file(&candidate, windows).then_some(candidate)
}

fn cursor_windows_program(opts: &CliLookupOptions) -> Option<(PathBuf, Vec<String>)> {
    let local = absolute_path(opts.env_get_ci("LOCALAPPDATA"))?;
    let versions_dir = local.join("cursor-agent").join("versions");
    let entries = list_dir_entries(&versions_dir);
    for ver in newest_first(&entries) {
        let folder = versions_dir.join(ver);
        let node = folder.join("node.exe");
        let index = folder.join("index.js");
        if node.is_file() && index.is_file() {
            return Some((node, vec![index.to_string_lossy().into_owned()]));
        }
    }
    None
}

/// Resolves a registered native provider's CLI binary using the shared lookup rules.
pub fn resolve_provider_cli(
    provider_id: &str,
    data_directory: &Path,
    opts: &CliLookupOptions,
) -> Option<ResolvedCli> {
    let home = opts.effective_home();
    let inherited = split_path_entries(opts.path_value(), opts.path_delimiter());
    match provider_id {
        "codex" => {
            let mut spec = CliSpec::simple("codex");
            spec.prefer_codex_vendor = true;
            if let Some(ref h) = home {
                spec.last.push(h.join(".codex").join("bin"));
            }
            find_cli(&spec, opts)
        }
        "claude" => {
            let mut spec = CliSpec::simple("claude");
            // Node's `findClaudeExecutable`: a `claude.cmd` would take a side call's system prompt through a shell, which
            // refuses its line breaks.
            spec.exe_only = true;
            if let Some(ref h) = home {
                spec.first.push(h.join(".local").join("bin"));
                spec.last.push(h.join(".claude").join("local"));
            }
            find_cli(&spec, opts)
        }
        "grok" => {
            let mut spec = CliSpec::simple("grok");
            let grok_home = absolute_path(opts.env_get_ci("GROK_HOME"))
                .or_else(|| home.as_ref().map(|h| h.join(".grok")));
            if let Some(gh) = grok_home {
                spec.first.push(gh.join("bin"));
            }
            find_cli(&spec, opts)
        }
        "devin" => {
            let mut spec = CliSpec::simple("devin");
            if opts.windows {
                if let Some(local) = absolute_path(opts.env_get_ci("LOCALAPPDATA")) {
                    spec.last.push(
                        local
                            .join("Programs")
                            .join("Devin")
                            .join("resources")
                            .join("app")
                            .join("extensions")
                            .join("windsurf")
                            .join("devin")
                            .join("bin"),
                    );
                }
            } else {
                spec.last.push(PathBuf::from(
                    "/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin",
                ));
                if let Some(ref h) = home {
                    spec.last.push(h.join(
                        "Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin",
                    ));
                }
            }
            find_cli(&spec, opts)
        }
        "cursor" => {
            if opts.windows {
                if let Some((node, args)) = cursor_windows_program(opts) {
                    return Some(finish_resolved(node, args, "cursor", &inherited, opts));
                }
            }
            let mut spec = CliSpec::simple("agent");
            spec.follow_realpath = !opts.windows;
            if let Some(ref h) = home {
                spec.first.push(h.join(".local").join("bin"));
            }
            find_cli(&spec, opts)
        }
        "antigravity" => {
            if let Some(configured) =
                antigravity_configured_binary(data_directory, home.as_deref(), opts.windows)
            {
                return Some(finish_resolved(
                    configured,
                    Vec::new(),
                    "antigravity",
                    &inherited,
                    opts,
                ));
            }
            if let Some(managed) =
                antigravity_managed_binary(data_directory, opts.windows, opts.macos)
            {
                return Some(finish_resolved(
                    managed,
                    Vec::new(),
                    "antigravity",
                    &inherited,
                    opts,
                ));
            }
            let mut spec = CliSpec::simple("agy");
            spec.alt_names.push("antigravity".into());
            if opts.windows {
                if let Some(local) = absolute_path(opts.env_get_ci("LOCALAPPDATA")) {
                    spec.first.push(local.join("agy").join("bin"));
                }
            }
            if let Some(ref h) = home {
                spec.first.push(h.join(".local").join("bin"));
            }
            find_cli(&spec, opts)
        }
        "hermes" => {
            let mut spec = CliSpec::simple("hermes");
            spec.follow_realpath = !opts.windows;
            if opts.windows {
                if let Some(local) = absolute_path(opts.env_get_ci("LOCALAPPDATA")) {
                    spec.last.push(local.join("hermes").join("bin"));
                }
            } else if let Some(ref h) = home {
                spec.last.push(
                    h.join(".hermes")
                        .join("hermes-agent")
                        .join(".hermes")
                        .join("bin"),
                );
            }
            find_cli(&spec, opts)
        }
        "muse" => {
            let mut spec = CliSpec::simple("muse");
            spec.prefer_muse_maker = true;
            if let Some(dir) = absolute_path(opts.env_get_ci("MUSE_INSTALL_DIR")) {
                spec.first.push(dir);
            }
            if let Some(ref h) = home {
                spec.last.push(h.join(".muse").join("bin"));
            }
            find_cli(&spec, opts)
        }
        "opencode" => {
            let mut spec = CliSpec::simple("opencode");
            spec.alt_names.push("opencode2".into());
            if let Some(ref h) = home {
                spec.first.push(h.join(".opencode").join("bin"));
                if !opts.windows {
                    spec.last.push(h.join(".nix-profile").join("bin"));
                }
            }
            if !opts.windows {
                spec.last.push(PathBuf::from("/run/current-system/sw/bin"));
                spec.last.push(PathBuf::from("/nix/var/nix/profiles/default/bin"));
                spec.last.push(PathBuf::from("/usr/bin"));
                spec.last.push(PathBuf::from("/usr/local/bin"));
            }
            find_cli(&spec, opts)
        }
        _ => None,
    }
}

/// Resolves a helper CLI tool (`git`, `gh`, `tailscale`, etc.) using the shared lookup rules.
pub fn resolve_tool_cli(tool: &str, opts: &CliLookupOptions) -> Option<ResolvedCli> {
    let mut spec = CliSpec::simple(tool);
    if tool == "tailscale" && !opts.windows {
        if opts.macos {
            spec.last.push(PathBuf::from(
                "/Applications/Tailscale.app/Contents/MacOS",
            ));
        }
        spec.last.push(PathBuf::from("/usr/bin"));
        spec.last.push(PathBuf::from("/usr/local/bin"));
    }
    find_cli(&spec, opts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn make_fake_executable(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn bare_path_options(home: &Path, bare_sys_bin: &Path, windows: bool) -> CliLookupOptions {
        fs::create_dir_all(bare_sys_bin).unwrap();
        let mut env = HashMap::new();
        env.insert("PATH".into(), bare_sys_bin.to_string_lossy().into_owned());
        if windows {
            env.insert("USERPROFILE".into(), home.to_string_lossy().into_owned());
            env.insert(
                "LOCALAPPDATA".into(),
                home.join("AppData").join("Local").to_string_lossy().into_owned(),
            );
            env.insert(
                "APPDATA".into(),
                home.join("AppData").join("Roaming").to_string_lossy().into_owned(),
            );
        } else {
            env.insert("HOME".into(), home.to_string_lossy().into_owned());
        }
        CliLookupOptions {
            env,
            home: Some(home.to_path_buf()),
            windows,
            macos: false,
            login_shell_path: Some(None),
        }
    }

    #[test]
    fn resolves_all_native_providers_under_bare_path() {
        let dir = tempdir().unwrap();
        let home = dir.path().join("home");
        let data = dir.path().join("data");
        let bare_sys_bin = dir.path().join("sysbin");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&data).unwrap();
        let windows = cfg!(windows);
        let ext = if windows { ".exe" } else { "" };
        let opts = bare_path_options(&home, &bare_sys_bin, windows);

        // Place each provider in a realistic user install location outside bare PATH.
        make_fake_executable(
            &home.join(".local/bin").join(format!("claude{ext}")),
            "#!/bin/sh\necho claude\n",
        );
        make_fake_executable(
            &home
                .join(if windows {
                    "AppData/Local/mise/installs/codex/latest/bin"
                } else {
                    ".local/share/mise/installs/codex/latest/bin"
                })
                .join(format!("codex{ext}")),
            "#!/bin/sh\necho codex\n",
        );
        make_fake_executable(
            &home.join(".grok/bin").join(format!("grok{ext}")),
            "#!/bin/sh\necho grok\n",
        );
        make_fake_executable(
            &home.join(".local/bin").join(format!("devin{ext}")),
            "#!/bin/sh\necho devin\n",
        );
        make_fake_executable(
            &home.join(".muse/bin").join(format!("muse{ext}")),
            "#!/bin/sh\necho muse\n",
        );
        make_fake_executable(
            &home.join(".opencode/bin").join(format!("opencode{ext}")),
            "#!/bin/sh\necho opencode\n",
        );
        if windows {
            let cursor_dir = home.join("AppData/Local/cursor-agent/versions/2026.11.01-abc");
            make_fake_executable(&cursor_dir.join("node.exe"), "MZ");
            fs::write(cursor_dir.join("index.js"), "console.log('ok')").unwrap();
        } else {
            make_fake_executable(&home.join(".local/bin/agent"), "#!/bin/sh\necho agent\n");
        }
        make_fake_executable(
            &home.join(".local/bin").join(format!("hermes{ext}")),
            "#!/bin/sh\necho hermes\n",
        );
        make_fake_executable(
            &home.join(".local/bin").join(format!("agy{ext}")),
            "#!/bin/sh\necho agy\n",
        );

        for provider in NATIVE_PROVIDER_IDS {
            let resolved = resolve_provider_cli(provider, &data, &opts)
                .unwrap_or_else(|| panic!("provider {provider} should resolve under bare PATH"));
            assert!(
                resolved.executable.exists(),
                "resolved path for {provider} should exist"
            );
            assert!(
                !resolved.augmented_path.is_empty(),
                "augmented PATH for {provider} should be populated"
            );
        }
    }

    #[test]
    fn skips_mise_wrapper_in_local_bin_in_favor_of_mise_installs_and_falls_back_to_shims() {
        let dir = tempdir().unwrap();
        let home = dir.path().join("home");
        let data = dir.path().join("data");
        let bare_sys_bin = dir.path().join("sysbin");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&data).unwrap();
        let windows = cfg!(windows);
        let ext = if windows { ".cmd" } else { "" };
        // Claude Code is found only by its `.exe` name on Windows.
        let claude_ext = if windows { ".exe" } else { "" };
        let opts = bare_path_options(&home, &bare_sys_bin, windows);

        // Exact forge layout: ~/.local/bin/claude wraps `mise x`, real binary is in mise/installs.
        let wrapper = home.join(".local/bin").join(format!("claude{claude_ext}"));
        make_fake_executable(
            &wrapper,
            "#!/usr/bin/env bash\nmise use -g claude@latest\nexec mise x -- claude \"$@\"\n",
        );
        let direct = home
            .join(if windows {
                "AppData/Local/mise/installs/claude/latest"
            } else {
                ".local/share/mise/installs/claude/latest"
            })
            .join(format!("claude{claude_ext}"));
        make_fake_executable(&direct, "#!/bin/sh\necho direct\n");

        let resolved = resolve_provider_cli("claude", &data, &opts).unwrap();
        assert_eq!(resolved.executable, direct);

        // When a binary exists ONLY in mise/shims (no installs/ copy), fallback still finds it.
        let shim = home
            .join(if windows {
                "AppData/Local/mise/shims"
            } else {
                ".local/share/mise/shims"
            })
            .join(format!("devin{ext}"));
        make_fake_executable(&shim, "#!/bin/sh\necho shim\n");
        let resolved_shim = resolve_provider_cli("devin", &data, &opts).unwrap();
        assert_eq!(resolved_shim.executable, shim);
    }

    /// Node's `findClaudeExecutable` looks for `claude.exe` on Windows and passes over npm's `claude.cmd`
    /// (`tests/unit/main/cliLookup.test.ts`): Windows starts a batch file only through a shell, which mangles or
    /// refuses an argument with a line break in it, such as a side call's system prompt.
    #[test]
    fn claude_on_windows_is_found_by_its_exe_name_past_npms_cmd_shims() {
        let dir = tempdir().unwrap();
        let home = dir.path().join("home");
        let data = dir.path().join("data");
        let opts = bare_path_options(&home, &dir.path().join("sysbin"), true);
        make_fake_executable(&home.join(".local/bin/claude.cmd"), "@echo off\r\n");
        make_fake_executable(&home.join("AppData/Roaming/npm/claude.bat"), "@echo off\r\n");
        assert!(resolve_provider_cli("claude", &data, &opts).is_none(), "a shim alone is not Claude Code");

        let claude = home.join(".claude/local/claude.exe");
        make_fake_executable(&claude, "MZ");
        assert_eq!(resolve_provider_cli("claude", &data, &opts).unwrap().executable, claude);
    }

    #[test]
    fn resolves_gh_in_unpacked_mise_release_folder_and_cargo_and_npm_global() {
        let dir = tempdir().unwrap();
        let home = dir.path().join("home");
        let bare_sys_bin = dir.path().join("sysbin");
        fs::create_dir_all(&home).unwrap();
        let windows = cfg!(windows);
        let ext = if windows { ".exe" } else { "" };
        let opts = bare_path_options(&home, &bare_sys_bin, windows);

        let unpacked_gh = home
            .join(if windows {
                "AppData/Local/mise/installs/gh/latest/gh_2.102.0_linux_amd64/bin"
            } else {
                ".local/share/mise/installs/gh/latest/gh_2.102.0_linux_amd64/bin"
            })
            .join(format!("gh{ext}"));
        make_fake_executable(&unpacked_gh, "#!/bin/sh\necho gh\n");
        let resolved_gh = resolve_tool_cli("gh", &opts).unwrap();
        assert_eq!(resolved_gh.executable, unpacked_gh);

        let cargo_tool = home.join(".cargo/bin").join(format!("sotto-cargo-tool{ext}"));
        make_fake_executable(&cargo_tool, "#!/bin/sh\necho cargo\n");
        let resolved_cargo = resolve_tool_cli("sotto-cargo-tool", &opts).unwrap();
        assert_eq!(resolved_cargo.executable, cargo_tool);

        let npm_tool = home
            .join(if windows {
                "AppData/Roaming/npm"
            } else {
                ".npm-global/bin"
            })
            .join(format!("sotto-npm-tool{ext}"));
        make_fake_executable(&npm_tool, "#!/bin/sh\necho npm\n");
        let resolved_npm = resolve_tool_cli("sotto-npm-tool", &opts).unwrap();
        assert_eq!(resolved_npm.executable, npm_tool);
    }

    #[test]
    fn every_native_provider_adapter_config_enables_shared_cli_lookup() {
        let data = PathBuf::from("/tmp/sotto-test-data");
        assert!(crate::providers::CodexAdapterConfig::native(data.clone()).use_cli_lookup);
        assert!(crate::providers::ClaudeAdapterConfig::native(data.clone()).use_cli_lookup);
        assert!(crate::providers::MuseAdapterConfig::native(data.clone()).use_cli_lookup);
        assert!(crate::providers::OpenCodeAdapterConfig::native(data.clone()).use_cli_lookup);
        for flavor in [
            crate::providers::AcpFlavor::Grok,
            crate::providers::AcpFlavor::Devin,
            crate::providers::AcpFlavor::Cursor,
            crate::providers::AcpFlavor::Hermes,
            crate::providers::AcpFlavor::Antigravity,
        ] {
            assert!(
                crate::providers::AcpAdapterConfig::native(flavor, data.clone()).use_cli_lookup,
                "native AcpAdapterConfig for {} must enable cli_lookup",
                flavor.id()
            );
            assert!(NATIVE_PROVIDER_IDS.contains(&flavor.id()));
        }
        for id in ["codex", "claude", "muse", "opencode"] {
            assert!(NATIVE_PROVIDER_IDS.contains(&id));
        }
    }
}
