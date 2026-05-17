//! Test suite for the Web and headless browsers.

#[cfg(target_arch = "wasm32")]
// ==============================
// Imports and configuration
// ==============================
extern crate wasm_bindgen_test;
use emmix::EmmixRuntime;
use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

#[wasm_bindgen_test]
fn browser_runtime_can_be_constructed() {
    let mut runtime = EmmixRuntime::new(128);

    runtime.feed_stdin(b"abc");

    assert_eq!(runtime.fd_close(3), 0);
    assert_eq!(runtime.fd_close(3), 8);
}

#[wasm_bindgen_test]
fn browser_runtime_memory_bridge_supports_fd_write() {
    let mut runtime = EmmixRuntime::new(128);

    runtime.write_memory(64, b"hello").unwrap();
    runtime.write_memory(16, &64u32.to_le_bytes()).unwrap();
    runtime.write_memory(20, &5u32.to_le_bytes()).unwrap();

    assert_eq!(runtime.memory_len(), 128);
    assert_eq!(runtime.fd_write(1, 16, 1, 32), 0);
    assert_eq!(runtime.read_memory(32, 4).unwrap(), 5u32.to_le_bytes());
    assert_eq!(runtime.take_stdout(), b"hello");
}

// ==============================
// Smoke tests
// ==============================

#[wasm_bindgen_test]
fn pass() {
    assert_eq!(1 + 1, 2);
}
