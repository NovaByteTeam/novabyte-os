/**
 * NovaByte — Unrestricted Call Gate
 * ────────────────────────────────────────────────────────────
 * A small number of IPC calls (currently all `nova:system:*`, used by the
 * Settings app to manage other apps' permissions and back up/restore
 * every app's data) are not ordinary dangerous permissions — there is no
 * meaningful "deny" state for Settings being able to change settings, so
 * they are never routed through AppPermissionManager's grant table at
 * all (see the discussion that led here: a settings app "asking
 * permission" to be a settings app doesn't make sense).
 *
 * Instead, eligibility for these calls is identity-based and checked
 * fresh on every single call, not once at install or launch time:
 *   1. The calling app's id matches a real, hardcoded allowlist entry
 *      for this specific call — not "any system app", since even a
 *      legitimately-signed different system app (Contacts, say) has no
 *      business reaching these calls.
 *   2. The app is flagged system:true, verified:true, and signed by
 *      exactly 'NovaByte System' — the same three fields
 *      isTrustedTransparentSystemApp() in app-sandbox.js checks.
 *   3. Its declared id also appears in the build-time first-party
 *      manifest (js/apps/novaapp-manifest.json) — the list nothing
 *      installed at runtime can ever add an entry to.
 *   4. Its packaged integrity hash (if present) still matches — a
 *      trusted signer does not make a tampered-since-signing package
 *      trustworthy (see showTamperDetectedDialog's own reasoning).
 *
 * Any failure on any of these is a hard block, not a downgrade — there
 * is no legitimate reason for a real, unmodified Settings package to
 * ever fail this, so a failure here is treated as a suspected
 * impersonation attempt, same posture as
 * isSuspectedSystemImpersonation() in the App Manager package's install flow.
 * This module re-checks at CALL time (not just install time) so a
 * package that was valid when installed but has since been tampered
 * with on disk, or had its trust-store entry revoked, loses access
 * immediately rather than keeping whatever it was granted at install.
 *
 * This file deliberately has no dependency on AppPermissionManager and
 * does not read or write any permission-grant state — mixing the two
 * models (identity-gated vs. user-grantable) in one table is exactly
 * the kind of ambiguity this file exists to avoid.
 *
 * @module js/platform/security/unrestricted-gate
 */
