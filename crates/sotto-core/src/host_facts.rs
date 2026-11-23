use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::workspace::now_iso;

pub const HOST_FACTS_TEXT_MAX: usize = 200;
pub const HOST_FACTS_CPU_COUNT_MAX: usize = 65_536;
pub const HOST_FACTS_REFRESH_MS: u64 = 5_000;
pub const HOST_LOAD_SAMPLE_MS: u64 = 2_000;
pub const HOST_LOAD_WINDOW_MAX_MS: u64 = 60_000;
pub const HOST_LOAD_WINDOW_LIMIT_MS: u64 = 24 * 60 * 60_000;
pub const HOST_RUNNING_THREADS_MAX: usize = 100_000;

#[derive(Debug, Clone)]
struct StaticOsFacts {
    family: Option<&'static str>,
    name: Option<String>,
    version: Option<String>,
    architecture: Option<String>,
    logical_cpu_count: Option<usize>,
}

#[derive(Debug, Clone, Copy)]
struct CpuCounters {
    idle: u64,
    total: u64,
}

#[derive(Debug, Clone, Copy)]
struct LoadSample {
    monotonic: Instant,
    wall_ms: i64,
    cpu: Option<CpuCounters>,
    available_memory_bytes: Option<u64>,
}

#[derive(Debug, Clone)]
struct CachedFacts {
    sampled_at: Instant,
    value: Value,
}

#[derive(Debug, Clone)]
struct CachedLoad {
    sampled_at: Instant,
    value: Value,
}

#[derive(Default)]
struct SamplerState {
    latest_facts: Option<CachedFacts>,
    sample: Option<LoadSample>,
    last_load: Option<CachedLoad>,
}

/// Cross-platform machine facts and live CPU/memory load sampler matching
/// `HostFactsSource` (`src/main/agents/hostFacts.ts`) and `hostMachineReportSchema`
/// (`src/shared/hostFacts.ts`). Reads OS identity once, refreshes memory at most every
/// `HOST_FACTS_REFRESH_MS`, and samples live load over a bounded window without any timer.
pub struct HostFactsSampler {
    static_facts: OnceLock<StaticOsFacts>,
    state: Mutex<SamplerState>,
}

impl Default for HostFactsSampler {
    fn default() -> Self {
        Self::new()
    }
}

impl HostFactsSampler {
    pub fn new() -> Self {
        Self {
            static_facts: OnceLock::new(),
            state: Mutex::new(SamplerState::default()),
        }
    }

    fn static_facts(&self) -> &StaticOsFacts {
        self.static_facts.get_or_init(read_static_os_facts)
    }

    /// Takes the initial load sample without sleeping so the first live report has a
    /// starting window immediately.
    pub fn prime_load(&self) {
        let _ = self.static_facts();
        let needs_prime = self
            .state
            .lock()
            .map(|guard| guard.sample.is_none())
            .unwrap_or(false);
        if !needs_prime {
            return;
        }
        let sample = take_load_sample();
        if let Ok(mut guard) = self.state.lock() {
            if guard.sample.is_none() {
                guard.sample = Some(sample);
            }
        }
    }

    pub fn read_facts(&self) -> Value {
        let now = Instant::now();
        if let Ok(guard) = self.state.lock() {
            if let Some(ref cached) = guard.latest_facts {
                if now.duration_since(cached.sampled_at)
                    < Duration::from_millis(HOST_FACTS_REFRESH_MS)
                {
                    return cached.value.clone();
                }
            }
        }

        let static_facts = self.static_facts();
        let (total_mem, free_mem, _) = read_memory_bytes();
        let value = json!({
            "observedAt": now_iso(),
            "os": {
                "family": static_facts.family,
                "name": static_facts.name,
                "version": static_facts.version,
            },
            "architecture": static_facts.architecture,
            "totalMemoryBytes": bound_bytes(total_mem),
            "freeMemoryBytes": bound_bytes(free_mem),
            "logicalCpuCount": static_facts.logical_cpu_count,
        });

        if let Ok(mut guard) = self.state.lock() {
            guard.latest_facts = Some(CachedFacts {
                sampled_at: Instant::now(),
                value: value.clone(),
            });
        }
        value
    }

