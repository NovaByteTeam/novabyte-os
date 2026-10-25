#!/bin/sh
# NM connection files must be owner-only readable or NM ignores them
chmod 600 "${TARGET_DIR}/etc/NetworkManager/system-connections/"*.nmconnection 2>/dev/null || true

# sudoers.d files must be 0440
chmod 440 "${TARGET_DIR}/etc/sudoers.d/nbosp" 2>/dev/null || true

# SELinux policy loading and initramfs labeling must happen before BusyBox init.
ln -sfn nbosp-init "${TARGET_DIR}/sbin/init"
ln -sfn sbin/nbosp-init "${TARGET_DIR}/init"
