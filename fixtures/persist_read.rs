use std::fs;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let value = fs::read_to_string("/persist.txt")?;
    println!("persist={value}");
    Ok(())
}
