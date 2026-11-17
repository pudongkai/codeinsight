use std::fs;
use std::path::Path;

fn main() {
    if let Ok(dir) = std::env::var("CODEINSIGHT_TEST_MARKER_DIR") {
        let _ = fs::write(Path::new(&dir).join("build-rs-ran"), "1");
    }
}
