#!/bin/sh
# NM connection files must be owner-only readable or NM ignores them
chmod 600 "${TARGET_DIR}/etc/NetworkManager/system-connections/"*.nmconnection 2>/dev/null || true

# sudoers.d files must be 0440
chmod 440 "${TARGET_DIR}/etc/sudoers.d/nbosp" 2>/dev/null || true

# SELinux policy loading and initramfs labeling must happen before BusyBox init.
INIT_APPLET="${TARGET_DIR}/sbin/init"
PRESERVED_INIT="${TARGET_DIR}/sbin/nbosp-busybox-init"

if [ -L "$INIT_APPLET" ] && [ "$(readlink "$INIT_APPLET")" = "nbosp-init" ]; then
	if [ ! -f "$PRESERVED_INIT" ] || [ -L "$PRESERVED_INIT" ]; then
		echo "Stale /sbin/init wrapper link found without a preserved BusyBox init applet." >&2
		exit 1
	fi
elif [ -x "$INIT_APPLET" ]; then
	cp -L "$INIT_APPLET" "$PRESERVED_INIT"
elif [ ! -f "$PRESERVED_INIT" ] || [ -L "$PRESERVED_INIT" ]; then
	echo "BusyBox init applet is missing; cannot install the SELinux init wrapper." >&2
	exit 1
fi

rm -f "$INIT_APPLET"
cp "$PRESERVED_INIT" "$INIT_APPLET"
chmod 0755 "$INIT_APPLET" "$PRESERVED_INIT"
ln -sfn sbin/nbosp-init "${TARGET_DIR}/init"
