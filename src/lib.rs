// ==============================
// Modules
// ==============================

mod memory;
mod syscalls;
mod vfs;

// ==============================
// Imports
// ==============================

use wasm_bindgen::prelude::*;

// ==============================
// Public Rust API
// ==============================

pub use syscalls::WasiRuntime;

// ==============================
// Browser-facing WASM API
// ==============================

#[wasm_bindgen]
pub struct EmmixRuntime {
    inner: WasiRuntime,
}

#[wasm_bindgen]
impl EmmixRuntime {
    #[wasm_bindgen(constructor)]
    pub fn new(memory_size: usize) -> EmmixRuntime {
        EmmixRuntime {
            inner: WasiRuntime::new(memory_size),
        }
    }

    pub fn feed_stdin(&mut self, data: &[u8]) {
        self.inner.feed_stdin(data);
    }

    pub fn set_stdin(&mut self, data: &[u8]) {
        self.inner.set_stdin(data);
    }

    pub fn take_stdout(&mut self) -> Vec<u8> {
        self.inner.take_stdout()
    }

    pub fn take_stderr(&mut self) -> Vec<u8> {
        self.inner.take_stderr()
    }

    pub fn set_args(&mut self, args: Box<[JsValue]>) -> Result<(), JsValue> {
        let args = js_values_to_strings(args)?;
        self.inner.set_args(args);
        Ok(())
    }

    pub fn set_environ(&mut self, environ: Box<[JsValue]>) -> Result<(), JsValue> {
        let environ = js_values_to_strings(environ)?;
        self.inner.set_environ(environ);
        Ok(())
    }

    pub fn memory_len(&self) -> usize {
        self.inner.memory_len()
    }

    pub fn read_memory(&self, ptr: u32, len: u32) -> Result<Vec<u8>, JsValue> {
        self.inner
            .read_memory(ptr, len)
            .map_err(|message| JsValue::from_str(&message))
    }

    pub fn write_memory(&mut self, ptr: u32, bytes: &[u8]) -> Result<(), JsValue> {
        self.inner
            .write_memory(ptr, bytes)
            .map_err(|message| JsValue::from_str(&message))
    }

    pub fn missing_syscalls(&self) -> Box<[JsValue]> {
        strings_to_js_values(self.inner.missing_syscalls())
    }

    pub fn take_missing_syscalls(&mut self) -> Box<[JsValue]> {
        strings_to_js_values(self.inner.take_missing_syscalls())
    }

    pub fn workspace_read_file(&self, path: &str) -> Result<Vec<u8>, JsValue> {
        self.inner
            .workspace_read_file(path)
            .map_err(|message| JsValue::from_str(&message))
    }

    pub fn workspace_write_file(&mut self, path: &str, bytes: &[u8]) -> Result<(), JsValue> {
        self.inner
            .workspace_write_file(path, bytes)
            .map_err(|message| JsValue::from_str(&message))
    }

    pub fn workspace_read_dir(&self, path: &str) -> Result<Box<[JsValue]>, JsValue> {
        self.inner
            .workspace_read_dir(path)
            .map(strings_to_js_values)
            .map_err(|message| JsValue::from_str(&message))
    }

    pub fn workspace_create_directory(&mut self, path: &str) -> Result<(), JsValue> {
        self.inner
            .workspace_create_directory(path)
            .map_err(|message| JsValue::from_str(&message))
    }

    pub fn workspace_remove_file(&mut self, path: &str) -> Result<(), JsValue> {
        self.inner
            .workspace_remove_file(path)
            .map_err(|message| JsValue::from_str(&message))
    }

    pub fn workspace_remove_directory(&mut self, path: &str) -> Result<(), JsValue> {
        self.inner
            .workspace_remove_directory(path)
            .map_err(|message| JsValue::from_str(&message))
    }

    pub fn workspace_rename(&mut self, old_path: &str, new_path: &str) -> Result<(), JsValue> {
        self.inner
            .workspace_rename(old_path, new_path)
            .map_err(|message| JsValue::from_str(&message))
    }

    pub fn workspace_entry_type(&self, path: &str) -> Result<Option<String>, JsValue> {
        self.inner
            .workspace_entry_type(path)
            .map_err(|message| JsValue::from_str(&message))
    }

    pub fn workspace_entry_size(&self, path: &str) -> Result<u64, JsValue> {
        self.inner
            .workspace_entry_size(path)
            .map_err(|message| JsValue::from_str(&message))
    }

    #[cfg(target_arch = "wasm32")]
    pub fn attach_guest_memory(&mut self, memory: js_sys::WebAssembly::Memory) {
        self.inner.attach_guest_memory(memory);
    }

    pub fn fd_write(&mut self, fd: u32, iovs_ptr: u32, iovs_len: u32, nwritten_ptr: u32) -> u32 {
        self.inner.fd_write(fd, iovs_ptr, iovs_len, nwritten_ptr)
    }

    pub fn fd_read(&mut self, fd: u32, iovs_ptr: u32, iovs_len: u32, nread_ptr: u32) -> u32 {
        self.inner.fd_read(fd, iovs_ptr, iovs_len, nread_ptr)
    }

    pub fn fd_readdir(
        &mut self,
        fd: u32,
        buf_ptr: u32,
        buf_len: u32,
        cookie: u64,
        bufused_ptr: u32,
    ) -> u32 {
        self.inner
            .fd_readdir(fd, buf_ptr, buf_len, cookie, bufused_ptr)
    }

    pub fn fd_seek(&mut self, fd: u32, offset: i64, whence: u32, newoffset_ptr: u32) -> u32 {
        self.inner.fd_seek(fd, offset, whence, newoffset_ptr)
    }

