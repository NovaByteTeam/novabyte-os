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
  BR2_PACKAGE_FONTCONFIG \
  BR2_PACKAGE_NOTO_EMOJI \
  BR2_PACKAGE_DEJAVU \
  BR2_PACKAGE_DEJAVU_SANS \
  BR2_PACKAGE_DEJAVU_MONO \
  BR2_PACKAGE_XORGPROTO \
  BR2_PACKAGE_LIBGLVND \
  BR2_PACKAGE_CAGE \
  BR2_PACKAGE_WLROOTS_XWAYLAND \
  BR2_PACKAGE_XWAYLAND \
  BR2_PACKAGE_SEATD_DAEMON \
  BR2_PACKAGE_DBUS \
  BR2_PACKAGE_XKEYBOARD_CONFIG \
  BR2_PACKAGE_XDATA_XCURSOR_THEMES \
  BR2_PACKAGE_LIBARCHIVE \
  BR2_PACKAGE_LIBARCHIVE_BSDTAR \
  BR2_PACKAGE_UTIL_LINUX_LIBUUID \
  BR2_PACKAGE_OPENVMTOOLS \
  BR2_PACKAGE_OPENVMTOOLS_RESOLUTIONKMS \
  BR2_PACKAGE_MESA3D_OPENGL_EGL \
  BR2_PACKAGE_MESA3D_OPENGL_ES \
  BR2_PACKAGE_MESA3D_OPENGL_GLX \
  BR2_PACKAGE_MESA3D_GBM \
  BR2_PACKAGE_MESA3D_GALLIUM_DRIVER_SVGA \
  BR2_PACKAGE_NBOSP_KIOSK \
  BR2_PACKAGE_NBOSP_POWER \
  BR2_PACKAGE_NBOSP_INSTALL \
  BR2_PACKAGE_DOSFSTOOLS \
  BR2_PACKAGE_DOSFSTOOLS_MKFS_FAT \
  BR2_PACKAGE_E2FSPROGS \
  BR2_PACKAGE_UTIL_LINUX_BINARIES \
  BR2_TARGET_GRUB2 \
  BR2_TARGET_GRUB2_I386_PC \
  BR2_TARGET_GRUB2_X86_64_EFI \
  BR2_TARGET_GRUB2_INSTALL_TOOLS \
  BR2_TARGET_ROOTFS_TAR
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

GRAPHICS_SIGNATURE_FILE="$OUTPUT_DIR/.nbosp-graphics-signature"
GRAPHICS_SIGNATURE="$(
  {
    printf '%s\n' 'nbosp-graphics-stack-v1'
    grep -E '^BR2_PACKAGE_(CAGE|WLROOTS_XWAYLAND|XWAYLAND|XORGPROTO|LIBGLVND|MESA3D)(_|=)' "$OUTPUT_DIR/.config"
  } | sha256sum | cut -d ' ' -f 1
)"
if [[ ! -f "$GRAPHICS_SIGNATURE_FILE" ]] \
  || [[ "$(cat "$GRAPHICS_SIGNATURE_FILE")" != "$GRAPHICS_SIGNATURE" ]]; then
  echo "Graphics configuration changed; rebuilding only Mesa, libglvnd, and XWayland."
  make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" \
    xwayland-dirclean libglvnd-dirclean mesa3d-dirclean
  printf '%s\n' "$GRAPHICS_SIGNATURE" > "$GRAPHICS_SIGNATURE_FILE"
fi

make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" \
  nbosp-kiosk-dirclean nbosp-install-dirclean nbosp-power-dirclean
make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" toolchain
make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" mesa3d-extract
MESA3D_VERSION="$(sed -n 's/^MESA3D_VERSION = //p' "$BUILDROOT_DIR/package/mesa3d/mesa3d.mk")"
MESA_DRI_INTERFACE="$OUTPUT_DIR/build/mesa3d-$MESA3D_VERSION/include/GL/internal/dri_interface.h"
STAGING_DRI_INTERFACE="$OUTPUT_DIR/host/x86_64-buildroot-linux-gnu/sysroot/usr/include/GL/internal/dri_interface.h"
if [[ ! -f "$MESA_DRI_INTERFACE" ]]; then
  echo "Mesa's XWayland DRI interface header is missing: $MESA_DRI_INTERFACE" >&2
  exit 1
fi
install -D -m 0644 "$MESA_DRI_INTERFACE" "$STAGING_DRI_INTERFACE"
if [[ ! -x "$OUTPUT_DIR/target/bin/lsblk" \
  && ! -x "$OUTPUT_DIR/target/sbin/lsblk" \
  && ! -x "$OUTPUT_DIR/target/usr/bin/lsblk" \
  && ! -x "$OUTPUT_DIR/target/usr/sbin/lsblk" \
  || ! -x "$OUTPUT_DIR/target/bin/sfdisk" \
  && ! -x "$OUTPUT_DIR/target/sbin/sfdisk" \
  && ! -x "$OUTPUT_DIR/target/usr/bin/sfdisk" \
  && ! -x "$OUTPUT_DIR/target/usr/sbin/sfdisk" ]]; then
  echo "Cached util-linux output lacks lsblk or sfdisk; rebuilding util-linux." >&2
  make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" \
    util-linux-dirclean
fi
make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" -j"$JOBS"

if [[ ! -x "$OUTPUT_DIR/target/usr/bin/cage" ]]; then
  echo "Cage compositor is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/usr/bin/Xwayland" ]]; then
  echo "XWayland was enabled but /usr/bin/Xwayland is missing from the target image." >&2
  exit 1
