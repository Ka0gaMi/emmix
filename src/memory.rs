enum MemoryBacking {
    Owned(Vec<u8>),
    #[cfg(target_arch = "wasm32")]
    Guest(js_sys::WebAssembly::Memory),
}

pub struct WasmMemory {
    backing: MemoryBacking,
}

impl WasmMemory {
    // ==============================
    // Construction
    // ==============================

    pub fn new(size: usize) -> Self {
        Self {
            backing: MemoryBacking::Owned(vec![0u8; size]),
        }
    }

    #[cfg(target_arch = "wasm32")]
    pub fn from_guest(memory: js_sys::WebAssembly::Memory) -> Self {
        Self {
            backing: MemoryBacking::Guest(memory),
        }
    }

    // ==============================
    // Slices and reads
    // ==============================

    #[allow(dead_code)]
    pub fn read_string(&self, ptr: u32, len: u32) -> Result<String, String> {
        String::from_utf8(self.read_bytes(ptr, len)?).map_err(|e| format!("invalid utf8: {}", e))
    }

    pub fn read_u32(&self, ptr: u32) -> Result<u32, String> {
        let bytes = self.read_bytes(ptr, 4)?;
        Ok(u32::from_le_bytes(bytes.try_into().unwrap()))
    }

    pub fn read_bytes(&self, ptr: u32, len: u32) -> Result<Vec<u8>, String> {
        let (start, end) = self.range(ptr, len, "memory read")?;

        match &self.backing {
            MemoryBacking::Owned(data) => Ok(data[start..end].to_vec()),
            #[cfg(target_arch = "wasm32")]
            MemoryBacking::Guest(memory) => {
                let view =
                    js_sys::Uint8Array::new(&memory.buffer()).subarray(start as u32, end as u32);
                let mut bytes = vec![0; len as usize];
                view.copy_to(&mut bytes);
                Ok(bytes)
            }
        }
    }

    #[allow(dead_code)]
    pub fn slice(&self, ptr: u32, len: u32) -> Result<&[u8], String> {
        let (start, end) = self.range(ptr, len, "memory slice")?;

        match &self.backing {
            MemoryBacking::Owned(data) => Ok(&data[start..end]),
            #[cfg(target_arch = "wasm32")]
            MemoryBacking::Guest(_) => {
                Err("borrowed slices are unavailable for guest memory".to_string())
            }
        }
    }

    #[allow(dead_code)]
    pub fn slice_mut(&mut self, ptr: u32, len: u32) -> Result<&mut [u8], String> {
        let (start, end) = self.range(ptr, len, "memory mutable slice")?;

        match &mut self.backing {
            MemoryBacking::Owned(data) => Ok(&mut data[start..end]),
            #[cfg(target_arch = "wasm32")]
            MemoryBacking::Guest(_) => {
                Err("borrowed mutable slices are unavailable for guest memory".to_string())
            }
        }
    }

    // ==============================
    // Primitive writes
    // ==============================

    pub fn write_u8(&mut self, ptr: u32, val: u8) -> Result<(), String> {
        let pos = ptr as usize;
        self.write_byte(pos, val)
    }

    pub fn write_u32(&mut self, ptr: u32, val: u32) -> Result<(), String> {
        self.write_bytes(ptr, &val.to_le_bytes())
    }

    pub fn write_u64(&mut self, ptr: u32, val: u64) -> Result<(), String> {
        self.write_bytes(ptr, &val.to_le_bytes())
    }

    pub fn write_byte(&mut self, pos: usize, byte: u8) -> Result<(), String> {
        let ptr = u32::try_from(pos).map_err(|_| "write_bytes pointer overflow".to_string())?;
        self.write_bytes(ptr, &[byte])
    }

    pub fn write_bytes(&mut self, ptr: u32, bytes: &[u8]) -> Result<(), String> {
        let len = u32::try_from(bytes.len()).map_err(|_| "memory write too large".to_string())?;
        let (start, end) = self.range(ptr, len, "memory write")?;

        match &mut self.backing {
            MemoryBacking::Owned(data) => data[start..end].copy_from_slice(bytes),
            #[cfg(target_arch = "wasm32")]
            MemoryBacking::Guest(memory) => {
                js_sys::Uint8Array::new(&memory.buffer())
                    .subarray(start as u32, end as u32)
                    .copy_from(bytes);
            }
        }

        Ok(())
    }

    // ==============================
    // WASI struct writes
    // ==============================

