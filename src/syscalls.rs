use std::collections::{HashSet, VecDeque};

use crate::memory::WasmMemory;
use crate::vfs::{VfsEntryKind, VirtualFileSystem};

#[repr(u32)]
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub enum Errno {
    Success = 0,
    TooBig = 1,
    Access = 2,
    Again = 6,
    Badf = 8,   // bad file descriptor
    Inval = 28, //invalid argument
    Noent = 44, // no such file or directory
    Nosys = 52, // function not implemented
    Perm = 63,
    Spipe = 73,
}

#[repr(u8)]
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub enum FileType {
    Unknown = 0,
    BlockDevice = 1,
    CharacterDevice = 2,
    Directory = 3,
    RegularFile = 4,
    SocketDgram = 5,
    SocketStream = 6,
    SymbolicLink = 7,
}

#[repr(u32)]
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub enum ClockId {
    Realtime = 0,
    Monotonic = 1,
    ProcessCputimeId = 2,
    ThreadCputimeId = 3,
}

const OFLAGS_CREAT: u32 = 1;
const OFLAGS_DIRECTORY: u32 = 2;
const OFLAGS_TRUNC: u32 = 8;
const DIRENT_SIZE: u32 = 24;
const FDFLAGS_APPEND: u32 = 1;

const WHENCE_SET: u32 = 0;
const WHENCE_CUR: u32 = 1;
const WHENCE_END: u32 = 2;

struct IoVec {
    buf: u32,
    buf_len: u32,
}

#[allow(dead_code)]
enum Descriptor {
    Directory {
        path: String,
    },
    File {
        path: String,
        offset: usize,
        append: bool,
    },
}

impl IoVec {
    fn read_from_memory(mem: &WasmMemory, ptr: u32) -> Result<Self, String> {
        // each IoVec is 8 bytes: 4 bytes ptr + 4 bytes len
        let buf = mem.read_u32(ptr)?;
        let len_ptr = ptr
            .checked_add(4)
            .ok_or_else(|| "iovec pointer overflow".to_string())?;
        let buf_len = mem.read_u32(len_ptr)?;
        Ok(IoVec { buf, buf_len })
    }
}

pub struct WasiRuntime {
    memory: WasmMemory,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdin: VecDeque<u8>,
    args: Vec<String>,
    environ: Vec<String>,
    preopens: Vec<String>,
    closed_fds: HashSet<u32>,
    descriptors: std::collections::HashMap<u32, Descriptor>,
    next_fd: u32,
    fs: VirtualFileSystem,
}

impl WasiRuntime {
    // ==============================
    // Construction
    // ==============================

    pub fn new(memory_size: usize) -> Self {
        let preopens = vec!["/".to_string()];
        let next_fd = 3 + preopens.len() as u32;

        Self {
            memory: WasmMemory::new(memory_size),
            stdout: Vec::new(),
            stderr: Vec::new(),
            stdin: VecDeque::new(),
            args: vec!["sh".to_string()],
            environ: vec!["PATH=/usr/bin:/bin".to_string(), "HOME=/home".to_string()],
            preopens,
            closed_fds: HashSet::new(),
            descriptors: std::collections::HashMap::new(),
            next_fd,
            fs: VirtualFileSystem::new(),
        }
    }

    // ==============================
    // Internal helpers
    // ==============================

    fn preopen_for_fd(&self, fd: u32) -> Option<&String> {
        if self.closed_fds.contains(&fd) {
            return None;
        }

        let preopen_idx = fd.checked_sub(3)? as usize;
        self.preopens.get(preopen_idx)
    }

    fn is_stdio_fd(fd: u32) -> bool {
        matches!(fd, 0 | 1 | 2)
    }

    fn is_fd_closed(&self, fd: u32) -> bool {
        self.closed_fds.contains(&fd)
    }

    fn is_open_fd(&self, fd: u32) -> bool {
        !self.is_fd_closed(fd)
            && (Self::is_stdio_fd(fd)
                || self.preopen_for_fd(fd).is_some()
                || self.descriptors.contains_key(&fd))
    }

    fn descriptor_file_type(&self, fd: u32) -> Option<FileType> {
        match self.descriptors.get(&fd)? {
            Descriptor::Directory { .. } => Some(FileType::Directory),
            Descriptor::File { .. } => Some(FileType::RegularFile),
        }
    }

    fn descriptor_dir_path(&self, fd: u32) -> Option<String> {
        if let Some(path) = self.preopen_for_fd(fd) {
            return Some(path.clone());
        }

        match self.descriptors.get(&fd)? {
            Descriptor::Directory { path } => Some(path.clone()),
            Descriptor::File { .. } => None,
        }
    }

    fn descriptor_file_state(&self, fd: u32) -> Option<(String, usize, bool)> {
        match self.descriptors.get(&fd)? {
            Descriptor::File {
                path,
                offset,
                append,
            } => Some((path.clone(), *offset, *append)),
            Descriptor::Directory { .. } => None,
        }
    }

    fn set_descriptor_file_offset(&mut self, fd: u32, offset: usize) -> Result<(), u32> {
        match self.descriptors.get_mut(&fd) {
            Some(Descriptor::File {
                offset: current_offset,
                ..
            }) => {
                *current_offset = offset;
                Ok(())
            }
            Some(Descriptor::Directory { .. }) => Err(Errno::Inval as u32),
            None => Err(Errno::Badf as u32),
        }
    }

    fn alloc_fd(&mut self, descriptor: Descriptor) -> Result<u32, u32> {
        let fd = self.next_fd;

        self.next_fd = self.next_fd.checked_add(1).ok_or(Errno::TooBig as u32)?;

        if self.descriptors.insert(fd, descriptor).is_some() {
            return Err(Errno::Inval as u32);
        }

        Ok(fd)
    }

    fn resolve_path(&self, dirfd: u32, path_ptr: u32, path_len: u32) -> Result<String, u32> {
        let path = self
            .memory
            .read_string(path_ptr, path_len)
            .map_err(|_| Errno::Inval as u32)?;

        if path.starts_with('/') {
            return Ok(Self::normalize_path("/", &path));
        }

        let base = self.descriptor_dir_path(dirfd).ok_or(Errno::Badf as u32)?;

        Ok(Self::normalize_path(&base, &path))
    }

