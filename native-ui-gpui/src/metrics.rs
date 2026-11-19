//! The frame log the measurements come from.
//!
//! - A frame's work is the time from the start of the root view's `render` to
//!   the end of its paint (the last element painted marks it). It is CPU time on
//!   the UI thread before GPUI submits to the GPU; it does not include the GPU
//!   or the compositor.
//! - A frame's interval is the time between the starts of consecutive frames.
//! - A key's latency is the time from the composer receiving the key to the end
//!   of the paint of the first frame that includes it.
//! - Memory is the process's working set and private bytes on Windows, and its
//!   RSS and PSS from `/proc/self/smaps_rollup` on Linux, three seconds after the
//!   stream ends (`SOTTO_GPUI_MEMORY_AFTER_MS` changes the wait).
//! - With `SOTTO_LAUNCH_T0` set to the wall clock in nanoseconds just before the
//!   process started (`date +%s%N`), launch is from then to the end of the first
//!   paint; without it, from the start of `main`.
//! - The end interval is the time between the ends of consecutive frames' paint,
//!   the way the Slint half measures its frames (`AfterRendering`).

use std::{
    path::PathBuf,
    sync::OnceLock,
    time::{Duration, Instant},
};

static PROCESS_START: OnceLock<Instant> = OnceLock::new();
static LAUNCH_T0: OnceLock<Option<Duration>> = OnceLock::new();

pub fn mark_process_start() {
    let _ = PROCESS_START.set(Instant::now());
    // How long before `main` the launcher took its timestamp, on the wall clock.
    let before_main = std::env::var("SOTTO_LAUNCH_T0").ok().and_then(|v| v.trim().parse::<u128>().ok()).and_then(|t0| {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
        Some(Duration::from_nanos(now.checked_sub(t0)? as u64))
    });
    let _ = LAUNCH_T0.set(before_main);
}

