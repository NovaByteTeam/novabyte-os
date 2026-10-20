# NBOSP OS boot image

This milestone extends the working x86_64 Buildroot boot into a graphical
VMware kiosk: Linux DRM/KMS with the VMware SVGA driver, Mesa, Wayland, Cage,
and the Linux x64 NBOSP NW.js bundle launched fullscreen. The existing NBOSP
VFS and Files app are unchanged.

## Build on Linux or WSL2

Buildroot must be built on a Linux host. On Windows, use WSL2 with Ubuntu. Keep
the source tree in the WSL filesystem (for example, `~/src/novabyte-os`) rather
than under `/mnt/c` for better build performance and filesystem behavior.

Install the host dependencies:

```sh
sudo apt update
sudo apt install -y build-essential bc bison flex file wget cpio unzip rsync \
  python3 perl patch gzip bzip2 xz-utils libncurses-dev libelf-dev libssl-dev curl \
  grub-common grub-pc-bin grub-efi-amd64-bin xorriso mtools
```

From `NBOSP/os`, build the ISO:

```sh
bash build-iso.sh
```

The script downloads Buildroot 2025.02 once, configures the x86_64 target,
builds the Linux 6.12.18 kernel and compressed initramfs, and creates:

```text
NBOSP/os/output/images/nbosp-live.iso
```

Attach that ISO to a VMware x86_64 VM and boot it. The GRUB menu has a
three-second timeout; Linux writes to the virtual display and serial console.
The initial root filesystem is an in-memory initramfs, so this milestone does
not partition or modify a VM disk.

The manual GitHub Actions workflow runs `npm ci` in `NBOSP`, builds the Linux
x64 NW.js application, adjusts its window settings for fullscreen Wayland
kiosk mode, and installs the complete app bundle into the ISO at `/opt/nbosp`.
At boot, Buildroot starts Cage on the VMware display and launches NW.js as the
unprivileged `nbosp` user. The build uploads the ISO artifact
`nbosp-live-x86_64`; there is no separate NW.js artifact.

The kiosk user runs with the Linux account and device-group permissions, but
this is not yet per-`.novaapp` process isolation. The initramfs is still
ephemeral: files and app data are lost at shutdown. The tty2 console remains
available for debugging.

The workflow caches the Buildroot source/downloads and compiled output, along
with the NW.js SDK and npm cache, to speed up later manual runs. The local
Buildroot package is deliberately rebuilt each run to include the newly built
NW.js bundle.

## Current limitations

This image targets the VMware virtual SVGA device first. Graphics support for
other virtual machines or physical hardware has not been validated. NW.js,
Wayland, Cage, and their runtime libraries are compiled into the image, so the
ISO is significantly larger than the earlier console-only image.
