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
  BR2_PACKAGE_CA_CERTIFICATES \
  BR2_PACKAGE_FONTCONFIG \
  BR2_PACKAGE_NOTO_EMOJI \
  BR2_PACKAGE_DEJAVU \
  BR2_PACKAGE_DEJAVU_SANS \
  BR2_PACKAGE_DEJAVU_MONO \
  BR2_PACKAGE_ALSA_LIB \
  BR2_PACKAGE_ALSA_UTILS \
  BR2_PACKAGE_ALSA_UTILS_ALSACTL \
  BR2_PACKAGE_ALSA_UTILS_AMIXER \
  BR2_PACKAGE_ALSA_UTILS_APLAY \
  BR2_PACKAGE_LIBDRM_VMWGFX \
  BR2_PACKAGE_XORGPROTO \
  BR2_PACKAGE_LIBGLVND \
  BR2_PACKAGE_LIBEPOXY \
  BR2_PACKAGE_CAGE \
  BR2_PACKAGE_WLROOTS_XWAYLAND \
  BR2_PACKAGE_XWAYLAND \
  BR2_PACKAGE_SEATD_DAEMON \
  BR2_PACKAGE_DBUS \
  BR2_PACKAGE_NETWORK_MANAGER \
  BR2_PACKAGE_NETWORK_MANAGER_CLI \
  BR2_PACKAGE_POLKIT \
  BR2_PACKAGE_WPA_SUPPLICANT \
  BR2_PACKAGE_WPA_SUPPLICANT_NL80211 \
  BR2_PACKAGE_BLUEZ5_UTILS \
  BR2_PACKAGE_BLUEZ5_UTILS_CLIENT \
  BR2_PACKAGE_BLUEZ5_UTILS_PLUGINS_AUDIO \
  BR2_PACKAGE_BLUEZ5_UTILS_PLUGINS_HID \
  BR2_PACKAGE_BLUEZ5_UTILS_PLUGINS_HOG \
  BR2_PACKAGE_LINUX_FIRMWARE \
  BR2_PACKAGE_LINUX_FIRMWARE_IWLWIFI_6E \
  BR2_PACKAGE_LINUX_FIRMWARE_IWLWIFI_9XXX \
  BR2_PACKAGE_LINUX_FIRMWARE_IWLWIFI_22000 \
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

if ! grep -q '^BR2_ROOTFS_OVERLAY=.*board/nbosp/rootfs-overlay' "$OUTPUT_DIR/.config"; then
  echo "NBOSP root filesystem overlay is not configured." >&2
  exit 1
fi

if grep -qx "BR2_PACKAGE_NODEJS=y" "$OUTPUT_DIR/.config"; then
  echo "Buildroot Node.js must stay disabled; the kiosk uses NW.js's bundled Node runtime." >&2
  exit 1
fi

GRAPHICS_SIGNATURE_FILE="$OUTPUT_DIR/.nbosp-graphics-signature"
GRAPHICS_SIGNATURE="$(
  {
    printf '%s\n' 'nbosp-graphics-stack-v3'
    grep -E '^BR2_PACKAGE_(CAGE|WLROOTS_XWAYLAND|XWAYLAND|XORGPROTO|LIBDRM|LIBGLVND|LIBEPOXY|MESA3D)(_|=)' "$OUTPUT_DIR/.config"
  } | sha256sum | cut -d ' ' -f 1
)"
XWAYLAND_SOURCE_DIR_EARLY="$(find "$OUTPUT_DIR/build" -maxdepth 1 -type d -name 'xwayland-*' -print -quit 2>/dev/null || true)"
XWAYLAND_BUILD_OPTIONS_EARLY=""
if [[ -n "$XWAYLAND_SOURCE_DIR_EARLY" ]]; then
  XWAYLAND_BUILD_OPTIONS_EARLY="$(find "$XWAYLAND_SOURCE_DIR_EARLY" -type f -path '*/meson-info/intro-buildoptions.json' -print -quit 2>/dev/null || true)"
fi
LIBDRM_SOURCE_DIR_EARLY="$(find "$OUTPUT_DIR/build" -maxdepth 1 -type d -name 'libdrm-*' -print -quit 2>/dev/null || true)"
LIBDRM_BUILD_OPTIONS_EARLY=""
if [[ -n "$LIBDRM_SOURCE_DIR_EARLY" ]]; then
  LIBDRM_BUILD_OPTIONS_EARLY="$(find "$LIBDRM_SOURCE_DIR_EARLY" -type f -path '*/meson-info/intro-buildoptions.json' -print -quit 2>/dev/null || true)"
