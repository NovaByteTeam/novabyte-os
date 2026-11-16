(function (global) {
  'use strict';

  const COMMANDS = Object.freeze({
    nmcli: '/usr/bin/nmcli',
    bluetoothctl: '/usr/bin/bluetoothctl',
  });

  function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      require('child_process').execFile(
        command,
        args,
        {
          encoding: 'utf8',
          timeout: options.timeout ?? 15000,
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            // 2026-11-15: an ENOENT on the binary itself means the
            // management tool simply isn't installed — surface a clean,
            // human-readable message instead of Node's raw
            // "Command failed: /usr/bin/bluetoothctl show" string.
            if (error.code === 'ENOENT') {
              reject(new Error(`${command} is not available on this system.`));
              return;
            }
            const detail = String(stderr || stdout || error.message).trim();
            reject(new Error(detail || `${command} failed`));
            return;
          }
          resolve(String(stdout || '').trim());
        }
      );
    });
  }

  // 2026-11-15: pre-flight the bluetoothctl binary. Machines without it
  // (or runtimes where the path simply doesn't exist) used to surface the
  // raw exec error in the Settings Internet section. Probe once, cache,
  // and let getStatus()/actions report a clean "unavailable" state.
  const toolAvailability = new Map();
  function toolAvailable(command) {
    if (toolAvailability.has(command)) return toolAvailability.get(command);
    let available = false;
    try {
      available = Boolean(require('fs').existsSync(command));
    } catch (_) { available = false; }
    toolAvailability.set(command, available);
    return available;
  }

  function requireBluetoothTool() {
    if (!toolAvailable(COMMANDS.bluetoothctl)) {
      throw new Error('Bluetooth management is not available on this system.');
    }
  }

  function splitNmcliFields(line) {
    const fields = [];
    let current = '';
    let escaped = false;
    for (const char of line) {
      if (escaped) {
        current += char;
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === ':') {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    if (escaped) current += '\\';
    fields.push(current);
    return fields;
  }

  function parseWifiRows(output) {
    const networks = new Map();
    for (const line of String(output || '').split(/\r?\n/)) {
      if (!line) continue;
      const [ssid, rawSignal, security] = splitNmcliFields(line);
      if (!ssid) continue;
      const signal = Number(rawSignal);
      const existing = networks.get(ssid);
      if (!existing || signal > existing.signal) {
        networks.set(ssid, {
          ssid,
          signal: Number.isFinite(signal) ? signal : 0,
          security: !security || security === '--' ? 'Open' : security,
        });
      }
    }
    return [...networks.values()].sort((a, b) => b.signal - a.signal || a.ssid.localeCompare(b.ssid));
  }

  function parseBluetoothDevices(output) {
    const devices = new Map();
    const pattern = /^Device\s+([0-9A-F]{2}(?::[0-9A-F]{2}){5})\s*(.*)$/i;
    for (const line of String(output || '').split(/\r?\n/)) {
      const match = pattern.exec(line.trim());
      if (!match) continue;
      devices.set(match[1].toUpperCase(), {
        address: match[1].toUpperCase(),
        name: match[2] || 'Unknown device',
      });
    }
    return [...devices.values()];
  }

  function validateBluetoothAddress(address) {
    const normalized = String(address || '').toUpperCase();
    return /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(normalized) ? normalized : null;
  }

  function isLinux() {
    return typeof process !== 'undefined' && process.platform === 'linux';
  }

  async function getStatus() {
    if (!isLinux()) {
      return { supported: false, reason: 'Connectivity controls are available in NBOSP Linux.' };
    }
    // 2026-11-15: when bluetoothctl is missing, do not even spawn it — a
    // clean "unavailable" state (bluetoothEnabled: null, no bluetoothError)
    // renders as the existing "Bluetooth unavailable" toggle instead of an
    // error-styled command failure line.
    const bluetoothReady = toolAvailable(COMMANDS.bluetoothctl);
    const bluetoothProbe = bluetoothReady
      ? run(COMMANDS.bluetoothctl, ['show'])
      : Promise.reject(new Error('Bluetooth management is not available on this system.'));
    const [general, networking, wifiRadio, bluetoothOutput] = await Promise.allSettled([
      run(COMMANDS.nmcli, ['-t', '-f', 'STATE,CONNECTIVITY', 'general']),
      run(COMMANDS.nmcli, ['-t', '-f', 'NETWORKING', 'general']),
      run(COMMANDS.nmcli, ['radio', 'wifi']),
      bluetoothProbe,
    ]);

    const network = general.status === 'fulfilled'
      ? splitNmcliFields(general.value)
      : null;
    const wifiEnabled = wifiRadio.status === 'fulfilled'
      ? wifiRadio.value.toLowerCase() === 'enabled'
      : null;
    const bluetoothMatch = bluetoothOutput.status === 'fulfilled'
      ? /^\s*Powered:\s*(yes|no)\s*$/im.exec(bluetoothOutput.value)
      : null;

    return {
      supported: true,
      networkState: network?.[0] || 'unknown',
      connectivity: network?.[1] || 'unknown',
      networkEnabled: networking.status === 'fulfilled'
        ? networking.value.toLowerCase() === 'enabled'
        : null,
      wifiEnabled,
      bluetoothEnabled: bluetoothMatch ? bluetoothMatch[1].toLowerCase() === 'yes' : null,
      bluetoothAvailable: bluetoothReady,
      wifiError: wifiRadio.status === 'rejected' ? wifiRadio.reason.message : null,
      bluetoothError: (bluetoothReady && bluetoothOutput.status === 'rejected') ? bluetoothOutput.reason.message : null,
    };
  }

  async function getWifiNetworks() {
    const output = await run(COMMANDS.nmcli, [
      '-t', '--escape', 'yes', '-f', 'SSID,SIGNAL,SECURITY',
      'device', 'wifi', 'list', '--rescan', 'yes',
    ], { timeout: 25000 });
    return parseWifiRows(output);
  }

  async function setWifiEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Wi-Fi state must be a boolean');
    await run(COMMANDS.nmcli, ['radio', 'wifi', enabled ? 'on' : 'off']);
  }

  async function setNetworkingEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Network state must be a boolean');
    await run(COMMANDS.nmcli, ['networking', enabled ? 'on' : 'off']);
  }

  async function connectWifi(ssid, password) {
    if (typeof ssid !== 'string' || !ssid || ssid.length > 32) {
      throw new TypeError('Choose a valid Wi-Fi network');
    }
    if (typeof password !== 'string' || password.length > 128) {
      throw new TypeError('Enter a valid Wi-Fi password');
    }
    const args = ['device', 'wifi', 'connect', ssid];
    if (password) args.push('password', password);
    return run(COMMANDS.nmcli, args, { timeout: 60000 });
  }

  async function disconnectWifi() {
    const output = await run(COMMANDS.nmcli, [
      '-t', '--escape', 'yes', '-f', 'DEVICE,TYPE', 'device', 'status',
    ]);
    const wifiDevice = output.split(/\r?\n/)
      .map(splitNmcliFields)
      .find((fields) => fields[1] === 'wifi')?.[0];
    if (!wifiDevice) throw new Error('No Wi-Fi adapter is available');
    return run(COMMANDS.nmcli, ['device', 'disconnect', wifiDevice]);
  }

  async function setBluetoothEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Bluetooth state must be a boolean');
    requireBluetoothTool();
    return run(COMMANDS.bluetoothctl, ['power', enabled ? 'on' : 'off']);
  }

  async function scanBluetooth() {
    requireBluetoothTool();
    await run(COMMANDS.bluetoothctl, ['--timeout', '12', 'scan', 'on'], { timeout: 20000 });
    const [allOutput, pairedOutput, connectedOutput] = await Promise.all([
      run(COMMANDS.bluetoothctl, ['devices']),
      run(COMMANDS.bluetoothctl, ['devices', 'Paired']),
      run(COMMANDS.bluetoothctl, ['devices', 'Connected']),
    ]);
    const paired = new Set(parseBluetoothDevices(pairedOutput).map((device) => device.address));
    const connected = new Set(parseBluetoothDevices(connectedOutput).map((device) => device.address));
    return parseBluetoothDevices(allOutput).map((device) => ({
      ...device,
      paired: paired.has(device.address),
      connected: connected.has(device.address),
    }));
  }

  async function pairBluetooth(address) {
    requireBluetoothTool();
    const deviceAddress = validateBluetoothAddress(address);
    if (!deviceAddress) throw new TypeError('Invalid Bluetooth device address');
    return run(COMMANDS.bluetoothctl, [
      '--timeout', '35', '--agent', 'NoInputNoOutput', 'pair', deviceAddress,
    ], { timeout: 40000 });
  }

  async function connectBluetooth(address) {
    requireBluetoothTool();
    const deviceAddress = validateBluetoothAddress(address);
    if (!deviceAddress) throw new TypeError('Invalid Bluetooth device address');
    return run(COMMANDS.bluetoothctl, ['connect', deviceAddress], { timeout: 30000 });
  }

  async function disconnectBluetooth(address) {
    requireBluetoothTool();
    const deviceAddress = validateBluetoothAddress(address);
    if (!deviceAddress) throw new TypeError('Invalid Bluetooth device address');
    return run(COMMANDS.bluetoothctl, ['disconnect', deviceAddress]);
  }

  async function forgetBluetooth(address) {
    requireBluetoothTool();
    const deviceAddress = validateBluetoothAddress(address);
    if (!deviceAddress) throw new TypeError('Invalid Bluetooth device address');
    return run(COMMANDS.bluetoothctl, ['remove', deviceAddress]);
  }

  const api = Object.freeze({
    getStatus,
    getWifiNetworks,
    setNetworkingEnabled,
    setWifiEnabled,
    connectWifi,
    disconnectWifi,
    setBluetoothEnabled,
    scanBluetooth,
    pairBluetooth,
    connectBluetooth,
    disconnectBluetooth,
    forgetBluetooth,
    parseWifiRows,
    parseBluetoothDevices,
    validateBluetoothAddress,
  });
  global.NovaConnectivity = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
