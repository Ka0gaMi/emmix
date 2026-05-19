use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VfsEntryKind {
    Directory,
    File,
}

#[derive(Debug, Clone)]
pub(crate) struct VfsDirEntry {
    pub(crate) name: String,
    pub(crate) kind: VfsEntryKind,
}

#[allow(dead_code)]
enum VfsNode {
    Directory(BTreeMap<String, VfsNode>),
    File(Vec<u8>),
}

pub(crate) struct VirtualFileSystem {
    root: VfsNode,
}

impl VirtualFileSystem {
    // ==============================
    // Construction
    // ==============================

    pub(crate) fn new() -> Self {
        Self {
            root: VfsNode::Directory(BTreeMap::new()),
        }
    }

    // ==============================
    // Read
    // ==============================

    pub(crate) fn read_dir(&self, path: &str) -> Result<Vec<VfsDirEntry>, String> {
        let parts = Self::components(path)?;
        let node = Self::node_at(&self.root, &parts)
            .ok_or_else(|| "directory does not exist".to_string())?;

        match node {
            VfsNode::Directory(children) => Ok(children
                .iter()
                .map(|(name, child)| VfsDirEntry {
                    name: name.clone(),
                    kind: match child {
                        VfsNode::Directory(_) => VfsEntryKind::Directory,
                        VfsNode::File(_) => VfsEntryKind::File,
                    },
                })
                .collect()),
            VfsNode::File(_) => Err("path is not a directory".to_string()),
        }
    }

    pub(crate) fn read_file(
        &self,
        path: &str,
        offset: usize,
        buf: &mut [u8],
    ) -> Result<usize, String> {
        let parts = Self::components(path)?;
        let node =
            Self::node_at(&self.root, &parts).ok_or_else(|| "file does not exist".to_string())?;

        match node {
            VfsNode::File(bytes) => {
                if offset >= bytes.len() {
                    return Ok(0);
                }

                let available = &bytes[offset..];
                let bytes_to_read = available.len().min(buf.len());
                buf[..bytes_to_read].copy_from_slice(&available[..bytes_to_read]);
                Ok(bytes_to_read)
            }
            VfsNode::Directory(_) => Err("path is a directory".to_string()),
        }
    }

    pub(crate) fn file_len(&self, path: &str) -> Result<usize, String> {
        let parts = Self::components(path)?;
        let node =
            Self::node_at(&self.root, &parts).ok_or_else(|| "file does not exist".to_string())?;

        match node {
            VfsNode::File(bytes) => Ok(bytes.len()),
            VfsNode::Directory(_) => Err("path is a directory".to_string()),
        }
    }

    // ==============================
    // Lookup
    // ==============================

    pub(crate) fn kind(&self, path: &str) -> Result<Option<VfsEntryKind>, String> {
        let parts = Self::components(path)?;

        Ok(Self::node_at(&self.root, &parts).map(|node| match node {
            VfsNode::Directory(_) => VfsEntryKind::Directory,
            VfsNode::File(_) => VfsEntryKind::File,
        }))
    }

    pub(crate) fn entry_size(&self, path: &str) -> Result<u64, String> {
        let parts = Self::components(path)?;
        let node =
            Self::node_at(&self.root, &parts).ok_or_else(|| "entry does not exist".to_string())?;

        match node {
            VfsNode::Directory(_) => Ok(0),
            VfsNode::File(bytes) => {
                u64::try_from(bytes.len()).map_err(|_| "file size overflow".to_string())
            }
        }
    }

    // ==============================
    // Mutation
    // ==============================

    pub(crate) fn create_file(&mut self, path: &str) -> Result<(), String> {
        let parts = Self::components(path)?;
        let (file_name, parent_parts) = parts
            .split_last()
            .ok_or_else(|| "cannot create root as a file".to_string())?;

        let parent = Self::node_at_mut(&mut self.root, parent_parts)
            .ok_or_else(|| "parent directory does not exist".to_string())?;

        match parent {
            VfsNode::Directory(children) => {
                if children.contains_key(*file_name) {
                    return Err("path already exists".to_string());
                }

                children.insert((*file_name).to_string(), VfsNode::File(Vec::new()));
                Ok(())
            }
            VfsNode::File(_) => Err("parent is not a directory".to_string()),
        }
    }

