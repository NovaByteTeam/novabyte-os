#!/usr/bin/env bash
set -euo pipefail

OS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BUILDROOT_VERSION="2025.02"
BUILDROOT_DIR="$OS_DIR/.buildroot/buildroot-$BUILDROOT_VERSION"
DOWNLOAD_DIR="$OS_DIR/.downloads"
ARCHIVE="$DOWNLOAD_DIR/buildroot-$BUILDROOT_VERSION.tar.xz"
OUTPUT_DIR="$OS_DIR/output"
NWJS_APP_DIR="$OS_DIR/package/nbosp-kiosk/source"
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

if [[ ! -x "$NWJS_APP_DIR/NovaByte" || ! -f "$NWJS_APP_DIR/package.nw/package.json" ]]; then
  echo "Linux NW.js kiosk bundle missing. Run the workflow app build/staging steps first." >&2
  exit 1
fi

make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" nbosp_x86_64_defconfig
for option in \
  BR2_TOOLCHAIN_BUILDROOT \
  BR2_TOOLCHAIN_BUILDROOT_GLIBC \
  BR2_TOOLCHAIN_BUILDROOT_CXX \
  BR2_INSTALL_LIBSTDCPP \
  BR2_SHARED_LIBS \
  BR2_TOOLCHAIN_HAS_THREADS_NPTL \
  BR2_ROOTFS_DEVICE_CREATION_DYNAMIC_EUDEV \
  BR2_PACKAGE_EUDEV \
  BR2_PACKAGE_LIBGTK3 \
  BR2_PACKAGE_LIBGTK3_WAYLAND \
  BR2_PACKAGE_LIBNSS \
  BR2_PACKAGE_LIBNSPR \
  BR2_PACKAGE_CAGE \
  BR2_PACKAGE_SEATD_DAEMON \
  BR2_PACKAGE_DBUS \
  BR2_PACKAGE_XKEYBOARD_CONFIG \
  BR2_PACKAGE_MESA3D_OPENGL_EGL \
  BR2_PACKAGE_MESA3D_OPENGL_ES \
  BR2_PACKAGE_MESA3D_GALLIUM_DRIVER_SVGA \
  BR2_PACKAGE_NBOSP_KIOSK
do
  if ! grep -qx "$option=y" "$OUTPUT_DIR/.config"; then
    echo "Required Buildroot option was not enabled: $option" >&2
    exit 1
  fi
done

if grep -qx "BR2_PACKAGE_NODEJS=y" "$OUTPUT_DIR/.config"; then
  echo "Buildroot Node.js must stay disabled; the kiosk uses NW.js's bundled Node runtime." >&2
  exit 1
fi

make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" nbosp-kiosk-dirclean
make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" -j"$JOBS"
bash "$OS_DIR/board/nbosp/post-image.sh" "$OUTPUT_DIR/images"

echo "ISO ready: $OUTPUT_DIR/images/nbosp-live.iso"
