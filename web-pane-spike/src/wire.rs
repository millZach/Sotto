//! The helper-process link: one SOCK_SEQPACKET socket pair between the window process and the CEF helper.
//! Frames go up as a dmabuf file descriptor (SCM_RIGHTS) and a 64-byte record; the window copies the frame and acks,
//! so the helper can hand the buffer back to CEF. Input goes down as 64-byte records.

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
    let r = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0, fds.as_mut_ptr()) };
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
            header.msg_controllen = space;
            let cmsg = libc::CMSG_FIRSTHDR(&header);
            (*cmsg).cmsg_level = libc::SOL_SOCKET;
            (*cmsg).cmsg_type = libc::SCM_RIGHTS;
            (*cmsg).cmsg_len = libc::CMSG_LEN(std::mem::size_of::<RawFd>() as u32) as usize;
            std::ptr::write_unaligned(libc::CMSG_DATA(cmsg) as *mut RawFd, fd);
        }
    }
    unsafe { libc::sendmsg(sock, &header, libc::MSG_NOSIGNAL) == 64 }
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
    header.msg_controllen = control.len();
    let n = unsafe { libc::recvmsg(sock, &mut header, libc::MSG_CMSG_CLOEXEC) };
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
