# NBOSP OS boot image

This milestone extends the working x86_64 Buildroot boot into a graphical
VMware kiosk: Linux DRM/KMS with the VMware SVGA driver, Mesa, Wayland, Cage,
and the Linux x64 NBOSP NW.js bundle launched fullscreen. On Linux, Files browses the host filesystem directly, can list ISO contents,
and can launch executable files as the unprivileged kiosk user after
confirmation. The shared filesystem API maps to the kiosk user's real home
directory, app data and package blobs are stored under
`~/.local/share/novabyte`, settings use `~/.config/novabyte/settings.json`, and
browser-origin state is mirrored to the native filesystem. First boot imports
legacy VFS, OPFS, and IndexedDB data when available; the browser-backed
filesystem remains only for non-Linux builds and that one-time migration.

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
builds the Linux 6.12.18 kernel, compressed live initramfs, and a root
filesystem archive for the installer, and creates:

```text
NBOSP/os/output/images/nbosp-live.iso
```

Attach that ISO to a VMware x86_64 VM and boot it. The GRUB menu has a
three-second timeout; Linux writes to the virtual display and serial console.
The live root filesystem is an in-memory initramfs, so live-session changes
are temporary until you install NovaByte to a VM disk.

## Installing to a VM disk

The launchpad includes **Install NovaByte**. Add a separate virtual hard disk
to the test VM, start the live ISO, select that disk in the installer, and
type the exact confirmation shown (for example, `ERASE /dev/sda`) before it
will proceed. The installer erases every partition on the selected disk,
creates a GPT layout, and installs BIOS and UEFI bootloaders. It checks that
the selected disk and its partitions are not mounted. Do not select a disk
containing data you need; the erase is irreversible.
The installed GRUB entry passes the root partition's GPT `PARTUUID` directly
to Linux, so the kernel can locate the ext4 root filesystem without an
initramfs.
For UEFI guests, disable Secure Boot; the installed GRUB loader is not signed.

After a successful installation, the app removes its own desktop shortcut;
any taskbar pin is left unchanged. Restart through the launchpad's power
controls, then remove the live ISO or change the VM boot order so it starts
from the installed disk. The installed root filesystem is writable and keeps
the user's home directory and NW.js profile across normal reboots. It does
not copy data from the temporary live session into the installed system.

This installer is designed for x86_64 VMware BIOS and UEFI guests. It has not
yet been validated in VMware or against physical disks; use a disposable VM
with a separate test disk until that verification is complete. Open VM Tools
is built into the image, so installing a separate VMware Tools ISO inside the
guest is unnecessary.
The launcher exposes restart and power-off controls through a dedicated
root-owned helper that accepts only those two actions; it does not provide
general root command execution.
**Wipe All Data** and Recovery's **Factory Reset** clear the contents of
`/home/nbosp` and restart the system, removing user files, settings, installed
app data, runtime state, and the NW.js profile. They preserve the installed
system under `/opt/nbosp` and do not repartition or reinstall the disk. Use the
installer to replace the operating system itself.

If boot reaches the console but the kiosk reports a missing VMware DRM device,
use a newly built ISO with `CONFIG_DRM_VMWGFX=y` and ensure the VM has a
connected virtual display. The kernel also includes VMware-compatible
`e1000`, `e1000e`, and `vmxnet3` network drivers for the VM's virtual NIC.
The boot command line keeps the VMware `e1000` interface named `eth0` for
Buildroot DHCP and makes the serial console the userspace console so init and
kiosk startup messages are captured by a configured VMware serial port.