    pub fn read_load(&self) -> Value {
        let now = Instant::now();
        let kept_start = {
            let guard = self.state.lock().ok();
            if let Some(ref g) = guard {
                if let Some(ref cached) = g.last_load {
                    if now.duration_since(cached.sampled_at)
                        < Duration::from_millis(HOST_FACTS_REFRESH_MS)
                    {
                        return cached.value.clone();
                    }
                }
                g.sample.filter(|s| {
                    now.duration_since(s.monotonic) <= Duration::from_millis(HOST_LOAD_WINDOW_MAX_MS)
                })
            } else {
                None
            }
        };

        let mut start = kept_start.unwrap_or_else(take_load_sample);
        let mut end = end_load_sample(start);
        if !window_current(start, end) {
            start = end;
            end = end_load_sample(start);
        }
        let current = window_current(start, end);
        let window_ms = end
            .monotonic
            .saturating_duration_since(start.monotonic)
            .as_millis()
            .clamp(1, HOST_LOAD_WINDOW_LIMIT_MS as u128) as u64;

        let load_val = json!({
            "observedAt": iso_from_millis(end.wall_ms),
            "windowMs": window_ms,
            "cpuBusyPercent": if current { cpu_busy_percent(start.cpu, end.cpu) } else { None },
            "loadAverage": read_load_average(),
            "availableMemoryBytes": bound_bytes(end.available_memory_bytes),
            "windowStartAvailableMemoryBytes": if current { bound_bytes(start.available_memory_bytes) } else { None },
            "memoryPressurePercent": read_memory_pressure(),
        });

        if let Ok(mut guard) = self.state.lock() {
            guard.sample = Some(end);
            guard.last_load = Some(CachedLoad {
                sampled_at: Instant::now(),
                value: load_val.clone(),
            });
        }
        load_val
    }

    pub fn report(&self, running_threads: usize, live: bool) -> Value {
        let running = if running_threads <= HOST_RUNNING_THREADS_MAX {
            Some(running_threads)
        } else {
            None
        };
        let facts = self.read_facts();
        if !live {
            return json!({
                "facts": facts,
                "runningThreads": running,
            });
        }
        let load = self.read_load();
        json!({
            "facts": facts,
            "runningThreads": running,
            "load": load,
        })
    }
}

static GLOBAL_SAMPLER: OnceLock<HostFactsSampler> = OnceLock::new();

pub fn global_host_facts_sampler() -> &'static HostFactsSampler {
    GLOBAL_SAMPLER.get_or_init(HostFactsSampler::new)
}

pub fn prime_host_facts_load() {
    global_host_facts_sampler().prime_load();
}

pub fn host_facts_report(running_threads: usize, live: bool) -> Value {
    global_host_facts_sampler().report(running_threads, live)
}

fn bound_text(raw: Option<String>, max: usize) -> Option<String> {
    let trimmed = raw?.trim().to_string();
    if trimmed.is_empty() || trimmed.chars().count() > max {
        None
    } else {
        Some(trimmed)
    }
}

fn bound_bytes(value: Option<u64>) -> Option<u64> {
    // Match JS Number.MAX_SAFE_INTEGER (2^53 - 1) enforced by hostFactsSchema.
    const MAX_SAFE_INT: u64 = 9_007_199_254_740_991;
    value.filter(|&v| v <= MAX_SAFE_INT)
}

fn wall_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn iso_from_millis(ms: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(now_iso)
}

fn window_current(start: LoadSample, end: LoadSample) -> bool {
    let elapsed_mono = end.monotonic.saturating_duration_since(start.monotonic);
    let elapsed_wall = end.wall_ms.saturating_sub(start.wall_ms);
    elapsed_mono <= Duration::from_millis(HOST_LOAD_WINDOW_MAX_MS)
        && elapsed_wall >= 0
        && (elapsed_wall as u64) <= HOST_LOAD_WINDOW_MAX_MS
}

fn end_load_sample(start: LoadSample) -> LoadSample {
    let elapsed = start.monotonic.elapsed();
    let target = Duration::from_millis(HOST_LOAD_SAMPLE_MS);
    if elapsed < target {
        std::thread::sleep(target - elapsed);
    }
    take_load_sample()
}

fn take_load_sample() -> LoadSample {
    let (_, _, available_memory_bytes) = read_memory_bytes();
    LoadSample {
        monotonic: Instant::now(),
        wall_ms: wall_millis(),
        cpu: read_cpu_counters(),
        available_memory_bytes,
    }
}

