fn main() {
    // PDF 내보내기가 WebKit 프레임워크(WKWebView)를 직접 쓴다(src/pdf.rs).
    println!("cargo:rustc-link-lib=framework=WebKit");
    tauri_build::build()
}