fi
if [[ ! -f "$GRAPHICS_SIGNATURE_FILE" ]] \
  || [[ "$(cat "$GRAPHICS_SIGNATURE_FILE")" != "$GRAPHICS_SIGNATURE" ]] \
  || [[ -z "$XWAYLAND_BUILD_OPTIONS_EARLY" ]] \
  || [[ -z "$LIBDRM_BUILD_OPTIONS_EARLY" ]]; then
  echo "Graphics configuration changed or graphics build incomplete; rebuilding Mesa, libglvnd, libdrm, and XWayland."
  make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" \
    xwayland-dirclean libglvnd-dirclean mesa3d-dirclean libdrm-dirclean
  printf '%s\n' "$GRAPHICS_SIGNATURE" > "$GRAPHICS_SIGNATURE_FILE"
fi

make -C "$BUILDROOT_DIR" O="$OUTPUT_DIR" BR2_EXTERNAL="$OS_DIR" \
  alsa-utils-dirclean nbosp-kiosk-dirclean nbosp-install-dirclean nbosp-power-dirclean
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

KERNEL_CONFIG="$(find "$OUTPUT_DIR/build" -maxdepth 2 -type f -path '*/linux-*/.config' -print -quit)"
if [[ -z "$KERNEL_CONFIG" ]]; then
  echo "The built Linux kernel configuration is missing." >&2
  exit 1
fi
for option in \
  CONFIG_DRM_VMWGFX \
  CONFIG_SND_HDA_INTEL \
  CONFIG_SND_HDA_GENERIC \
  CONFIG_SND_HDA_CODEC_REALTEK \
  CONFIG_SND_ENS1371
do
  if ! grep -qx "$option=y" "$KERNEL_CONFIG"; then
    echo "Required VMware graphics/audio kernel option is missing: $option" >&2
    exit 1
  fi
done

if [[ ! -x "$OUTPUT_DIR/target/usr/bin/cage" ]]; then
  echo "Cage compositor is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/usr/bin/amixer" \
  || ! -x "$OUTPUT_DIR/target/usr/sbin/alsactl" \
  || ! -x "$OUTPUT_DIR/target/usr/bin/aplay" ]]; then
  echo "ALSA mixer, control, and playback utilities are missing from the target image." >&2
  exit 1
fi
ROOTFS_GROUPS="$(tar -xOf "$OUTPUT_DIR/images/rootfs.tar" ./etc/group)" || {
  echo "Could not read /etc/group from the generated rootfs.tar image." >&2
  exit 1
}
if ! grep -Eq '^render:[^:]*:[^:]*:' <<<"$ROOTFS_GROUPS"; then
  echo "The render group is missing from /etc/group in the generated rootfs.tar image:" >&2
  printf '%s\n' "$ROOTFS_GROUPS" >&2
  exit 1
fi
if ! grep -Eq '^render:[^:]*:[^:]*:([^,]*,)*nbosp(,|$)' <<<"$ROOTFS_GROUPS"; then
  echo "The kiosk user is missing from the render group in /etc/group in the generated rootfs.tar image:" >&2
  printf '%s\n' "$ROOTFS_GROUPS" >&2
  exit 1
fi
if ! awk '$1 == "-" && $3 == "render" && $4 == "60000" { found = 1 } END { exit !found }' \
  "$OS_DIR/board/nbosp/users.table"; then
  echo "The NBOSP user table does not define render with the reserved GID 60000." >&2
  exit 1
fi
if ! awk '$1 == "nbosp" { count = split($8, groups, ","); for (i = 1; i <= count; i++) if (groups[i] == "render") found = 1 } END { exit !found }' \
  "$OS_DIR/board/nbosp/users.table"; then
  echo "The NBOSP user table does not grant the kiosk user render-group access." >&2
  exit 1
fi
UDEV_DEVICE_RULES="$OUTPUT_DIR/target/etc/udev/rules.d/70-nbosp-device-groups.rules"
if [[ ! -f "$UDEV_DEVICE_RULES" ]] \
  || ! grep -Fq 'KERNEL=="renderD*", OWNER="nbosp", GROUP="render", MODE="0660"' "$UDEV_DEVICE_RULES" \
  || ! grep -Fq 'SUBSYSTEM=="sound", OWNER="nbosp", GROUP="audio", MODE="0660"' "$UDEV_DEVICE_RULES"; then
  echo "udev rules granting the kiosk user access to GPU and audio devices are missing." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/usr/bin/nmcli" \
  || ! -x "$OUTPUT_DIR/target/usr/bin/bluetoothctl" \
  || ! -x "$OUTPUT_DIR/target/usr/sbin/NetworkManager" \
  || ! -x "$OUTPUT_DIR/target/usr/sbin/wpa_supplicant" \
  || ! -f "$OUTPUT_DIR/target/etc/init.d/S40bluetoothd" \
  || ! -f "$OUTPUT_DIR/target/etc/init.d/S45NetworkManager" \
  || ! -f "$OUTPUT_DIR/target/etc/init.d/S50polkitd" \
  || ! -f "$OUTPUT_DIR/target/etc/polkit-1/rules.d/50-nbosp-connectivity.rules" ]]; then
  echo "NetworkManager, Bluetooth control, or NBOSP connectivity authorization is missing from the target image." >&2
  exit 1