fn cpu_busy_percent(start: Option<CpuCounters>, end: Option<CpuCounters>) -> Option<f64> {
    let (s, e) = (start?, end?);
    if e.total <= s.total || e.idle < s.idle {
        return None;
    }
    let dt = (e.total - s.total) as f64;
    let di = (e.idle - s.idle) as f64;
    let busy = 1.0 - (di / dt);
    let rounded = (busy * 1_000.0).round() / 10.0;
    Some(rounded.clamp(0.0, 100.0))
}

fn read_static_os_facts() -> StaticOsFacts {
    let cpus = std::thread::available_parallelism()
        .ok()
        .map(|n| n.get())
        .filter(|n| (1..=HOST_FACTS_CPU_COUNT_MAX).contains(n));
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    let (family, name, version) = read_os_identity();
    StaticOsFacts {
        family,
        name: bound_text(name, HOST_FACTS_TEXT_MAX),
        version: bound_text(version, HOST_FACTS_TEXT_MAX),
        architecture: bound_text(Some(arch.to_string()), 32),
        logical_cpu_count: cpus,
    }
}

/// Parses `/etc/os-release` key=value lines matching `parseOsRelease` in `hostFacts.ts`.
pub fn parse_os_release(content: &str) -> HashMap<String, String> {
    let mut fields = HashMap::new();
    for line in content.lines() {
        let trimmed = line.trim();
        let Some((key, assigned)) = trimmed.split_once('=') else {
            continue;
        };
        if key.is_empty()
            || !key.chars().next().is_some_and(|c| c.is_ascii_uppercase())
            || !key
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        {
            continue;
        }
        let raw = assigned.trim();
        let value = if raw.starts_with('"') && raw.ends_with('"') && raw.len() >= 2 {
            let inner = &raw[1..raw.len() - 1];
            let mut out = String::with_capacity(inner.len());
            let mut chars = inner.chars().peekable();
            while let Some(c) = chars.next() {
                if c == '\\' {
                    if let Some(&next) = chars.peek() {
                        if matches!(next, '"' | '\\' | '$' | '`') {
                            out.push(next);
                            chars.next();
                            continue;
                        }
                    }
                }
                out.push(c);
            }
            out
        } else if raw.starts_with('\'') && raw.ends_with('\'') && raw.len() >= 2 {
            raw[1..raw.len() - 1].to_string()
        } else {
            raw.to_string()
        };
        fields.insert(key.to_string(), value);
    }
    fields
}

/// Parses `MemTotal`, `MemFree`, and `MemAvailable` (in bytes) from `/proc/meminfo`.
pub fn parse_meminfo(content: &str) -> (Option<u64>, Option<u64>, Option<u64>) {
    let mut total = None;
    let mut free = None;
    let mut available = None;
    for line in content.lines() {
        let mut parts = line.split_whitespace();
        let Some(key) = parts.next() else { continue };
        let Some(kib_str) = parts.next() else { continue };
        let Ok(kib) = kib_str.parse::<u64>() else {
            continue;
        };
        let bytes = kib.saturating_mul(1024);
        match key {
            "MemTotal:" => total = Some(bytes),
            "MemFree:" => free = Some(bytes),
            "MemAvailable:" => available = Some(bytes),
            _ => {}
        }
    }
    (total, free, available)
}

/// Parses aggregate `cpu ` jiffies from `/proc/stat` matching Node `os.cpus()` counters
/// (`user + nice + sys + idle + irq`).
pub fn parse_proc_stat_cpu(content: &str) -> Option<(u64, u64)> {
    let line = content.lines().find(|l| l.starts_with("cpu "))?;
    let nums: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|s| s.parse::<u64>().ok())
        .collect();
    if nums.len() < 4 {
        return None;
    }
    let user = nums[0];
    let nice = nums[1];
    let sys = nums[2];
    let idle = nums[3];
    let irq = nums.get(5).copied().unwrap_or(0);
    let total = user
        .saturating_add(nice)
        .saturating_add(sys)
        .saturating_add(idle)
        .saturating_add(irq);
    Some((idle, total))
}

