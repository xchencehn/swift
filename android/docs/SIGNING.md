# Personal release signing

Agent Studio uses a stable PKCS12 signing certificate for both Android editions.
The signing identity and application IDs `io.swift.chat` and
`io.swift.terminal` are retained so Agent Studio can update the existing installations. These
private files are ignored by Git and must be backed up together:

```text
android/private/signing/swift.p12
android/signing.properties
```

The keystore filename and key alias are both `swift`. Losing the key requires
uninstalling the old app before installing a replacement.

Build and verify from `android/`:

```bash
./gradlew assembleTerminalRelease assembleChatRelease
$ANDROID_HOME/build-tools/36.0.0/apksigner verify \
  app/build/outputs/apk/terminal/release/agent-studio-terminal-release.apk
$ANDROID_HOME/build-tools/36.0.0/apksigner verify \
  app/build/outputs/apk/chat/release/agent-studio-chat-release.apk
```
