#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

# NM connection files must be owner-only readable or NM ignores them
chmod 600 "${TARGET_DIR}/etc/NetworkManager/system-connections/"*.nmconnection 2>/dev/null || true

# sudoers.d files must be 0440
chmod 440 "${TARGET_DIR}/etc/sudoers.d/nbosp" 2>/dev/null || true

# Keep startup files current even when Buildroot reuses a cached target tree.
install -D -m 0644 "${SCRIPT_DIR}/rootfs-overlay/etc/inittab" \
	"${TARGET_DIR}/etc/inittab"
install -D -m 0755 "${SCRIPT_DIR}/rootfs-overlay/etc/init.d/rcS" \
	"${TARGET_DIR}/etc/init.d/rcS"
install -D -m 0755 "${SCRIPT_DIR}/rootfs-overlay/etc/init.d/rcK" \
	"${TARGET_DIR}/etc/init.d/rcK"
sed -i 's/\r$//' \
	"${TARGET_DIR}/etc/inittab" \
	"${TARGET_DIR}/etc/init.d/rcS" \
	"${TARGET_DIR}/etc/init.d/rcK"

# SELinux policy loading and initramfs labeling must happen before BusyBox init.
INIT_APPLET="${TARGET_DIR}/sbin/init"
PRESERVED_INIT="${TARGET_DIR}/sbin/nbosp-busybox-init"
INIT_WRAPPER="${TARGET_DIR}/sbin/nbosp-init"

if [ -L "$INIT_APPLET" ] && [ "$(readlink "$INIT_APPLET")" = "nbosp-init" ]; then
	echo "Stale /sbin/init wrapper link remains; BusyBox must be reinstalled before applying the init wrapper." >&2
	exit 1
fi
if [ ! -x "$INIT_APPLET" ]; then
	echo "BusyBox init applet is missing; cannot install the SELinux init wrapper." >&2
	exit 1
fi

cp -L "$INIT_APPLET" "$PRESERVED_INIT"
if cmp -s "$PRESERVED_INIT" "$INIT_WRAPPER"; then
	echo "Preserved BusyBox init is the SELinux wrapper, not the BusyBox init applet." >&2
	exit 1
fi
chmod 0755 "$PRESERVED_INIT"
ln -sfn sbin/nbosp-init "${TARGET_DIR}/init"