fi
if ! find "$OUTPUT_DIR/target/usr/lib" -type f -name 'vmwgfx_dri.so' -print -quit | grep -q .; then
  echo "Mesa's VMware SVGA DRI driver is missing from the target image." >&2
  exit 1
fi
if ! find "$OUTPUT_DIR/target/usr/lib" \( -type f -o -type l \) -name 'libGLX_mesa.so*' -print -quit | grep -q .; then
  echo "Mesa GLX support is missing from the target image." >&2
  exit 1
fi
if ! find "$OUTPUT_DIR/target/usr/lib" \( -type f -o -type l \) -name 'libGL.so.1*' -print -quit | grep -q .; then
  echo "The OpenGL libGL.so.1 dispatch library is missing from the target image." >&2
  exit 1
fi
if ! find "$OUTPUT_DIR/target/usr/lib" \( -type f -o -type l \) -name 'libgbm.so*' -print -quit | grep -q .; then
  echo "Mesa GBM is missing from the target image; XWayland glamor cannot initialize without it." >&2
  exit 1
fi
if [[ ! -f "$OUTPUT_DIR/target/opt/nbosp/lib/libffmpeg.so" ]]; then
  echo "NW.js runtime library libffmpeg.so is missing from /opt/nbosp/lib in the target image." >&2
  exit 1
fi
if [[ ! -d "$OUTPUT_DIR/target/usr/share/fonts/dejavu" ]]; then
  echo "DejaVu fonts were enabled but are missing from the target image." >&2
  exit 1
fi
if [[ ! -f "$OUTPUT_DIR/target/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf" ]]; then
  echo "Noto Color Emoji is missing from the target image." >&2
  exit 1
fi
if [[ ! -f "$OUTPUT_DIR/target/usr/share/icons/whiteglass/cursors/left_ptr" \
  && ! -f "$OUTPUT_DIR/target/usr/share/icons/Whiteglass/cursors/left_ptr" ]]; then
  echo "Whiteglass X cursor theme is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/usr/bin/bsdtar" ]]; then
  echo "BSD tar is required to browse ISO files but is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/bin/tar" || ! -x "$OUTPUT_DIR/target/bin/gzip" ]]; then
  echo "BusyBox tar with gzip support is required by the disk installer." >&2
  exit 1
fi
if [[ ! -u "$OUTPUT_DIR/target/usr/bin/nbosp-power" ]]; then
  echo "Restricted power helper is missing its setuid permission." >&2
  exit 1
fi
if [[ ! -u "$OUTPUT_DIR/target/usr/bin/nbosp-install" ]]; then
  echo "Restricted disk installer helper is missing its setuid permission." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/usr/sbin/nbosp-install-system" ]]; then
  echo "Root-owned disk installation script is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/sbin/grub-install" \
  && ! -x "$OUTPUT_DIR/target/usr/bin/grub-install" \
  && ! -x "$OUTPUT_DIR/target/usr/sbin/grub-install" ]]; then
  echo "grub-install is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/bin/lsblk" \
  && ! -x "$OUTPUT_DIR/target/sbin/lsblk" \
  && ! -x "$OUTPUT_DIR/target/usr/bin/lsblk" \
  && ! -x "$OUTPUT_DIR/target/usr/sbin/lsblk" ]]; then
  echo "lsblk is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/bin/sfdisk" \
  && ! -x "$OUTPUT_DIR/target/sbin/sfdisk" \
  && ! -x "$OUTPUT_DIR/target/usr/bin/sfdisk" \
  && ! -x "$OUTPUT_DIR/target/usr/sbin/sfdisk" ]]; then
  echo "sfdisk is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/bin/mkfs.vfat" \
  && ! -x "$OUTPUT_DIR/target/sbin/mkfs.vfat" \
  && ! -x "$OUTPUT_DIR/target/usr/bin/mkfs.vfat" \
  && ! -x "$OUTPUT_DIR/target/usr/sbin/mkfs.vfat" ]]; then
  echo "mkfs.vfat is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/bin/mkfs.ext4" \
  && ! -x "$OUTPUT_DIR/target/sbin/mkfs.ext4" \
  && ! -x "$OUTPUT_DIR/target/usr/bin/mkfs.ext4" \
  && ! -x "$OUTPUT_DIR/target/usr/sbin/mkfs.ext4" ]]; then
  echo "mkfs.ext4 is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/bin/blkid" \
  && ! -x "$OUTPUT_DIR/target/sbin/blkid" \
  && ! -x "$OUTPUT_DIR/target/usr/bin/blkid" \
  && ! -x "$OUTPUT_DIR/target/usr/sbin/blkid" ]]; then
  echo "blkid is missing from the target image." >&2
  exit 1
fi
if [[ ! -d "$OUTPUT_DIR/target/lib/grub/i386-pc" \
  && ! -d "$OUTPUT_DIR/target/usr/lib/grub/i386-pc" \
  || ! -d "$OUTPUT_DIR/target/lib/grub/x86_64-efi" \
  && ! -d "$OUTPUT_DIR/target/usr/lib/grub/x86_64-efi" ]]; then
  echo "GRUB BIOS or UEFI modules are missing from the target image." >&2
  exit 1
fi
if [[ ! -f "$OUTPUT_DIR/images/rootfs.tar" ]]; then
  echo "Buildroot did not produce the root filesystem archive for disk installation." >&2
  exit 1
fi

bash "$OS_DIR/board/nbosp/post-image.sh" "$OUTPUT_DIR/images"

echo "ISO ready: $OUTPUT_DIR/images/nbosp-live.iso"
