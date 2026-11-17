#!/bin/zsh
# Builds the native helper as a universal binary into <plugin>.sdPlugin/bin/ and signs it.
# With your own signing identity the Accessibility permission survives rebuilds:
#   CODESIGN_IDENTITY="Apple Development: …" npm run build:helper
set -euo pipefail
cd "${0:A:h}/.."

out="io.github.marvin-bay.miccontrol.sdPlugin/bin/mic-control-helper"
mkdir -p "${out:h}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for arch in arm64 x86_64; do
	swiftc -O -swift-version 5 -target "$arch-apple-macos13" \
		-framework CoreAudio -framework AppKit -framework ApplicationServices \
		helper/main.swift -o "$tmp/helper-$arch"
done
lipo -create "$tmp/helper-arm64" "$tmp/helper-x86_64" -output "$out"
codesign --force --sign "${CODESIGN_IDENTITY:--}" --identifier io.github.marvin-bay.miccontrol.helper "$out"
echo "built: $out ($(lipo -archs "$out"))"
