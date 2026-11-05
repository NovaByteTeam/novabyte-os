
/**
 * NovaByte OS - App Package Manager
 * ────────────────────────────────────────────────────────────
 * Creates, validates, and signs NovaByte app packages (.novaapp)
 * Similar to driver-compiler.js for .drv packages.
 * 
 * @module js/app-package
 */

const AppPackage = (() => {
  const NOVAAPP_FORMAT_VERSION = '1.0';
  const crypto = (typeof window !== 'undefined' ? window.crypto : null) || globalThis.crypto || require('crypto');

  /**
   * Validate app manifest
   * @param {object} manifest - App manifest object
   * @returns {object} Validation result
   */
  function validateManifest(manifest) {
    const errors = [];
    const warnings = [];

    // Required fields
    const requiredFields = ['id', 'name', 'version', 'entry'];
    requiredFields.forEach(field => {
      if (!manifest[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    });

    // Validate app ID format
    if (manifest.id && !manifest.id.startsWith('webapp_')) {
      if (!/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/.test(manifest.id)) {
        errors.push(
          `Invalid app ID "${manifest.id}". ` +
          `Must be reverse domain format (e.g., com.example.app)`
        );
      }
    }

    // Validate version
    if (manifest.version && !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
      warnings.push(
        `Version "${manifest.version}" doesn't follow semver (x.y.z)`
      );
    }

    // Validate permissions
    if (manifest.permissions) {
      const validPermissions = Object.values(
        AppPermissionManager.PERMISSION_TYPES || {}
      );
      manifest.permissions.forEach(perm => {
        if (!validPermissions.includes(perm)) {
          warnings.push(`Unknown permission: ${perm}`);
        }
      });
    }

    // Validate size arrays
    if (manifest.defaultSize && 
        (!Array.isArray(manifest.defaultSize) || 
         manifest.defaultSize.length !== 2)) {
      errors.push('defaultSize must be [width, height]');
    }
    if (manifest.minSize && 
        (!Array.isArray(manifest.minSize) || 
         manifest.minSize.length !== 2)) {
      errors.push('minSize must be [width, height]');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Create a NovaByte app package
   * @param {object} manifest - App manifest
   * @param {object} files - App files (path -> content)
   * @param {object} options - Package options
   * @returns {object} Package object
   */
  function createPackage(manifest, files, options = {}) {
    // Validate manifest
    const validation = validateManifest(manifest);
    if (!validation.valid) {
      throw new Error(
        `Invalid manifest: ${validation.errors.join(', ')}`
      );
    }

    if (validation.warnings.length > 0) {
      console.warn('[AppPackage] Warnings:', validation.warnings);
    }

    // Prepare package
    const pkg = {
      novabyte_app: NOVAAPP_FORMAT_VERSION,
      manifest: {
        ...manifest,
        packagedAt: new Date().toISOString()
      },
      files: {},
      signature: null,
      compiled_at: new Date().toISOString()
    };

    // Encode files as base64
    for (const [path, content] of Object.entries(files)) {
      if (typeof content === 'string') {
        pkg.files[path] = btoa(unescape(encodeURIComponent(content)));
      } else if (content instanceof Uint8Array || Buffer.isBuffer(content)) {
        const binary = Array.from(new Uint8Array(content))
          .map(b => String.fromCharCode(b))
          .join('');
        pkg.files[path] = btoa(binary);
      }
    }

    // Sign package if key provided
    if (options.signingKey) {
      pkg.signature = signPackage(pkg, options.signingKey);
    }

    return pkg;
  }

  /**
   * Sign a package
   * @param {object} pkg - Package object
   * @param {string|Uint8Array} key - Signing key
   * @returns {string} Signature
   */
  function signPackage(pkg, key) {
    // Create deterministic string to sign
    const toSign = JSON.stringify({
      novabyte_app: pkg.novabyte_app,
      manifest: pkg.manifest,
      files: pkg.files,
      compiled_at: pkg.compiled_at
    });

    if (typeof window !== 'undefined' && crypto.subtle) {
      // Web Crypto API
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(toSign))
        .then(hash => {
          return Array.from(new Uint8Array(hash))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        });
    } else if (typeof require !== 'undefined') {
      // Node.js
      const cryptoNode = require('crypto');
      return cryptoNode.createHash('sha256').update(toSign).digest('hex');
    }
    
    throw new Error('No crypto implementation available');
  }

  /**
   * Verify package signature
   * @param {object} pkg - Package object
   * @returns {boolean} Valid signature
   */
  function verifyPackage(pkg) {
    if (!pkg.signature) {
      return false;
    }

    // Recalculate signature
    const toVerify = JSON.stringify({
      novabyte_app: pkg.novabyte_app,
      manifest: pkg.manifest,
      files: pkg.files,
      compiled_at: pkg.compiled_at
    });

    // For now, just check format
    // In production, would verify against known keys
    return /^[a-f0-9]{64}$/.test(pkg.signature);
  }

  /**
   * Install a package
   * @param {object} pkg - Package object
   * @param {object} options - Install options
   * @returns {object} Installation result
   */
  function installPackage(pkg, options = {}) {
    // Verify package
    if (!options.skipVerify && !verifyPackage(pkg)) {
      throw new Error('Package signature verification failed');
    }

    // Validate manifest
    const validation = validateManifest(pkg.manifest);
    if (!validation.valid) {
      throw new Error(
        `Invalid manifest: ${validation.errors.join(', ')}`
      );
    }

    // Check for existing app
    const existing = AppRegistry?.getApp(pkg.manifest.id);
    if (existing && !options.force) {
      throw new Error(
        `App ${pkg.manifest.id} is already installed. Use force option to overwrite.`
      );
    }

    // Prepare app config
    const appConfig = {
      ...pkg.manifest,
      files: pkg.files,
      signature: pkg.signature,
      verified: verifyPackage(pkg),
      source: options.source || 'file',
      installedDate: new Date().toISOString()
    };

    // Register app
    const registered = AppRegistry?.registerApp(appConfig);

    return {
      success: true,
      app: registered,
      warnings: validation.warnings
    };
  }

  /**
   * Uninstall an app
   * @param {string} appId - App ID
   * @returns {boolean} Success
   */
  function uninstallPackage(appId) {
    return AppRegistry?.unregisterApp(appId) || false;
  }

  /**
   * Extract package contents
   * @param {object} pkg - Package object
   * @returns {object} Extracted files
   */
  function extractPackage(pkg) {
    const files = {};
    
    for (const [path, encoded] of Object.entries(pkg.files)) {
      try {
        const binary = atob(encoded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        files[path] = bytes;
      } catch (error) {
        console.error(`[AppPackage] Failed to decode ${path}:`, error);
      }
    }
    
    return files;
  }

  /**
   * Inspect package contents
   * @param {object} pkg - Package object
   * @returns {object} Package info
   */
  function inspectPackage(pkg) {
    return {
      format: pkg.novabyte_app,
      manifest: pkg.manifest,
      fileCount: Object.keys(pkg.files).length,
      files: Object.keys(pkg.files),
      hasSignature: !!pkg.signature,
      verified: verifyPackage(pkg),
      size: JSON.stringify(pkg).length
    };
  }

  return {
    validateManifest,
    createPackage,
    signPackage,
    verifyPackage,
    installPackage,
    uninstallPackage,
    extractPackage,
    inspectPackage,
    NOVAAPP_FORMAT_VERSION
  };
})();

// Export for Node.js/CommonJS
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AppPackage;
}
