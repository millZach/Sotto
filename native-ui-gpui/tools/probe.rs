//! The outside measurer, used the same way on the GPUI build and on Electron Sotto.
//!
//! It sees only what reaches the screen: it reads pixels from the desktop
//! (the composed DWM output, through GDI `BitBlt`) and sends input through
//! `SendInput`, as a person's keyboard would. Windows only.
//!
//! Subcommands:
//!   probe launch <exe> [args...] --title <text>
//!       Time from process start to the window being visible, and to its first
//!       painted frame (more than 2% of a pixel grid differs from the window's
//!       first visible colour).
//!   probe type --title <text> --at <x>,<y> [--count 40] [--band 24]
//!       Click at window-relative physical pixels <x>,<y> (in the composer), then
//!       type characters one at a time. For each, the time from SendInput to the
//!       first change in a band of pixels around the caret row.
//!   probe keys --title <text> <key>...   Send keys: a-z, space, tab, shift-tab, enter, esc,
//!       pgup, pgdn, home, end, up, down, left, right, backspace, f6, ctrl-<k>, alt-<k>.
//!   probe click --title <text> <x>,<y>
//!   probe mem --name <process.exe> [--name ...]
//!       Working set and private bytes, summed over every process with that name.
//!   probe wheel --title <text> --at <x>,<y> <notches>

#[cfg(windows)]
fn main() {
    imp::main();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("probe runs on Windows only");
}

