//! The frame log the measurements come from.
//!
//! - A frame's work is the time from the start of the root view's `render` to
//!   the end of its paint (the last element painted marks it). It is CPU time on
//!   the UI thread before GPUI submits to the GPU; it does not include the GPU
//!   or the compositor.
//! - A frame's interval is the time between the starts of consecutive frames.
//! - A key's latency is the time from the composer receiving the key to the end
//!   of the paint of the first frame that includes it.
//! - Memory is the process's working set and private bytes, three seconds after
//!   the stream ends.

use std::{
    path::PathBuf,
    sync::OnceLock,
    time::{Duration, Instant},
};

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

pub fn mark_process_start() {
    let _ = PROCESS_START.set(Instant::now());
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
            self.first_paint = PROCESS_START.get().map(|s| now - *s);
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
            "{{\n  \"long_frames_at_ms_work_ms_reply_char\": [{}],\n  \"stream_ms\": {:.0},\n  \"frames\": {},\n  \"streaming_frames\": {},\n  \"frame_work_ms\": {},\n  \"frame_interval_ms\": {},\n  \"key_to_paint_ms\": {},\n  \"first_paint_ms\": {},\n  \"working_set_mb\": {},\n  \"private_mb\": {}\n}}\n",
            long.join(", "),
            (end - start).as_secs_f64() * 1000.,
            during.len(),
            streaming_frames,
            summary(&mut work),
            summary(&mut intervals),
            summary(&mut keys),
            self.first_paint.map(|d| format!("{:.1}", d.as_secs_f64() * 1000.)).unwrap_or("null".into()),
            self.memory.map(|m| format!("{:.1}", m.0 as f64 / 1048576.)).unwrap_or("null".into()),
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

#[cfg(not(windows))]
fn process_memory() -> Option<(u64, u64)> {
    None
}