    pub fn write_fdstat(
        &mut self,
        ptr: u32,
        file_type: u8,
        flags: u16,
        rights_base: u64,
        rights_inheriting: u64,
    ) -> Result<(), String> {
        self.range(ptr, 24, "write_fdstat")?;
        let mut bytes = [0; 24];
        // fs_filetype - 1 byte
        bytes[0] = file_type;
        // padding - 1 byte
        bytes[1] = 0;
        // fs_flags - 2bytes le
        let flag_bytes = flags.to_le_bytes();
        bytes[2] = flag_bytes[0];
        bytes[3] = flag_bytes[1];
        // padding - 4 bytes
        bytes[4..8].fill(0);
        //fs_rights_base - 8 bytes le
        let rights_bytes = rights_base.to_le_bytes();
        bytes[8..16].copy_from_slice(&rights_bytes);
        // fs_rights_inheriting - 8 bytes le
        let inheriting_bytes = rights_inheriting.to_le_bytes();
        bytes[16..24].copy_from_slice(&inheriting_bytes);

        self.write_bytes(ptr, &bytes)
    }

    pub fn write_prestat_dir(&mut self, ptr: u32, name_len: u32) -> Result<(), String> {
        self.range(ptr, 8, "write_prestat")?;
        let mut bytes = [0; 8];
        // tag = 0 (directory)
        bytes[0..4].copy_from_slice(&0u32.to_le_bytes());
        // name length
        bytes[4..8].copy_from_slice(&name_len.to_le_bytes());
        self.write_bytes(ptr, &bytes)
    }

    pub fn write_filestat(&mut self, ptr: u32, file_type: u8, size: u64) -> Result<(), String> {
        self.range(ptr, 64, "write_filestat")?;
        let mut bytes = [0; 64];

        // dev: device id, 8 bytes
        bytes[0..8].copy_from_slice(&0u64.to_le_bytes());

        // ino: inode number, synthetic for now, 8 bytes
        bytes[8..16].copy_from_slice(&0u64.to_le_bytes());

        // filetype: 1 byte
        bytes[16] = file_type;

        // nlink: number of hard links, 8 bytes
        bytes[24..32].copy_from_slice(&1u64.to_le_bytes());

        // size: file size, 8 bytes
        bytes[32..40].copy_from_slice(&size.to_le_bytes());

        self.write_bytes(ptr, &bytes)
    }

    // ==============================
    // Introspection
    // ==============================

    pub fn len(&self) -> usize {
        match &self.backing {
            MemoryBacking::Owned(data) => data.len(),
            #[cfg(target_arch = "wasm32")]
            MemoryBacking::Guest(memory) => {
                js_sys::Uint8Array::new(&memory.buffer()).length() as usize
            }
        }
    }

    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn range(&self, ptr: u32, len: u32, operation: &str) -> Result<(usize, usize), String> {
        let start = ptr as usize;
        let end = start
            .checked_add(len as usize)
            .ok_or_else(|| format!("{} pointer overflow", operation))?;

        if end > self.len() {
            return Err(format!(
                "{} out of bounds: {} > {}",
                operation,
                end,
                self.len()
            ));
        }

        Ok((start, end))
    }
}

#[cfg(test)]
mod tests {
    use super::WasmMemory;

    #[test]
    fn slice_and_slice_mut_reject_out_of_bounds_access() {
        let mut memory = WasmMemory::new(8);

        assert!(memory.slice(4, 4).is_ok());
        assert!(memory.slice(5, 4).is_err());
        assert!(memory.slice_mut(4, 4).is_ok());
        assert!(memory.slice_mut(5, 4).is_err());
    }

    #[test]
    fn write_u32_and_u64_use_little_endian_layout() {
        let mut memory = WasmMemory::new(16);

        memory.write_u32(0, 0x1122_3344).unwrap();
        memory.write_u64(4, 0x0102_0304_0506_0708).unwrap();

        assert_eq!(memory.slice(0, 4).unwrap(), &[0x44, 0x33, 0x22, 0x11]);
        assert_eq!(
            memory.slice(4, 8).unwrap(),
            &[0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]
        );
    }

    #[test]
    fn write_fdstat_rejects_short_tail_space() {
        let mut memory = WasmMemory::new(24);

        assert!(memory.write_fdstat(0, 2, 0, u64::MAX, u64::MAX).is_ok());
        assert!(memory.write_fdstat(1, 2, 0, u64::MAX, u64::MAX).is_err());
    }

    #[test]
    fn write_filestat_writes_type_nlink_and_size() {
        let mut memory = WasmMemory::new(64);

        memory.write_filestat(0, 4, 123).unwrap();

        assert_eq!(memory.slice(16, 1).unwrap()[0], 4);

        let nlink_bytes = memory.slice(24, 8).unwrap();
        assert_eq!(u64::from_le_bytes(nlink_bytes.try_into().unwrap()), 1);

        let size_bytes = memory.slice(32, 8).unwrap();
        assert_eq!(u64::from_le_bytes(size_bytes.try_into().unwrap()), 123);
    }

    #[test]
    fn write_filestat_rejects_short_tail_space() {
        let mut memory = WasmMemory::new(64);

        assert!(memory.write_filestat(0, 4, 123).is_ok());
        assert!(memory.write_filestat(1, 4, 123).is_err());
    }
}