pub fn memory_wait() -> Duration {
    Duration::from_millis(std::env::var("SOTTO_GPUI_MEMORY_AFTER_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(3000))
}

struct Frame {
    start: Instant,
    end: Option<Instant>,
    streaming: bool,
}

pub struct Metrics {
    frames: Vec<Frame>,
    pending_keys: Vec<Instant>,
    key_latencies: Vec<Duration>,
    first_paint: Option<Duration>,
    stream_start: Option<Instant>,
    stream_end: Option<Instant>,
    memory: Option<(u64, u64)>,
    out: Option<PathBuf>,
}

impl Metrics {
    pub fn new() -> Self {
        Metrics {
            frames: Vec::with_capacity(20_000),
            pending_keys: Vec::new(),
            key_latencies: Vec::new(),
            first_paint: None,
            stream_start: None,
            stream_end: None,
            memory: None,
            out: std::env::var("SOTTO_GPUI_METRICS").ok().map(PathBuf::from),
        }
    }

    pub fn begin_frame(&mut self, streaming: bool) {
        self.frames.push(Frame { start: Instant::now(), end: None, streaming });
    }

    pub fn key(&mut self, at: Instant) {
        self.pending_keys.push(at);
    }

    pub fn end_paint(&mut self) {
        let now = Instant::now();
        if let Some(frame) = self.frames.last_mut()
            && frame.end.is_none()
        {
            frame.end = Some(now);
        }
        if self.first_paint.is_none() {
            let before_main = LAUNCH_T0.get().copied().flatten().unwrap_or_default();
            self.first_paint = PROCESS_START.get().map(|s| now - *s + before_main);
            if let Some(d) = self.first_paint {
                eprintln!("first-frame launch_ms={:.1} from={}", d.as_secs_f64() * 1000., if before_main.is_zero() { "main" } else { "SOTTO_LAUNCH_T0" });
            }
        }
        for key in self.pending_keys.drain(..) {
            self.key_latencies.push(now - key);
        }
    }

    pub fn stream_started(&mut self) {
        self.stream_start = Some(Instant::now());
        self.stream_end = None;
    }

    pub fn stream_ended(&mut self) {
        self.stream_end = Some(Instant::now());
    }

    pub fn sample_memory(&mut self) {
        self.memory = process_memory();
    }

    pub fn write(&self) {
        let Some(path) = &self.out else { return };
        let (Some(start), Some(end)) = (self.stream_start, self.stream_end) else { return };
        let during: Vec<&Frame> = self.frames.iter().filter(|f| f.start >= start && f.start <= end && f.end.is_some()).collect();
        let mut work: Vec<f64> = during.iter().map(|f| (f.end.unwrap() - f.start).as_secs_f64() * 1000.).collect();
        let mut intervals: Vec<f64> = during.windows(2).map(|w| (w[1].start - w[0].start).as_secs_f64() * 1000.).collect();
        let mut end_intervals: Vec<f64> =
            during.windows(2).map(|w| (w[1].end.unwrap() - w[0].end.unwrap()).as_secs_f64() * 1000.).collect();
        let over_33 = end_intervals.iter().filter(|v| **v > 33.3).count();
        let over_33_start = intervals.iter().filter(|v| **v > 33.3).count();
        // The raw series, for summaries across runs.
        let raw_path = path.with_extension("raw.json");
        let list = |v: &[f64]| v.iter().map(|x| format!("{x:.3}")).collect::<Vec<_>>().join(",");
        let _ = std::fs::write(
            &raw_path,
            format!(
                "{{\"frame_interval_ms\": [{}], \"frame_end_interval_ms\": [{}], \"frame_work_ms\": [{}], \"key_to_paint_ms\": [{}]}}\n",
                list(&intervals),
                list(&end_intervals),
                list(&during.iter().map(|f| (f.end.unwrap() - f.start).as_secs_f64() * 1000.).collect::<Vec<_>>()),
                list(&self.key_latencies.iter().map(|d| d.as_secs_f64() * 1000.).collect::<Vec<_>>()),
            ),
        );
        let mut keys: Vec<f64> = self.key_latencies.iter().map(|d| d.as_secs_f64() * 1000.).collect();
        let summary = |v: &mut Vec<f64>| -> String {
            if v.is_empty() {
                return "null".into();
            }
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let p = |q: f64| v[((v.len() as f64 - 1.) * q).round() as usize];
            format!(
                "{{\"count\": {}, \"median\": {:.2}, \"p95\": {:.2}, \"p99\": {:.2}, \"max\": {:.2}}}",
                v.len(),
                p(0.5),
                p(0.95),
                p(0.99),
                v[v.len() - 1]
            )
        };
        let streaming_frames = during.iter().filter(|f| f.streaming).count();
        // Frames whose work took over 30 ms, with when they started in the stream and roughly where in the reply.
        let long: Vec<String> = during
            .iter()
            .filter(|f| (f.end.unwrap() - f.start).as_millis() > 30)
            .map(|f| {
                let at = (f.start - start).as_secs_f64() * 1000.;
                format!("[{:.0}, {:.1}, {}]", at, (f.end.unwrap() - f.start).as_secs_f64() * 1000., (at / 16.) as usize * 20)
            })
            .collect();
        let json = format!(
            "{{\n  \"long_frames_at_ms_work_ms_reply_char\": [{}],\n  \"stream_ms\": {:.0},\n  \"frames\": {},\n  \"streaming_frames\": {},\n  \"frame_work_ms\": {},\n  \"frame_interval_ms\": {},\n  \"frame_end_interval_ms\": {},\n  \"frames_over_33ms_end\": {},\n  \"frames_over_33ms_start\": {},\n  \"key_to_paint_ms\": {},\n  \"first_paint_ms\": {},\n  \"{}\": {},\n  \"{}\": {}\n}}\n",
            long.join(", "),
            (end - start).as_secs_f64() * 1000.,
            during.len(),
            streaming_frames,
            summary(&mut work),
            summary(&mut intervals),
            summary(&mut end_intervals),
            over_33,
            over_33_start,
            summary(&mut keys),
            self.first_paint.map(|d| format!("{:.1}", d.as_secs_f64() * 1000.)).unwrap_or("null".into()),
            MEMORY_NAMES.0,
            self.memory.map(|m| format!("{:.1}", m.0 as f64 / 1048576.)).unwrap_or("null".into()),
            MEMORY_NAMES.1,
            self.memory.map(|m| format!("{:.1}", m.1 as f64 / 1048576.)).unwrap_or("null".into()),
        );
        let _ = std::fs::write(path, json);
    }
}

#[cfg(windows)]
fn process_memory() -> Option<(u64, u64)> {
    use windows::Win32::System::{ProcessStatus::*, Threading::GetCurrentProcess};
    let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
    unsafe {
        GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut counters as *mut _ as *mut PROCESS_MEMORY_COUNTERS,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        )
        .ok()?;
    }
    Some((counters.WorkingSetSize as u64, counters.PrivateUsage as u64))
}

#[cfg(windows)]
const MEMORY_NAMES: (&str, &str) = ("working_set_mb", "private_mb");
#[cfg(not(windows))]
const MEMORY_NAMES: (&str, &str) = ("rss_mib", "pss_mib");

/// RSS and PSS of this process alone (the terminal's shell is its own process and not counted).
#[cfg(target_os = "linux")]
fn process_memory() -> Option<(u64, u64)> {
    let text = std::fs::read_to_string("/proc/self/smaps_rollup").ok()?;
    let field = |name: &str| -> Option<u64> {
        let line = text.lines().find(|l| l.starts_with(name))?;
        Some(line.split_whitespace().nth(1)?.parse::<u64>().ok()? * 1024)
    };
    Some((field("Rss:")?, field("Pss:")?))
}

#[cfg(not(any(windows, target_os = "linux")))]
fn process_memory() -> Option<(u64, u64)> {
    None
}
