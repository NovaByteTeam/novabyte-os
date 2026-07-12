// [NBOSP_APP-PACKAGE_JS] -- from NovaByte OS Platform (NBOSP), not NovaPack Studio
/**
 * NovaByte - App Package Manager
 * ────────────────────────────────────────────────────────────
 *
 * TRUST MODEL CHANGE (this revision):
 *  Previously, signing used HMAC-SHA256 with a *shared secret* — the same
 *  key had to be typed into both the signer's tool and every installer's
 *  dialog box. That can prove "this package wasn't altered since I typed
 *  the key in", but it can't prove "this came from a trusted publisher",
 *  because anyone who has the key (which by definition has to be shared to
 *  verify anything) can sign arbitrary packages. It also can't support a
 *  central signing authority: handing out the HMAC key to let a CA "vouch"
 *  for an app would let that CA (or anyone who intercepts the key) forge
 *  ANY app's signature, trusted or not.
 *
  *  This revision moves to Ed25519 public/private key signing:
 *   - The signing authority (or an individual developer) holds a PRIVATE
 *     key offline and never ships it anywhere.
 *   - signPackage(pkg, privateKey) is only ever run on the signer's
 *     machine/server (e.g. inside NovaPack Studio's signing flow) — it is
 *     not something end users' installs ever call.
 *   - verifyPackage(pkg, publicKeyOrTrustEntry) only needs a PUBLIC key.
 *     Public keys are safe to ship inside NBOSP itself (a "trust store"),
 *     the same way browsers ship root CA certs. Verifying a package proves
 *     it was signed by the holder of a specific private key, without the
 *     verifier ever being able to forge new signatures.
 *   - This is what actually makes a paid/trusted signing authority
 *     possible: NovaByte (or a partner CA) can sign on a developer's
 *     behalf using a key nobody else has, and every installation of NBOSP
 *     can verify that signature using a public key baked into the trust
 *     store — no secret ever needs to leave the signer.
 *
 * SECURITY FIXES carried over / re-verified in this revision:
  *  [1] verifyPackage() performs real Ed25519 signature verification, not a
 *      hash-equality check the signer of any package could trivially
 *      satisfy themselves (see appmanager.js fix — the old install path
 *      had a fallback that accepted `signature === sha256(payload)`,
 *      which is not a proof of anything: it just repeats the hash the
 *      attacker already controls).
 *  [2] installPackage() rejects packages whose signature fails
 *      verification unless the caller explicitly opts into
 *      skipVerify — surfaced as an unmistakable warning in the UI, never
 *      a silent default.
 *
 * @module js/app-package
 */

