const fs = require('fs');
const https = require('https');
const path = require('path');

function configureSSL(app) {
    const keyPath = path.resolve(__dirname, '..', '..', 'cert.key');
    const certPath = path.resolve(__dirname, '..', '..', 'cert.crt');

    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
        throw new Error(
            `[SSL Core] Cannot start server without TLS: cert.key or cert.crt not found.\n` +
            `Expected at:\n  ${keyPath}\n  ${certPath}\n` +
            `See the project documentation for certificate setup instructions.`
        );
    }

    const httpsOptions = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath),
        ALPNProtocols: ['http/1.1'] // Critical protocol alignment for Chromium
    };
    const server = https.createServer(httpsOptions, app);
    console.log('[SSL Core] Secure HTTPS Server successfully running with native cert.key');
    return { server };
}

module.exports = { configureSSL };
