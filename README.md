<div align="center">

<img src="./logo.svg" width="120" height="120" alt="NovaByte OS logo" />

# NovaByte OS

**A Linux-based kiosk operating system with an NW.js desktop.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-6b7280?style=flat-square)](https://www.apache.org/licenses/LICENSE-2.0)
[![No telemetry](https://img.shields.io/badge/Telemetry-None-22c55e?style=flat-square)](https://github.com/NovaByteTeam/novabyte-os/tree/main/NBOSP)

**NBOSP (NovaByte Open Source Project)** is a Linux-based operating system.
It uses the Linux kernel and a Buildroot-generated root filesystem, then starts
NovaByte's NW.js desktop in a fullscreen kiosk session. The experimental
bootable image currently targets x86_64 VMware virtual machines.

[Live site](https://novabyteteam.github.io/novabyte-os/) ·
[Build the Linux ISO](#build-the-linux-iso) ·
[NBOSP OS build guide](./NBOSP/os/README.md)

</div>

---

## What is in this repository?

- **`NBOSP/`** — the Linux OS userspace, NW.js kiosk desktop, local server,
  built-in apps, and tests. NBOSP is licensed under Apache 2.0.
- **`NBOSP/os/`** — the Buildroot configuration, board support, and packages
  used to make the experimental bootable Linux image.
- **`.github/workflows/nbosp-os-iso.yml`** — the manually triggered GitHub
  Actions workflow for producing the ISO.

The NW.js desktop provides the graphical shell: window management, files,
browser, settings, app management, and other built-in tools. Optional apps can
be packaged as `.novaapp` files. In the Linux image, user files and settings
are stored on the Linux filesystem.

## Develop NBOSP

The ISO is built on a Linux host (including WSL2). To run the NW.js desktop
from source while developing, install Node.js and npm, then run:

```sh
git clone https://github.com/NovaByteTeam/novabyte-os.git
cd novabyte-os/NBOSP
npm start
```

The `start` script bootstraps dependencies and app assets before opening the
NW.js desktop. The Linux OS image is built separately as described below. To
run the test suite, use:

```sh
npm test
```

## Build the Linux ISO

The ISO targets **x86_64 VMware virtual machines** and is experimental. It
uses Buildroot, the Linux kernel, Wayland, Cage, XWayland, and a bundled Linux
NW.js runtime to start NovaByte in fullscreen kiosk mode.

To build through GitHub Actions:

1. Open the repository's [Actions page](https://github.com/NovaByteTeam/novabyte-os/actions).
2. Select **Build NBOSP OS ISO** and choose **Run workflow**.
3. When the workflow succeeds, download the `nbosp-live-x86_64` artifact. It is
   retained for 14 days.

For local builds, use Linux or WSL2 with the source tree inside the Linux
filesystem (not `/mnt/c`). Install the host packages listed in
[`NBOSP/os/README.md`](./NBOSP/os/README.md), then run:

```sh
cd NBOSP/os
bash build-iso.sh
```

The ISO is written to `NBOSP/os/output/images/nbosp-live.iso`. See the OS
build guide for dependencies, boot troubleshooting, and installation details.

### Testing and persistence

Test the ISO in a disposable VMware VM. The live system runs from an
in-memory initramfs, so changes made during a live session are lost at
shutdown. For persistence, the desktop includes an installer that writes to a
selected disk. **The installer erases and repartitions that disk.** Use a
separate disposable virtual disk and verify the selected device before
confirming. Do not select a host or physical disk containing data you need.

The image is not yet validated for general physical hardware, other
hypervisors, or production use. For UEFI guests, disable Secure Boot because
the GRUB bootloader is unsigned.

## Apps and NovaByte Studio

Use [NovaByte Studio](https://github.com/NovaByteOfficial/novapack-studio) to
create and test `.novaapp` packages. Install apps only from sources you trust:
packages can contain executable code, and app-level isolation is not a
security boundary.

## Security

- The local desktop server uses HTTPS, CSRF protections, and rate limiting.
- Package signature and integrity indicators do not guarantee that an app is
  safe. Review package source and permissions before installing.
- The built-in file scanner uses heuristics; it is not antivirus and can miss
  malicious content.
- The kiosk's Linux account is unprivileged, but installed apps do not each
  run in a separate Linux security sandbox.

For a suspected vulnerability, contact the maintainer privately instead of
posting exploit details publicly.

## License

`NBOSP/` is licensed under Apache 2.0. See [`LICENSE`](./LICENSE) for the
license text and preserve the required copyright and license notices when
redistributing.