    pub(crate) fn create_directory(&mut self, path: &str) -> Result<(), String> {
        let parts = Self::components(path)?;
        let (dir_name, parent_parts) = parts
            .split_last()
            .ok_or_else(|| "cannot create root directory".to_string())?;

        let parent = Self::node_at_mut(&mut self.root, parent_parts)
            .ok_or_else(|| "parent directory does not exist".to_string())?;

        match parent {
            VfsNode::Directory(children) => {
                if children.contains_key(*dir_name) {
                    return Err("path already exists".to_string());
                }

                children.insert((*dir_name).to_string(), VfsNode::Directory(BTreeMap::new()));
                Ok(())
            }
            VfsNode::File(_) => Err("parent is not a directory".to_string()),
        }
    }

    pub(crate) fn unlink_file(&mut self, path: &str) -> Result<(), String> {
        let parts = Self::components(path)?;
        let (file_name, parent_parts) = parts
            .split_last()
            .ok_or_else(|| "cannot unlink root".to_string())?;

        let parent = Self::node_at_mut(&mut self.root, parent_parts)
            .ok_or_else(|| "parent directory does not exist".to_string())?;

        match parent {
            VfsNode::Directory(children) => match children.get(*file_name) {
                Some(VfsNode::File(_)) => {
                    children.remove(*file_name);
                    Ok(())
                }
                Some(VfsNode::Directory(_)) => Err("path is a directory".to_string()),
                None => Err("file does not exist".to_string()),
            },
            VfsNode::File(_) => Err("parent is not a directory".to_string()),
        }
    }

    pub(crate) fn rename(&mut self, old_path: &str, new_path: &str) -> Result<(), String> {
        let old_parts = Self::components(old_path)?;
        let new_parts = Self::components(new_path)?;

        if old_parts.is_empty() || new_parts.is_empty() {
            return Err("cannot rename root".to_string());
        }

        if old_parts == new_parts {
            return Ok(());
        }

        if new_parts.starts_with(&old_parts) {
            return Err("cannot move an entry into itself".to_string());
        }

        if Self::node_at(&self.root, &old_parts).is_none() {
            return Err("source does not exist".to_string());
        }

        if Self::node_at(&self.root, &new_parts).is_some() {
            return Err("destination already exists".to_string());
        }

        let (new_name, new_parent_parts) = new_parts
            .split_last()
            .ok_or_else(|| "cannot rename root".to_string())?;

        match Self::node_at(&self.root, new_parent_parts) {
            Some(VfsNode::Directory(_)) => {}
            Some(VfsNode::File(_)) => {
                return Err("destination parent is not a directory".to_string())
            }
            None => return Err("destination parent does not exist".to_string()),
        }

        let node = Self::remove_node(&mut self.root, &old_parts)?;
        let new_parent = Self::node_at_mut(&mut self.root, new_parent_parts)
            .ok_or_else(|| "destination parent does not exist".to_string())?;

        match new_parent {
            VfsNode::Directory(children) => {
                children.insert((*new_name).to_string(), node);
                Ok(())
            }
            VfsNode::File(_) => Err("destination parent is not a directory".to_string()),
        }
    }

    pub(crate) fn write_file(
        &mut self,
        path: &str,
        offset: usize,
        bytes: &[u8],
    ) -> Result<usize, String> {
        let parts = Self::components(path)?;
        let node = Self::node_at_mut(&mut self.root, &parts)
            .ok_or_else(|| "file does not exist".to_string())?;

        match node {
            VfsNode::File(contents) => {
                let end = offset
                    .checked_add(bytes.len())
                    .ok_or_else(|| "file write offset overflow".to_string())?;

                if end > contents.len() {
                    contents.resize(end, 0);
                }

                contents[offset..end].copy_from_slice(bytes);
                Ok(bytes.len())
            }
            VfsNode::Directory(_) => Err("path is a directory".to_string()),
        }
    }

