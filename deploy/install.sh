#!/usr/bin/env bash
set -euo pipefail
script_file=$(readlink -f -- "${BASH_SOURCE[0]}")
source_dir=$(cd -- "$(dirname -- "$script_file")/.." && pwd -P)
root_dir=${SWIFT_ROOT_DIR:-${AGENT_STUDIO_ROOT_DIR:-"$HOME/workdir"}}
herdr_bin=${HERDR_BIN:-"$HOME/.local/bin/herdr"}
start_services=0
previous_source=''
skip_runtime=0
while (($#)); do
  case "$1" in
    --root) root_dir=$2; shift 2 ;;
    --herdr) herdr_bin=$2; shift 2 ;;
    --start) start_services=1; shift ;;
    --no-start) start_services=0; shift ;;
    --previous-source) previous_source=$2; shift 2 ;;
    --skip-runtime) skip_runtime=1; shift ;;
    *) echo 'Usage: deploy/install.sh [--root ABSOLUTE_DIRECTORY] [--herdr ABSOLUTE_BINARY] [--start|--no-start] [--previous-source DIRECTORY] [--skip-runtime]' >&2; exit 2 ;;
  esac
done
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major<22||(major===22&&minor<13))process.exit(1)' || { echo 'Node.js >= 22.13 is required.' >&2; exit 1; }
command -v python3 >/dev/null
[[ -x "$herdr_bin" ]] || { echo 'Install a compatible Herdr binary first.' >&2; exit 1; }
[[ "$root_dir" = /* && "$herdr_bin" = /* ]] || { echo 'Use absolute paths.' >&2; exit 2; }
# Validate ownership before creating configuration or installing dependencies.
python3 - "$source_dir" "$previous_source" "$skip_runtime" <<'PYOWN'
import pathlib,sys
source=pathlib.Path(sys.argv[1]).resolve()
previous=pathlib.Path(sys.argv[2]).resolve() if sys.argv[2] else None
if previous and (source/'.local').resolve() != (previous/'.local').resolve():
    raise RuntimeError('An upgrade must preserve the previous installation state directory.')
for name in (['swift.service'] if sys.argv[3]=='1' else ['swift.service','swift-runtime.service']):
    link=pathlib.Path.home()/'.config/systemd/user'/name
    owned=[p.resolve() for base in [source,previous] if base for p in [base/'deploy/systemd'/name,base/'.local/config/systemd'/name]]
    if (link.exists() or link.is_symlink()) and (not link.is_symlink() or link.resolve() not in owned):
        raise RuntimeError('Existing service belongs to another installation: '+name)
launcher=pathlib.Path.home()/'.local/bin/swift'
if launcher.exists() or launcher.is_symlink():
    managed=launcher.is_file() and b'# Swift-managed execution environment' in launcher.read_bytes()
    launchers=[base/'deploy/swift.sh' for base in [source,previous] if base]
    shared_state=False
    if previous and launcher.is_symlink():
        target=launcher.resolve()
        shared_state=target.name=='swift.sh' and target.parent.name=='deploy' and (target.parent.parent/'.local').resolve()==(source/'.local').resolve()
    if not managed and not shared_state and (not launcher.is_symlink() or launcher.resolve() not in launchers):
        raise RuntimeError('Existing swift command belongs to another installation: '+str(launcher))
PYOWN
python3 "$source_dir/deploy/cleanup-legacy-environment.py" "$source_dir"
npm --prefix "$source_dir" ci --omit=dev
python3 - "$source_dir" "$root_dir" "$herdr_bin" "$skip_runtime" <<'PY'
import os,sys,secrets,pathlib
source,root,herdr=map(pathlib.Path,sys.argv[1:4])
config=source/'.local/config';config.mkdir(parents=True,exist_ok=True);config.chmod(0o700)
env=config/'swift.env'
def quote(value): return '"'+str(value).replace('\\','\\\\').replace('"','\\"')+'"'
if not env.exists():
    values={'SWIFT_DIRECT_AUTH':'local','HOST':'0.0.0.0','PORT':'8792','SWIFT_TOKEN':secrets.token_urlsafe(32),
      'HERDR_SESSION':'swift','HERDR_BIN':str(herdr),'SWIFT_ROOT_DIR':str(root),
      'SWIFT_SETTINGS_FILE':str(config/'settings.json'),
      'SWIFT_DATA_DIR':str(source/'.local/data/roots'),'SWIFT_BASE_PATH':'/swift','SWIFT_HIDE_STARTUP_URLS':'1'}
    if 'microsoft' in __import__('platform').release().lower():
        route=__import__('subprocess').check_output(['ip','-4','route','show','default'],text=True).split()
        if 'via' in route: values['SWIFT_WSL_HOST']=route[route.index('via')+1]
    with env.open('x') as f:
        os.chmod(env,0o600);f.write(''.join(k+'='+quote(v)+'\n' for k,v in values.items()))
unitdir=pathlib.Path.home()/'.config/systemd/user';unitdir.mkdir(parents=True,exist_ok=True)
# Render absolute paths, including directories with spaces or systemd specifiers.
# Live legacy units remain untouched until this installer is explicitly run.
def unit_path(value):
    value=str(value)
    if any(c in value for c in ['\n','\r','\x00']): raise ValueError('Unsupported character in service path')
    return value.replace('\\','\\\\').replace('"','\\"').replace('%','%%').replace(' ',r'\x20')
units=config/'systemd';units.mkdir(exist_ok=True)
import shutil
replacements={'@SOURCE@':unit_path(source),'@CONFIG@':unit_path(config),'@NODE@':unit_path(shutil.which('node'))}
for name in (['swift.service'] if sys.argv[4]=='1' else ['swift.service','swift-runtime.service']):
    target=units/name
    text=(source/'deploy/templates'/name).read_text()
    for old,new in replacements.items(): text=text.replace(old,new)
    target.write_text(text)
    link=unitdir/name
    if link.is_symlink():link.unlink()
    link.symlink_to(target)
bindir=pathlib.Path.home()/'.local/bin';bindir.mkdir(parents=True,exist_ok=True)
launcher=bindir/'swift'
if launcher.exists() or launcher.is_symlink():launcher.unlink()
launcher.symlink_to(source/'deploy/swift.sh')
print('Project-local configuration preserved; systemd entries link to this project.')
PY
# Install Swift's Codex defaults and extensions when the Codex npm package exists.
# Verification, immutable releases and credentials remain in their own Swift state directory.
if ((!skip_runtime)) && [[ -f "$source_dir/deploy/codex/install.py" ]]; then
  codex_python="${SWIFT_CODEX_PYTHON:-/usr/bin/python3}"
  "$codex_python" -B "$source_dir/deploy/codex/install.py" --source "$source_dir" --auto
fi
systemctl --user daemon-reload
if ((start_services)); then
  # The frontend uses an existing Herdr session; do not enable or restart its runtime.
  systemctl --user start swift.service
fi
echo 'Configuration: .local/config/swift.env; local entry: http://127.0.0.1:8792/swift/.'
echo 'Run swift to show server information and client connection links.'
