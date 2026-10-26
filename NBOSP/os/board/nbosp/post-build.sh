#!/bin/sh
# NM connection files must be owner-only readable or NM ignores them
chmod 600 "${TARGET_DIR}/etc/NetworkManager/system-connections/"*.nmconnection 2>/dev/null || true

# sudoers.d files must be 0440
chmod 440 "${TARGET_DIR}/etc/sudoers.d/nbosp" 2>/dev/null || true

# SELinux policy loading and initramfs labeling must happen before BusyBox init.
if [ ! -x "${TARGET_DIR}/sbin/init" ]; then
	echo "BusyBox init applet is missing; cannot install the SELinux init wrapper." >&2
	exit 1
fi
cp -L "${TARGET_DIR}/sbin/init" "${TARGET_DIR}/sbin/nbosp-busybox-init"
chmod 0755 "${TARGET_DIR}/sbin/nbosp-busybox-init"
ln -sfn sbin/nbosp-init "${TARGET_DIR}/init"
