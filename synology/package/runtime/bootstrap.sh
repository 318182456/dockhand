#!/bin/sh
# Managed by DockhandNative: host integration for the native package.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run this bootstrap as administrator/root'; exit 1; }
account=${1:-}
[ -n "$account" ] || { echo 'Usage: bootstrap.sh NAS_ACCOUNT [--check|--repair]'; exit 1; }
mode=${2:---check}
pkg=/var/packages/DockhandNative
[ -x "$pkg/target/runtime/node" ] || { echo 'DockhandNative package is not installed'; exit 1; }
uid=$(id -u "$account")
gid=$(id -g "$account")
sockgid=$(stat -c %g /var/run/docker.sock)
unit=/etc/systemd/system/dockhand-native.service
control=/usr/local/libexec/dockhand-native-control
sudoers=/etc/sudoers.d/dockhand-native
if [ "$mode" != '--repair' ]; then
 [ -f "$unit" ] && [ -x "$control" ] && [ -f "$sudoers" ] || { echo 'Native host integration needs repair'; exit 2; }
 /bin/systemctl is-enabled dockhand-native.service
 exit 0
fi
for managed in "$unit" "$control" "$sudoers"; do
 if [ -e "$managed" ] && ! grep -q 'Managed by DockhandNative' "$managed"; then
  echo 'Unexpected existing host integration file; refusing to replace it'; exit 1
 fi
done
mkdir -p /usr/local/libexec
cat > "$unit" <<EOF
# Managed by DockhandNative
[Unit]
Description=Dockhand native Docker management
After=network-online.target pkgctl-ContainerManager.service
Wants=network-online.target
Requires=pkgctl-ContainerManager.service
StartLimitInterval=300
StartLimitBurst=3
ConditionPathExists=$pkg/target/runtime/supervisor.mjs

[Service]
Type=simple
User=$uid
Group=$gid
SupplementaryGroups=$sockgid
WorkingDirectory=$pkg/target/app
ExecStart=$pkg/target/runtime/node $pkg/target/runtime/supervisor.mjs
Restart=on-failure
RestartSec=10
TimeoutStopSec=20
KillMode=mixed
StartLimitInterval=300
StartLimitBurst=3
UMask=0077
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
cat > "$control" <<'EOF'
#!/bin/sh
# Managed by DockhandNative
set -eu
case "${1:-}" in
 start)
  owner=$(sed -n 's/^User=//p' /etc/systemd/system/dockhand-native.service)
  group=$(sed -n 's/^Group=//p' /etc/systemd/system/dockhand-native.service)
  for metadata in /var/packages/DockhandNative/target/ui/config; do
   [ ! -L "$metadata" ] || exit 1
   chown "$owner:$group" "$metadata"
   chmod 644 "$metadata"
  done
  /bin/systemctl reset-failed dockhand-native.service >/dev/null 2>&1 || true
  exec /bin/systemctl start dockhand-native.service ;;
 update) exec /usr/local/bin/node /usr/local/libexec/dockhand-native-updater/upgrade-worker.mjs request ;;
 stop) exec /bin/systemctl stop dockhand-native.service ;;
 status) exec /bin/systemctl is-active --quiet dockhand-native.service ;;
 *) exit 64 ;;
esac
EOF
cat > "$sudoers" <<'EOF'
# Managed by DockhandNative
sc-dockhand-native ALL=(root) NOPASSWD: /usr/local/libexec/dockhand-native-control start, /usr/local/libexec/dockhand-native-control stop, /usr/local/libexec/dockhand-native-control status
EOF
chown root:root "$unit" "$control" "$sudoers"
chmod 644 "$unit"
chmod 755 "$control"
chmod 440 "$sudoers"
/bin/systemctl daemon-reload
/bin/systemctl enable dockhand-native.service
echo 'Native host integration installed; application data and runtime configuration were preserved.'
