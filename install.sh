#!/bin/sh
set -eu
base=${1:-/storage/docker/sillytavern}
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
config="$base/config/config.yaml"
[ -f "$config" ] || { echo "Config not found: $config" >&2; exit 1; }
[ -d "$base/extensions" ] && [ -d "$base/plugins" ] || { echo 'Existing extensions/plugins folders required.' >&2; exit 1; }
if ! grep -Eq '^enableServerPlugins: (true|false)[[:space:]]*(#.*)?$' "$config"; then
    echo 'Unexpected enableServerPlugins setting. No files changed.' >&2; exit 1
fi
backup="$base/jev-backups/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$backup"
cp -p "$config" "$backup/config.yaml"
for kind in extensions plugins; do
    if [ -d "$base/$kind/jev-speaker-router" ]; then
        mkdir -p "$backup/$kind"
        cp -Rp "$base/$kind/jev-speaker-router" "$backup/$kind/"
    fi
done
trap 'echo "Installation interrupted. Original files are backed up at: $backup" >&2' 1 2 3 15
cp -R "$source_dir/extensions/jev-speaker-router" "$base/extensions/"
cp -R "$source_dir/plugins/jev-speaker-router" "$base/plugins/"
sed -i 's/^enableServerPlugins: false/enableServerPlugins: true/' "$config"
trap - 1 2 3 15
echo "Jev Speaker Router 0.5.2 installed. Backup: $backup"
echo 'Existing profiles and settings were preserved. Active routing is off unless explicitly enabled.'
echo 'Next: docker restart sillytavern'
echo 'Then hard-refresh SillyTavern. Use Manual group reply order, Auto-mode off, and disable other speaker routers before enabling active routing.'
