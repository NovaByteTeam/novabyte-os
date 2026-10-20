#!/usr/bin/env bash
set -euo pipefail

OS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BUILDROOT_VERSION="2025.02"
BUILDROOT_DIR="$OS_DIR/.buildroot/buildroot-$BUILDROOT_VERSION"
DOWNLOAD_DIR="$OS_DIR/.downloads"
ARCHIVE="$DOWNLOAD_DIR/buildroot-$BUILDROOT_VERSION.tar.xz"
OUTPUT_DIR="$OS_DIR/output"
JOBS="${JOBS:-$(nproc)}"

mkdir -p "$DOWNLOAD_DIR" "$OS_DIR/.buildroot"

if [[ ! -d "$BUILDROOT_DIR" ]]; then
  if [[ ! -f "$ARCHIVE" ]]; then
    curl --fail --location --retry 3 \
      "https://buildroot.org/downloads/buildroot-$BUILDROOT_VERSION.tar.xz" \
      --output "$ARCHIVE"
  fi
  mkdir -p "$BUILDROOT_DIR"
  tar -xJf "$ARCHIVE" --strip-components=1 -C "$BUILDROOT_DIR"
fi

make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" nbosp_x86_64_defconfig
make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" -j"$JOBS"
bash "$OS_DIR/board/nbosp/post-image.sh" "$OUTPUT_DIR/images"

echo "ISO ready: $OUTPUT_DIR/images/nbosp-live.iso"
