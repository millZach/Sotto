//! Web pane spike for issue #2690: Chromium (CEF 156 through cef-rs) as a component for Sotto's web panes.
//! Throwaway code. One binary; WP_MODE picks the run. CEF runs this same binary for its child processes.

mod cefapp;
mod embed;
mod hub;
#[cfg(target_os = "macos")]
mod mac;
#[cfg(any(target_os = "windows", target_os = "macos"))]
mod osr;
#[cfg(target_os = "linux")]
mod remote;
#[cfg(target_os = "macos")]
mod remote_mac;
#[cfg(target_os = "windows")]
mod remote_win;
mod runs;
mod wire;

use cef::*;
use cefapp::{Config, Seal, set_config};
use hub::hub;
use std::process::ExitCode;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn switches() -> Vec<(String, Option<String>)> {
    let mut out = vec![("password-store".to_string(), Some("basic".to_string()))];
    if let Some(list) = env("WP_SWITCHES") {
        for item in list.split(';').map(str::trim).filter(|s| !s.is_empty()) {
            let item = item.trim_start_matches("--");
            match item.split_once('=') {
                Some((k, v)) => out.push((k.to_string(), Some(v.to_string()))),
                None => out.push((item.to_string(), None)),
            }
        }
    }
    out
}

fn seal_from_env() -> Seal {
    let layers = env("WP_SEAL").unwrap_or_else(|| "csp,filter,proxy,webrtc,deny".into());
    let has = |n: &str| layers.split(',').any(|l| l.trim() == n);
    Seal { csp: has("csp"), filter: has("filter"), proxy: has("proxy"), webrtc_policy: has("webrtc"), deny: has("deny"), no_rtc: has("nortc") }
}

/// The dead proxy: a loopback port that accepts and closes without a byte. Every connection it sees is one that
/// tried to leave the sealed page and was held.
fn dead_proxy() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("dead proxy port");
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            hub().refuse("dead-proxy", format!("connection from {:?}", stream.peer_addr().ok()));
            drop(stream);
        }
    });
    port
}

