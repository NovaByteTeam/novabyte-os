(function () {
  'use strict';

  const APP_ID = 'com.nbosp.install';
  const INSTALLER = '/usr/bin/nbosp-install';

  function formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
  }

  function listDisks() {
    const fs = require('fs');
    const names = fs.readdirSync('/sys/block')
      .filter(name => /^(sd[a-z]|vd[a-z]|nvme\d+n\d+|mmcblk\d+)$/.test(name));

    return names.flatMap(name => {
      const device = `/dev/${name}`;
      try {
        if (!fs.statSync(device).isBlockDevice()) return [];
        const sectors = Number(fs.readFileSync(`/sys/block/${name}/size`, 'utf8').trim());
        if (!Number.isSafeInteger(sectors) || sectors <= 0) return [];
        const modelPath = `/sys/block/${name}/device/model`;
        let model = '';
        try {
          model = fs.readFileSync(modelPath, 'utf8').trim().replace(/\s+/g, ' ');
        } catch (error) {
          if (error.code !== 'ENOENT') {
            console.warn(`[Install NovaByte] Could not read the model for ${device}:`, error);
          }
        }
        return [{ device, model, size: sectors * 512 }];
      } catch (error) {
        console.error(`[Install NovaByte] Could not inspect ${device}:`, error);
        return [];
      }
    });
  }

  async function removeInstallerDesktopShortcut() {
    const desktopFolder = FS.specialFolders?.desktop;
    if (!desktopFolder) throw new Error('The desktop folder is unavailable.');

    const iconPositions = OS.settings.get('desktopIconPositions') || {};
    let removed = 0;
    for (const file of FS.listDir(desktopFolder)) {
      if (!file.name.endsWith('.lnk') || file.mimeType !== 'application/x-app-shortcut') continue;
      let shortcut;
      try {
        shortcut = JSON.parse(file.content || '{}');
      } catch {
        continue;
      }
      if (shortcut?.type !== 'app-shortcut' || shortcut?.target !== APP_ID) continue;
      await FS.permanentDelete(file.id);
      delete iconPositions[`file:${file.id}`];
      removed++;
    }

    OS.settings.set('desktopIconPositions', iconPositions);
    if (typeof renderDesktopIcons === 'function') renderDesktopIcons();
    return removed;
  }

  registerApp({
    id: APP_ID,
    name: 'Install NovaByte',
    icon: 'hard-drive',
    version: '3.0.2',
    description: 'Install NovaByte OS to a selected disk.',
    defaultSize: [680, 520],
    minSize: [520, 420],
    init(content) {
      content.replaceChildren();
      if (typeof process === 'undefined' || process.platform !== 'linux') {
        content.textContent = 'Disk installation is available only in the NBOSP Linux image.';
        return;
      }
      Object.assign(content.style, {
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        padding: '24px',
        height: '100%',
        color: 'var(--text-primary)',
        fontFamily: 'var(--font-ui, sans-serif)'
      });

      const title = createEl('h1', {
        textContent: 'Install NovaByte OS',
        style: 'font-size:22px;margin:0'
      });
      const description = createEl('p', {
        textContent: 'Choose a disk to install the live system onto. The installer creates a bootable disk for both VMware BIOS and UEFI firmware.',
        style: 'margin:0;line-height:1.5;color:var(--text-muted)'
      });
      const warning = createEl('div', {
        textContent: 'Warning: every partition and file on the selected disk will be permanently erased.',
        style: 'padding:12px;border:1px solid var(--text-danger,#f85149);border-radius:8px;color:var(--text-danger,#f85149);font-weight:600'
      });
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Installation disk');
      Object.assign(select.style, {
        padding: '10px',
        color: 'var(--text-primary)',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: '6px'
      });
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Select a disk';
      select.appendChild(placeholder);

      let disks = [];
      try {
        disks = listDisks();
      } catch (error) {
        console.error('[Install NovaByte] Disk discovery failed:', error);
      }
      for (const disk of disks) {
        const option = document.createElement('option');
        option.value = disk.device;
        option.textContent = `${disk.device}${disk.model ? ` — ${disk.model}` : ''} (${formatSize(disk.size)})`;
        select.appendChild(option);
      }
      if (!disks.length) {
        placeholder.textContent = 'No supported disks found';
        select.disabled = true;
      }

      const installButton = createEl('button', {
        textContent: 'Install to disk…',
        style: 'align-self:flex-start;padding:10px 18px;border:0;border-radius:6px;background:var(--accent);color:#fff;font-weight:600;cursor:pointer'
      });
      installButton.disabled = !disks.length;
      const status = createEl('div', {
        textContent: 'No changes will be made until you confirm the exact disk name.',
        style: 'color:var(--text-muted);line-height:1.45'
      });
      const output = createEl('pre', {
        style: 'box-sizing:border-box;flex:1;min-height:80px;overflow:auto;margin:0;padding:12px;border-radius:6px;background:var(--bg-secondary);white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace'
      });

      const appendOutput = text => {
        output.textContent = `${output.textContent}${text}`.slice(-16000);
        output.scrollTop = output.scrollHeight;
      };

      installButton.addEventListener('click', async () => {
        const device = select.value;
        if (!disks.some(disk => disk.device === device)) {
          Notify.show({ title: 'Choose a disk', body: 'Select a supported installation disk first.', type: 'warning', appName: 'Install NovaByte' });
          return;
        }

        const body = document.createElement('div');
        body.appendChild(createEl('p', {
          textContent: `This will erase all data on ${device}. Type ERASE ${device} to confirm.`,
          style: 'line-height:1.5'
        }));
        const confirmation = document.createElement('input');
        confirmation.type = 'text';
        confirmation.autocomplete = 'off';
        confirmation.spellcheck = false;
        confirmation.setAttribute('aria-label', `Type ERASE ${device} to confirm`);
        confirmation.placeholder = `ERASE ${device}`;
        Object.assign(confirmation.style, {
          boxSizing: 'border-box',
          width: '100%',
          padding: '10px',
          color: 'var(--text-primary)',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: '6px'
        });
        body.appendChild(confirmation);

        const confirmationModal = showModal(
          'Confirm disk erasure',
          body,
          [
            { label: 'Cancel' },
            { label: 'Erase and install', danger: true, value: 'install' }
          ]
        );
        confirmation.focus();
        const action = await confirmationModal;
        if (action !== 'install') return;
        if (confirmation.value.trim() !== `ERASE ${device}`) {
          Notify.show({ title: 'Confirmation did not match', body: `Type ERASE ${device} exactly to continue.`, type: 'error', appName: 'Install NovaByte' });
          return;
        }

        installButton.disabled = true;
        select.disabled = true;
        status.textContent = `Installing to ${device}. Do not power off the VM.`;
        output.textContent = '';

        let finished = false;
        const childProcess = require('child_process');
        let child;
        try {
          child = childProcess.spawn(INSTALLER, [device, `ERASE:${device}`], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
          status.textContent = 'The installer could not be started.';
          appendOutput(`${error.message}\n`);
          installButton.disabled = false;
          select.disabled = false;
          return;
        }

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', appendOutput);
        child.stderr.on('data', appendOutput);
        child.on('error', error => {
          if (finished) return;
          finished = true;
          console.error('[Install NovaByte] Installer process failed:', error);
          status.textContent = 'Installation failed. The disk may have been changed; review the output before retrying.';
          appendOutput(`${error.message}\n`);
          installButton.disabled = false;
          select.disabled = false;
        });
        child.on('close', async code => {
          if (finished) return;
          finished = true;
          if (code !== 0) {
            status.textContent = `Installation failed with exit code ${code ?? 'unknown'}. The disk may have been changed; review the output before retrying.`;
            installButton.disabled = false;
            select.disabled = false;
            return;
          }
          status.textContent = `NovaByte was installed to ${device}. You can restart from the launchpad when ready.`;
          try {
            await removeInstallerDesktopShortcut();
          } catch (error) {
            console.error('[Install NovaByte] Could not remove its desktop shortcut:', error);
            status.textContent = `NovaByte was installed to ${device}, but its desktop shortcut could not be removed. You can remove it manually from the desktop.`;
            Notify.show({
              title: 'Desktop shortcut cleanup failed',
              body: error?.message || String(error),
              type: 'warning',
              appName: 'Install NovaByte'
            });
          }
          Notify.show({ title: 'Installation complete', body: `NovaByte is installed to ${device}. Restart the VM to boot from it.`, type: 'success', appName: 'Install NovaByte' });
        });
      });

      content.append(title, description, warning, select, installButton, status, output);
    }
  });
})();
