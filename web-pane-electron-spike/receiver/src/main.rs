//! The Rust window: starts the Electron helper, receives each frame as a dmabuf over a SOCK_SEQPACKET pair
//! (SCM_RIGHTS), imports it into Vulkan, acks it so the helper can release it, samples its pixels and draws it with
//! rounded corners. Clicks and typing in the page rectangle go back to the helper. Settings come from WPE_* variables.
mod import;
use std::io::Write;
use std::os::fd::RawFd;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use winit::application::ApplicationHandler;
use winit::event::{ElementState, MouseButton, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::window::{Window, WindowAttributes, WindowId};

const LEFT: f32 = 220.0; const TOP: f32 = 48.0; const MARGIN: f32 = 16.0; const RADIUS: f32 = 14.0;

fn env(k: &str, d: &str) -> String { std::env::var(k).unwrap_or_else(|_| d.into()) }

struct Shared {
    device: wgpu::Device, queue: wgpu::Queue,
    texture: Mutex<Option<wgpu::Texture>>,
    stdin: Mutex<Option<ChildStdin>>,
    view: (u32, u32),
    frames: AtomicU64,
    import_us: Mutex<Vec<u64>>,
    samples: Mutex<Vec<serde_json::Value>>,
    errors: Mutex<Vec<String>>,
    cycles: Mutex<Vec<serde_json::Value>>,
    proxy: Mutex<Option<EventLoopProxy<()>>>,
    done: std::sync::atomic::AtomicBool,
}

fn tree(pid: u32) -> Vec<u32> {
    let (mut out, mut todo) = (Vec::new(), vec![pid]);
    while let Some(p) = todo.pop() {
        out.push(p);
        if let Ok(tasks) = std::fs::read_dir(format!("/proc/{p}/task")) {
            for t in tasks.flatten() { if let Ok(c) = std::fs::read_to_string(t.path().join("children")) { todo.extend(c.split_whitespace().filter_map(|x| x.parse::<u32>().ok())); } }
        }
    }
    out
}
fn pss_kb(pids: &[u32]) -> u64 {
    pids.iter().map(|p| std::fs::read_to_string(format!("/proc/{p}/smaps_rollup")).ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("Pss:")).and_then(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok())).unwrap_or(0)).sum()
}
/// Every process whose executable lives in the Electron distribution's folder.
fn ours(dist: &str) -> Vec<u32> {
    std::fs::read_dir("/proc").into_iter().flatten().flatten().filter_map(|d| {
        let pid: u32 = d.file_name().to_str()?.parse().ok()?;
        let exe = std::fs::read_link(d.path().join("exe")).ok()?;
        exe.starts_with(dist).then_some(pid)
    }).collect()
}

fn recv(sock: RawFd) -> Option<([u32; 16], Option<RawFd>)> {
    let mut bytes = [0u8; 64];
    let mut iov = libc::iovec { iov_base: bytes.as_mut_ptr() as *mut _, iov_len: 64 };
    let mut control = [0u8; 64];
    let mut h: libc::msghdr = unsafe { std::mem::zeroed() };
    h.msg_iov = &mut iov; h.msg_iovlen = 1; h.msg_control = control.as_mut_ptr() as *mut _; h.msg_controllen = 64;
    if unsafe { libc::recvmsg(sock, &mut h, libc::MSG_CMSG_CLOEXEC) } != 64 { return None }
    let mut fd = None;
    unsafe { let c = libc::CMSG_FIRSTHDR(&h); if !c.is_null() && (*c).cmsg_type == libc::SCM_RIGHTS { fd = Some(std::ptr::read_unaligned(libc::CMSG_DATA(c) as *const RawFd)); } }
    let mut m = [0u32; 16];
    for (i, v) in m.iter_mut().enumerate() { *v = u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap()); }
    Some((m, fd))
}

fn send_line(s: &Shared, line: &str) { if let Some(w) = s.stdin.lock().unwrap().as_mut() { let _ = w.write_all(line.as_bytes()); let _ = w.flush(); } }