    pub fn fd_tell(&mut self, fd: u32, offset_ptr: u32) -> u32 {
        self.inner.fd_tell(fd, offset_ptr)
    }

    pub fn fd_fdstat_get(&mut self, fd: u32, stat_ptr: u32) -> u32 {
        self.inner.fd_fdstat_get(fd, stat_ptr)
    }

    pub fn fd_filestat_get(&mut self, fd: u32, stat_ptr: u32) -> u32 {
        self.inner.fd_filestat_get(fd, stat_ptr)
    }

    pub fn path_filestat_get(
        &mut self,
        dirfd: u32,
        flags: u32,
        path_ptr: u32,
        path_len: u32,
        stat_ptr: u32,
    ) -> u32 {
        self.inner
            .path_filestat_get(dirfd, flags, path_ptr, path_len, stat_ptr)
    }

    pub fn fd_prestat_get(&mut self, fd: u32, prestat_ptr: u32) -> u32 {
        self.inner.fd_prestat_get(fd, prestat_ptr)
    }

    pub fn fd_prestat_dir_name(&mut self, fd: u32, path_ptr: u32, path_len: u32) -> u32 {
        self.inner.fd_prestat_dir_name(fd, path_ptr, path_len)
    }

    pub fn fd_close(&mut self, fd: u32) -> u32 {
        self.inner.fd_close(fd)
    }

    pub fn fd_renumber(&mut self, fd: u32, to: u32) -> u32 {
        self.inner.fd_renumber(fd, to)
    }

    pub fn fd_sync(&mut self, fd: u32) -> u32 {
        self.inner.fd_sync(fd)
    }

    pub fn fd_datasync(&mut self, fd: u32) -> u32 {
        self.inner.fd_datasync(fd)
    }

    pub fn args_sizes_get(&mut self, argc_ptr: u32, argv_buf_size_ptr: u32) -> u32 {
        self.inner.args_sizes_get(argc_ptr, argv_buf_size_ptr)
    }

    pub fn args_get(&mut self, argv_ptr: u32, argv_buf_ptr: u32) -> u32 {
        self.inner.args_get(argv_ptr, argv_buf_ptr)
    }

    pub fn environ_sizes_get(&mut self, count_ptr: u32, buf_size_ptr: u32) -> u32 {
        self.inner.environ_sizes_get(count_ptr, buf_size_ptr)
    }

    pub fn environ_get(&mut self, environ_ptr: u32, environ_buf_ptr: u32) -> u32 {
        self.inner.environ_get(environ_ptr, environ_buf_ptr)
    }

    pub fn clock_time_get(&mut self, clock_id: u32, precision: u64, time_ptr: u32) -> u32 {
        self.inner.clock_time_get(clock_id, precision, time_ptr)
    }

    pub fn random_get(&mut self, buf_ptr: u32, buf_len: u32) -> u32 {
        self.inner.random_get(buf_ptr, buf_len)
    }

    pub fn path_open(
        &mut self,
        dirfd: u32,
        dirflags: u32,
        path_ptr: u32,
        path_len: u32,
        oflags: u32,
        rights_base: u64,
        rights_inheriting: u64,
        fdflags: u32,
        opened_fd_ptr: u32,
    ) -> u32 {
        self.inner.path_open(
            dirfd,
            dirflags,
            path_ptr,
            path_len,
            oflags,
            rights_base,
            rights_inheriting,
            fdflags,
            opened_fd_ptr,
        )
    }

    pub fn path_create_directory(&mut self, dirfd: u32, path_ptr: u32, path_len: u32) -> u32 {
        self.inner.path_create_directory(dirfd, path_ptr, path_len)
    }

    pub fn path_rename(
        &mut self,
        old_fd: u32,
        old_path_ptr: u32,
        old_path_len: u32,
        new_fd: u32,
        new_path_ptr: u32,
        new_path_len: u32,
    ) -> u32 {
        self.inner.path_rename(
            old_fd,
            old_path_ptr,
            old_path_len,
            new_fd,
            new_path_ptr,
            new_path_len,
        )
    }

    pub fn path_readlink(
        &mut self,
        dirfd: u32,
        path_ptr: u32,
        path_len: u32,
        buf_ptr: u32,
        buf_len: u32,
        bufused_ptr: u32,
    ) -> u32 {
        self.inner
            .path_readlink(dirfd, path_ptr, path_len, buf_ptr, buf_len, bufused_ptr)
    }

    pub fn path_unlink_file(&mut self, dirfd: u32, path_ptr: u32, path_len: u32) -> u32 {
        self.inner.path_unlink_file(dirfd, path_ptr, path_len)
    }

    pub fn path_remove_directory(&mut self, dirfd: u32, path_ptr: u32, path_len: u32) -> u32 {
        self.inner.path_remove_directory(dirfd, path_ptr, path_len)
    }

    pub fn proc_exit(&self, code: u32) {
        self.inner.proc_exit(code);
    }

    pub fn stub(&mut self, name: &str) -> u32 {
        self.inner.stub(name)
    }
}

// ==============================
// Helpers
// ==============================

fn js_values_to_strings(values: Box<[JsValue]>) -> Result<Vec<String>, JsValue> {
    values
        .iter()
        .map(|value| {
            value
                .as_string()
                .ok_or_else(|| JsValue::from_str("expected an array of strings"))
        })
        .collect()
}

fn strings_to_js_values(values: Vec<String>) -> Box<[JsValue]> {
    values
        .into_iter()
        .map(|value| JsValue::from_str(&value))
        .collect::<Vec<_>>()
        .into_boxed_slice()
}
