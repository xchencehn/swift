#!/usr/bin/env bash
set -euo pipefail

config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/swift"
server_env="$config_dir/agent-studio.env"
android_properties="$(cd "$(dirname "$0")/../android" && pwd)/swift.properties"
android_root="$(dirname "$android_properties")"
signing_properties="$android_root/signing.properties"
keystore="$android_root/private/signing/swift.p12"

if [[ ! -f "$server_env" ]]; then
  echo "Missing $server_env" >&2
  exit 1
fi

umask 077
token="$(sed -n 's/^AGENT_STUDIO_ANDROID_TOKEN=//p' "$server_env" | tail -n 1)"
if [[ "${1:-}" == "--rotate" || -z "$token" ]]; then
  token="$(openssl rand -base64 32 | tr -d '\n' | tr '+/' '-_')"
  temporary="$(mktemp "$config_dir/agent-studio.env.XXXXXX")"
  grep -v '^AGENT_STUDIO_ANDROID_TOKEN=' "$server_env" >"$temporary"
  printf '\nAGENT_STUDIO_ANDROID_TOKEN=%s\n' "$token" >>"$temporary"
  mv "$temporary" "$server_env"
fi

{
  printf 'baseUrl=https://150.158.39.216:8000/swift\n'
  printf 'token=%s\n' "$token"
} >"$android_properties"
chmod 600 "$server_env" "$android_properties"

if [[ ! -f "$keystore" ]]; then
  mkdir -p "$(dirname "$keystore")"
  signing_password="$(openssl rand -base64 24 | tr -d '\n' | tr '+/' '-_')"
  keytool -genkeypair -noprompt \
    -keystore "$keystore" -storetype PKCS12 \
    -storepass "$signing_password" -keypass "$signing_password" \
    -alias swift -keyalg RSA -keysize 3072 -validity 10000 \
    -dname "CN=swift Personal Sideload"
  {
    printf 'storeFile=private/signing/swift.p12\n'
    printf 'storePassword=%s\n' "$signing_password"
    printf 'keyAlias=swift\n'
    printf 'keyPassword=%s\n' "$signing_password"
    printf 'storeType=PKCS12\n'
  } >"$signing_properties"
fi
chmod 600 "$signing_properties" "$keystore"

echo "Android private configuration initialized (secret not printed)."