    pub(crate) fn remove_directory(&mut self, path: &str) -> Result<(), String> {
        let parts = Self::components(path)?;
        let (dir_name, parent_parts) = parts
            .split_last()
            .ok_or_else(|| "cannot remove root directory".to_string())?;

        let parent = Self::node_at_mut(&mut self.root, parent_parts)
            .ok_or_else(|| "parent directory does not exist".to_string())?;

        match parent {
            VfsNode::Directory(children) => match children.get(*dir_name) {
                Some(VfsNode::Directory(grandchildren)) if grandchildren.is_empty() => {
                    children.remove(*dir_name);
                    Ok(())
                }
                Some(VfsNode::Directory(_)) => Err("directory is not empty".to_string()),
                Some(VfsNode::File(_)) => Err("path is not a directory".to_string()),
                None => Err("directory does not exist".to_string()),
            },
            VfsNode::File(_) => Err("parent is not a directory".to_string()),
        }
    }

    pub(crate) fn truncate_file(&mut self, path: &str) -> Result<(), String> {
        let parts = Self::components(path)?;
        let node = Self::node_at_mut(&mut self.root, &parts)
            .ok_or_else(|| "file does not exist".to_string())?;

        match node {
            VfsNode::File(contents) => {
                contents.clear();
                Ok(())
            }
            VfsNode::Directory(_) => Err("path is a directory".to_string()),
        }
    }

    // ==============================
    // Internal helpers
    // ==============================

    fn components(path: &str) -> Result<Vec<&str>, String> {
        let mut parts = Vec::new();

        for part in path.split('/') {
            match part {
                "" | "." => {}
                ".." => return Err("parent path components are not supported".to_string()),
                name => parts.push(name),
            }
        }

        Ok(parts)
    }