/// One helper lifetime: spawn, show frames, hold, measure, stop. Cycle 0 is cold when WPE_COLD=1 (the caller evicts).
fn cycle(s: &Arc<Shared>, n: usize, hold: u64, window: &Arc<Window>) {
    let dist = env("WPE_DIST", "");
    let run = env("WPE_RUN_DIR", ".");
    let mut fds = [0; 2];
    assert_eq!(unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0, fds.as_mut_ptr()) }, 0);
    let (ours_fd, theirs) = (fds[0], fds[1]);
    unsafe { libc::fcntl(theirs, libc::F_SETFD, 0); } // the helper inherits only this end
    let dir = format!("{run}/helper{n}");
    std::fs::create_dir_all(&dir).ok();
    let profile = if env("WPE_FRESH_PROFILE", "0") == "1" { format!("{dir}/profile") } else { format!("{run}/profile") };
    let mut args = vec![env("WPE_APP", "helper"), format!("--user-data-dir={profile}")];
    args.extend(env("WPE_SWITCHES", "--ozone-platform=wayland --enable-features=Vulkan").split_whitespace().map(String::from));
    let cef = env("WPE_PRODUCER", "electron") == "cef";
    let spawned = Instant::now();
    let mut command = if cef {
        let mut c = Command::new(format!("{}/webpane", env("WPE_CEF", "")));
        c.current_dir(env("WPE_CEF", "")).env("WP_MODE", "helper").env("WP_RUN_DIR", &dir).env("WP_CACHE", format!("{dir}/cache"))
            .env("WP_URL", format!("file://{}/page.html", env("WPE_APP", "helper"))).env("WP_SWITCHES", "ozone-platform=wayland").env("WP_SOCK_FD", theirs.to_string());
        c
    } else { let mut c = Command::new(format!("{dist}/electron")); c.args(&args).env("WPE_CAPTURE_PNG", format!("{dir}/capture-page.png")); c };
    let mut child: Child = command
        .env("WPE_SOCK_FD", theirs.to_string()).env("WPE_VIEW", format!("{}x{}", s.view.0, s.view.1))
        .env("WPE_SPAWNED_MS", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis().to_string())
        .stdin(Stdio::piped()).stdout(std::fs::File::create(format!("{dir}/helper.jsonl")).unwrap()).stderr(std::fs::File::create(format!("{dir}/helper.stderr")).unwrap())
        .spawn().expect("electron");
    unsafe { libc::close(theirs); }
    let pid = child.id();
    *s.stdin.lock().unwrap() = child.stdin.take();
    if cef { let mut r = [0u8; 64]; for (i, v) in [8u32, s.view.0, s.view.1].iter().enumerate() { r[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes()); } unsafe { libc::send(ours_fd, r.as_ptr() as *const _, 64, libc::MSG_NOSIGNAL); } }
    let first = Arc::new(Mutex::new(None::<f64>));
    let (rs, rf) = (s.clone(), first.clone());
    let reader = std::thread::spawn(move || {
        let mut k = 0u64;
        while let Some((m, fd)) = recv(ours_fd) {
            let Some(fd) = fd else { continue };
            if m[0] != 1 { unsafe { libc::close(fd); } continue }
            let f = import::Frame { fd, width: m[1], height: m[2], stride: m[3], offset: m[4] as u64 | (m[5] as u64) << 32, modifier: m[6] as u64 | (m[7] as u64) << 32, format: m[8] };
            let start = Instant::now();
            let imported = unsafe { import::import(&rs.device, &rs.queue, &f) };
            let us = start.elapsed().as_micros() as u64;
            // The copy is done: the helper may release its texture.
            send_line(&rs, &format!("A {}\n", m[9]));
            if cef { let mut r = [0u8; 64]; r[0] = 2; r[4..8].copy_from_slice(&m[9].to_le_bytes()); unsafe { libc::send(ours_fd, r.as_ptr() as *const _, 64, libc::MSG_NOSIGNAL | libc::MSG_DONTWAIT); } }
            unsafe { libc::close(fd); }
            match imported {
                Ok(t) => {
                    k += 1;
                    rs.import_us.lock().unwrap().push(us);
                    if k % 30 == 0 && rs.samples.lock().unwrap().len() < 40 {
                        let mut v = import::sample(&rs.device, &rs.queue, &t);
                        v["frame"] = k.into(); v["cycle"] = n.into(); v["modifier"] = format!("{:#x}", f.modifier).into(); v["size"] = format!("{}x{}", f.width, f.height).into();
                        rs.samples.lock().unwrap().push(v);
                    }
                    *rs.texture.lock().unwrap() = Some(t);
                    if rf.lock().unwrap().is_none() { *rf.lock().unwrap() = Some(spawned.elapsed().as_secs_f64() * 1000.0); }
                    rs.frames.fetch_add(1, Ordering::Relaxed);
                    if let Some(p) = rs.proxy.lock().unwrap().as_ref() { let _ = p.send_event(()); }
                }
                Err(e) => { let mut er = rs.errors.lock().unwrap(); if er.len() < 5 { er.push(e); } }
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    while first.lock().unwrap().is_none() && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(2)); }
    let first_ms = *first.lock().unwrap();
    let f0 = s.frames.load(Ordering::Relaxed); let t0 = Instant::now();
    std::thread::sleep(Duration::from_secs(hold));
    let fps = (s.frames.load(Ordering::Relaxed) - f0) as f64 / t0.elapsed().as_secs_f64();
    let pids = tree(pid);
    let helper_pss = pss_kb(&pids);
    let types: Vec<String> = pids.iter().map(|p| std::fs::read_to_string(format!("/proc/{p}/cmdline")).unwrap_or_default().split('\0').find(|a| a.starts_with("--type=")).map(|a| a[7..].to_string()).unwrap_or("browser".into())).collect();
    // The last pane closes: stdin ends, the helper quits.
    let stop = Instant::now();
    *s.stdin.lock().unwrap() = None;
    if cef { unsafe { libc::shutdown(ours_fd, libc::SHUT_RDWR); } }
    let mut exit = None;
    while stop.elapsed() < Duration::from_secs(10) { if let Ok(Some(st)) = child.try_wait() { exit = Some(st); break } std::thread::sleep(Duration::from_millis(5)); }
    if exit.is_none() { let _ = child.kill(); exit = child.wait().ok(); }
    let stop_ms = stop.elapsed().as_secs_f64() * 1000.0;
    unsafe { libc::shutdown(ours_fd, libc::SHUT_RDWR); }
    let _ = reader.join();
    unsafe { libc::close(ours_fd); }
    *s.texture.lock().unwrap() = None;
    window.request_redraw();
    std::thread::sleep(Duration::from_secs(2));
    let left = ours(&dist);
    let row = serde_json::json!({ "cycle": n, "first_frame_in_window_ms": first_ms, "fps": (fps * 10.0).round() / 10.0, "helper_processes": pids.len(), "process_types": types,
        "helper_pss_mb": helper_pss / 1024, "window_pss_mb": pss_kb(&[std::process::id()]) / 1024, "stop_ms": stop_ms, "exit": exit.map(|e| format!("{e}")), "electron_processes_left_2s_after": left });
    eprintln!("[cycle] {row}");
    s.cycles.lock().unwrap().push(row);
}

#[repr(C)] #[derive(Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
struct U { viewport: [f32; 2], radius: f32, pad: f32, rect: [f32; 4] }
const SHADER: &str = r#"
struct U { viewport: vec2<f32>, radius: f32, pad: f32, rect: vec4<f32> };
@group(0) @binding(0) var page: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0)); return vec4(p[i], 0.0, 1.0);
}
@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let px = pos.xy;
  var bg = vec3(0.075, 0.08, 0.09);
  if (px.x < u.rect.x * 0.92) { bg = vec3(0.10, 0.11, 0.12); }
  if (px.y < u.rect.y * 0.7) { bg = vec3(0.06, 0.065, 0.07); }
  let q = abs(px - (u.rect.xy + u.rect.zw * 0.5)) - u.rect.zw * 0.5 + vec2(u.radius);
  let d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - u.radius;
  let c = textureSample(page, samp, clamp((px - u.rect.xy) / u.rect.zw, vec2(0.0), vec2(1.0))).rgb;
  return vec4(mix(bg, c, clamp(0.5 - d, 0.0, 1.0)), 1.0);
}
"#;

