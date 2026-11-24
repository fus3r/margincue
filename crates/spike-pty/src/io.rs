//! Unix PTY ownership and I/O shared with the nested-terminal tests.

use std::ffi::{CStr, OsStr};
use std::fs::{File, OpenOptions};
use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Size {
    pub rows: u16,
    pub cols: u16,
    pub xpixel: u16,
    pub ypixel: u16,
}

impl Size {
    pub fn cells(rows: u16, cols: u16) -> Self {
        Self {
            rows,
            cols,
            xpixel: 0,
            ypixel: 0,
        }
    }

    fn winsize(self) -> libc::winsize {
        libc::winsize {
            ws_row: self.rows,
            ws_col: self.cols,
            ws_xpixel: self.xpixel,
            ws_ypixel: self.ypixel,
        }
    }

    pub fn viewport(self, band: u16) -> Self {
        // DECSTBM needs two rows. Release the band rather than reporting an
        // impossible size when a pane is temporarily very small.
        let rows = if self.rows.saturating_sub(band) >= 2 {
            self.rows - band
        } else {
            self.rows
        };
        Self {
            rows,
            ypixel: (u32::from(self.ypixel) * u32::from(rows) / u32::from(self.rows)) as u16,
            ..self
        }
    }

    pub fn read(fd: RawFd) -> io::Result<Self> {
        let mut ws = MaybeUninit::<libc::winsize>::uninit();
        let ws = unsafe {
            check(libc::ioctl(fd, libc::TIOCGWINSZ, ws.as_mut_ptr()))?;
            ws.assume_init()
        };
        Ok(Self {
            rows: ws.ws_row.max(1),
            cols: ws.ws_col.max(1),
            xpixel: ws.ws_xpixel,
            ypixel: ws.ws_ypixel,
        })
    }

    pub fn set(self, fd: RawFd) -> io::Result<()> {
        check(unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &self.winsize()) })?;
        Ok(())
    }
}

pub struct RawTerminal {
    pub file: File,
    pub original: libc::termios,
}

impl RawTerminal {
    pub fn open() -> io::Result<Self> {
        // Darwin does not reliably wake poll on the /dev/tty alias. Open the
        // concrete slave node, without changing O_NONBLOCK on the shell's fd.
        let mut name = [0; 1024];
        let named =
            unsafe { libc::ttyname_r(libc::STDIN_FILENO, name.as_mut_ptr(), name.len()) } == 0;
        let path = if named {
            OsStr::from_bytes(unsafe { CStr::from_ptr(name.as_ptr()) }.to_bytes())
        } else {
            OsStr::new("/dev/tty")
        };
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOCTTY | libc::O_NONBLOCK)
            .open(path)?;
        let fd = file.as_raw_fd();
        let original = terminal_attributes(fd)?;
        let mut raw = original;
        unsafe {
            libc::cfmakeraw(&mut raw);
            check(libc::tcsetattr(fd, libc::TCSANOW, &raw))?;
        }
        Ok(Self { file, original })
    }
}

impl Drop for RawTerminal {
    fn drop(&mut self) {
        unsafe { libc::tcsetattr(self.file.as_raw_fd(), libc::TCSANOW, &self.original) };
    }
}

pub fn terminal_attributes(fd: RawFd) -> io::Result<libc::termios> {
    let mut attrs = MaybeUninit::uninit();
    unsafe {
        check(libc::tcgetattr(fd, attrs.as_mut_ptr()))?;
        Ok(attrs.assume_init())
    }
}

pub struct PtyChild {
    pub master: File,
    pub child: Child,
}

impl PtyChild {
    pub fn spawn(
        mut command: Command,
        size: Size,
        attrs: Option<&libc::termios>,
    ) -> io::Result<Self> {
        let mut master_fd = -1;
        let mut slave_fd = -1;
        unsafe {
            // On Darwin the optional termios and winsize parameters are not
            // declared const. Supply our own writable copies on both platforms.
            let mut ws = size.winsize();
            let mut attrs = attrs.copied();
            check(libc::openpty(
                &mut master_fd,
                &mut slave_fd,
                std::ptr::null_mut(),
                attrs.as_mut().map_or(std::ptr::null_mut(), |attrs| attrs),
                &mut ws,
            ))?;
        }
        let master = unsafe { File::from_raw_fd(master_fd) };
        let slave = unsafe { File::from_raw_fd(slave_fd) };
        for fd in [master_fd, slave_fd] {
            check(unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) })?;
        }
        check(unsafe { libc::fcntl(master_fd, libc::F_SETFL, libc::O_NONBLOCK) })?;
        command
            .stdin(Stdio::from(slave.try_clone()?))
            .stdout(Stdio::from(slave.try_clone()?))
            .stderr(Stdio::from(slave));
        // std wires up the three slave descriptors before pre_exec. The new
        // session needs a controlling terminal for /dev/tty and SIGWINCH.
        unsafe {
            command.pre_exec(|| {
                check(libc::setsid())?;
                check(libc::ioctl(libc::STDIN_FILENO, libc::TIOCSCTTY as _, 0))?;
                Ok(())
            });
        }
        let child = command.spawn()?;
        Ok(Self { master, child })
    }
}

impl Drop for PtyChild {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            // This group was created by setsid above. Never signal the shell's
            // group or an existing agent session.
            unsafe { libc::kill(-(self.child.id() as libc::pid_t), libc::SIGKILL) };
            let _ = self.child.wait();
        }
    }
}

pub fn poll(fds: &mut [libc::pollfd], ms: i32) -> io::Result<usize> {
    loop {
        let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, ms) };
        match check(ready) {
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            result => return result.map(|ready| ready as usize),
        }
    }
}

pub fn event(fd: RawFd, events: i16) -> libc::pollfd {
    libc::pollfd {
        fd,
        events,
        revents: 0,
    }
}

pub fn has_event(fd: &libc::pollfd, events: i16) -> bool {
    fd.revents & events != 0
}

pub fn check(result: libc::c_int) -> io::Result<libc::c_int> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result)
    }
}
