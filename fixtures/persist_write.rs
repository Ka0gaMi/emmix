use std::fs;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    fs::write("/persist.txt", "kept")?;
    Ok(())
}
