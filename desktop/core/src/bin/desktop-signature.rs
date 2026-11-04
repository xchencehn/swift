use base64::Engine;
fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert_eq!(args.len(), 4, "installer, signature, public key required");
    let bytes = std::fs::read(&args[1]).expect("installer");
    let signature = std::fs::read_to_string(&args[2]).expect("signature");
    let decode = |value: &str| {
        String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(value.trim())
                .expect("base64 signature"),
        )
        .expect("signature text")
    };
    let public = minisign_verify::PublicKey::decode(&decode(&args[3])).expect("public key");
    let signature = minisign_verify::Signature::decode(&decode(&signature)).expect("signature");
    public
        .verify(&bytes, &signature, true)
        .expect("installer signature");
    let mut corrupted = bytes;
    corrupted[0] ^= 1;
    assert!(
        public.verify(&corrupted, &signature, true).is_err(),
        "tampered installer must be rejected"
    );
    println!("PASS update signature; tampered payload rejected");
}
