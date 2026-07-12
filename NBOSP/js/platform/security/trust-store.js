// [NBOSP_TRUST-STORE_JS] -- from NovaByte OS Platform (NBOSP), not NovaPack Studio
/**
 * NovaByte - Trust Store
 * ────────────────────────────────────────────────────────────
 * A small, explicit list of public keys NBOSP trusts to vouch for app
 * packages, analogous to a browser's shipped root CA list. Each entry
 * holds ONLY a public key — never a secret — so shipping this file to
 * every install is safe: it lets installs *verify* signatures, it can
 * never let anyone *forge* one.
 *
 * Where entries come from:
 *  - "NovaByte Trusted Signing" is the built-in signing authority run by
 *    NovaByte. Developers who want the "Trusted" badge submit their
 *    package to that authority (see NovaPack Studio's signing flow),
 *    which reviews it and signs it with a private key ONLY NovaByte
 *    holds, offline. This file ships the matching public key.
 *  - Additional partner/enterprise CAs can be appended the same way if
 *    NovaByte ever delegates trust to other signing authorities.
 *  - Individual developers can still self-sign (createPackage with a
 *    signingKey) for their own testing, but self-signed packages will
 *    not match anything in this trust store, so they'll always surface
 *    as "Unverified" to end users — which is correct: nobody but the
 *    developer themselves vouches for a self-signed app.
 *
 * IMPORTANT: replace PLACEHOLDER_PUBLIC_KEY_JWK below with the real
 * public key exported from whatever offline system actually holds the
 * NovaByte Trusted Signing private key. Nothing here is a working key.
 *
 * @module js/platform/security/trust-store
 */

const TrustStore = (() => {
  // Placeholder — swap in the real exported JWK public key before shipping.
  // Generate a real pair with AppPackage.generateSigningKeyPair() on a
  // secure offline machine; keep privateJwk there forever, publish
  // publicJwk here.
  const NOVABYTE_TRUSTED_SIGNING_PUBLIC_JWK = {
    kty: 'OKP',
    crv: 'Ed25519',
    x: 'Id_PakcUqjCM2k3i7mSkQy7LadrM_PwVz9S1ikYAzEY',
  };

  const entries = [
    {
      name: 'NovaByte Trusted Signing',
      id: 'novabyte-trusted-signing-v1',
      publicKey: NOVABYTE_TRUSTED_SIGNING_PUBLIC_JWK,
      // Shown in the "More Info" panel of the untrusted-app dialog.
      description: 'Reviewed and signed by NovaByte\u2019s trusted signing authority.',
    },
    // Additional trusted CAs / partners can be appended here.
  ];

  function list() {
    return entries.slice();
  }

  function add(entry) {
    if (!entry || !entry.publicKey || !entry.name) {
      throw new Error('Trust store entries need at least {name, publicKey}');
    }
    entries.push(entry);
  }

  return { list, add };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TrustStore;
if (typeof window !== 'undefined') window.TrustStore = TrustStore;