fi
WIRED_CONNECTION="$OUTPUT_DIR/target/etc/NetworkManager/system-connections/nbosp-wired.nmconnection"
if [[ ! -f "$WIRED_CONNECTION" ]] \
  || ! grep -Fqx 'autoconnect=true' "$WIRED_CONNECTION" \
  || ! grep -Fqx 'method=auto' "$WIRED_CONNECTION" \
  || [[ "$(stat -c '%a' "$WIRED_CONNECTION")" != "600" ]]; then
  echo "The default DHCP-enabled VMware Ethernet connection is missing or has unsafe permissions." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/usr/bin/Xwayland" ]]; then
  echo "XWayland was enabled but /usr/bin/Xwayland is missing from the target image." >&2
  exit 1
fi
XWAYLAND_SOURCE_DIR="$(find "$OUTPUT_DIR/build" -maxdepth 1 -type d -name 'xwayland-*' -print -quit)"
XWAYLAND_BUILD_OPTIONS=""
if [[ -n "$XWAYLAND_SOURCE_DIR" ]]; then
  XWAYLAND_BUILD_OPTIONS="$(find "$XWAYLAND_SOURCE_DIR" -type f -path '*/meson-info/intro-buildoptions.json' -print -quit)"
fi
if [[ -z "$XWAYLAND_BUILD_OPTIONS" ]]; then
  echo "XWayland Meson build options are missing; cannot verify GLX and glamor support." >&2
  exit 1
fi
python3 - "$XWAYLAND_BUILD_OPTIONS" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as options_file:
    options = {item["name"]: item["value"] for item in json.load(options_file)}

missing = [name for name in ("glx", "glamor") if options.get(name) is not True]
if missing:
    raise SystemExit(
        "XWayland must be built with GLX and glamor enabled; disabled: "
        + ", ".join(missing)
    )
PY
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
if ! find "$OUTPUT_DIR/target/usr/lib" \( -type f -o -type l \) -name 'libepoxy.so*' -print -quit | grep -q .; then
  echo "libepoxy is missing from the target image; XWayland glamor cannot initialize." >&2
  exit 1
fi
LIBDRM_SOURCE_DIR="$(find "$OUTPUT_DIR/build" -maxdepth 1 -type d -name 'libdrm-*' -print -quit)"
LIBDRM_BUILD_OPTIONS=""
if [[ -n "$LIBDRM_SOURCE_DIR" ]]; then
  LIBDRM_BUILD_OPTIONS="$(find "$LIBDRM_SOURCE_DIR" -type f -path '*/meson-info/intro-buildoptions.json' -print -quit)"
fi
if [[ -z "$LIBDRM_BUILD_OPTIONS" ]]; then
  echo "libdrm Meson build options are missing; cannot verify VMware support." >&2
  exit 1
fi
python3 - "$LIBDRM_BUILD_OPTIONS" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as options_file:
    options = {item["name"]: item["value"] for item in json.load(options_file)}

if options.get("vmwgfx") != "enabled":
    raise SystemExit("libdrm must be built with vmwgfx support enabled.")
PY
if ! find "$OUTPUT_DIR/target/usr/lib" \( -type f -o -type l \) -name 'libdrm.so.2*' -print -quit | grep -q .; then
  echo "The libdrm runtime library required by Mesa's VMware driver is missing from the target image." >&2
  exit 1
fi
if [[ ! -f "$OUTPUT_DIR/target/etc/udev/rules.d/70-nbosp-device-groups.rules" ]]; then
  echo "DRM render and ALSA device access rules are missing from the target image." >&2
  exit 1
fi
if [[ ! -s "$OUTPUT_DIR/target/etc/ssl/certs/ca-certificates.crt" ]]; then
  echo "The public CA certificate bundle is missing from the target image." >&2
  exit 1
fi
if [[ ! -x "$OUTPUT_DIR/target/usr/bin/certutil" ]]; then
  echo "NSS certutil is missing from the target image; the kiosk cannot verify its local CA trust." >&2
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
for layout in us gb ca au de fr be es it pt br nl se no dk fi pl tr ru ua jp; do
  if [[ ! -f "$OUTPUT_DIR/target/usr/share/X11/xkb/symbols/$layout" ]]; then
    echo "XKB keyboard layout '$layout' is missing from the target image." >&2
    exit 1
  fi
done
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
