'use strict';

const fs    = require('fs');
const https = require('https');
const path  = require('path');

function configureSSL(app) {
  const keyPath  = path.resolve(__dirname, '..', '..', 'cert.key');
  const certPath = path.resolve(__dirname, '..', '..', 'cert.crt');

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    throw new Error(
      `[SSL Core] Cannot start server without TLS: cert.key or cert.crt missing.\n` +
      `Expected at:\n  ${keyPath}\n  ${certPath}\n`
    );
  }

  const httpsOptions = {
    key:           fs.readFileSync(keyPath),
    cert:          fs.readFileSync(certPath),
    ALPNProtocols: ['http/1.1'],
  };

  const server = https.createServer(httpsOptions, app);
  console.log('[SSL Core] Secure HTTPS Server initialized successfully.');

  return { server };
}

module.exports = { configureSSL };