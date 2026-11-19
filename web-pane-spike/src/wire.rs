//! The helper-process link: one SOCK_SEQPACKET socket pair between the window process and the CEF helper.
//! Frames go up as a dmabuf file descriptor (SCM_RIGHTS) and a 64-byte record; the window copies the frame and acks,
//! so the helper can hand the buffer back to CEF. Input goes down as 64-byte records.
//! macOS has no SOCK_SEQPACKET for Unix sockets, so there the pair is a stream of fixed 64-byte records, and frames
//! cross separately, as Mach messages (remote_mac.rs).

#[cfg(unix)]
use std::os::fd::RawFd;

pub const FRAME: u32 = 1;
pub const ACK: u32 = 2;
pub const MOVE: u32 = 3;
pub const CLICK: u32 = 4;
pub const WHEEL: u32 = 5;
pub const KEY: u32 = 6;
pub const FOCUS: u32 = 7;
pub const RESIZE: u32 = 8;
pub const SOFTWARE: u32 = 9;
/// Windows windowed helper: its page finished loading (no frames cross in that shape).
pub const LOADED: u32 = 10;

/// The key code CEF reads as `native_key_code`: on macOS the Carbon virtual key code (kVK_*), which CEF uses to build
/// the NSEvent and the page's `KeyboardEvent.key`; elsewhere the Windows virtual key code the spike already sends.
pub fn native_key_code(windows_code: i32) -> i32 {
    if !cfg!(target_os = "macos") { return windows_code }
    let letters = [0x00, 0x0B, 0x08, 0x02, 0x0E, 0x03, 0x05, 0x04, 0x22, 0x26, 0x28, 0x25, 0x2E, 0x2D, 0x1F, 0x23, 0x0C, 0x0F, 0x01, 0x11, 0x20, 0x09, 0x0D, 0x07, 0x10, 0x06];
    let digits = [0x1D, 0x12, 0x13, 0x14, 0x15, 0x17, 0x16, 0x1A, 0x1C, 0x19];
    match windows_code {
        0x41..=0x5A => letters[(windows_code - 0x41) as usize],
        0x30..=0x39 => digits[(windows_code - 0x30) as usize],
        0x0D => 0x24, 0x09 => 0x30, 0x20 => 0x31, 0x08 => 0x33, 0x1B => 0x35,
        0x25 => 0x7B, 0x27 => 0x7C, 0x28 => 0x7D, 0x26 => 0x7E,
        _ => windows_code,
    }
}

/// Sixteen little-endian u32 fields; field 0 is the kind. Frames carry u64s split over two fields.
#[derive(Clone, Copy, Default, Debug)]
pub struct Msg(pub [u32; 16]);

impl Msg {
    pub fn new(kind: u32, fields: &[u32]) -> Msg {
        let mut m = [0u32; 16];
        m[0] = kind;
        m[1..1 + fields.len()].copy_from_slice(fields);
        Msg(m)
    }
    pub fn kind(&self) -> u32 { self.0[0] }
    pub fn u64_at(&self, i: usize) -> u64 { self.0[i] as u64 | ((self.0[i + 1] as u64) << 32) }
    pub fn i(&self, i: usize) -> i32 { self.0[i] as i32 }
    #[allow(dead_code)]
    pub fn bytes(&self) -> [u8; 64] {
        let mut b = [0u8; 64];
        for (i, v) in self.0.iter().enumerate() { b[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes()); }
        b
    }
    #[allow(dead_code)]
    pub fn from_bytes(b: &[u8; 64]) -> Msg {
        let mut m = [0u32; 16];
        for (i, v) in m.iter_mut().enumerate() { *v = u32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap()); }
        Msg(m)
    }
}

#[cfg(unix)]
pub fn pair() -> (RawFd, RawFd) {
    let mut fds = [0; 2];
    #[cfg(target_os = "linux")]
    let r = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0, fds.as_mut_ptr()) };
    #[cfg(not(target_os = "linux"))]
    let r = unsafe {
        let r = libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr());
        for fd in fds {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
            let one: libc::c_int = 1;
            libc::setsockopt(fd, libc::SOL_SOCKET, libc::SO_NOSIGPIPE, &one as *const _ as *const libc::c_void, std::mem::size_of::<libc::c_int>() as libc::socklen_t);
        }
        r
    };
    assert_eq!(r, 0, "socketpair");
    (fds[0], fds[1])
}

/// Sends one record, with a file descriptor when `fd` is given. Returns false when the other side is gone.
#[cfg(unix)]
pub fn send(sock: RawFd, msg: &Msg, fd: Option<RawFd>) -> bool {
    let bytes = msg.bytes();
    let mut iov = libc::iovec { iov_base: bytes.as_ptr() as *mut _, iov_len: 64 };
    let mut control = [0u8; 64];
    let mut header: libc::msghdr = unsafe { std::mem::zeroed() };
    header.msg_iov = &mut iov;
    header.msg_iovlen = 1;
    if let Some(fd) = fd {
        unsafe {
            let space = libc::CMSG_SPACE(std::mem::size_of::<RawFd>() as u32) as usize;
            header.msg_control = control.as_mut_ptr() as *mut _;
            header.msg_controllen = space as _;
            let cmsg = libc::CMSG_FIRSTHDR(&header);
            (*cmsg).cmsg_level = libc::SOL_SOCKET;
            (*cmsg).cmsg_type = libc::SCM_RIGHTS;
            (*cmsg).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<RawFd>() as u32) as _;
            std::ptr::write_unaligned(libc::CMSG_DATA(cmsg) as *mut RawFd, fd);
        }
    }
    #[cfg(target_os = "linux")]
    let flags = libc::MSG_NOSIGNAL;
    #[cfg(not(target_os = "linux"))]
    let flags = 0;
    unsafe { libc::sendmsg(sock, &header, flags) == 64 }
}

/// Receives one record and the file descriptor it carried, if any. None when the other side is gone.
#[cfg(unix)]
pub fn recv(sock: RawFd) -> Option<(Msg, Option<RawFd>)> {
    let mut bytes = [0u8; 64];
    let mut iov = libc::iovec { iov_base: bytes.as_mut_ptr() as *mut _, iov_len: 64 };
    let mut control = [0u8; 64];
    let mut header: libc::msghdr = unsafe { std::mem::zeroed() };
    header.msg_iov = &mut iov;
    header.msg_iovlen = 1;
    header.msg_control = control.as_mut_ptr() as *mut _;
    header.msg_controllen = control.len() as _;
    #[cfg(target_os = "linux")]
    let flags = libc::MSG_CMSG_CLOEXEC;
    #[cfg(not(target_os = "linux"))]
    let flags = libc::MSG_WAITALL;
    let n = unsafe { libc::recvmsg(sock, &mut header, flags) };
    if n != 64 { return None }
    let mut fd = None;
    unsafe {
        let cmsg = libc::CMSG_FIRSTHDR(&header);
        if !cmsg.is_null() && (*cmsg).cmsg_level == libc::SOL_SOCKET && (*cmsg).cmsg_type == libc::SCM_RIGHTS {
            fd = Some(std::ptr::read_unaligned(libc::CMSG_DATA(cmsg) as *const RawFd));
        }
    }
    Some((Msg::from_bytes(&bytes), fd))
}