The manual GitHub Actions workflow runs `npm ci` in `NBOSP`, builds the Linux
x64 NW.js application, adjusts its window settings for fullscreen Cage kiosk
mode using XWayland, and installs the complete app bundle into the ISO at
`/opt/nbosp`.
The application build uses the same pinned NW.js SDK version as the `nw`
package instead of tracking `latest`, keeping the runtime, SDK, and optional
FFmpeg binary release in sync. Browser downloads use NW.js's Downloads API,
save into the user's Downloads folder, and appear in the Downloads app with
progress and completion status.
At boot, Buildroot starts Cage on the VMware display and launches NW.js as the
unprivileged `nbosp` user. Cage and NW.js output is appended to
`/home/nbosp/nbosp-kiosk.log` and mirrored to the configured `ttyS0` serial
console for debugging without switching virtual terminals. The kiosk is
started inside a fresh D-Bus session to avoid inheriting a malformed session
bus address. The NW.js bundle remains root-owned. Mutable runtime state,
including generated secrets, TLS certificates, server logs, and SQLite data,
is stored under `/home/nbosp/.config/novabyte/runtime`. User settings and
profile data are stored under `/home/nbosp`. Cage runs the compositor on Wayland and
XWayland is enabled for NW.js, retaining GPU acceleration while avoiding the
Chromium native-Wayland DMA-BUF import failure observed with VMware SVGA.
The image enables Mesa's VMware SVGA Gallium driver and X11/GLX support for
NW.js running through XWayland; Chromium is configured to use desktop OpenGL,
GPU rasterization, and zero-copy buffers. The kiosk account belongs to the
`render` group, and udev assigns render nodes to that group. Before starting
the browser, the service verifies that `nbosp` can read and write a DRM render
node rather than silently accepting the software-rendering fallback.
libepoxy is included so Buildroot enables XWayland's glamor path as well as
GLX. The ISO build verifies XWayland's configured Meson options, not just the
presence of GL libraries, before producing the image.
Mesa GBM is enabled explicitly as well, since XWayland's glamor path needs it
to initialize accelerated rendering. The ISO build verifies that `libgbm`
ships in the target image.
Xorg protocol headers are enabled explicitly because Mesa's GLX client build
requires `GL/glxproto.h`. libglvnd provides the standard `libGL.so.1` dispatch
library; the image build verifies that it is present alongside Mesa's GLX
library and SVGA DRI driver. XWayland's GLX server also needs Mesa's
`GL/internal/dri_interface.h`; the build stages that private header from the
matching Mesa source into the toolchain sysroot before compiling XWayland.
In VMware, enable **Accelerate 3D graphics** for the VM. The image build checks
for XWayland GLX/glamor, Mesa GBM, libepoxy, and the VMware SVGA driver; still
confirm Chromium's actual renderer from its GPU log in the VM.
The image also includes ALSA HDA and Ensoniq ES1371 drivers, ALSA utilities,
and initializes the mixer at kiosk startup. The kiosk user is in the `audio`
group, which udev grants access to sound devices. For VMware audio, add or
enable a virtual sound card and select **Connect at power on**. The attached
log's HDA controller times out while probing codecs; that means the guest did
not receive a responding audio codec, which cannot be repaired by ALSA mixer
settings alone. With no detected card, startup logs a specific warning instead
of claiming audio is ready.
NovaByte's built-in HTML select controls open an in-page listbox instead of
Chromium's native popup, avoiding popup-positioning differences in the
XWayland kiosk. Select controls rendered inside external websites in the
Browser app remain managed by Chromium.
The Display Scale setting is passed to NW.js/Chromium with
`--force-device-scale-factor`, which scales the complete NovaByte UI. Changing
the setting requires restarting the system from the launchpad; it does not
alter the display mode or scale other Wayland clients.
The Date and Region settings also include a keyboard layout selector. The
selected XKB layout is saved for the `nbosp` user and passed to Cage on its
next start, so restart NovaByte OS after changing it. The ISO build verifies
that every offered layout is included in the image.
Settings includes a Connectivity section backed by NetworkManager/wpa_supplicant
for Ethernet and Wi-Fi and BlueZ for Bluetooth scanning and pairing. Network
control is authorized for the dedicated `nbosp` kiosk account through a
Polkit rule scoped to network-management and Bluetooth device actions. VMware
exposes virtual Ethernet by default; Wi-Fi and Bluetooth require suitable
guest-visible adapters, kernel drivers, and any firmware those adapters need.
The ISO includes common wireless kernel drivers and selected Intel Wi-Fi
firmware, but does not bundle firmware for every vendor or model.
The image includes the public CA bundle so Chromium and Node can validate
external HTTPS sites. At each Linux kiosk start, NovaByte refreshes its local
CA entry in the kiosk user's NSS database and verifies the imported certificate
and SSL trust flags against the CA used by the server. NW.js retains
`--allow-insecure-localhost` as a localhost-only fallback; broad certificate
verification bypasses remain disabled.
DejaVu Sans/Mono and Noto Color Emoji fonts and Fontconfig are included so
Chromium and the UI can render text and emoji without downloading fonts at
runtime. The emoji font is pinned to a Noto Emoji source revision and its OFL
license is included in the image. The Whiteglass Xcursor theme is included,
and Cage uses a software-rendered cursor to avoid invisible hardware cursors
in VMware.
The image build keeps Buildroot's cached kernel and graphics outputs. It
clean-rebuilds Mesa, libglvnd, and XWayland only when the graphics configuration
signature changes, and checks that `libGL.so.1`, Mesa's `vmwgfx_dri.so` SVGA
driver, and GLX library are present.
CI first opens a minimal NW.js app under Xvfb, then checks Node access and the
`better-sqlite3` native module before starting the Buildroot build. The image
does not build a separate Node.js package. The build uploads the ISO artifact
`nbosp-live-x86_64`; there is no separate NW.js artifact.

The kiosk user runs with the Linux account and device-group permissions, but
this is not yet per-`.novaapp` process isolation. The live initramfs remains
ephemeral: files and app data are lost at shutdown unless you use the disk
installer. The tty2 console remains available for debugging.
The VMware Open VM Tools guest daemon and its resolution helper are included;
installing a separate Tools ISO inside the guest is unnecessary.
The kernel command line explicitly selects the SRSO `safe-ret` mitigation.
The guest cannot provide the host CPU microcode required for the additional
IBPB protection. If the host CPU is affected, update its BIOS/UEFI firmware
and VMware, then fully power off and cold-start the VM. The guest may continue
to report `Vulnerable: Safe RET, no microcode` when the host does not expose
the required microcode; do not disable the kernel mitigation to hide that
status.

The workflow caches the Buildroot source/downloads and compiled output, along
with the NW.js SDK and npm cache, to speed up later manual runs. The local
Buildroot package is deliberately rebuilt each run to include the newly built
NW.js bundle.

## Current limitations

This image targets the VMware virtual SVGA device first. Graphics support for
other virtual machines or physical hardware has not been validated. NW.js,
Wayland, Cage, and their runtime libraries are compiled into the image, so the
ISO is significantly larger than the earlier console-only image.
