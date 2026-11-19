//! State shared between CEF's handlers (on CEF's UI thread) and the script that drives a run (on its own thread).
//! The script never touches a CEF object directly: it posts a closure to the UI thread and waits on the hub.

use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub struct Hub {
    pub t0: Instant,
    pub next_id: AtomicI32,
    results: Mutex<HashMap<i32, (bool, Value)>>,
    results_cv: Condvar,
    pub events: Mutex<Vec<(f64, String, Value)>>,
    loads: Mutex<Vec<(f64, i32, String)>>,
    loads_cv: Condvar,
    pub console: Mutex<Vec<String>>,
    pub paints: AtomicU64,
    pub accelerated_paints: AtomicU64,
    pub first_paint_ms: Mutex<Option<f64>>,
    /// What the seal refused, in the order it refused it: (layer, what).
    pub refused: Mutex<Vec<(String, String)>>,
    pub view: Mutex<(i32, i32)>,
    pub ready: Mutex<bool>,
    ready_cv: Condvar,
    pub closed: AtomicBool,
    pub notes: Mutex<Vec<String>>,
}

static HUB: OnceLock<Hub> = OnceLock::new();

pub fn hub() -> &'static Hub {
    HUB.get_or_init(|| Hub {
        t0: Instant::now(),
        next_id: AtomicI32::new(1),
        results: Mutex::new(HashMap::new()),
        results_cv: Condvar::new(),
        events: Mutex::new(Vec::new()),
        loads: Mutex::new(Vec::new()),
        loads_cv: Condvar::new(),
        console: Mutex::new(Vec::new()),
        paints: AtomicU64::new(0),
        accelerated_paints: AtomicU64::new(0),
        first_paint_ms: Mutex::new(None),
        refused: Mutex::new(Vec::new()),
        view: Mutex::new((1280, 800)),
        ready: Mutex::new(false),
        ready_cv: Condvar::new(),
        closed: AtomicBool::new(false),
        notes: Mutex::new(Vec::new()),
    })
}

impl Hub {
    pub fn ms(&self) -> f64 {
        self.t0.elapsed().as_secs_f64() * 1000.0
    }
    pub fn put_result(&self, id: i32, ok: bool, value: Value) {
        self.results.lock().unwrap().insert(id, (ok, value));
        self.results_cv.notify_all();
    }
    pub fn take_result(&self, id: i32, timeout: Duration) -> Option<(bool, Value)> {
        let deadline = Instant::now() + timeout;
        let mut results = self.results.lock().unwrap();
        loop {
            if let Some(found) = results.remove(&id) {
                return Some(found);
            }
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            results = self.results_cv.wait_timeout(results, deadline - now).unwrap().0;
        }
    }
    pub fn put_event(&self, method: String, params: Value) {
        self.events.lock().unwrap().push((self.ms(), method, params));
    }
    pub fn load_count(&self) -> usize {
        self.loads.lock().unwrap().len()
    }
    pub fn put_load(&self, status: i32, url: String) {
        self.loads.lock().unwrap().push((self.ms(), status, url));
        self.loads_cv.notify_all();
    }
    /// Waits until more than `seen` main-frame loads have ended; returns the newest.
    pub fn wait_load(&self, seen: usize, timeout: Duration) -> Option<(f64, i32, String)> {
        let deadline = Instant::now() + timeout;
        let mut loads = self.loads.lock().unwrap();
        loop {
            if loads.len() > seen {
                return loads.last().cloned();
            }
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            loads = self.loads_cv.wait_timeout(loads, deadline - now).unwrap().0;
        }
    }
    pub fn set_ready(&self) {
        *self.ready.lock().unwrap() = true;
        self.ready_cv.notify_all();
    }
    pub fn wait_ready(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut ready = self.ready.lock().unwrap();
        while !*ready {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            ready = self.ready_cv.wait_timeout(ready, deadline - now).unwrap().0;
        }
        true
    }
    pub fn refuse(&self, layer: &str, what: impl Into<String>) {
        let what = what.into();
        eprintln!("[seal] {layer}: {what}");
        self.refused.lock().unwrap().push((layer.to_string(), what));
    }
    pub fn note(&self, note: impl Into<String>) {
        let note = note.into();
        eprintln!("[note] {note}");
        self.notes.lock().unwrap().push(note);
    }
    pub fn first_paint(&self) {
        let mut first = self.first_paint_ms.lock().unwrap();
        if first.is_none() {
            *first = Some(self.ms());
        }
    }
    pub fn summary(&self) -> Value {
        json!({
            "paints": self.paints.load(Ordering::Relaxed),
            "accelerated_paints": self.accelerated_paints.load(Ordering::Relaxed),
            "first_paint_ms": *self.first_paint_ms.lock().unwrap(),
            "loads": self.loads.lock().unwrap().iter().map(|(t, s, u)| json!({"t": t, "status": s, "url": u})).collect::<Vec<_>>(),
            "refused": self.refused.lock().unwrap().iter().map(|(l, w)| json!({"layer": l, "what": w})).collect::<Vec<_>>(),
            "notes": *self.notes.lock().unwrap(),
        })
    }
}

/// A closure for CEF's UI thread. Cloneable because CEF's task wrapper clones its fields.
pub type UiJob = Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>;
pub fn job(f: impl FnOnce() + Send + 'static) -> UiJob {
    Arc::new(Mutex::new(Some(Box::new(f))))
}