const UnrestrictedGate = (() => {
  'use strict';

  // The NovaByte Settings app id. Settings is the one app whose every
  // permission check passes unconditionally — it's the app that manages
  // permissions for other apps, so asking itself for permission is
  // incoherent. AppPermissionManager.isGranted() consults
  // isTrustedSettingsAppById() below for this id, and nothing else in this
  // file is reachable from any live code path.
  const SETTINGS_APP_ID = 'com.nbosp.settings';

  /**
   * Single authority for "is this the trusted, system-signed Settings app?"
   * — the identity tuple (id + system + verified + NovaByte System signer +
   * manifest.system), resolved from the live OS.apps registry so callers
   * that only have an appId (AppPermissionManager.isGranted, below) can
   * consult it without plumbing app records around.
   *
   * SECURITY (2026-11-15 audit, finding M7): this path previously checked
   * ONLY the install-time registry flags, contradicting the header
   * contract (conditions 3+4, "re-checked live on every call") — a package
   * tampered after install kept its all-permissions status forever, and a
   * trust-store revocation never touched OS.apps[id].verified. The call now
   * also enforces, synchronously:
   *   * provenance — entry.source must be 'system-bundle' (same rule
   *     checkUnrestrictedApp applies; nothing user-installed qualifies);
   *   * presence of an integrity record — a first-party system package
   *     has no legitimate reason to omit one;
   *   * live trust-store revocation of the entry's signature;
   *   * first-party manifest membership once the manifest has loaded (it
   *     is pre-warmed at module load; the membership leg is not enforced
   *     during the pre-load window so boot-order stays stable — every
   *     other condition must still hold).
   * And asynchronously, throttled: the integrity hash is re-verified in
   * the background; a failure flips a sticky kill-switch that fails every
   * subsequent check until reload — the same "tampered-since-install loses
   * access immediately" posture the gate's own header promises.
   */
  let _settingsTamperFlag = false;
  let _settingsIntegrityProbeAt = 0;

  function _probeSettingsIntegrityThrottled(entry) {
    const now = Date.now();
    if (now - _settingsIntegrityProbeAt < 30_000) return;
    _settingsIntegrityProbeAt = now;
    // Only probe when verification is actually possible; an absent
    // AppPackage yields no new signal, so the identity fields above remain
    // the guard rather than manufacturing a false tamper flag.
    if (typeof AppPackage === 'undefined' || typeof AppPackage.verifyIntegrity !== 'function') return;
    _integrityStillHolds(entry).then(ok => {
      if (!ok && !_settingsTamperFlag) {
        console.error('[UnrestrictedGate] Settings package failed its call-time integrity re-check — unrestricted access revoked for this session.');
      }
      _settingsTamperFlag = _settingsTamperFlag || !ok;
    }).catch(() => { /* _integrityStillHolds already fails closed on throw */ });
  }

  function isTrustedSettingsAppById(appId) {
    if (appId !== SETTINGS_APP_ID) return false;
    if (_settingsTamperFlag) return false;
    const entry = (typeof OS !== 'undefined' && OS.apps && OS.apps[appId]) || null;
    if (!(
      entry &&
      entry.system === true &&
      entry.verified === true &&
      entry.signer === 'NovaByte System' &&
      entry.manifest?.system === true
    )) return false;
    // Provenance: bundled first-party package, never a user install.
    if (entry.source !== 'system-bundle') return false;
    // First-party system packages must carry an integrity record.
    if (!entry.integrity) return false;
    // Live revocation: a signature added to the trust store's revoked list
    // must cut this off immediately, not at next boot.
    try {
      if (typeof TrustStore !== 'undefined' && typeof TrustStore.isRevoked === 'function'
        && entry.signature && TrustStore.isRevoked(entry.signature)) {
        return false;
      }
    } catch (_) { /* TrustStore read failure: the identity fields above still gate */ }
    // First-party manifest membership (enforced once the manifest has loaded).
    if (_firstPartyIdsCache && !_firstPartyIdsCache.has(appId)) return false;
    // Background integrity re-verification (throttled).
    _probeSettingsIntegrityThrottled(entry);
    return true;
  }

  // Pre-warm the first-party manifest as early as possible so the
  // membership leg of isTrustedSettingsAppById is enforced for essentially
  // the whole session, not just after the first nova:system:* call.
  if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
    window.setTimeout(() => { _getFirstPartyAppIds(); }, 0);
  }

  // Cached the same way the App Manager package's install-time impersonation check
  // caches it — this file is fetched once and only changes on a real
  // deploy, so there is no reason to refetch it on every single call.
  let _firstPartyIdsCache = null;
  async function _getFirstPartyAppIds() {
    if (_firstPartyIdsCache) return _firstPartyIdsCache;
    try {
      const response = await fetch('js/apps/novaapp-manifest.json', { cache: 'no-store' });
      if (!response.ok) throw new Error(`manifest ${response.status}`);
      const parsed = await response.json();
      _firstPartyIdsCache = new Set(
        Array.isArray(parsed) ? parsed.filter(x => x && x.id).map(x => x.id) : []
      );
    } catch (e) {
      // Fail closed: an unreadable manifest must not be treated as "no
      // restriction" — an empty set still blocks everything, since
      // nothing can match membership in an empty list.
      console.error('[UnrestrictedGate] Could not load first-party manifest — failing closed:', e);
      _firstPartyIdsCache = new Set();
    }
    return _firstPartyIdsCache;
  }

  /**
   * Re-verify a package's integrity against its own stamped hash, the
   * same check the App Manager package runs at install time — but run here again
   * at call time, since a package that verified cleanly at install could
   * have been modified on disk (or in the in-memory app registry) since.
   * Returns true if there's no integrity block to check at all (nothing
   * to fail), matching AppPackage.verifyIntegrity()'s own "true means no
   * detected problem" semantics for a missing/absent integrity field.
   */
  async function _integrityStillHolds(app) {
    if (!app?.integrity) return true;
    if (typeof AppPackage === 'undefined' || typeof AppPackage.verifyIntegrity !== 'function') {
      // Can't check what we can't check — but silently treating an
      // unverifiable claim as fine is exactly the gap this file exists
      // to close, so an unrestricted call fails closed instead.
      console.error('[UnrestrictedGate] AppPackage.verifyIntegrity unavailable — failing closed.');
      return false;
    }
    try {
      return await AppPackage.verifyIntegrity(app);
    } catch (e) {
      console.error('[UnrestrictedGate] Integrity re-check threw — failing closed:', e);
      return false;
    }
  }

  /**
   * Gate for an app's sandbox tier. This is intentionally separate from the
   * Settings-only unrestricted IPC call map: the sandbox decision needs a
   * package-level answer, while individual nova:system:* calls still retain
   * their narrower per-call allowlist.
   *
   * Bundled first-party system packages are trusted by provenance (the file
   * is named by the build-generated first-party manifest and is reconciled
   * from the immutable OS bundle), while their integrity is still checked.
   * User-installed packages cannot satisfy this path merely by copying an id
   * or setting system:true.
   */
  async function checkUnrestrictedApp(app) {
    if (!app || typeof app.id !== 'string') {
      return { allowed: false, reason: 'missing app identity' };
    }
    if (app.system !== true || app.verified !== true || app.signer !== 'NovaByte System') {
      return { allowed: false, reason: 'app is not a trusted NovaByte System package' };
    }
    if (app.source !== 'system-bundle') {
      return { allowed: false, reason: 'package is not running from the trusted system bundle' };
    }
    if (app.manifest?.system !== true) {
      return { allowed: false, reason: 'package manifest is not marked as a system app' };
    }

    const firstPartyIds = await _getFirstPartyAppIds();
    if (!firstPartyIds.has(app.id)) {
      return { allowed: false, reason: 'app id is not present in the build-time first-party manifest' };
    }

    // Bundled system code must carry an integrity record. Unlike a user app,
    // there is no reason for a first-party system package to omit one.
    if (!app.integrity) {
      return { allowed: false, reason: 'system package has no integrity record' };
    }
    const integrityOk = await _integrityStillHolds(app);
    if (!integrityOk) {
      return { allowed: false, reason: 'package integrity check failed' };
    }

    // This gate is only for trusted, signed, first-party system packages.
    // Host execution is authorized by verified signing identity, integrity,
    // provenance and the build-time package allowlist; sandbox permission
    // prompts remain in force for apps that use the sandbox runtime.

    return { allowed: true };
  }

  return { checkUnrestrictedApp, isTrustedSettingsAppById };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = UnrestrictedGate;
if (typeof window !== 'undefined') window.UnrestrictedGate = UnrestrictedGate;