/// Parses `some ... avg10=<share>` from `/proc/pressure/memory`.
pub fn parse_memory_pressure(content: &str) -> Option<f64> {
    for line in content.lines() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with("some") {
            continue;
        }
        for token in trimmed.split_whitespace() {
            if let Some(raw) = token.strip_prefix("avg10=") {
                if let Ok(val) = raw.parse::<f64>() {
                    if val.is_finite() && (0.0..=100.0).contains(&val) {
                        return Some(val);
                    }
                }
            }
        }
    }
    None
}

/// Parses macOS `ProductVersion` from `/System/Library/CoreServices/SystemVersion.plist`.
pub fn parse_macos_product_version(plist: &str) -> Option<String> {
    let key_pos = plist.find("<key>ProductVersion</key>")?;
    let after_key = &plist[key_pos + "<key>ProductVersion</key>".len()..];
    let open = after_key.find("<string>")?;
    let after_open = &after_key[open + "<string>".len()..];
    let close = after_open.find("</string>")?;
    let ver = after_open[..close].trim();
    if ver.is_empty() || !ver.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    Some(ver.to_string())
}

#[cfg(target_os = "linux")]
fn read_os_identity() -> (Option<&'static str>, Option<String>, Option<String>) {
    for path in ["/etc/os-release", "/usr/lib/os-release"] {
        if let Ok(content) = std::fs::read_to_string(path) {
            let fields = parse_os_release(&content);
            let name = fields
                .get("PRETTY_NAME")
                .cloned()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| fields.get("NAME").cloned());
            let version = fields.get("VERSION_ID").cloned();
            return (Some("linux"), name, version);
        }
    }
    (Some("linux"), Some("Linux".into()), None)
}

#[cfg(target_os = "macos")]
fn read_os_identity() -> (Option<&'static str>, Option<String>, Option<String>) {
    let version = std::fs::read_to_string("/System/Library/CoreServices/SystemVersion.plist")
        .ok()
        .and_then(|plist| parse_macos_product_version(&plist));
    (Some("macos"), Some("macOS".into()), version)
}

