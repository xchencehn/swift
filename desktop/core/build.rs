fn main() {
    // include_dir embeds generated files; Cargo must rebuild when those files change.
    println!("cargo:rerun-if-changed=../dist");
}