struct Gfx { window: Arc<Window>, surface: wgpu::Surface<'static>, config: wgpu::SurfaceConfiguration, pipeline: wgpu::RenderPipeline, layout: wgpu::BindGroupLayout, sampler: wgpu::Sampler, uniforms: wgpu::Buffer, placeholder: wgpu::Texture }
struct App { s: Arc<Shared>, instance: wgpu::Instance, gfx: Option<Gfx>, cursor: (f64, f64) }

impl App {
    fn rect(&self) -> [f32; 4] {
        let g = self.gfx.as_ref().unwrap(); let sc = g.window.scale_factor() as f32;
        let (w, h) = (g.config.width as f32, g.config.height as f32);
        [LEFT * sc, TOP * sc, (w - (LEFT + MARGIN) * sc).max(50.0), (h - (TOP + MARGIN) * sc).max(50.0)]
    }
    fn draw(&mut self) {
        let r = self.rect();
        let Some(g) = &mut self.gfx else { return };
        let frame = match g.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            _ => { g.surface.configure(&self.s.device, &g.config); return }
        };
        let u = U { viewport: [g.config.width as f32, g.config.height as f32], radius: RADIUS * g.window.scale_factor() as f32, pad: 0.0, rect: r };
        self.s.queue.write_buffer(&g.uniforms, 0, bytemuck::bytes_of(&u));
        let page = self.s.texture.lock().unwrap().clone().unwrap_or_else(|| g.placeholder.clone());
        let view = page.create_view(&Default::default());
        let bind = self.s.device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &g.layout, entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&g.sampler) },
            wgpu::BindGroupEntry { binding: 2, resource: g.uniforms.as_entire_binding() } ] });
        let target = frame.texture.create_view(&Default::default());
        let mut enc = self.s.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: None, color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &target, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store }, depth_slice: None })], ..Default::default() });
            pass.set_pipeline(&g.pipeline); pass.set_bind_group(0, &bind, &[]); pass.draw(0..3, 0..1);
        }
        self.s.queue.submit(Some(enc.finish()));
        g.window.pre_present_notify();
        self.s.queue.present(frame);
    }
    /// Window pixels to page pixels (the page is drawn scaled into the rectangle).
    fn to_page(&self, x: f64, y: f64) -> Option<(i32, i32)> {
        let r = self.rect();
        let (u, v) = ((x as f32 - r[0]) / r[2], (y as f32 - r[1]) / r[3]);
        ((0.0..1.0).contains(&u) && (0.0..1.0).contains(&v)).then(|| ((u * self.s.view.0 as f32) as i32, (v * self.s.view.1 as f32) as i32))
    }
}

