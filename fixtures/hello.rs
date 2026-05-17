use std::env;
use std::fs;
use std::io::{self, Read};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    let marker = env::var("EMMIX_FIXTURE").unwrap_or_else(|_| "missing".to_string());

    let mut stdin = String::new();
    io::stdin().read_to_string(&mut stdin)?;

    fs::create_dir("/tmp")?;
    fs::create_dir("/tmp/demo")?;
    fs::write("/tmp/demo/message.txt", format!("{}|{}", marker, stdin))?;

    let file = fs::read_to_string("/tmp/demo/message.txt")?;
    let mut entries = fs::read_dir("/tmp/demo")?
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort();

    println!("args={}", args.join(","));
    println!("env={marker}");
    println!("stdin={}", stdin.trim_end());
    println!("file={}", file.trim_end());
    println!("entries={}", entries.join(","));

    Ok(())
}