#[cfg(windows)]
mod imp {
    use std::time::{Duration, Instant};
    use windows::Win32::{
        Foundation::*,
        Graphics::{Dwm::*, Gdi::*},
        System::{ProcessStatus::*, Threading::*},
        UI::{Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    };
    use windows::core::BOOL;

    pub fn main() {
        unsafe {
            let _ = windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(
                windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            );
        }
        let args: Vec<String> = std::env::args().skip(1).collect();
        let Some(cmd) = args.first() else {
            eprintln!("usage: probe launch|type|keys|click|mem|wheel ...");
            std::process::exit(2);
        };
        let opt = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
        match cmd.as_str() {
            "launch" => launch(&args[1..]),
            "type" => {
                let title = opt("--title").expect("--title");
                let at = parse_xy(&opt("--at").expect("--at"));
                let count = opt("--count").and_then(|c| c.parse().ok()).unwrap_or(40);
                let band = opt("--band").and_then(|c| c.parse().ok()).unwrap_or(24);
                type_latency(&title, at, count, band);
            }
            "keys" => {
                let title = opt("--title").expect("--title");
                let hwnd = find(&title).expect("window");
                if !args.iter().any(|a| a == "--no-focus") {
                    focus(hwnd);
                }
                let keys: Vec<&String> = args.iter().skip(1).filter(|a| !a.starts_with("--") && **a != title).collect();
                for k in keys {
                    send_key(k);
                    std::thread::sleep(Duration::from_millis(60));
                }
            }
            "lang" => {
                // Ask the window to switch its input language, as the language bar does.
                let title = opt("--title").expect("--title");
                let klid = opt("--klid").expect("--klid, such as 00000411");
                let hwnd = find(&title).expect("window");
                focus(hwnd);
                let wide: Vec<u16> = klid.encode_utf16().chain(std::iter::once(0)).collect();
                unsafe {
                    let hkl = LoadKeyboardLayoutW(windows::core::PCWSTR(wide.as_ptr()), KLF_ACTIVATE).expect("layout");
                    let _ = PostMessageW(Some(hwnd), WM_INPUTLANGCHANGEREQUEST, WPARAM(0), LPARAM(hkl.0 as isize));
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            "watch" => {
                // Edit a source file, then time until the band of pixels at --at changes on screen.
                let title = opt("--title").expect("--title");
                let at = parse_xy(&opt("--at").expect("--at"));
                let band: i32 = opt("--band").and_then(|c| c.parse().ok()).unwrap_or(40);
                let file = opt("--file").expect("--file");
                let from = opt("--from").expect("--from");
                let to = opt("--to").expect("--to");
                let timeout: u64 = opt("--timeout").and_then(|c| c.parse().ok()).unwrap_or(600);
                watch(&title, at, band, &file, &from, &to, timeout);
            }
            "move" => {
                // Move a window's top-left to physical screen pixels x,y, keeping its size.
                let title = opt("--title").expect("--title");
                let hwnd = find(&title).expect("window");
                let xy = parse_xy(&opt("--to").expect("--to x,y"));
                unsafe {
                    let _ = SetWindowPos(hwnd, None, xy.0, xy.1, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
                }
                let r = rect(hwnd);
                println!("window now at {},{} to {},{}", r.left, r.top, r.right, r.bottom);
            }
            "click" => {
                let title = opt("--title").expect("--title");
                let hwnd = find(&title).expect("window");
                let xy = args.iter().skip(1).find(|a| a.contains(',') && !a.starts_with("--")).expect("x,y");
                focus(hwnd);
                click(hwnd, parse_xy(xy));
            }
            "wheel" => {
                let title = opt("--title").expect("--title");
                let hwnd = find(&title).expect("window");
                let at = parse_xy(&opt("--at").expect("--at"));
                let notches: i32 = args.last().unwrap().parse().expect("notches");
                focus(hwnd);
                wheel(hwnd, at, notches);
            }
            "mem" if opt("--tree").is_some() => mem_tree(opt("--tree").unwrap().parse().expect("pid")),
            "mem" => {
                let names: Vec<String> = args.windows(2).filter(|w| w[0] == "--name").map(|w| w[1].to_lowercase()).collect();
                mem(&names);
            }
            other => {
                eprintln!("unknown subcommand {other}");
                std::process::exit(2);
            }
        }
    }

    fn parse_xy(s: &str) -> (i32, i32) {
        let (x, y) = s.split_once(',').expect("x,y");
        (x.trim().parse().unwrap(), y.trim().parse().unwrap())
    }

    pub fn find(part: &str) -> Option<HWND> {
        struct Search {
            part: Vec<u16>,
            found: Option<HWND>,
            exact: bool,
        }
        unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
            unsafe {
                let search = &mut *(lparam.0 as *mut Search);
                if !IsWindowVisible(hwnd).as_bool() {
                    return BOOL(1);
                }
                // PROBE_PID limits the search to one process's windows.
                if let Some(want) = std::env::var("PROBE_PID").ok().and_then(|v| v.parse::<u32>().ok()) {
                    let mut pid = 0u32;
                    GetWindowThreadProcessId(hwnd, Some(&mut pid));
                    if pid != want {
                        return BOOL(1);
                    }
                }
                let mut buf = [0u16; 512];
                let n = GetWindowTextW(hwnd, &mut buf) as usize;
                let title = &buf[..n];
                let hit = if search.exact {
                    title == search.part.as_slice()
                } else {
                    search.part.len() <= title.len() && title.windows(search.part.len()).any(|w| w == search.part.as_slice())
                };
                if hit {
                    search.found = Some(hwnd);
                    return BOOL(0);
                }
                BOOL(1)
            }
        }
        let exact = part.starts_with('=');
        let part = part.trim_start_matches('=');
        let mut search = Search { part: part.encode_utf16().collect(), found: None, exact };
        unsafe {
            let _ = EnumWindows(Some(cb), LPARAM(&mut search as *mut _ as isize));
        }
        search.found
    }

    fn rect(hwnd: HWND) -> RECT {
        let mut r = RECT::default();
        unsafe {
            let _ = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut _ as *mut _, std::mem::size_of::<RECT>() as u32);
        }
        r
    }

    fn focus(hwnd: HWND) {
        unsafe {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            // Pressing and releasing Alt lets a background process take the foreground.
            send_vk(VK_MENU, false);
            send_vk(VK_MENU, true);
            let _ = SetForegroundWindow(hwnd);
        }
        std::thread::sleep(Duration::from_millis(250));
    }

    /// Pixels of a screen rectangle, BGRA.
    fn grab(x: i32, y: i32, w: i32, h: i32) -> Vec<u8> {
        unsafe {
            let screen = GetDC(None);
            let mem = CreateCompatibleDC(Some(screen));
            let bmp = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(mem, bmp.into());
            let _ = BitBlt(mem, 0, 0, w, h, Some(screen), x, y, SRCCOPY);
            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut out = vec![0u8; (w * h * 4) as usize];
            GetDIBits(mem, bmp, 0, h as u32, Some(out.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);
            SelectObject(mem, old);
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            out
        }
    }

    fn send_inputs(inputs: &[INPUT]) {
        unsafe {
            SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }

    fn vk_input(vk: VIRTUAL_KEY, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: 0 },
            },
        }
    }

    fn send_vk(vk: VIRTUAL_KEY, up: bool) {
        send_inputs(&[vk_input(vk, up)]);
    }

    fn vk_for(name: &str) -> Option<VIRTUAL_KEY> {
        Some(match name {
            "space" => VK_SPACE,
            "tab" => VK_TAB,
            "enter" => VK_RETURN,
            "esc" => VK_ESCAPE,
            "pgup" => VK_PRIOR,
            "pgdn" => VK_NEXT,
            "home" => VK_HOME,
            "end" => VK_END,
            "up" => VK_UP,
            "down" => VK_DOWN,
            "left" => VK_LEFT,
            "right" => VK_RIGHT,
            "backspace" => VK_BACK,
            "delete" => VK_DELETE,
            "f6" => VK_F6,
            "kanji" => VIRTUAL_KEY(0x19),
            "grave" => VK_OEM_3,
            "shift" => VK_SHIFT,
            k if k.len() == 1 => {
                let c = k.chars().next().unwrap().to_ascii_uppercase();
                VIRTUAL_KEY(c as u16)
            }
            _ => return None,
        })
    }

    pub fn send_key(spec: &str) {
        let mut parts: Vec<&str> = spec.split('-').collect();
        let key = parts.pop().unwrap();
        let mods: Vec<VIRTUAL_KEY> = parts
            .iter()
            .map(|m| match *m {
                "ctrl" => VK_CONTROL,
                "shift" => VK_SHIFT,
                "alt" => VK_MENU,
                "win" => VK_LWIN,
                other => panic!("unknown modifier {other}"),
            })
            .collect();
        let vk = vk_for(key).unwrap_or_else(|| panic!("unknown key {key}"));
        let mut inputs = Vec::new();
        for m in &mods {
            inputs.push(vk_input(*m, false));
        }
        inputs.push(vk_input(vk, false));
        inputs.push(vk_input(vk, true));
        for m in mods.iter().rev() {
            inputs.push(vk_input(*m, true));
        }
        send_inputs(&inputs);
    }

    fn mouse_to(hwnd: HWND, at: (i32, i32)) -> INPUT {
        let r = rect(hwnd);
        let (sx, sy) = (r.left + at.0, r.top + at.1);
        let (vw, vh) = unsafe { (GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN)) };
        let (vx, vy) = unsafe { (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN)) };
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: ((sx - vx) * 65535) / (vw - 1),
                    dy: ((sy - vy) * 65535) / (vh - 1),
                    mouseData: 0,
                    dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn click(hwnd: HWND, at: (i32, i32)) {
        let mv = mouse_to(hwnd, at);
        let button = |flags| INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        };
        send_inputs(&[mv, button(MOUSEEVENTF_LEFTDOWN), button(MOUSEEVENTF_LEFTUP)]);
        std::thread::sleep(Duration::from_millis(150));
    }

    fn wheel(hwnd: HWND, at: (i32, i32), notches: i32) {
        let mv = mouse_to(hwnd, at);
        send_inputs(&[mv]);
        for _ in 0..notches.abs() {
            let w = INPUT {
                r#type: INPUT_MOUSE,
                Anonymous: INPUT_0 {
                    mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: (120 * notches.signum()) as u32, dwFlags: MOUSEEVENTF_WHEEL, time: 0, dwExtraInfo: 0 },
                },
            };
            send_inputs(&[w]);
            std::thread::sleep(Duration::from_millis(40));
        }
    }

    fn type_latency(title: &str, at: (i32, i32), count: usize, band: i32) {
        let hwnd = find(title).expect("window");
        focus(hwnd);
        click(hwnd, at);
        std::thread::sleep(Duration::from_millis(500));
        let r = rect(hwnd);
        // A band the width of the window's left 70%, centred on the caret row.
        let (x, y, w, h) = (r.left + 4, r.top + at.1 - band / 2, ((r.right - r.left) as f32 * 0.7) as i32, band);
        let letters = b"harborschedulerkeepstheorderofarrivals";
        let mut samples = Vec::new();
        for i in 0..count {
            let before = grab(x, y, w, h);
            let vk = VIRTUAL_KEY(letters[i % letters.len()].to_ascii_uppercase() as u16);
            let start = Instant::now();
            send_inputs(&[vk_input(vk, false), vk_input(vk, true)]);
            let mut changed = None;
            while start.elapsed() < Duration::from_millis(1000) {
                if grab(x, y, w, h) != before {
                    changed = Some(start.elapsed());
                    break;
                }
            }
            match changed {
                Some(d) => samples.push(d.as_secs_f64() * 1000.),
                None => eprintln!("key {i}: no change within 1 s"),
            }
            std::thread::sleep(Duration::from_millis(80 + (i as u64 * 37) % 90));
        }
        // Clear what was typed.
        for _ in 0..count {
            send_inputs(&[vk_input(VK_BACK, false), vk_input(VK_BACK, true)]);
            std::thread::sleep(Duration::from_millis(5));
        }
        report("keypress to pixels (ms)", &mut samples);
    }

    fn watch(title: &str, at: (i32, i32), band: i32, file: &str, from: &str, to: &str, timeout: u64) {
        let hwnd = find(title).expect("window");
        let r = rect(hwnd);
        let (x, y, w, h) = (r.left + at.0 - 300, r.top + at.1 - band / 2, 600, band);
        let before = grab(x, y, w, h);
        let text = std::fs::read_to_string(file).expect("file");
        assert!(text.contains(from), "--from text not in file");
        let start = Instant::now();
        std::fs::write(file, text.replacen(from, to, 1)).expect("write");
        loop {
            // The window may be replaced by a relaunch; look it up again each time.
            if let Some(hwnd) = find(title) {
                let r = rect(hwnd);
                let (x, y) = (r.left + at.0 - 300, r.top + at.1 - band / 2);
                let now = grab(x, y, w, h);
                let differ = now.chunks(4).zip(before.chunks(4)).filter(|(a, b)| a != b).count();
                if differ > 200 {
                    println!("save to screen: {:.0} ms ({differ} pixels changed)", start.elapsed().as_secs_f64() * 1000.);
                    return;
                }
            }
            if start.elapsed() > Duration::from_secs(timeout) {
                println!("no change within {timeout} s");
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn report(label: &str, v: &mut Vec<f64>) {
        if v.is_empty() {
            println!("{label}: no samples");
            return;
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let p = |q: f64| v[((v.len() as f64 - 1.) * q).round() as usize];
        println!(
            "{label}: n={} median={:.1} p95={:.1} p99={:.1} max={:.1} min={:.1}",
            v.len(),
            p(0.5),
            p(0.95),
            p(0.99),
            v[v.len() - 1],
            v[0]
        );
    }

    fn launch(args: &[String]) {
        let title_ix = args.iter().position(|a| a == "--title").expect("--title");
        let title = args[title_ix + 1].clone();
        let exe = &args[0];
        let rest: Vec<&String> = args[1..title_ix].iter().collect();
        // CreateProcessW with no inherited handles: std's Command passes every inheritable
        // handle on, including the pipe a caller reads the probe's output from, and the
        // caller would then wait for the app to exit.
        let mut line: Vec<u16> = format!(
            "\"{exe}\"{}",
            rest.iter().map(|a| format!(" \"{a}\"")).collect::<String>()
        )
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
        let si = STARTUPINFOW { cb: std::mem::size_of::<STARTUPINFOW>() as u32, ..Default::default() };
        let mut pi = PROCESS_INFORMATION::default();
        let start = Instant::now();
        unsafe {
            CreateProcessW(
                None,
                Some(windows::core::PWSTR(line.as_mut_ptr())),
                None,
                None,
                false,
                PROCESS_CREATION_FLAGS(0),
                None,
                None,
                &si,
                &mut pi,
            )
            .expect("CreateProcessW");
            let _ = CloseHandle(pi.hThread);
            let _ = CloseHandle(pi.hProcess);
        }
        // Only this process's windows count, so another copy of the app can't be mistaken for it.
        unsafe { std::env::set_var("PROBE_PID", pi.dwProcessId.to_string()) };
        let mut visible = None;
        let hwnd = loop {
            if let Some(h) = find(&title) {
                visible = Some(start.elapsed());
                break h;
            }
            if start.elapsed() > Duration::from_secs(60) {
                eprintln!("no window after 60 s");
                std::process::exit(1);
            }
            std::thread::sleep(Duration::from_millis(1));
        };
        // Painted: more than 2% of a 64x40 grid of samples differs from the first sample.
        let painted = loop {
            let r = rect(hwnd);
            let (w, h) = (r.right - r.left, r.bottom - r.top);
            if w > 50 && h > 50 {
                let pixels = grab(r.left, r.top, w, h);
                let at = |x: i32, y: i32| {
                    let i = ((y * w + x) * 4) as usize;
                    [pixels[i], pixels[i + 1], pixels[i + 2]]
                };
                // Painted: at least 0.5% of every-4th-pixel samples differ by more than 24 levels
                // from the window's most common colour. Text alone passes; a blank fill does not.
                let mut counts = std::collections::HashMap::new();
                let mut samples = Vec::new();
                let mut y = 0;
                while y < h {
                    let mut x = 0;
                    while x < w {
                        let p = at(x, y);
                        *counts.entry([p[0] >> 3, p[1] >> 3, p[2] >> 3]).or_insert(0u32) += 1;
                        samples.push(p);
                        x += 4;
                    }
                    y += 4;
                }
                let mode = counts.iter().max_by_key(|(_, n)| **n).map(|(k, _)| *k).unwrap();
                let base = [mode[0] << 3, mode[1] << 3, mode[2] << 3];
                let differ = samples
                    .iter()
                    .filter(|p| p.iter().zip(base.iter()).any(|(a, b)| (*a as i32 - *b as i32).abs() > 24))
                    .count();
                if differ * 200 > samples.len() {
                    break start.elapsed();
                }
            }
            if start.elapsed() > Duration::from_secs(60) {
                eprintln!("no painted frame after 60 s");
                std::process::exit(1);
            }
            std::thread::sleep(Duration::from_millis(2));
        };
        println!(
            "window visible: {:.0} ms, first painted frame: {:.0} ms",
            visible.unwrap().as_secs_f64() * 1000.,
            painted.as_secs_f64() * 1000.
        );
    }

    /// Working set and private bytes summed over a process and all its descendants.
    fn mem_tree(root: u32) {
        use windows::Win32::System::Diagnostics::ToolHelp::*;
        let mut parents = Vec::new();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).expect("snapshot");
            let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            if Process32FirstW(snap, &mut e).is_ok() {
                loop {
                    parents.push((e.th32ProcessID, e.th32ParentProcessID));
                    if Process32NextW(snap, &mut e).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }
        let mut tree = vec![root];
        let mut grew = true;
        while grew {
            grew = false;
            for (pid, parent) in &parents {
                if tree.contains(parent) && !tree.contains(pid) {
                    tree.push(*pid);
                    grew = true;
                }
            }
        }
        let (mut ws, mut private) = (0u64, 0u64);
        for pid in &tree {
            unsafe {
                let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, *pid) else { continue };
                let mut c = PROCESS_MEMORY_COUNTERS_EX::default();
                if GetProcessMemoryInfo(handle, &mut c as *mut _ as *mut _, std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32).is_ok() {
                    ws += c.WorkingSetSize as u64;
                    private += c.PrivateUsage as u64;
                }
                let _ = CloseHandle(handle);
            }
        }
        println!(
            "processes: {}, working set: {:.1} MB, private bytes: {:.1} MB",
            tree.len(),
            ws as f64 / 1048576.,
            private as f64 / 1048576.
        );
    }

    fn mem(names: &[String]) {
        let mut pids = vec![0u32; 4096];
        let mut needed = 0u32;
        unsafe {
            let _ = EnumProcesses(pids.as_mut_ptr(), (pids.len() * 4) as u32, &mut needed);
        }
        pids.truncate((needed / 4) as usize);
        let (mut ws, mut private, mut count) = (0u64, 0u64, 0);
        for pid in pids {
            unsafe {
                let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, pid) else { continue };
                let mut buf = [0u16; 260];
                let mut len = buf.len() as u32;
                if QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
                    let path = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
                    let file = path.rsplit('\\').next().unwrap_or("").to_string();
                    if names.iter().any(|n| *n == file) {
                        let mut c = PROCESS_MEMORY_COUNTERS_EX::default();
                        if GetProcessMemoryInfo(handle, &mut c as *mut _ as *mut _, std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32).is_ok() {
                            ws += c.WorkingSetSize as u64;
                            private += c.PrivateUsage as u64;
                            count += 1;
                        }
                    }
                }
                let _ = CloseHandle(handle);
            }
        }
        println!(
            "processes: {count}, working set: {:.1} MB, private bytes: {:.1} MB",
            ws as f64 / 1048576.,
            private as f64 / 1048576.
        );
    }
}