    fn normalize_path(base: &str, path: &str) -> String {
        let joined = if path.starts_with('/') {
            path.to_string()
        } else if base == "/" {
            format!("/{}", path)
        } else {
            format!("{}/{}", base.trim_end_matches('/'), path)
        };

        let parts: Vec<&str> = joined
            .split('/')
            .filter(|part| !part.is_empty() && *part != ".")
            .collect();

        if parts.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", parts.join("/"))
        }
    }

    fn args(&self) -> Vec<String> {
        self.args.clone()
    }

    fn environ(&self) -> Vec<String> {
        self.environ.clone()
    }

    fn now_realtime_ns() -> Result<u64, String> {
        let duration = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("system time before unix epoch: {}", e))?;

        let nanos = duration
            .as_secs()
            .checked_mul(1_000_000_000)
            .and_then(|secs_ns| secs_ns.checked_add(duration.subsec_nanos() as u64))
            .ok_or_else(|| "timestamp overflow".to_string())?;

        Ok(nanos)
    }

    fn wasi_file_type(kind: VfsEntryKind) -> u8 {
        match kind {
            VfsEntryKind::Directory => FileType::Directory as u8,
            VfsEntryKind::File => FileType::RegularFile as u8,
        }
    }

    fn write_dirent(
        &mut self,
        dirent_ptr: u32,
        next_cookie: u64,
        inode: u64,
        name_len: u32,
        file_type: u8,
    ) -> Result<(), String> {
        let ino_ptr = dirent_ptr
            .checked_add(8)
            .ok_or_else(|| "dirent inode pointer overflow".to_string())?;
        let namlen_ptr = dirent_ptr
            .checked_add(16)
            .ok_or_else(|| "dirent namlen pointer overflow".to_string())?;
        let type_ptr = dirent_ptr
            .checked_add(20)
            .ok_or_else(|| "dirent type pointer overflow".to_string())?;

        self.memory.write_u64(dirent_ptr, next_cookie)?;
        self.memory.write_u64(ino_ptr, inode)?;
        self.memory.write_u32(namlen_ptr, name_len)?;
        self.memory.write_u8(type_ptr, file_type)?;

        let pad_1_ptr = type_ptr
            .checked_add(1)
            .ok_or_else(|| "dirent padding pointer overflow".to_string())?;
        let pad_2_ptr = type_ptr
            .checked_add(2)
            .ok_or_else(|| "dirent padding pointer overflow".to_string())?;
        let pad_3_ptr = type_ptr
            .checked_add(3)
            .ok_or_else(|| "dirent padding pointer overflow".to_string())?;

        self.memory.write_u8(pad_1_ptr, 0)?;
        self.memory.write_u8(pad_2_ptr, 0)?;
        self.memory.write_u8(pad_3_ptr, 0)?;

        Ok(())
    }

    fn seek_offset(
        current: usize,
        file_len: usize,
        offset: i64,
        whence: u32,
    ) -> Result<usize, u32> {
        let base = match whence {
            WHENCE_SET => 0_i128,
            WHENCE_CUR => current as i128,
            WHENCE_END => file_len as i128,
            _ => return Err(Errno::Inval as u32),
        };

        let next = base
            .checked_add(offset as i128)
            .ok_or(Errno::Inval as u32)?;

        if next < 0 {
            return Err(Errno::Inval as u32);
        }

        usize::try_from(next).map_err(|_| Errno::Inval as u32)
    }

    // ==============================
    // Host-facing helpers
    // ==============================

    // Get stdout and stderr contents and clear the buffer.
    pub fn take_stdout(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.stdout)
    }

    pub fn take_stderr(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.stderr)
    }

    pub fn feed_stdin(&mut self, data: &[u8]) {
        self.stdin.extend(data);
    }

    pub fn set_args(&mut self, args: Vec<String>) {
        self.args = args;
    }

    pub fn set_environ(&mut self, environ: Vec<String>) {
        self.environ = environ;
    }

    pub fn memory_len(&self) -> usize {
        self.memory.len()
    }

    pub fn read_memory(&self, ptr: u32, len: u32) -> Result<Vec<u8>, String> {
        self.memory.read_bytes(ptr, len)
    }

    pub fn write_memory(&mut self, ptr: u32, bytes: &[u8]) -> Result<(), String> {
        self.memory.write_bytes(ptr, bytes)
    }

    #[cfg(target_arch = "wasm32")]
    pub fn attach_guest_memory(&mut self, memory: js_sys::WebAssembly::Memory) {
        self.memory = WasmMemory::from_guest(memory);
    }

    // ==============================
    // File descriptor syscalls
    // ==============================

    // Writes data from WASM memory to a file descriptor.
    // fd 1 = stdout, fd 2 = stderr
    pub fn fd_write(
        &mut self,
        fd: u32,
        iovs_ptr: u32,     // pointer to array of iovecs
        iovs_len: u32,     // number of iovecs
        nwritten_ptr: u32, // where to write total bytes written
    ) -> u32 {
        if self.is_fd_closed(fd) {
            return Errno::Badf as u32;
        }

        let mut total_written: u32 = 0;
        let mut file_state = match fd {
            1 | 2 => None,
            _ => match self.descriptor_file_state(fd) {
                Some(state) => Some(state),
                None => return Errno::Badf as u32,
            },
        };

        for i in 0..iovs_len {
            // each iovec is 8 bytes so offset by i * 8
            let iov_offset = match i.checked_mul(8) {
                Some(v) => v,
                None => return Errno::Inval as u32,
            };
            let iov_ptr = match iovs_ptr.checked_add(iov_offset) {
                Some(v) => v,
                None => return Errno::Inval as u32,
            };
            let iov = match IoVec::read_from_memory(&self.memory, iov_ptr) {
                Ok(v) => v,
                Err(_) => return Errno::Inval as u32,
            };

            let bytes = match self.memory.read_bytes(iov.buf, iov.buf_len) {
                Ok(b) => b,
                Err(_) => return Errno::Inval as u32,
            };

            match fd {
                1 => self.stdout.extend_from_slice(&bytes),
                2 => self.stderr.extend_from_slice(&bytes),
                _ => {
                    let (path, offset, append) = match &file_state {
                        Some((path, offset, append)) => (path.clone(), *offset, *append),
                        None => return Errno::Badf as u32,
                    };

                    let write_offset = if append {
                        match self.fs.file_len(&path) {
                            Ok(len) => len,
                            Err(_) => return Errno::Inval as u32,
                        }
                    } else {
                        offset
                    };

                    let bytes_written = match self.fs.write_file(&path, write_offset, &bytes) {
                        Ok(bytes_written) => bytes_written,
                        Err(_) => return Errno::Inval as u32,
                    };

                    let next_offset = match write_offset.checked_add(bytes_written) {
                        Some(v) => v,
                        None => return Errno::Inval as u32,
                    };

                    file_state = Some((path, next_offset, append));
                }
            }

            total_written = match total_written.checked_add(iov.buf_len) {
                Some(v) => v,
                None => return Errno::Inval as u32,
            };
        }

        // Write total bytes written back into WASM memory
        if let Err(_) = self.memory.write_u32(nwritten_ptr, total_written) {
            return Errno::Inval as u32;
        }

        if let Some((_, offset, _)) = file_state {
            if let Err(errno) = self.set_descriptor_file_offset(fd, offset) {
                return errno;
            }
        }

        Errno::Success as u32
    }

    pub fn fd_read(
        &mut self,
        fd: u32,
        iovs_ptr: u32,  // pointer to array of iovecs
        iovs_len: u32,  // number of iovecs
        nread_ptr: u32, // where to write total bytes actually read
    ) -> u32 {
        if self.is_fd_closed(fd) {
            return Errno::Badf as u32;
        }

        let mut total_read: u32 = 0;
        let mut file_state = match fd {
            0 => None,
            _ => match self.descriptor_file_state(fd) {
                Some(state) => Some(state),
                None => return Errno::Badf as u32,
            },
        };

        for i in 0..iovs_len {
            let iov_offset = match i.checked_mul(8) {
                Some(v) => v,
                None => return Errno::Inval as u32,
            };
            let iov_ptr = match iovs_ptr.checked_add(iov_offset) {
                Some(v) => v,
                None => return Errno::Inval as u32,
            };

            // Read the iovec. It tells us where in WASM memory to write
            // and how many bytes that slot can hold
            let buf_ptr = match self.memory.read_u32(iov_ptr) {
                Ok(v) => v,
                Err(_) => return Errno::Inval as u32,
            };

            let buf_len_ptr = match iov_ptr.checked_add(4) {
                Some(v) => v,
                None => return Errno::Inval as u32,
            };
            let buf_len = match self.memory.read_u32(buf_len_ptr) {
                Ok(v) => v,
                Err(_) => return Errno::Inval as u32,
            };

            let bytes_read = match fd {
                0 => {
                    let mut bytes_read: u32 = 0;
                    for j in 0..buf_len {
                        match self.stdin.pop_front() {
                            Some(byte) => {
                                let write_pos = match (buf_ptr as usize).checked_add(j as usize) {
                                    Some(v) => v,
                                    None => return Errno::Inval as u32,
                                };
                                if let Err(_) = self.memory.write_byte(write_pos, byte) {
                                    return Errno::Inval as u32;
                                }
                                bytes_read += 1;
                            }
                            None => break,
                        }
                    }
                    bytes_read
                }
                _ => {
                    let (path, offset, append) = match &file_state {
                        Some((path, offset, append)) => (path.clone(), *offset, *append),
                        None => return Errno::Badf as u32,
                    };

                    let mut buf = vec![0; buf_len as usize];

                    let bytes_read = match self.fs.read_file(&path, offset, &mut buf) {
                        Ok(bytes_read) => bytes_read,
                        Err(_) => return Errno::Inval as u32,
                    };

                    let bytes_read_u32 = match u32::try_from(bytes_read) {
                        Ok(v) => v,
                        Err(_) => return Errno::Inval as u32,
                    };

                    if self
                        .memory
                        .write_bytes(buf_ptr, &buf[..bytes_read])
                        .is_err()
                    {
                        return Errno::Inval as u32;
                    }

                    let next_offset = match offset.checked_add(bytes_read) {
                        Some(v) => v,
                        None => return Errno::Inval as u32,
                    };

                    file_state = Some((path, next_offset, append));

                    bytes_read_u32
                }
            };

            total_read = match total_read.checked_add(bytes_read) {
                Some(v) => v,
                None => return Errno::Inval as u32,
            };

            if bytes_read < buf_len {
                break;
            }
        }

        if let Err(_) = self.memory.write_u32(nread_ptr, total_read) {
            return Errno::Inval as u32;
        }

        if let Some((_, offset, _)) = file_state {
            if let Err(errno) = self.set_descriptor_file_offset(fd, offset) {
                return errno;
            }
        }

        Errno::Success as u32
    }

    pub fn fd_readdir(
        &mut self,
        fd: u32,
        buf_ptr: u32,
        buf_len: u32,
        cookie: u64,
        bufused_ptr: u32,
    ) -> u32 {
        let dir_path = match self.descriptor_dir_path(fd) {
            Some(path) => path,
            None => return Errno::Badf as u32,
        };

        let entries = match self.fs.read_dir(&dir_path) {
            Ok(entries) => entries,
            Err(_) => return Errno::Badf as u32,
        };

        let mut cursor = buf_ptr;
        let mut used: u32 = 0;

        let start_index = match usize::try_from(cookie) {
            Ok(v) => v,
            Err(_) => {
                return match self.memory.write_u32(bufused_ptr, 0) {
                    Ok(_) => Errno::Success as u32,
                    Err(_) => Errno::Inval as u32,
                };
            }
        };

        for (index, entry) in entries.iter().enumerate().skip(start_index) {
            let name_bytes = entry.name.as_bytes();
            let name_len = name_bytes.len() as u32;

            let record_len = match DIRENT_SIZE.checked_add(name_len) {
                Some(v) => v,
                None => return Errno::Inval as u32,
            };

            let next_used = match used.checked_add(record_len) {
                Some(v) => v,
                None => return Errno::Inval as u32,
            };

            if next_used > buf_len {
                break;
            }

            let next_cookie = (index + 1) as u64;
            let inode = next_cookie;

            if self
                .write_dirent(
                    cursor,
                    next_cookie,
                    inode,
                    name_len,
                    Self::wasi_file_type(entry.kind),
                )
                .is_err()
            {
                return Errno::Inval as u32;
            }

            let name_ptr = match cursor.checked_add(DIRENT_SIZE) {
                Some(v) => v,
                None => return Errno::Inval as u32,
            };

            for (i, &byte) in name_bytes.iter().enumerate() {
                let write_pos = match (name_ptr as usize).checked_add(i) {
                    Some(v) => v,
                    None => return Errno::Inval as u32,
                };

                if self.memory.write_byte(write_pos, byte).is_err() {
                    return Errno::Inval as u32;
                }
            }

            cursor = match cursor.checked_add(record_len) {
                Some(v) => v,
                None => return Errno::Inval as u32,
            };

            used = next_used;
        }

        match self.memory.write_u32(bufused_ptr, used) {
            Ok(_) => Errno::Success as u32,
            Err(_) => Errno::Inval as u32,
        }
    }

    pub fn fd_seek(&mut self, fd: u32, offset: i64, whence: u32, newoffset_ptr: u32) -> u32 {
        if self.is_fd_closed(fd) {
            return Errno::Badf as u32;
        }

        match fd {
            0 | 1 | 2 => return Errno::Spipe as u32,
            _ => {}
        }

        let (path, current_offset, _) = match self.descriptor_file_state(fd) {
            Some(state) => state,
            None if self.preopen_for_fd(fd).is_some() => return Errno::Inval as u32,
            None => return Errno::Badf as u32,
        };

        let file_len = match self.fs.file_len(&path) {
            Ok(len) => len,
            Err(_) => return Errno::Inval as u32,
        };

        let new_offset = match Self::seek_offset(current_offset, file_len, offset, whence) {
            Ok(offset) => offset,
            Err(errno) => return errno,
        };

        if let Err(errno) = self.set_descriptor_file_offset(fd, new_offset) {
            return errno;
        }

        let new_offset_u64 = match u64::try_from(new_offset) {
            Ok(value) => value,
            Err(_) => return Errno::Inval as u32,
        };

        match self.memory.write_u64(newoffset_ptr, new_offset_u64) {
            Ok(_) => Errno::Success as u32,
            Err(_) => Errno::Inval as u32,
        }
    }

    pub fn fd_fdstat_get(&mut self, fd: u32, stat_ptr: u32) -> u32 {
        let all_rights: u64 = u64::MAX;

        let file_type = match fd {
            0 | 1 | 2 if !self.is_fd_closed(fd) => FileType::CharacterDevice,
            _ if self.preopen_for_fd(fd).is_some() => FileType::Directory,
            _ => match self.descriptor_file_type(fd) {
                Some(file_type) => file_type,
                None => return Errno::Badf as u32,
            },
        };

        match self
            .memory
            .write_fdstat(stat_ptr, file_type as u8, 0, all_rights, all_rights)
        {
            Ok(_) => Errno::Success as u32,
            Err(_) => Errno::Inval as u32,
        }
    }

    pub fn fd_filestat_get(&mut self, fd: u32, stat_ptr: u32) -> u32 {
        if self.is_fd_closed(fd) {
            return Errno::Badf as u32;
        }

        let (file_type, size) = match fd {
            0 | 1 | 2 => (FileType::CharacterDevice, 0),
            _ if self.preopen_for_fd(fd).is_some() => (FileType::Directory, 0),
            _ => match self.descriptors.get(&fd) {
                Some(Descriptor::Directory { path }) => {
                    let size = match self.fs.entry_size(path) {
                        Ok(size) => size,
                        Err(_) => return Errno::Inval as u32,
                    };

                    (FileType::Directory, size)
                }
                Some(Descriptor::File { path, .. }) => {
                    let size = match self.fs.entry_size(path) {
                        Ok(size) => size,
                        Err(_) => return Errno::Inval as u32,
                    };

                    (FileType::RegularFile, size)
                }
                None => return Errno::Badf as u32,
            },
        };

        match self.memory.write_filestat(stat_ptr, file_type as u8, size) {
            Ok(_) => Errno::Success as u32,
            Err(_) => Errno::Inval as u32,
        }
    }

    pub fn path_filestat_get(
        &mut self,
        dirfd: u32,
        _flags: u32,
        path_ptr: u32,
        path_len: u32,
        stat_ptr: u32,
    ) -> u32 {
        let path = match self.resolve_path(dirfd, path_ptr, path_len) {
            Ok(path) => path,
            Err(errno) => return errno,
        };

        let kind = match self.fs.kind(&path) {
            Ok(Some(kind)) => kind,
            Ok(None) => return Errno::Noent as u32,
            Err(_) => return Errno::Inval as u32,
        };

        let file_type = match kind {
            VfsEntryKind::Directory => FileType::Directory,
            VfsEntryKind::File => FileType::RegularFile,
        };

        let size = match self.fs.entry_size(&path) {
            Ok(size) => size,
            Err(_) => return Errno::Inval as u32,
        };

        match self.memory.write_filestat(stat_ptr, file_type as u8, size) {
            Ok(_) => Errno::Success as u32,
            Err(_) => Errno::Inval as u32,
        }
    }

    pub fn fd_prestat_get(&mut self, fd: u32, prestat_ptr: u32) -> u32 {
        match self.preopen_for_fd(fd) {
            Some(path) => {
                let name_len = path.len() as u32;
                match self.memory.write_prestat_dir(prestat_ptr, name_len) {
                    Ok(_) => Errno::Success as u32,
                    Err(_) => Errno::Inval as u32,
                }
            }
            None => Errno::Badf as u32,
        }
    }

    pub fn fd_prestat_dir_name(&mut self, fd: u32, path_ptr: u32, path_len: u32) -> u32 {
        let path = match self.preopen_for_fd(fd) {
            Some(p) => p.clone(),
            None => return Errno::Badf as u32,
        };

        let bytes = path.as_bytes();

        if bytes.len() > path_len as usize {
            return Errno::Inval as u32;
        }

        for (i, &byte) in bytes.iter().enumerate() {
            let write_pos = path_ptr as usize + i;
            if let Err(_) = self.memory.write_byte(write_pos, byte) {
                return Errno::Inval as u32;
            }
        }

        Errno::Success as u32
    }

    pub fn fd_close(&mut self, fd: u32) -> u32 {
        if !self.is_open_fd(fd) {
            return Errno::Badf as u32;
        }

        if self.descriptors.remove(&fd).is_none() {
            self.closed_fds.insert(fd);
        }

        Errno::Success as u32
    }

    // ==============================
    // Argument and environment syscalls
    // ==============================

    pub fn args_sizes_get(&mut self, argc_ptr: u32, argv_buf_size_ptr: u32) -> u32 {
        let args = self.args();

        let argc = args.len() as u32;
        let buf_size: u32 = args.iter().map(|a| a.len() as u32 + 1).sum();

        if let Err(_) = self.memory.write_u32(argc_ptr, argc) {
            return Errno::Inval as u32;
        }

        if let Err(_) = self.memory.write_u32(argv_buf_size_ptr, buf_size) {
            return Errno::Inval as u32;
        }

        Errno::Success as u32
    }

    pub fn args_get(&mut self, argv_ptr: u32, argv_buf_ptr: u32) -> u32 {
        let args = self.args();
        let mut buf_offset = argv_buf_ptr;

        for (i, arg) in args.iter().enumerate() {
            let ptr_offset = match (i as u32).checked_mul(4) {
                Some(offset) => offset,
                None => return Errno::Inval as u32,
            };
            let ptr_location = match argv_ptr.checked_add(ptr_offset) {
                Some(ptr) => ptr,
                None => return Errno::Inval as u32,
            };
            if let Err(_) = self.memory.write_u32(ptr_location, buf_offset) {
                return Errno::Inval as u32;
            }

            let bytes = arg.as_bytes();
            for (j, &byte) in bytes.iter().enumerate() {
                let write_pos = buf_offset as usize + j;
                if write_pos >= self.memory.len() {
                    return Errno::Inval as u32;
                }

                if let Err(_) = self.memory.write_byte(write_pos, byte) {
                    return Errno::Inval as u32;
                }
            }

            let null_pos = buf_offset as usize + bytes.len();
            if let Err(_) = self.memory.write_byte(null_pos, 0) {
                return Errno::Inval as u32;
            }

            let advance = match u32::try_from(bytes.len() + 1) {
                Ok(advance) => advance,
                Err(_) => return Errno::Inval as u32,
            };

            buf_offset = match buf_offset.checked_add(advance) {
                Some(next) => next,
                None => return Errno::Inval as u32,
            }
        }

        Errno::Success as u32
    }

    pub fn environ_sizes_get(&mut self, count_ptr: u32, buf_size_ptr: u32) -> u32 {
        let env = self.environ();

        let count = env.len() as u32;
        let buf_size: u32 = env.iter().map(|e| e.len() as u32 + 1).sum();

        if let Err(_) = self.memory.write_u32(count_ptr, count) {
            return Errno::Inval as u32;
        }
        if let Err(_) = self.memory.write_u32(buf_size_ptr, buf_size) {
            return Errno::Inval as u32;
        }

        Errno::Success as u32
    }

    pub fn environ_get(&mut self, environ_ptr: u32, environ_buf_ptr: u32) -> u32 {
        let env = self.environ();
        let mut buf_offset = environ_buf_ptr;

        for (i, var) in env.iter().enumerate() {
            let ptr_offset = match (i as u32).checked_mul(4) {
                Some(offset) => offset,
                None => return Errno::Inval as u32,
            };
            let ptr_location = match environ_ptr.checked_add(ptr_offset) {
                Some(ptr) => ptr,
                None => return Errno::Inval as u32,
            };
            if let Err(_) = self.memory.write_u32(ptr_location, buf_offset) {
                return Errno::Inval as u32;
            }

            let bytes = var.as_bytes();
            for (j, &byte) in bytes.iter().enumerate() {
                let write_pos = buf_offset as usize + j;
                if let Err(_) = self.memory.write_byte(write_pos, byte) {
                    return Errno::Inval as u32;
                }
            }

            let null_pos = buf_offset as usize + bytes.len();
            if let Err(_) = self.memory.write_byte(null_pos, 0) {
                return Errno::Inval as u32;
            }

            let advance = match u32::try_from(bytes.len() + 1) {
                Ok(advance) => advance,
                Err(_) => return Errno::Inval as u32,
            };

            buf_offset = match buf_offset.checked_add(advance) {
                Some(next) => next,
                None => return Errno::Inval as u32,
            }
        }

        Errno::Success as u32
    }

    // ==============================
    // Time and randomness syscalls
    // ==============================

    pub fn clock_time_get(&mut self, clock_id: u32, _precision: u64, time_ptr: u32) -> u32 {
        let now = match clock_id {
            0 | 1 => match Self::now_realtime_ns() {
                Ok(v) => v,
                Err(_) => return Errno::Inval as u32,
            },
            2 | 3 => return Errno::Inval as u32,
            _ => return Errno::Inval as u32,
        };

        match self.memory.write_u64(time_ptr, now) {
            Ok(_) => Errno::Success as u32,
            Err(_) => Errno::Inval as u32,
        }
    }

    pub fn random_get(&mut self, buf_ptr: u32, buf_len: u32) -> u32 {
        let len = match usize::try_from(buf_len) {
            Ok(len) => len,
            Err(_) => return Errno::Inval as u32,
        };
        let mut bytes = vec![0; len];

        if self.memory.read_bytes(buf_ptr, buf_len).is_err() {
            return Errno::Inval as u32;
        }

        match getrandom::getrandom(&mut bytes) {
            Ok(_) => match self.memory.write_bytes(buf_ptr, &bytes) {
                Ok(_) => Errno::Success as u32,
                Err(_) => Errno::Inval as u32,
            },
            Err(_) => Errno::Inval as u32,
        }
    }

    // ==============================
    // Path syscalls
    // ==============================

    pub fn path_open(
        &mut self,
        dirfd: u32,
        _dirflags: u32,
        path_ptr: u32,
        path_len: u32,
        oflags: u32,
        _rights_base: u64,
        _rights_inheriting: u64,
        fdflags: u32,
        opened_fd_ptr: u32,
    ) -> u32 {
        let path = match self.resolve_path(dirfd, path_ptr, path_len) {
            Ok(path) => path,
            Err(errno) => return errno,
        };

        let wants_directory = oflags & OFLAGS_DIRECTORY != 0;
        let wants_create = oflags & OFLAGS_CREAT != 0;
        let wants_truncate = oflags & OFLAGS_TRUNC != 0;
        let wants_append = fdflags & FDFLAGS_APPEND != 0;

        let descriptor = match self.fs.kind(&path) {
            Ok(Some(VfsEntryKind::Directory)) => Descriptor::Directory { path },
            Ok(Some(VfsEntryKind::File)) if wants_directory => return Errno::Inval as u32,
            Ok(Some(VfsEntryKind::File)) => {
                if wants_truncate && self.fs.truncate_file(&path).is_err() {
                    return Errno::Inval as u32;
                }

                let offset = if wants_append {
                    match self.fs.file_len(&path) {
                        Ok(len) => len,
                        Err(_) => return Errno::Inval as u32,
                    }
                } else {
                    0
                };

                Descriptor::File {
                    path,
                    offset,
                    append: wants_append,
                }
            }
            Ok(None) if wants_create && !wants_directory => {
                if self.fs.create_file(&path).is_err() {
                    return Errno::Noent as u32;
                }
                Descriptor::File {
                    path,
                    offset: 0,
                    append: wants_append,
                }
            }
            Ok(None) => return Errno::Noent as u32,
            Err(_) => return Errno::Inval as u32,
        };

        if self.memory.read_bytes(opened_fd_ptr, 4).is_err() {
            return Errno::Inval as u32;
        }

        let opened_fd = match self.alloc_fd(descriptor) {
            Ok(fd) => fd,
            Err(errno) => return errno,
        };

        match self.memory.write_u32(opened_fd_ptr, opened_fd) {
            Ok(_) => Errno::Success as u32,
            Err(_) => {
                self.descriptors.remove(&opened_fd);
                Errno::Inval as u32
            }
        }
    }

    pub fn path_create_directory(&mut self, dirfd: u32, path_ptr: u32, path_len: u32) -> u32 {
        let path = match self.resolve_path(dirfd, path_ptr, path_len) {
            Ok(path) => path,
            Err(errno) => return errno,
        };

        match self.fs.kind(&path) {
            Ok(Some(_)) => return Errno::Inval as u32,
            Ok(None) => {}
            Err(_) => return Errno::Inval as u32,
        }

        match self.fs.create_directory(&path) {
            Ok(_) => Errno::Success as u32,
            Err(_) => Errno::Noent as u32,
        }
    }

    pub fn path_unlink_file(&mut self, dirfd: u32, path_ptr: u32, path_len: u32) -> u32 {
        let path = match self.resolve_path(dirfd, path_ptr, path_len) {
            Ok(path) => path,
            Err(errno) => return errno,
        };

        match self.fs.kind(&path) {
            Ok(Some(VfsEntryKind::File)) => {}
            Ok(Some(VfsEntryKind::Directory)) => return Errno::Inval as u32,
            Ok(None) => return Errno::Noent as u32,
            Err(_) => return Errno::Inval as u32,
        }

        match self.fs.unlink_file(&path) {
            Ok(_) => Errno::Success as u32,
            Err(_) => Errno::Inval as u32,
        }
    }

    pub fn path_remove_directory(&mut self, dirfd: u32, path_ptr: u32, path_len: u32) -> u32 {
        let path = match self.resolve_path(dirfd, path_ptr, path_len) {
            Ok(path) => path,
            Err(errno) => return errno,
        };

        match self.fs.kind(&path) {
            Ok(Some(VfsEntryKind::Directory)) => {}
            Ok(Some(VfsEntryKind::File)) => return Errno::Inval as u32,
            Ok(None) => return Errno::Noent as u32,
            Err(_) => return Errno::Inval as u32,
        }

        match self.fs.remove_directory(&path) {
            Ok(_) => Errno::Success as u32,
            Err(_) => Errno::Inval as u32,
        }
    }

    // ==============================
    // Process syscalls
    // ==============================

    // Called when the WASM program wants to exit.
    pub fn proc_exit(&self, code: u32) {
        #[cfg(target_arch = "wasm32")]
        web_sys::console::log_1(&format!("process exited with code {}", code).into());

        #[cfg(not(target_arch = "wasm32"))]
        eprintln!("process exited with code {}", code);
    }

    // ==============================
    // Fallback
    // ==============================

    pub fn stub(&self, name: &str) -> u32 {
        #[cfg(target_arch = "wasm32")]
        web_sys::console::warn_1(&format!("unimplemented syscall: {}", name).into());

        #[cfg(not(target_arch = "wasm32"))]
        eprintln!("unimplemented syscall: {}", name);

        Errno::Nosys as u32
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Errno, FileType, WasiRuntime, DIRENT_SIZE, FDFLAGS_APPEND, OFLAGS_CREAT, OFLAGS_DIRECTORY,
        OFLAGS_TRUNC, WHENCE_CUR, WHENCE_END, WHENCE_SET,
    };

    fn write_str(runtime: &mut WasiRuntime, ptr: u32, value: &str) {
        for (i, byte) in value.as_bytes().iter().enumerate() {
            runtime.memory.write_byte(ptr as usize + i, *byte).unwrap();
        }
    }

    fn read_u32(runtime: &WasiRuntime, ptr: u32) -> u32 {
        runtime.memory.read_u32(ptr).unwrap()
    }

    fn read_u64(runtime: &WasiRuntime, ptr: u32) -> u64 {
        let bytes = runtime.memory.slice(ptr, 8).unwrap();
        u64::from_le_bytes(bytes.try_into().unwrap())
    }

    #[test]
    fn fd_fdstat_get_reports_preopen_as_directory() {
        let mut runtime = WasiRuntime::new(128);

        assert_eq!(runtime.fd_fdstat_get(3, 0), Errno::Success as u32);
        assert_eq!(
            runtime.memory.slice(0, 1).unwrap()[0],
            FileType::Directory as u8
        );
    }

    #[test]
    fn fd_filestat_get_reports_preopen_directory() {
        let mut runtime = WasiRuntime::new(128);

        assert_eq!(runtime.fd_filestat_get(3, 0), Errno::Success as u32);
        assert_eq!(
            runtime.memory.slice(16, 1).unwrap()[0],
            FileType::Directory as u8
        );
        assert_eq!(read_u64(&runtime, 32), 0);
    }

    #[test]
    fn host_memory_bridge_supports_syscall_iovecs() {
        let mut runtime = WasiRuntime::new(128);

        assert_eq!(runtime.memory_len(), 128);
        runtime.write_memory(64, b"hello").unwrap();
        runtime.write_memory(16, &64u32.to_le_bytes()).unwrap();
        runtime.write_memory(20, &5u32.to_le_bytes()).unwrap();

        assert_eq!(runtime.fd_write(1, 16, 1, 32), Errno::Success as u32);

        assert_eq!(runtime.read_memory(64, 5).unwrap(), b"hello");
        assert_eq!(read_u32(&runtime, 32), 5);
        assert_eq!(runtime.take_stdout(), b"hello");
    }

    #[test]
    fn host_memory_bridge_rejects_out_of_bounds_access() {
        let mut runtime = WasiRuntime::new(8);

        assert!(runtime.write_memory(4, b"rust").is_ok());
        assert!(runtime.write_memory(5, b"rust").is_err());
        assert!(runtime.read_memory(4, 4).is_ok());
        assert!(runtime.read_memory(5, 4).is_err());
    }

    #[test]
    fn fd_close_closes_preopen_descriptor() {
        let mut runtime = WasiRuntime::new(128);

        assert_eq!(runtime.fd_close(3), Errno::Success as u32);
        assert_eq!(runtime.fd_fdstat_get(3, 0), Errno::Badf as u32);
        assert_eq!(runtime.fd_close(3), Errno::Badf as u32);
    }

    #[test]
    fn fd_close_closes_dynamic_file_descriptor() {
        let mut runtime = WasiRuntime::new(256);

        write_str(&mut runtime, 0, "note.txt");
        assert_eq!(
            runtime.path_open(3, 0, 0, 8, OFLAGS_CREAT, 0, 0, 0, 32),
            Errno::Success as u32
        );
        let fd = read_u32(&runtime, 32);

        assert_eq!(runtime.fd_close(fd), Errno::Success as u32);
        assert_eq!(runtime.fd_fdstat_get(fd, 64), Errno::Badf as u32);
        assert_eq!(runtime.fd_close(fd), Errno::Badf as u32);
    }

    #[test]
    fn path_create_open_and_readdir_round_trip() {
        let mut runtime = WasiRuntime::new(512);

        write_str(&mut runtime, 0, "tmp");
        assert_eq!(
            runtime.path_create_directory(3, 0, 3),
            Errno::Success as u32
        );

        write_str(&mut runtime, 16, "tmp/file.txt");
        assert_eq!(
            runtime.path_open(3, 0, 16, 12, OFLAGS_CREAT, 0, 0, 0, 64),
            Errno::Success as u32
        );
        let file_fd = read_u32(&runtime, 64);
        assert_eq!(file_fd, 4);

        write_str(&mut runtime, 80, "tmp");
        assert_eq!(
            runtime.path_open(3, 0, 80, 3, OFLAGS_DIRECTORY, 0, 0, 0, 96),
            Errno::Success as u32
        );
        let dir_fd = read_u32(&runtime, 96);
        assert_eq!(dir_fd, 5);

        assert_eq!(
            runtime.fd_readdir(dir_fd, 128, 128, 0, 112),
            Errno::Success as u32
        );

        let used = read_u32(&runtime, 112);
        assert_eq!(used, DIRENT_SIZE + "file.txt".len() as u32);
        assert_eq!(read_u64(&runtime, 128), 1);
        assert_eq!(read_u64(&runtime, 136), 1);
        assert_eq!(read_u32(&runtime, 144), "file.txt".len() as u32);
        assert_eq!(
            runtime.memory.slice(148, 1).unwrap()[0],
            FileType::RegularFile as u8
        );
        assert_eq!(runtime.memory.slice(149, 3).unwrap(), &[0, 0, 0]);
        assert_eq!(runtime.memory.slice(152, 8).unwrap(), b"file.txt");
    }

    #[test]
    fn fd_filestat_get_reports_file_size() {
        let mut runtime = WasiRuntime::new(512);

        write_str(&mut runtime, 0, "note.txt");
        assert_eq!(
            runtime.path_open(3, 0, 0, 8, OFLAGS_CREAT, 0, 0, 0, 32),
            Errno::Success as u32
        );
        let fd = read_u32(&runtime, 32);

        write_str(&mut runtime, 64, "hello");
        runtime.memory.write_u32(48, 64).unwrap();
        runtime.memory.write_u32(52, 5).unwrap();
        assert_eq!(runtime.fd_write(fd, 48, 1, 40), Errno::Success as u32);

        assert_eq!(runtime.fd_filestat_get(fd, 80), Errno::Success as u32);
        assert_eq!(
            runtime.memory.slice(96, 1).unwrap()[0],
            FileType::RegularFile as u8
        );
        assert_eq!(read_u64(&runtime, 112), 5);
    }

    #[test]
    fn path_filestat_get_reports_file_and_directory_metadata() {
        let mut runtime = WasiRuntime::new(512);

        write_str(&mut runtime, 0, "tmp");
        assert_eq!(
            runtime.path_create_directory(3, 0, 3),
            Errno::Success as u32
        );

        write_str(&mut runtime, 16, "tmp/note.txt");
        assert_eq!(
            runtime.path_open(3, 0, 16, 12, OFLAGS_CREAT, 0, 0, 0, 48),
            Errno::Success as u32
        );
        let fd = read_u32(&runtime, 48);

        write_str(&mut runtime, 64, "hello");
        runtime.memory.write_u32(56, 64).unwrap();
        runtime.memory.write_u32(60, 5).unwrap();
        assert_eq!(runtime.fd_write(fd, 56, 1, 44), Errno::Success as u32);

        assert_eq!(
            runtime.path_filestat_get(3, 0, 16, 12, 96),
            Errno::Success as u32
        );
        assert_eq!(
            runtime.memory.slice(112, 1).unwrap()[0],
            FileType::RegularFile as u8
        );
        assert_eq!(read_u64(&runtime, 128), 5);

        assert_eq!(
            runtime.path_filestat_get(3, 0, 0, 3, 160),
            Errno::Success as u32
        );
        assert_eq!(
            runtime.memory.slice(176, 1).unwrap()[0],
            FileType::Directory as u8
        );
        assert_eq!(read_u64(&runtime, 192), 0);
    }

    #[test]
    fn path_filestat_get_rejects_missing_paths_and_invalid_memory() {
        let mut runtime = WasiRuntime::new(128);

        write_str(&mut runtime, 0, "missing.txt");
        assert_eq!(
            runtime.path_filestat_get(3, 0, 0, 11, 32),
            Errno::Noent as u32
        );

        write_str(&mut runtime, 16, "tmp");
        assert_eq!(
            runtime.path_create_directory(3, 16, 3),
            Errno::Success as u32
        );
        assert_eq!(
            runtime.path_filestat_get(3, 0, 16, 3, 96),
            Errno::Inval as u32
        );
    }

    #[test]
    fn fd_filestat_get_rejects_closed_descriptor_and_invalid_memory() {
        let mut runtime = WasiRuntime::new(64);

        assert_eq!(runtime.fd_close(3), Errno::Success as u32);
        assert_eq!(runtime.fd_filestat_get(3, 0), Errno::Badf as u32);
        assert_eq!(runtime.fd_filestat_get(0, 1), Errno::Inval as u32);
    }

    #[test]
    fn fd_readdir_honors_cookie() {
        let mut runtime = WasiRuntime::new(512);

        write_str(&mut runtime, 0, "a.txt");
        assert_eq!(
            runtime.path_open(3, 0, 0, 5, OFLAGS_CREAT, 0, 0, 0, 64),
            Errno::Success as u32
        );
        write_str(&mut runtime, 16, "b.txt");
        assert_eq!(
            runtime.path_open(3, 0, 16, 5, OFLAGS_CREAT, 0, 0, 0, 68),
            Errno::Success as u32
        );

        assert_eq!(
            runtime.fd_readdir(3, 128, 128, 1, 112),
            Errno::Success as u32
        );

        assert_eq!(read_u32(&runtime, 112), DIRENT_SIZE + 5);
        assert_eq!(read_u64(&runtime, 128), 2);
        assert_eq!(runtime.memory.slice(152, 5).unwrap(), b"b.txt");
    }

    #[test]
    fn path_syscalls_reject_parent_components() {
        let mut runtime = WasiRuntime::new(512);

        write_str(&mut runtime, 0, "tmp");
        assert_eq!(
            runtime.path_create_directory(3, 0, 3),
            Errno::Success as u32
        );

        write_str(&mut runtime, 16, "tmp/../escape.txt");
        assert_eq!(
            runtime.path_open(3, 0, 16, 17, OFLAGS_CREAT, 0, 0, 0, 64),
            Errno::Inval as u32
        );
        assert_eq!(
            runtime.path_create_directory(3, 16, 17),
            Errno::Inval as u32
        );
    }

    #[test]
    fn path_open_invalid_output_pointer_does_not_allocate_fd() {
        let mut runtime = WasiRuntime::new(128);

        write_str(&mut runtime, 0, "note.txt");
        assert_eq!(
            runtime.path_open(3, 0, 0, 8, OFLAGS_CREAT, 0, 0, 0, 126),
            Errno::Inval as u32
        );

        write_str(&mut runtime, 16, "note.txt");
        assert_eq!(
            runtime.path_open(3, 0, 16, 8, 0, 0, 0, 0, 64),
            Errno::Success as u32
        );
        assert_eq!(read_u32(&runtime, 64), 4);
    }

    #[test]
    fn path_unlink_and_remove_directory_enforce_entry_kind() {
        let mut runtime = WasiRuntime::new(512);

        write_str(&mut runtime, 0, "tmp");
        assert_eq!(
            runtime.path_create_directory(3, 0, 3),
            Errno::Success as u32
        );

        assert_eq!(runtime.path_unlink_file(3, 0, 3), Errno::Inval as u32);

        write_str(&mut runtime, 16, "tmp/file.txt");
        assert_eq!(
            runtime.path_open(3, 0, 16, 12, OFLAGS_CREAT, 0, 0, 0, 64),
            Errno::Success as u32
        );

        assert_eq!(runtime.path_remove_directory(3, 0, 3), Errno::Inval as u32);
        assert_eq!(runtime.path_unlink_file(3, 16, 12), Errno::Success as u32);
        assert_eq!(
            runtime.path_remove_directory(3, 0, 3),
            Errno::Success as u32
        );
    }

    #[test]
    fn fd_write_and_fd_read_round_trip_file_contents_with_offsets() {
        let mut runtime = WasiRuntime::new(512);

        write_str(&mut runtime, 0, "note.txt");
        assert_eq!(
            runtime.path_open(3, 0, 0, 8, OFLAGS_CREAT, 0, 0, 0, 32),
            Errno::Success as u32
        );
        let write_fd = read_u32(&runtime, 32);

        write_str(&mut runtime, 64, "hello");
        runtime.memory.write_u32(48, 64).unwrap();
        runtime.memory.write_u32(52, 5).unwrap();

        assert_eq!(runtime.fd_write(write_fd, 48, 1, 40), Errno::Success as u32);
        assert_eq!(read_u32(&runtime, 40), 5);

        write_str(&mut runtime, 80, "note.txt");
        assert_eq!(
            runtime.path_open(3, 0, 80, 8, 0, 0, 0, 0, 36),
            Errno::Success as u32
        );
        let read_fd = read_u32(&runtime, 36);

        runtime.memory.write_u32(96, 128).unwrap();
        runtime.memory.write_u32(100, 2).unwrap();

        assert_eq!(runtime.fd_read(read_fd, 96, 1, 44), Errno::Success as u32);
        assert_eq!(read_u32(&runtime, 44), 2);
        assert_eq!(runtime.memory.slice(128, 2).unwrap(), b"he");

        assert_eq!(runtime.fd_read(read_fd, 96, 1, 44), Errno::Success as u32);
        assert_eq!(read_u32(&runtime, 44), 2);
        assert_eq!(runtime.memory.slice(128, 2).unwrap(), b"ll");
    }

    #[test]
    fn fd_seek_repositions_file_descriptor_offset() {
        let mut runtime = WasiRuntime::new(512);

        write_str(&mut runtime, 0, "note.txt");
        assert_eq!(
            runtime.path_open(3, 0, 0, 8, OFLAGS_CREAT, 0, 0, 0, 32),
            Errno::Success as u32
        );
        let write_fd = read_u32(&runtime, 32);

        write_str(&mut runtime, 64, "hello");
        runtime.memory.write_u32(48, 64).unwrap();
        runtime.memory.write_u32(52, 5).unwrap();

        assert_eq!(runtime.fd_write(write_fd, 48, 1, 40), Errno::Success as u32);
        assert_eq!(
            runtime.fd_seek(write_fd, 1, WHENCE_SET, 80),
            Errno::Success as u32
        );
        assert_eq!(read_u64(&runtime, 80), 1);

        write_str(&mut runtime, 96, "a");
        runtime.memory.write_u32(88, 96).unwrap();
        runtime.memory.write_u32(92, 1).unwrap();

        assert_eq!(runtime.fd_write(write_fd, 88, 1, 44), Errno::Success as u32);

        write_str(&mut runtime, 112, "note.txt");
        assert_eq!(
            runtime.path_open(3, 0, 112, 8, 0, 0, 0, 0, 36),
            Errno::Success as u32
        );
        let read_fd = read_u32(&runtime, 36);

        runtime.memory.write_u32(128, 160).unwrap();
        runtime.memory.write_u32(132, 5).unwrap();

        assert_eq!(runtime.fd_read(read_fd, 128, 1, 84), Errno::Success as u32);
        assert_eq!(read_u32(&runtime, 84), 5);
        assert_eq!(runtime.memory.slice(160, 5).unwrap(), b"hallo");
    }

    #[test]
    fn fd_seek_supports_current_and_end_origins() {
        let mut runtime = WasiRuntime::new(512);

        write_str(&mut runtime, 0, "note.txt");
        assert_eq!(
            runtime.path_open(3, 0, 0, 8, OFLAGS_CREAT, 0, 0, 0, 32),
            Errno::Success as u32
        );
        let fd = read_u32(&runtime, 32);

        write_str(&mut runtime, 64, "abcdef");
        runtime.memory.write_u32(48, 64).unwrap();
        runtime.memory.write_u32(52, 6).unwrap();
        assert_eq!(runtime.fd_write(fd, 48, 1, 40), Errno::Success as u32);

        assert_eq!(
            runtime.fd_seek(fd, -2, WHENCE_CUR, 80),
            Errno::Success as u32
        );
        assert_eq!(read_u64(&runtime, 80), 4);

        assert_eq!(
            runtime.fd_seek(fd, -3, WHENCE_END, 88),
            Errno::Success as u32
        );
        assert_eq!(read_u64(&runtime, 88), 3);
    }

    #[test]
    fn fd_seek_rejects_negative_results_invalid_whence_and_streams() {
        let mut runtime = WasiRuntime::new(512);

        write_str(&mut runtime, 0, "note.txt");
        assert_eq!(
            runtime.path_open(3, 0, 0, 8, OFLAGS_CREAT, 0, 0, 0, 32),
            Errno::Success as u32
        );
        let fd = read_u32(&runtime, 32);

        assert_eq!(runtime.fd_seek(fd, -1, WHENCE_SET, 80), Errno::Inval as u32);
        assert_eq!(runtime.fd_seek(fd, 0, 99, 80), Errno::Inval as u32);
        assert_eq!(runtime.fd_seek(0, 0, WHENCE_SET, 80), Errno::Spipe as u32);
        assert_eq!(runtime.fd_seek(3, 0, WHENCE_SET, 80), Errno::Inval as u32);
        assert_eq!(runtime.fd_seek(999, 0, WHENCE_SET, 80), Errno::Badf as u32);
    }

    #[test]
    fn path_open_with_truncate_clears_existing_file() {
        let mut runtime = WasiRuntime::new(512);

        write_str(&mut runtime, 0, "note.txt");
        assert_eq!(
            runtime.path_open(3, 0, 0, 8, OFLAGS_CREAT, 0, 0, 0, 32),
            Errno::Success as u32
        );
        let fd = read_u32(&runtime, 32);

        write_str(&mut runtime, 64, "hello");
        runtime.memory.write_u32(48, 64).unwrap();
        runtime.memory.write_u32(52, 5).unwrap();
        assert_eq!(runtime.fd_write(fd, 48, 1, 40), Errno::Success as u32);

        write_str(&mut runtime, 80, "note.txt");
        assert_eq!(
            runtime.path_open(3, 0, 80, 8, OFLAGS_TRUNC, 0, 0, 0, 36),
            Errno::Success as u32
        );
        let read_fd = read_u32(&runtime, 36);

        runtime.memory.write_u32(96, 128).unwrap();
        runtime.memory.write_u32(100, 5).unwrap();
        assert_eq!(runtime.fd_read(read_fd, 96, 1, 44), Errno::Success as u32);
        assert_eq!(read_u32(&runtime, 44), 0);
    }

    #[test]
    fn append_mode_writes_to_end_even_after_seek() {
        let mut runtime = WasiRuntime::new(512);

        write_str(&mut runtime, 0, "note.txt");
        assert_eq!(
            runtime.path_open(3, 0, 0, 8, OFLAGS_CREAT, 0, 0, 0, 32),
            Errno::Success as u32
        );
        let seed_fd = read_u32(&runtime, 32);

        write_str(&mut runtime, 64, "hello");
        runtime.memory.write_u32(48, 64).unwrap();
        runtime.memory.write_u32(52, 5).unwrap();
        assert_eq!(runtime.fd_write(seed_fd, 48, 1, 40), Errno::Success as u32);

        write_str(&mut runtime, 80, "note.txt");
        assert_eq!(
            runtime.path_open(3, 0, 80, 8, 0, 0, 0, FDFLAGS_APPEND, 36),
            Errno::Success as u32
        );
        let append_fd = read_u32(&runtime, 36);

        assert_eq!(
            runtime.fd_seek(append_fd, 0, WHENCE_SET, 44),
            Errno::Success as u32
        );

        write_str(&mut runtime, 96, "!");
        runtime.memory.write_u32(88, 96).unwrap();
        runtime.memory.write_u32(92, 1).unwrap();
        assert_eq!(
            runtime.fd_write(append_fd, 88, 1, 40),
            Errno::Success as u32
        );

        write_str(&mut runtime, 112, "note.txt");
        assert_eq!(
            runtime.path_open(3, 0, 112, 8, 0, 0, 0, 0, 120),
            Errno::Success as u32
        );
        let read_fd = read_u32(&runtime, 120);

        runtime.memory.write_u32(128, 160).unwrap();
        runtime.memory.write_u32(132, 6).unwrap();
        assert_eq!(runtime.fd_read(read_fd, 128, 1, 136), Errno::Success as u32);
        assert_eq!(read_u32(&runtime, 136), 6);
        assert_eq!(runtime.memory.slice(160, 6).unwrap(), b"hello!");
    }
}