fn main() -> ExitCode {
    let args = cef::args::Args::new();
    // macOS: a helper app runs CEF's sandbox before it loads the framework, unless the browser turned it off; then
    // every process loads the framework from the bundle before its first CEF call, and makes NSApp CEF's kind.
    #[cfg(target_os = "macos")]
    let _sandbox = {
        let argv: Vec<String> = std::env::args().collect();
        (argv.iter().any(|a| a.starts_with("--type=")) && !argv.iter().any(|a| a == "--no-sandbox")).then(|| {
            let mut sandbox = cef::sandbox::Sandbox::new();
            sandbox.initialize(args.as_main_args());
            sandbox
        })
    };
    #[cfg(target_os = "macos")]
    let _framework = mac::load_framework();
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    // Only the browser process gets an NSApplication: CEF's helpers make none, and a sandboxed helper that does crashes
    // ("required built-in appearance SystemAppearance not found").
    #[cfg(target_os = "macos")]
    if !std::env::args().any(|a| a.starts_with("--type=")) && !mac::setup_application() {
        eprintln!("NSApp is not the spike's CefAppProtocol application");
    }
    let cmd = args.as_cmd_line().unwrap();
    let is_browser = cmd.has_switch(Some(&CefString::from("type"))) != 1;
    let mode = env("WP_MODE").unwrap_or_else(|| "cdp".into());
    let run_dir = env("WP_RUN_DIR").unwrap_or_else(|| ".".into());

    if is_browser {
        let seal = (mode == "seal").then(seal_from_env);
        let dead_proxy_port = if seal.map(|s| s.proxy).unwrap_or(false) { dead_proxy() } else { 0 };
        set_config(Config {
            mode: mode.clone(),
            switches: switches(),
            root_cache: env("WP_CACHE").unwrap_or_else(|| format!("{run_dir}/cache")),
            seal,
            dead_proxy_port,
            sealed_page: std::sync::Mutex::new(None),
            sealed_url: std::sync::Mutex::new(None),
            log_requests: env("WP_LOG_REQUESTS").is_some(),
        });
    }

    let mut app = cefapp::SpikeApp::new();
    let code = execute_process(Some(args.as_main_args()), Some(&mut app), std::ptr::null_mut());
    if !is_browser {
        return ExitCode::from(code.max(0) as u8);
    }

    #[cfg(target_os = "linux")]
    if mode == "helper" {
        return remote::run_helper(&args, &mut app);
    }
    #[cfg(target_os = "windows")]
    if mode == "helper" {
        return remote_win::run_helper(&args, &mut app);
    }
    #[cfg(target_os = "macos")]
    if mode == "helper" {
        return remote_mac::run_helper(&args, &mut app);
    }
    if mode == "embed" || mode == "child" {
        return embed::run(&args, &mut app, &mode);
    }

    let config = cefapp::config();
    if let Some(prefs) = env("WP_PREFS") {
        // Seed the persistent profile's preferences before Chromium reads them, so they hold from its first second.
        let profile = format!("{}/profile", config.root_cache);
        std::fs::create_dir_all(&profile).ok();
        std::fs::write(format!("{profile}/Preferences"), std::fs::read(&prefs).expect("WP_PREFS file")).expect("seed prefs");
    }
    let settings = Settings {
        windowless_rendering_enabled: 1,
        no_sandbox: env("WP_NO_SANDBOX").is_some() as i32,
        root_cache_path: CefString::from(config.root_cache.as_str()),
        cache_path: CefString::from(format!("{}/profile", config.root_cache).as_str()),
        log_severity: LogSeverity::from(if env("WP_LOG").is_some() { sys::cef_log_severity_t::LOGSEVERITY_INFO } else { sys::cef_log_severity_t::LOGSEVERITY_WARNING }),
        log_file: CefString::from(format!("{run_dir}/cef.log").as_str()),
        ..Default::default()
    };
    if initialize(Some(args.as_main_args()), Some(&settings), Some(&mut app), std::ptr::null_mut()) != 1 {
        eprintln!("CEF initialize failed");
        return ExitCode::from(2);
    }
    let started = hub().ms();
    let script_mode = mode.clone();
    let script = std::thread::spawn(move || {
        if !hub().wait_ready(std::time::Duration::from_secs(30)) {
            eprintln!("CEF context never initialized");
        }
        let result = match script_mode.as_str() {
            "cdp" => runs::run_cdp(),
            "iphone" => runs::run_iphone(),
            "seal" => runs::run_seal(cefapp::config().seal.unwrap()),
            "net" => runs::run_net(),
            "pane" => runs::run_pane(),
            "eval" => runs::run_eval(),
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            "osr" => osr::run_osr(),
            "windowed" => runs::run_windowed(),
            other => serde_json::json!({ "error": format!("unknown mode {other}") }),
        };
        result
    });
    run_message_loop();
    let result = script.join().unwrap_or_else(|_| serde_json::json!({ "error": "script panicked" }));
    shutdown();
    let mut result = result;
    result["initialize_ms"] = serde_json::json!(started);
    let out = env("WP_OUT").unwrap_or_else(|| format!("{run_dir}/{mode}.json"));
    std::fs::write(&out, serde_json::to_string_pretty(&result).unwrap()).expect("write result");
    eprintln!("wrote {out}");
    if env("WP_REINIT").is_some() {
        // CEF documents one initialize per process. Try a second one after shutdown and say what happens.
        eprintln!("REINIT trying initialize after shutdown");
        let again = initialize(Some(args.as_main_args()), Some(&settings), Some(&mut app), std::ptr::null_mut());
        println!("REINIT initialize returned {again}");
        if again == 1 { shutdown(); }
    }
    ExitCode::SUCCESS
}