    fn node_at<'a>(node: &'a VfsNode, parts: &[&str]) -> Option<&'a VfsNode> {
        if parts.is_empty() {
            return Some(node);
        }

        match node {
            VfsNode::Directory(children) => {
                let next = children.get(parts[0])?;
                Self::node_at(next, &parts[1..])
            }
            VfsNode::File(_) => None,
        }
    }

    fn node_at_mut<'a>(node: &'a mut VfsNode, parts: &[&str]) -> Option<&'a mut VfsNode> {
        if parts.is_empty() {
            return Some(node);
        }

        match node {
            VfsNode::Directory(children) => {
                let next = children.get_mut(parts[0])?;
                Self::node_at_mut(next, &parts[1..])
            }
            VfsNode::File(_) => None,
        }
    }

    fn remove_node(node: &mut VfsNode, parts: &[&str]) -> Result<VfsNode, String> {
        let (name, parent_parts) = parts
            .split_last()
            .ok_or_else(|| "cannot remove root".to_string())?;

        let parent = Self::node_at_mut(node, parent_parts)
            .ok_or_else(|| "parent directory does not exist".to_string())?;

        match parent {
            VfsNode::Directory(children) => children
                .remove(*name)
                .ok_or_else(|| "entry does not exist".to_string()),
            VfsNode::File(_) => Err("parent is not a directory".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{VfsEntryKind, VirtualFileSystem};

    #[test]
    fn create_directory_and_file_then_read_dir_in_sorted_order() {
        let mut fs = VirtualFileSystem::new();

        fs.create_directory("/zeta").unwrap();
        fs.create_directory("/alpha").unwrap();
        fs.create_file("/note.txt").unwrap();

        let entries = fs.read_dir("/").unwrap();
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();

        assert_eq!(names, vec!["alpha", "note.txt", "zeta"]);
        assert_eq!(entries[0].kind, VfsEntryKind::Directory);
        assert_eq!(entries[1].kind, VfsEntryKind::File);
    }

    #[test]
    fn unlink_file_rejects_directories() {
        let mut fs = VirtualFileSystem::new();

        fs.create_directory("/tmp").unwrap();

        assert!(fs.unlink_file("/tmp").is_err());
        assert_eq!(fs.kind("/tmp").unwrap(), Some(VfsEntryKind::Directory));
    }

    #[test]
    fn remove_directory_requires_empty_directory() {
        let mut fs = VirtualFileSystem::new();

        fs.create_directory("/tmp").unwrap();
        fs.create_file("/tmp/file.txt").unwrap();

        assert!(fs.remove_directory("/tmp").is_err());
        fs.unlink_file("/tmp/file.txt").unwrap();
        fs.remove_directory("/tmp").unwrap();

        assert_eq!(fs.kind("/tmp").unwrap(), None);
    }

    #[test]
    fn parent_components_are_rejected() {
        let mut fs = VirtualFileSystem::new();

        assert!(fs.create_directory("/tmp/../escape").is_err());
        assert!(fs.kind("/tmp/../escape").is_err());
    }

    #[test]
    fn write_file_extends_with_zero_filled_gap() {
        let mut fs = VirtualFileSystem::new();

        fs.create_file("/sparse.bin").unwrap();
        fs.write_file("/sparse.bin", 3, b"xy").unwrap();

        let mut contents = [255; 5];
        let bytes_read = fs.read_file("/sparse.bin", 0, &mut contents).unwrap();

        assert_eq!(bytes_read, 5);
        assert_eq!(&contents, &[0, 0, 0, b'x', b'y']);
    }

    #[test]
    fn entry_size_reports_file_length_and_zero_for_directories() {
        let mut fs = VirtualFileSystem::new();

        fs.create_directory("/tmp").unwrap();
        fs.create_file("/tmp/file.txt").unwrap();
        fs.write_file("/tmp/file.txt", 0, b"hello").unwrap();

        assert_eq!(fs.entry_size("/tmp").unwrap(), 0);
        assert_eq!(fs.entry_size("/tmp/file.txt").unwrap(), 5);
    }

    #[test]
    fn rename_moves_files_and_directories() {
        let mut fs = VirtualFileSystem::new();

        fs.create_directory("/tmp").unwrap();
        fs.create_directory("/tmp/archive").unwrap();
        fs.create_file("/tmp/file.txt").unwrap();
        fs.write_file("/tmp/file.txt", 0, b"hello").unwrap();

        fs.rename("/tmp/file.txt", "/tmp/archive/final.txt")
            .unwrap();

        assert_eq!(fs.kind("/tmp/file.txt").unwrap(), None);
        assert_eq!(
            fs.kind("/tmp/archive/final.txt").unwrap(),
            Some(VfsEntryKind::File)
        );

        let mut contents = [0; 5];
        assert_eq!(
            fs.read_file("/tmp/archive/final.txt", 0, &mut contents)
                .unwrap(),
            5
        );
        assert_eq!(&contents, b"hello");

        fs.rename("/tmp/archive", "/renamed").unwrap();
        assert_eq!(fs.kind("/tmp/archive").unwrap(), None);
        assert_eq!(fs.kind("/renamed").unwrap(), Some(VfsEntryKind::Directory));
    }

    #[test]
    fn rename_rejects_missing_destination_parent_existing_destination_and_self_move() {
        let mut fs = VirtualFileSystem::new();

        fs.create_directory("/tmp").unwrap();
        fs.create_directory("/tmp/child").unwrap();
        fs.create_file("/tmp/file.txt").unwrap();
        fs.create_file("/tmp/existing.txt").unwrap();

        assert!(fs.rename("/tmp/missing.txt", "/tmp/new.txt").is_err());
        assert!(fs.rename("/tmp/file.txt", "/missing/new.txt").is_err());
        assert!(fs.rename("/tmp/file.txt", "/tmp/existing.txt").is_err());
        assert!(fs.rename("/tmp", "/tmp/child/moved").is_err());
    }
}