impl ApplicationHandler for App {
    fn resumed(&mut self, el: &ActiveEventLoop) {
        if self.gfx.is_some() { return }
        let window = Arc::new(el.create_window(WindowAttributes::default().with_title("Sotto electron helper spike").with_inner_size(winit::dpi::LogicalSize::new(1280.0, 800.0))).unwrap());
        let surface = self.instance.create_surface(window.clone()).unwrap();
        let size = window.inner_size();
        let config = wgpu::SurfaceConfiguration { usage: wgpu::TextureUsages::RENDER_ATTACHMENT, format: wgpu::TextureFormat::Bgra8Unorm, color_space: wgpu::SurfaceColorSpace::Auto, view_formats: vec![], alpha_mode: wgpu::CompositeAlphaMode::Auto, width: size.width.max(1), height: size.height.max(1), desired_maximum_frame_latency: 2, present_mode: wgpu::PresentMode::AutoVsync };
        let d = &self.s.device;
        surface.configure(d, &config);
        let layout = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &[
            wgpu::BindGroupLayoutEntry { binding: 0, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Texture { multisampled: false, view_dimension: wgpu::TextureViewDimension::D2, sample_type: wgpu::TextureSampleType::Float { filterable: true } }, count: None },
            wgpu::BindGroupLayoutEntry { binding: 1, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            wgpu::BindGroupLayoutEntry { binding: 2, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None } ] });
        let shader = d.create_shader_module(wgpu::ShaderModuleDescriptor { label: None, source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
        let pl = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
        let pipeline = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor { label: None, layout: Some(&pl),
            vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &shader, entry_point: Some("fs"), targets: &[Some(wgpu::ColorTargetState { format: config.format, blend: None, write_mask: wgpu::ColorWrites::ALL })], compilation_options: Default::default() }),
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None });
        let sampler = d.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
        let uniforms = d.create_buffer(&wgpu::BufferDescriptor { label: None, size: std::mem::size_of::<U>() as u64, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let placeholder = d.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Bgra8Unorm, usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[] });
        self.gfx = Some(Gfx { window: window.clone(), surface, config, pipeline, layout, sampler, uniforms, placeholder });
        let s = self.s.clone();
        std::thread::spawn(move || {
            let cycles: usize = env("WPE_CYCLES", "1").parse().unwrap();
            let hold: u64 = env("WPE_HOLD_S", "20").parse().unwrap();
            for n in 0..cycles { cycle(&s, n, if n == 0 { hold } else { env("WPE_HOLD_LATER_S", "3").parse().unwrap() }, &window); }
            s.done.store(true, Ordering::SeqCst);
            if let Some(p) = s.proxy.lock().unwrap().as_ref() { let _ = p.send_event(()); }
        });
    }
    fn user_event(&mut self, el: &ActiveEventLoop, _: ()) {
        if self.s.done.load(Ordering::SeqCst) { el.exit(); return }
        if let Some(g) = &self.gfx { g.window.request_redraw(); }
    }
    fn window_event(&mut self, el: &ActiveEventLoop, _: WindowId, e: WindowEvent) {
        match e {
            WindowEvent::CloseRequested => el.exit(),
            WindowEvent::Resized(sz) => { if let Some(g) = &mut self.gfx { g.config.width = sz.width.max(1); g.config.height = sz.height.max(1); g.surface.configure(&self.s.device, &g.config); g.window.request_redraw(); } }
            WindowEvent::RedrawRequested => self.draw(),
            WindowEvent::CursorMoved { position, .. } => self.cursor = (position.x, position.y),
            WindowEvent::MouseInput { state: ElementState::Pressed, button: MouseButton::Left, .. } => {
                if let Some((x, y)) = self.to_page(self.cursor.0, self.cursor.1) { send_line(&self.s, &format!("F\nC {x} {y}\n")); eprintln!("[input] click page {x},{y}"); }
            }
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => {
                if let Some(t) = event.text.as_ref() { let t: String = t.chars().filter(|c| !c.is_control()).collect(); if !t.is_empty() { send_line(&self.s, &format!("T {t}\n")); } }
            }
            _ => {}
        }
    }
}