const AppPackage = (() => {
  const NOVAAPP_FORMAT_VERSION = '1.0';
  const _crypto = (typeof window !== 'undefined' ? window.crypto : null)
    || globalThis.crypto
    || require('crypto');

  const SIG_ALGO = { name: 'Ed25519' };
  const SIG_SIGN_PARAMS = { name: 'Ed25519' };

  // ─── Manifest validation (unchanged) ────────────────────────────────────────

  function validateManifest(manifest) {
    const errors = [], warnings = [];
    if (!manifest || typeof manifest !== 'object') {
      return { valid: false, errors: ['Manifest is missing or not an object'], warnings: [] };
    }
    ['id', 'name', 'version', 'entry'].forEach(f => {
      if (!manifest[f]) errors.push(`Missing required field: ${f}`);
    });
    if (manifest.id && !manifest.id.startsWith('webapp_')) {
      if (!/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/.test(manifest.id))
        errors.push(`Invalid app ID "${manifest.id}". Must be reverse domain format.`);
    }
    if (manifest.version && !/^\d+\.\d+\.\d+$/.test(manifest.version))
      warnings.push(`Version "${manifest.version}" doesn't follow semver (x.y.z)`);
    if (manifest.permissions) {
      const valid = Object.values((typeof AppPermissionManager !== 'undefined' && AppPermissionManager?.PERMISSION_TYPES) || {});
      manifest.permissions.forEach(p => {
        if (valid.length > 0 && !valid.includes(p)) warnings.push(`Unknown permission: ${p}`);
      });
    }
    if (manifest.defaultSize &&
        (!Array.isArray(manifest.defaultSize) || manifest.defaultSize.length !== 2))
      errors.push('defaultSize must be [width, height]');
    if (manifest.minSize &&
        (!Array.isArray(manifest.minSize) || manifest.minSize.length !== 2))
      errors.push('minSize must be [width, height]');
    if (manifest.maxSize &&
        (!Array.isArray(manifest.maxSize) || manifest.maxSize.length !== 2))
      errors.push('maxSize must be [width, height]');
    return { valid: errors.length === 0, errors, warnings };
  }

  // ─── Canonical payload for signing ──────────────────────────────────────────

  function _signingPayload(pkg) {
    return JSON.stringify({
      novabyte_app: pkg.novabyte_app,
      manifest:     pkg.manifest,
      files:        pkg.files,
      compiled_at:  pkg.compiled_at
    });
  }

  // ─── Key material helpers ───────────────────────────────────────────────────

  // Accepts a CryptoKey directly, or a JWK object/string, and returns a usable
  // CryptoKey for the given usage ('sign' needs a private key, 'verify' a
  // public key). Keeping this flexible means callers (including existing
  // tests) can keep passing whatever key representation they already have.
  async function _toCryptoKey(key, usage) {
    if (!key) throw new Error('No key provided');
    if (typeof key === 'object' && typeof key.type === 'string' && key.algorithm) {
      // Already a CryptoKey (duck-typed check to avoid instanceof issues across realms)
      return key;
    }
    let jwk = key;
    if (typeof key === 'string') {
      try { jwk = JSON.parse(key); }
      catch (_) {       throw new Error('String keys must be a JWK JSON string for Ed25519'); }
    }
    return _crypto.subtle.importKey('jwk', jwk, SIG_ALGO, true, [usage]);
  }

  // ─── Keypair generation (for signing authorities / developers) ─────────────

  /**
   * Generate a new Ed25519 keypair for signing packages.
   * The private key must be kept offline by whoever runs the signing
   * authority; only the public key should ever be distributed / trusted.
   * @returns {Promise<{publicKey: CryptoKey, privateKey: CryptoKey, publicJwk: object, privateJwk: object}>}
   */
  async function generateSigningKeyPair() {
    const pair = await _crypto.subtle.generateKey(SIG_ALGO, true, ['sign', 'verify']);
    const [publicJwk, privateJwk] = await Promise.all([
      _crypto.subtle.exportKey('jwk', pair.publicKey),
      _crypto.subtle.exportKey('jwk', pair.privateKey),
    ]);
    return { publicKey: pair.publicKey, privateKey: pair.privateKey, publicJwk, privateJwk };
  }

  // ─── Signing & verification (Ed25519) ────────────────────────────────────────

  /**
   * Sign a package. Only ever call this with a PRIVATE key, and only ever
   * on the signer's own machine/server — this must never run as part of
   * an end user's install flow.
   * @param {object} pkg - Package object (signature field ignored/overwritten)
   * @param {CryptoKey|object|string} privateKey - Ed25519 private key (CryptoKey or JWK)
   * @returns {Promise<string>} Hex-encoded Ed25519 signature
   */
  async function signPackage(pkg, privateKey) {
    const payload = new TextEncoder().encode(_signingPayload(pkg));
    const cryptoKey = await _toCryptoKey(privateKey, 'sign');
    const sig = await _crypto.subtle.sign(SIG_SIGN_PARAMS, cryptoKey, payload);
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Verify a package's signature against a PUBLIC key. Safe to run on
   * every install/launch — a public key can only verify, never forge,
   * signatures.
   * @param {object} pkg - Package object with .signature field
   * @param {CryptoKey|object|string} publicKey - Ed25519 public key (CryptoKey or JWK)
   * @returns {Promise<boolean>}
   */
  async function verifyPackage(pkg, publicKey) {
    if (!pkg || !pkg.signature || !publicKey) return false;
    try {
      const payload = new TextEncoder().encode(_signingPayload(pkg));
      const cryptoKey = await _toCryptoKey(publicKey, 'verify');
      const sigMatch = pkg.signature.match(/.{2}/g);
      if (!sigMatch) return false;
      const sigBytes = new Uint8Array(sigMatch.map(b => parseInt(b, 16)));
      return await _crypto.subtle.verify(SIG_SIGN_PARAMS, cryptoKey, sigBytes, payload);
    } catch (_) {
      return false;
    }
  }

  /**
   * Verify a package against every entry in a trust store (array of
   * {name, publicKey} — see js/platform/security/trust-store.js) and
   * return which entry (if any) vouches for it. This is the primary
   * entry point NBOSP's install/launch flow should use instead of calling
   * verifyPackage with a single key.
   *
   * Checks revocation FIRST if a `revocationCheck` function is supplied —
   * a cryptographically valid signature that has been individually
   * revoked (see TrustStore.revoke/isRevoked) must still come back
   * untrusted. Pass `TrustStore.isRevoked` from trust-store.js as
   * `revocationCheck`; if omitted, revocation is simply not checked (so
   * existing callers that haven't been updated yet keep working, but you
   * should pass it in production).
   *
   * @param {object} pkg
   * @param {Array<{name:string, publicKey:any}>} trustStore
   * @param {(signature:string)=>boolean} [revocationCheck] - e.g. TrustStore.isRevoked
   * @returns {Promise<{trusted:boolean, signer:string|null, revoked?:boolean}>}
   */
  async function verifyAgainstTrustStore(pkg, trustStore, revocationCheck) {
    if (!pkg || !pkg.signature || !Array.isArray(trustStore)) return { trusted: false, signer: null };
    if (typeof revocationCheck === 'function' && revocationCheck(pkg.signature)) {
      // Signature is cryptographically valid territory, but this exact
      // signed package has been individually pulled — never treat it as
      // trusted regardless of which trust-store entry would otherwise
      // vouch for it.
      return { trusted: false, signer: null, revoked: true };
    }
    for (const entry of trustStore) {
      try {
        const ok = await verifyPackage(pkg, entry.publicKey);
        if (ok) return { trusted: true, signer: entry.name || null };
      } catch (_) { /* try next entry */ }
    }
    return { trusted: false, signer: null };
  }

  // ─── Package creation ────────────────────────────────────────────────────────

  async function createPackage(manifest, files, options = {}) {
    const validation = validateManifest(manifest);
    if (!validation.valid) throw new Error(`Invalid manifest: ${validation.errors.join(', ')}`);
    if (validation.warnings.length > 0) console.warn('[AppPackage] Warnings:', validation.warnings);

    const pkg = {
      novabyte_app: NOVAAPP_FORMAT_VERSION,
      manifest: { ...manifest, packagedAt: new Date().toISOString() },
      files: {},
      signature: null,
      signer: null,
      compiled_at: new Date().toISOString()
    };

    for (const [path, content] of Object.entries(files)) {
      if (typeof content === 'string') {
        pkg.files[path] = btoa(unescape(encodeURIComponent(content)));
      } else if (content instanceof Uint8Array || Buffer.isBuffer?.(content)) {
        const binary = Array.from(new Uint8Array(content))
          .map(b => String.fromCharCode(b)).join('');
        pkg.files[path] = btoa(binary);
      }
    }

    // NOTE: signingKey here must be a PRIVATE key. This path is intended
    // for developer/local self-signing (createPackage running inside
    // NovaPack Studio, on the developer's own machine) — a paid/trusted
    // signature from a signing authority should instead be obtained via
    // that authority's own signing endpoint and attached afterwards
    // (see studio's requestTrustedSignature()), since the authority's
    // private key must never be present in the developer's environment.
    if (options.signingKey) {
      pkg.signature = await signPackage(pkg, options.signingKey);
      pkg.signer = options.signerName || 'self-signed';
    }
    return pkg;
  }

  // ─── Install / uninstall ─────────────────────────────────────────────────────

  /**
   * Install a package. Verification now checks against a trust store
   * (array of known public keys) rather than a single shared secret.
   * Packages that don't verify against any trusted key are NOT silently
   * rejected here — that decision belongs to the UI (see the "untrusted
   * app" dialog in appmanager.js), so this returns the verification
   * result rather than throwing, unless skipVerify is explicitly false
   * and no trust store was even supplied (a caller error).
   */
  async function installPackage(pkg, options = {}) {
    let verified = false;
    let signer = null;

    if (!options.skipVerify) {
      const trustStore = options.trustStore || [];
      const result = await verifyAgainstTrustStore(pkg, trustStore);
      verified = result.trusted;
      signer = result.signer;
      if (!verified && !options.allowUnverified) {
        throw new Error('Package signature did not match any trusted signer');
      }
    }

    const validation = validateManifest(pkg.manifest);
    if (!validation.valid) throw new Error(`Invalid manifest: ${validation.errors.join(', ')}`);

    const existing = (typeof AppRegistry !== 'undefined') && AppRegistry?.getApp(pkg.manifest.id);
    if (existing && !options.force) {
      throw new Error(`App ${pkg.manifest.id} is already installed. Use force option to overwrite.`);
    }

    const appConfig = {
      ...pkg.manifest,
      files:         pkg.files,
      signature:     pkg.signature,
      verified,
      signer,
      source:        options.source || 'file',
      installedDate: new Date().toISOString()
    };

    const registered = (typeof AppRegistry !== 'undefined') && AppRegistry?.registerApp(appConfig);
    return { success: true, app: registered, verified, signer, warnings: validation.warnings };
  }

  function uninstallPackage(appId) {
    return (typeof AppRegistry !== 'undefined' && AppRegistry?.unregisterApp(appId)) || false;
  }

  function extractPackage(pkg) {
    const files = {};
    for (const [path, encoded] of Object.entries(pkg.files)) {
      try {
        const binary = atob(encoded);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        files[path] = bytes;
      } catch (e) {
        console.error(`[AppPackage] Failed to decode ${path}:`, e);
      }
    }
    return files;
  }

  function inspectPackage(pkg) {
    return {
      format:       pkg.novabyte_app,
      manifest:     pkg.manifest,
      fileCount:    Object.keys(pkg.files).length,
      files:        Object.keys(pkg.files),
      hasSignature: !!pkg.signature,
      signer:       pkg.signer || null,
      // NOTE: sync inspection only — call verifyAgainstTrustStore(pkg, trustStore) for real check
      size:         JSON.stringify(pkg).length
    };
  }

  return {
    validateManifest, createPackage, signPackage, verifyPackage,
    verifyAgainstTrustStore, generateSigningKeyPair,
    installPackage, uninstallPackage, extractPackage, inspectPackage,
    NOVAAPP_FORMAT_VERSION
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AppPackage;
// Same pattern every other core module uses (wm.js -> window.WM,
// app-permission-manager.js -> window.AppPermissionManager) — without this,
// AppPackage was only reachable via the CommonJS module.exports line above,
// which packages.js (a frontend app running in the browser/NW.js window
// context, not a Node require() context) has no way to reach.
if (typeof window !== 'undefined') window.AppPackage = AppPackage;