#[cfg(windows)]
fn read_os_identity() -> (Option<&'static str>, Option<String>, Option<String>) {
    #[repr(C)]
    struct OsVersionInfoW {
        dw_os_version_info_size: u32,
        dw_major_version: u32,
        dw_minor_version: u32,
        dw_build_number: u32,
        dw_platform_id: u32,
        sz_csd_version: [u16; 128],
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(lp_version_information: *mut OsVersionInfoW) -> i32;
    }
    let mut info = OsVersionInfoW {
        dw_os_version_info_size: std::mem::size_of::<OsVersionInfoW>() as u32,
        dw_major_version: 0,
        dw_minor_version: 0,
        dw_build_number: 0,
        dw_platform_id: 0,
        sz_csd_version: [0; 128],
    };
    let status = unsafe { RtlGetVersion(&mut info) };
    if status == 0 {
        let release = format!(
            "{}.{}.{}",
            info.dw_major_version, info.dw_minor_version, info.dw_build_number
        );
        let name = if info.dw_major_version == 10 && info.dw_minor_version == 0 {
            if info.dw_build_number >= 22_000 {
                Some("Windows 11".into())
            } else {
                Some("Windows 10".into())
            }
        } else {
            Some("Windows".into())
        };
        return (Some("windows"), name, Some(release));
    }
    (Some("windows"), Some("Windows".into()), None)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn read_os_identity() -> (Option<&'static str>, Option<String>, Option<String>) {
    (None, None, None)
}

#[cfg(target_os = "linux")]
fn read_memory_bytes() -> (Option<u64>, Option<u64>, Option<u64>) {
    std::fs::read_to_string("/proc/meminfo")
        .map(|s| parse_meminfo(&s))
        .unwrap_or((None, None, None))
}

#[cfg(windows)]
fn read_memory_bytes() -> (Option<u64>, Option<u64>, Option<u64>) {
    #[repr(C)]
    struct MemoryStatusEx {
        dw_length: u32,
        dw_memory_load: u32,
        ull_total_phys: u64,
        ull_avail_phys: u64,
        ull_total_page_file: u64,
        ull_avail_page_file: u64,
        ull_total_virtual: u64,
        ull_avail_virtual: u64,
        ull_avail_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(lp_buffer: *mut MemoryStatusEx) -> i32;
    }
    let mut mem = MemoryStatusEx {
        dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
        dw_memory_load: 0,
        ull_total_phys: 0,
        ull_avail_phys: 0,
        ull_total_page_file: 0,
        ull_avail_page_file: 0,
        ull_total_virtual: 0,
        ull_avail_virtual: 0,
        ull_avail_extended_virtual: 0,
    };
    let ok = unsafe { GlobalMemoryStatusEx(&mut mem) };
    if ok != 0 {
        (
            Some(mem.ull_total_phys),
            Some(mem.ull_avail_phys),
            Some(mem.ull_avail_phys),
        )
    } else {
        (None, None, None)
    }
}

#[cfg(target_os = "macos")]
fn read_memory_bytes() -> (Option<u64>, Option<u64>, Option<u64>) {
    use std::ffi::CStr;
    extern "C" {
        fn sysctlbyname(
            name: *const std::ffi::c_char,
            oldp: *mut std::ffi::c_void,
            oldlenp: *mut usize,
            newp: *mut std::ffi::c_void,
            newlen: usize,
        ) -> i32;
        fn mach_host_self() -> u32;
        fn host_page_size(host: u32, out_page_size: *mut usize) -> i32;
        fn host_statistics64(
            host_priv: u32,
            flavor: i32,
            host_info64_out: *mut u32,
            host_info64_out_cnt: *mut u32,
        ) -> i32;
    }
    let mut total: u64 = 0;
    let mut len = std::mem::size_of::<u64>();
    let name = CStr::from_bytes_with_nul(b"hw.memsize\0").unwrap();
    let total_mem = if unsafe {
        sysctlbyname(
            name.as_ptr(),
            (&mut total as *mut u64).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    } == 0
    {
        Some(total)
    } else {
        None
    };

    // HOST_VM_INFO64 = 4, vm_statistics64_data_t has `free_count` as its first u32 field
    // and fits well within 64 u32 words (HOST_VM_INFO64_COUNT = 38).
    const HOST_VM_INFO64: i32 = 4;
    const HOST_VM_INFO64_COUNT: u32 = 38;
    let mut page_size: usize = 0;
    let mut vm_info = [0u32; 64];
    let mut count = HOST_VM_INFO64_COUNT;
    let free_mem = unsafe {
        let host = mach_host_self();
        if host_page_size(host, &mut page_size) == 0
            && host_statistics64(host, HOST_VM_INFO64, vm_info.as_mut_ptr(), &mut count) == 0
        {
            Some((vm_info[0] as u64).saturating_mul(page_size as u64))
        } else {
            None
        }
    };
    // Match hostFacts.ts: macOS available memory reads null because free pages understate reclaimable cache.
    (total_mem, free_mem, None)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn read_memory_bytes() -> (Option<u64>, Option<u64>, Option<u64>) {
    (None, None, None)
}

#[cfg(target_os = "linux")]
fn read_cpu_counters() -> Option<CpuCounters> {
    let content = std::fs::read_to_string("/proc/stat").ok()?;
    let (idle, total) = parse_proc_stat_cpu(&content)?;
    Some(CpuCounters { idle, total })
}

#[cfg(windows)]
fn read_cpu_counters() -> Option<CpuCounters> {
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        dw_low_date_time: u32,
        dw_high_date_time: u32,
    }
    impl FileTime {
        fn as_u64(&self) -> u64 {
            ((self.dw_high_date_time as u64) << 32) | (self.dw_low_date_time as u64)
        }
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemTimes(
            lp_idle_time: *mut FileTime,
            lp_kernel_time: *mut FileTime,
            lp_user_time: *mut FileTime,
        ) -> i32;
    }
    let mut idle = FileTime::default();
    let mut kernel = FileTime::default();
    let mut user = FileTime::default();
    let ok = unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) };
    if ok == 0 {
        return None;
    }
    // Windows GetSystemTimes kernel time includes idle time.
    let idle_v = idle.as_u64();
    let total_v = kernel.as_u64().saturating_add(user.as_u64());
    Some(CpuCounters {
        idle: idle_v,
        total: total_v,
    })
}

