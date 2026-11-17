use proc_macro::TokenStream;

fn touch(name: &str) {
    if let Ok(dir) = std::env::var("CODEINSIGHT_TEST_MARKER_DIR") {
        let _ = std::fs::write(std::path::Path::new(&dir).join(name), "1");
    }
}

/// Attribute macro that leaves the item unchanged.
#[proc_macro_attribute]
pub fn mark(_attr: TokenStream, item: TokenStream) -> TokenStream {
    touch("proc-macro-attr-ran");
    item
}

/// Derive macro that generates nothing.
#[proc_macro_derive(Touch)]
pub fn touch_derive(_item: TokenStream) -> TokenStream {
    touch("proc-macro-derive-ran");
    TokenStream::new()
}
