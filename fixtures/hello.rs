use std::env;
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    let marker = env::var("EMMIX_FIXTURE").unwrap_or_else(|_| "missing".to_string());

    let mut stdin = String::new();
    io::stdin().read_to_string(&mut stdin)?;

    fs::create_dir("/tmp")?;
    fs::create_dir("/tmp/demo")?;
    fs::create_dir("/tmp/demo/archive")?;

    let payload = format!("{}|{}|{}", marker, stdin, "chunk-".repeat(80));

    fs::write("/tmp/demo/message.txt", &payload)?;
    fs::rename("/tmp/demo/message.txt", "/tmp/demo/archive/renamed.txt")?;
    fs::rename("/tmp/demo/archive/renamed.txt", "/tmp/demo/final.txt")?;
    let mut final_file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/tmp/demo/final.txt")?;
    final_file.sync_all()?;
    final_file.sync_data()?;
    final_file.seek(SeekFrom::Start(7))?;
    let file_position = final_file.stream_position()?;
    fs::remove_dir("/tmp/demo/archive")?;

    fs::write("/tmp/demo/remove-me.txt", "temporary")?;
    fs::remove_file("/tmp/demo/remove-me.txt")?;

    let file = fs::read_to_string("/tmp/demo/final.txt")?;
    let mut entries = fs::read_dir("/tmp/demo")?
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort();

    println!("args={}", args.join(","));
    println!("env={marker}");
    println!("stdin={}", stdin.trim_end());
    println!("file_prefix={}", file.split('|').take(2).collect::<Vec<_>>().join("|").trim_end());
    println!("file_len={}", file.len());
    println!("file_pos={file_position}");
    println!("entries={}", entries.join(","));

    Ok(())
}