#[cfg(target_os = "macos")]
fn read_cpu_counters() -> Option<CpuCounters> {
    extern "C" {
        fn mach_host_self() -> u32;
        fn host_statistics(
            host_priv: u32,
            flavor: i32,
            host_info_out: *mut u32,
            host_info_out_cnt: *mut u32,
        ) -> i32;
    }
    // HOST_CPU_LOAD_INFO = 3, CPU_STATE_MAX = 4: [USER=0, SYSTEM=1, IDLE=2, NICE=3]
    const HOST_CPU_LOAD_INFO: i32 = 3;
    let mut ticks = [0u32; 4];
    let mut count: u32 = 4;
    let rc = unsafe {
        host_statistics(
            mach_host_self(),
            HOST_CPU_LOAD_INFO,
            ticks.as_mut_ptr(),
            &mut count,
        )
    };
    if rc != 0 {
        return None;
    }
    let idle = ticks[2] as u64;
    let total = (ticks[0] as u64)
        .saturating_add(ticks[1] as u64)
        .saturating_add(idle)
        .saturating_add(ticks[3] as u64);
    Some(CpuCounters { idle, total })
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn read_cpu_counters() -> Option<CpuCounters> {
    None
}

#[cfg(target_os = "linux")]
fn read_load_average() -> Option<f64> {
    let content = std::fs::read_to_string("/proc/loadavg").ok()?;
    let one = content.split_whitespace().next()?.parse::<f64>().ok()?;
    if one.is_finite() && one >= 0.0 {
        Some((one * 100.0).round() / 100.0)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn read_load_average() -> Option<f64> {
    extern "C" {
        fn getloadavg(loadavg: *mut f64, nelem: i32) -> i32;
    }
    let mut avg = [0.0f64; 1];
    let n = unsafe { getloadavg(avg.as_mut_ptr(), 1) };
    if n >= 1 && avg[0].is_finite() && avg[0] >= 0.0 {
        Some((avg[0] * 100.0).round() / 100.0)
    } else {
        None
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn read_load_average() -> Option<f64> {
    None
}

#[cfg(target_os = "linux")]
fn read_memory_pressure() -> Option<f64> {
    let content = std::fs::read_to_string("/proc/pressure/memory").ok()?;
    parse_memory_pressure(&content)
}

#[cfg(not(target_os = "linux"))]
fn read_memory_pressure() -> Option<f64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_linux_os_release_meminfo_stat_and_pressure() {
        let os_rel = r#"
NAME="Arch Linux"
PRETTY_NAME="Omarchy \"Linux\""
VERSION_ID='2026.11'
"#;
        let fields = parse_os_release(os_rel);
        assert_eq!(fields.get("PRETTY_NAME").map(String::as_str), Some("Omarchy \"Linux\""));
        assert_eq!(fields.get("VERSION_ID").map(String::as_str), Some("2026.11"));

        let mem = "MemTotal:       16384000 kB\nMemFree:         2048000 kB\nMemAvailable:    8192000 kB\n";
        assert_eq!(
            parse_meminfo(mem),
            (
                Some(16_384_000 * 1024),
                Some(2_048_000 * 1024),
                Some(8_192_000 * 1024),
            )
        );

        let stat = "cpu  100 20 80 800 50 10 5 0\ncpu0 50 10 40 400 25 5 2 0\n";
        assert_eq!(parse_proc_stat_cpu(stat), Some((800, 1010)));

        let psi = "some avg10=1.25 avg60=0.50 avg300=0.10 total=12345\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n";
        assert_eq!(parse_memory_pressure(psi), Some(1.25));

        let plist = "<plist><dict><key>ProductVersion</key>\n\t<string>15.3.1</string></dict></plist>";
        assert_eq!(parse_macos_product_version(plist).as_deref(), Some("15.3.1"));
    }

    #[test]
    fn computes_cpu_busy_percent_and_reads_live_host_facts() {
        let busy = cpu_busy_percent(
            Some(CpuCounters { idle: 800, total: 1000 }),
            Some(CpuCounters { idle: 950, total: 1200 }),
        );
        assert_eq!(busy, Some(25.0));
        assert_eq!(
            cpu_busy_percent(
                Some(CpuCounters { idle: 800, total: 1000 }),
                Some(CpuCounters { idle: 800, total: 1000 }),
            ),
            None
        );

        let sampler = HostFactsSampler::new();
        let report = sampler.report(3, false);
        assert_eq!(report["runningThreads"], 3);
        assert!(report["facts"]["logicalCpuCount"].as_u64().unwrap() >= 1);
        assert!(report["facts"]["totalMemoryBytes"].as_u64().unwrap() > 0);
        assert!(report["facts"]["freeMemoryBytes"].as_u64().is_some());
        assert!(report.get("load").is_none());
    }
}
