#!/bin/sh
set -eu
image=${1:-ghcr.io/318182456/dockhand:latest}
build=${2:?Missing build number}
output=${3:?Missing output directory}
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
stage=$(mktemp -d)
container=
cleanup(){ [ -z "$container" ] || docker rm "$container" >/dev/null 2>&1 || true; rm -rf -- "$stage"; }
trap cleanup EXIT INT TERM
docker pull "$image"
container=$(docker create --platform linux/amd64 "$image")
mkdir "$stage/app"
for file in node_modules build bin drizzle drizzle-pg server.js package.json LICENSE.txt PRIVACY.txt scripts; do
 docker cp "$container:/app/$file" "$stage/app/$file"
done
docker cp "$container:/usr/local/bin/node" "$stage/node"
version=$(node -p "require('$root/synology/compose-version.json').version")
checksum=$(node -p "require('$root/synology/compose-version.json').sha256")
curl --fail --location --retry 3 "https://github.com/docker/compose/releases/download/$version/docker-compose-linux-x86_64" -o "$stage/docker-compose"
printf '%s  %s\n' "$checksum" "$stage/docker-compose" | sha256sum -c -
node "$root/synology/build-spk.mjs" --app "$stage/app" --node "$stage/node" --compose "$stage/docker-compose" --out "$output" --build "$build"
