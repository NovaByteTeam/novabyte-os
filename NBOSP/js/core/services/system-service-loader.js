/**
 * Loads trusted system-service NovaApps into the OS page before the
 * OS boot sequence.
 */
(() => {
  'use strict';

  let loadPromise = null;
  const loadedServices = [];

  function decodePackageFile(encoded) {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async function loadService(service, bundle) {
    if (!service || typeof service.id !== 'string' ||
        !bundle || bundle.id !== service.id || bundle.systemService !== true ||
        typeof bundle.file !== 'string') {
      throw new Error('Invalid entry in system-service manifest');
    }

    const response = await fetch(bundle.file, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${service.id}: HTTP ${response.status}`);
    }
    const pkg = await response.json();
    const manifest = pkg?.manifest;
    const entry = manifest?.unrestrictedEntry;

    const scriptEntries = service.scripts ?? [entry];
    if (manifest?.id !== service.id || manifest?.system !== true ||
        manifest?.systemService !== true || entry !== service.entry ||
        !Array.isArray(scriptEntries) || scriptEntries.length === 0 ||
        scriptEntries[0] !== entry ||
        scriptEntries.some(scriptEntry =>
          typeof scriptEntry !== 'string' || typeof pkg.files?.[scriptEntry] !== 'string'
        )) {
      throw new Error(`Invalid system-service package: ${service.id}`);
    }

    if (typeof AppPackage?.verifyIntegrity !== 'function' ||
        !await AppPackage.verifyIntegrity(pkg)) {
      throw new Error(`Integrity verification failed for system service ${service.id}`);
    }

    const runtimeApp = {
      ...pkg,
      id: manifest.id,
      system: true,
      verified: true,
      signer: 'NovaByte System',
      source: 'system-bundle',
    };
    const result = await UnrestrictedGate.checkUnrestrictedApp(runtimeApp);
    if (!result.allowed) {
      throw new Error(`Trusted execution denied for ${service.id}: ${result.reason}`);
    }

    for (const scriptEntry of scriptEntries) {
      const script = document.createElement('script');
      script.dataset.novaSystemService = service.id;
      script.dataset.novaSystemServiceEntry = scriptEntry;
      script.textContent = decodePackageFile(pkg.files[scriptEntry]);
      let runtimeError = null;
      const onScriptError = event => {
        runtimeError = event.error || new Error(event.message || 'Unknown script error');
      };
      window.addEventListener('error', onScriptError, true);
      try {
        document.head.appendChild(script);
      } finally {
        window.removeEventListener('error', onScriptError, true);
        script.remove();
      }
      if (runtimeError) {
        throw new Error(`System service ${service.id} entry ${scriptEntry} failed during startup: ${runtimeError.message || runtimeError}`);
      }
    }
    loadedServices.push({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      icon: manifest.icon,
      permissions: manifest.permissions || [],
      optionalPermissions: manifest.optionalPermissions || [],
      manifest,
      system: true,
      verified: true,
      signer: 'NovaByte System',
      source: 'system-bundle',
      headlessSystemService: manifest.headless !== false,
    });
    console.info(`[SystemServiceLoader] Started ${service.id}`);
  }

  function showUnavailableServices(failures) {
    if (!failures.length) return;
    const banner = document.createElement('aside');
    banner.setAttribute('role', 'status');
    banner.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483646;display:flex;align-items:flex-start;gap:12px;max-width:min(720px,calc(100vw - 32px));padding:12px 16px;border:1px solid #8b6b2e;border-radius:8px;background:#292316;color:#fff;font:13px system-ui,sans-serif;box-shadow:0 4px 20px #0008';

    const message = document.createElement('span');
    message.textContent = `NovaByte started with ${failures.length} unavailable system service${failures.length === 1 ? '' : 's'}: ${failures.map(({ id }) => id).join(', ')}. See the console for details.`;
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss system service warning');
    dismiss.addEventListener('click', () => banner.remove());
    banner.append(message, dismiss);
    document.body.appendChild(banner);
  }

  async function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const failures = [];
      let requiredServiceFailed = false;
      try {
        const response = await fetch('js/apps/system-service-manifest.json', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Failed to fetch system-service manifest: HTTP ${response.status}`);
        }
        const services = await response.json();
        if (!Array.isArray(services)) {
          throw new Error('System-service manifest must be an array');
        }
        const bundleResponse = await fetch('js/apps/novaapp-manifest.json', { cache: 'no-store' });
        if (!bundleResponse.ok) {
          throw new Error(`Failed to fetch first-party app manifest: HTTP ${bundleResponse.status}`);
        }
        const bundles = await bundleResponse.json();
        if (!Array.isArray(bundles)) {
          throw new Error('First-party app manifest must be an array');
        }
        const bundlesById = new Map(bundles.map(bundle => [bundle?.id, bundle]));
        for (const service of services) {
          try {
            await loadService(service, bundlesById.get(service?.id));
          } catch (error) {
            const failure = { id: service?.id || '(invalid service entry)', error };
            failures.push(failure);
            console.error(`[SystemServiceLoader] Service unavailable: ${failure.id}`, error);
            if (service?.required === true) {
              requiredServiceFailed = true;
              break;
            }
          }
        }
      } catch (error) {
        failures.push({ id: 'system-service-manifest', error });
        console.error('[SystemServiceLoader] Could not load service manifests:', error);
        requiredServiceFailed = true;
      }

      if (requiredServiceFailed) {
        localStorage.setItem('nova_force_recovery', '1');
      }

      try {
        if (typeof window.boot === 'function') {
          await window.boot();
        } else {
          throw new Error('boot() is not defined');
        }
      } catch (error) {
        failures.push({ id: 'OS boot', error });
        console.error('[SystemServiceLoader] OS boot failed:', error);
      }

      showUnavailableServices(failures);
      return { failures: failures.map(({ id, error }) => ({ id, message: error?.message || String(error) })) };
    })();
    return loadPromise;
  }

  window.SystemServiceLoader = Object.freeze({
    load,
    listLoadedServices: () => loadedServices.map(service => ({ ...service })),
  });

  load().catch(error => console.error('[SystemServiceLoader] Unexpected loader failure:', error));
})();