fn pct(v: &mut Vec<u64>, p: f64) -> u64 { if v.is_empty() { return 0 } v.sort(); v[((v.len() - 1) as f64 * p) as usize] }

fn main() {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor { backends: wgpu::Backends::VULKAN, ..wgpu::InstanceDescriptor::new_without_display_handle() });
    let adapter = pollster::block_on(instance.request_adapter(&Default::default())).expect("adapter");
    eprintln!("[receiver] adapter {} driver {}", adapter.get_info().name, adapter.get_info().driver_info);
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { required_features: wgpu::Features::VULKAN_EXTERNAL_MEMORY_DMA_BUF, ..Default::default() })).expect("device");
    let view = env("WPE_VIEW", "1280x800"); let (a, b) = view.split_once('x').unwrap();
    let s = Arc::new(Shared { device, queue, texture: Mutex::new(None), stdin: Mutex::new(None), view: (a.parse().unwrap(), b.parse().unwrap()), frames: AtomicU64::new(0), import_us: Mutex::new(Vec::new()), samples: Mutex::new(Vec::new()), errors: Mutex::new(Vec::new()), cycles: Mutex::new(Vec::new()), proxy: Mutex::new(None), done: false.into() });
    let el = EventLoop::new().unwrap();
    *s.proxy.lock().unwrap() = Some(el.create_proxy());
    el.set_control_flow(ControlFlow::Wait);
    let mut app = App { s: s.clone(), instance, gfx: None, cursor: (0.0, 0.0) };
    let _ = el.run_app(&mut app);
    let mut us = s.import_us.lock().unwrap().clone();
    let samples = s.samples.lock().unwrap().clone();
    let hashes: std::collections::BTreeSet<String> = samples.iter().filter_map(|v| v["hash"].as_str().map(String::from)).collect();
    let out = serde_json::json!({
        "adapter": adapter.get_info().name, "view": view, "switches": env("WPE_SWITCHES", ""), "frames": s.frames.load(Ordering::Relaxed),
        "import_and_copy_us": { "n": us.len(), "p50": pct(&mut us, 0.5), "p95": pct(&mut us, 0.95), "max": pct(&mut us, 1.0) },
        "pixel_samples": samples.len(), "distinct_sample_hashes": hashes.len(), "samples_with_nonblack": samples.iter().filter(|v| v["nonblack"].as_u64().unwrap_or(0) > 0).count(),
        "samples": samples, "import_errors": *s.errors.lock().unwrap(), "cycles": *s.cycles.lock().unwrap(),
    });
    std::fs::write(format!("{}/receiver.json", env("WPE_RUN_DIR", ".")), serde_json::to_string_pretty(&out).unwrap()).unwrap();
    eprintln!("[receiver] done frames={} samples={} distinct={}", out["frames"], out["pixel_samples"], out["distinct_sample_hashes"]);
}
