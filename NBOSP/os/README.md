# NBOSP OS boot image

This is the first OS milestone: a minimal x86_64 Buildroot system that boots
Linux and BusyBox to a console from a BIOS- and UEFI-bootable ISO. It does not
start the NBOSP NW.js application yet. The existing NBOSP VFS and Files app are
unchanged; replacing them with the Linux filesystem is a separate later task.

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
builds the Linux 6.12.18 kernel and compressed initramfs, then creates:

```text
NBOSP/os/output/images/nbosp-live.iso
```

Attach that ISO to a VMware x86_64 VM and boot it. The GRUB menu has a
three-second timeout; Linux writes to the virtual display and serial console.
The initial root filesystem is an in-memory initramfs, so this milestone does
not partition or modify a VM disk.

The GitHub Actions workflow also runs `npm ci` in `NBOSP`, builds the existing
Linux x64 NW.js application with `build.mjs`, and uploads that app (including
its production dependencies and NW.js runtime) as a separate workflow
artifact. For now it is built alongside the boot ISO, not launched during
boot; kiosk/Wayland integration is a later milestone.

The workflow caches the Buildroot source/downloads and compiled output, along
with the NW.js SDK and npm cache, to speed up later manual runs. The first
successful Buildroot run still needs to compile the toolchain and kernel.

## Next milestone

After confirming reliable boot, add VMware-compatible DRM graphics, Wayland,
and Cage, then package and launch the Linux NBOSP app. The live root filesystem
and ISO arrangement can be revised when persistent storage is introduced.
