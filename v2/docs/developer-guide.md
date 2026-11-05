# NovaByte OS - App Development Guide

## Overview

Welcome to NovaByte OS app development! This guide will walk you through creating, packaging, and distributing applications for the NovaByte OS platform.

## Table of Contents

1. [Getting Started](#getting-started)
2. [App Architecture](#app-architecture)
3. [Manifest Format](#manifest-format)
4. [Creating Your First App](#creating-your-first-app)
5. [Packaging Apps](#packaging-apps)
6. [App Lifecycle](#app-lifecycle)
7. [API Reference](#api-reference)
8. [Security Model](#security-model)
9. [Security Update API](#security-update-api)
10. [Best Practices](#best-practices)
11. [Distribution](#distribution)

---

## Getting Started

### Prerequisites

- NovaByte OS 2.3.8 or later
- Node.js 16+ (for CLI tools)
- A text editor (VS Code recommended)
- Basic knowledge of HTML, CSS, and JavaScript

### Installation

1. Clone or download the NovaByte OS repository
2. Navigate to the project directory
3. Install dependencies (if needed):

```bash
npm install
```

### Development Tools

NovaByte OS provides several tools for app development:

- **novaapp-cli.js**: Command-line tool for packaging and verification
- **App Templates**: Pre-built templates for common app types
- **My Apps Manager**: UI for managing installed apps
- **Sandbox Environment**: Secure execution environment for testing

---

## App Architecture

### Core Concepts

#### 1. App Registry
The App Registry (`js/app-registry.js`) manages all installed applications:
- Registers apps with the OS
- Tracks installation status
- Manages app lifecycle
- Provides app metadata

#### 2. Window Manager
The Window Manager (`WM`) handles app windows:
- Creates and manages windows
- Handles drag, resize, minimize, maximize
- Manages focus and z-index
- Provides window controls

#### 3. App Sandbox
The App Sandbox (`js/app-sandbox.js`) provides secure execution:
- Isolated iframe environment
- Content Security Policy (CSP)
- Permission enforcement
- API bridge for OS communication

#### 4. Permission Manager
The Permission Manager (`js/app-permission-manager.js`) handles access control:
- Manages permission grants
- Tracks user consent
- Enforces permission scopes
- Provides permission revocation

### App Types

NovaByte OS supports several app types:

| Type | Description | Use Case |
|------|-------------|----------|
| `blank` | Empty app shell | Custom applications |
| `webapp` | External website wrapper | Web-based tools |
| `utility` | Tool with file access | Productivity apps |
| `game` | Canvas-based game | Entertainment |
| `dashboard` | Data visualization | Monitoring tools |

---

## Manifest Format

Every NovaByte app requires a `manifest.json` file that defines its properties.

### Basic Structure

```json
{
  "id": "com.example.myapp",
  "name": "My Awesome App",
  "version": "1.0.0",
  "description": "A sample NovaByte application",
  "author": "Developer Name",
  "email": "dev@example.com",
  "website": "https://example.com",
  "entry": "index.html",
  "type": "blank",
  "permissions": [],
  "optionalPermissions": [],
  "defaultSize": [800, 600],
  "minSize": [400, 300],
  "categories": ["utilities"]
}
```

### Field Reference

#### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique app ID (reverse domain format) |
| `name` | string | Display name |
| `version` | string | Semantic version (x.y.z) |
| `entry` | string | Main HTML file |

#### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Short description |
| `author` | string | Developer name |
| `email` | string | Contact email |
| `website` | string | Developer website |
| `icon` | string | Icon name or path |
| `type` | string | App type (default: "blank") |
| `permissions` | array | Required permissions |
| `optionalPermissions` | array | Optional permissions |
| `defaultSize` | array | [width, height] |
| `minSize` | array | [width, height] |
| `maxSize` | array | [width, height] |
| `resizable` | boolean | Can be resized (default: true) |
| `frame` | boolean | Has window frame (default: true) |
| `categories` | array | App categories |
| `minSecurityPatch` | string | Minimum OS patch date (`YYYY-MM-DD`) required to run this app |

### App ID Format

Use reverse domain name notation:
- ✅ `com.example.myapp`
- ✅ `io.github.username.app`
- ❌ `MyApp` (no uppercase)
- ❌ `myapp` (no domain)

For web apps, use: `webapp_<unique-id>`

### Permissions

#### Available Permissions

| Permission | Category | Risk Level |
|------------|----------|------------|
| `fs:read` | Filesystem | Medium |
| `fs:write` | Filesystem | High |
| `fs:delete` | Filesystem | Critical |
| `net:internal` | Network | Low |
| `net:external` | Network | Medium |
| `device:notifications` | Device | Medium |
| `device:geolocation` | Device | High |
| `system:settings` | System | High |
| `admin:system` | Admin | Critical |

#### Requesting Permissions

```json
{
  "permissions": ["fs:read", "net:internal"],
  "optionalPermissions": ["device:notifications"]
}
```

- **Required permissions**: Must be granted for app to run
- **Optional permissions**: User can deny, app handles gracefully

---

## Creating Your First App

### Using the CLI Tool

1. Create a new app from template:

```bash
node novaapp-cli.js create my-first-app --template=blank
```

2. Navigate to the app directory:

```bash
cd my-first-app
```

3. Edit `manifest.json` to customize your app

4. Build the package:

```bash
node novaapp-cli.js build . --out ./dist
```

### Manual Creation

1. Create a project directory:

```bash
mkdir my-app
cd my-app
```

2. Create `manifest.json`:

```json
{
  "id": "com.example.myapp",
  "name": "My App",
  "version": "1.0.0",
  "description": "My first NovaByte app",
  "author": "Your Name",
  "entry": "index.html",
  "type": "blank",
  "permissions": [],
  "defaultSize": [800, 600],
  "minSize": [400, 300],
  "categories": ["utilities"]
}
```

3. Create `index.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <title>My App</title>
  <style>
    body {
      font-family: sans-serif;
      padding: 20px;
    }
  </style>
</head>
<body>
  <h1>Hello, NovaByte!</h1>
  <p>Welcome to my first app.</p>
</body>
</html>
```

4. Test your app by loading it in NovaByte OS

---

## Packaging Apps

### Package Format

NovaByte apps are packaged as `.novaapp` files:
- JSON manifest with metadata
- Base64-encoded file contents
- SHA-256 digital signature
- Compression support

### Creating Packages

#### Using the CLI

```bash
# Build from directory
node novaapp-cli.js build ./my-app/ --out ./dist/

# Verify package
node novaapp-cli.js verify ./my-app.novaapp

# Inspect package contents
node novaapp-cli.js inspect ./my-app.novaapp
```

#### Programmatic Packaging

```javascript
const AppPackage = require('./js/app-package.js');

const manifest = {
  id: 'com.example.myapp',
  name: 'My App',
  version: '1.0.0',
  entry: 'index.html',
  permissions: []
};

const files = {
  'index.html': '<html>...</html>',
  'app.js': 'console.log("Hello");'
};

const pkg = AppPackage.createPackage(manifest, files, {
  signingKey: 'your-key'
});

// Save package
fs.writeFileSync('my-app.novaapp', JSON.stringify(pkg, null, 2));
```

### Package Validation

Packages are validated for:
- Correct manifest format
- Valid app ID
- Required fields
- Permission validity
- File integrity
- Digital signature

---

## App Lifecycle

### Installation

1. User selects `.novaapp` file or URL
2. Package is validated and verified
3. Permissions are requested (if needed)
4. App is registered with AppRegistry
5. App appears in "My Apps" list

### Launch

1. User clicks app icon or launcher entry
2. `WM.createWindow()` creates window
3. App sandbox is initialized
4. App content is loaded
5. `app.init()` is called

### Runtime

- App runs in sandboxed iframe
- Can communicate via postMessage API
- Can request additional permissions
- State is auto-saved periodically

### Termination

- Window close triggers cleanup
- `app.onClose()` is called (if defined)
- Resources are released
- State is saved

### Uninstallation

1. User selects "Uninstall" in My Apps
2. App is removed from AppRegistry
3. Permissions are revoked
4. App data is cleaned up
5. App is removed from launcher

---

## API Reference

### OS.apps Registry

Apps are registered with the OS.apps object:

```javascript
OS.apps[appId] = {
  id: string,
  name: string,
  icon: string,
  description: string,
  defaultSize: [number, number],
  minSize: [number, number],
  init: function(content, state, options),
  onDrop: function(file, state),  // optional
  onClose: function(state)        // optional
};
```

### Window Manager (WM)

```javascript
// Create window
const window = WM.createWindow(appId, options);

// Window methods
WM.focusWindow(id);
WM.minimizeWindow(id);
WM.toggleMaximize(id);
WM.closeWindow(id);

// Window state
{
  id: string,
  appId: string,
  element: HTMLElement,
  content: HTMLElement,
  x: number,
  y: number,
  width: number,
  height: number,
  maximized: boolean,
  minimized: boolean
}
```

### App Sandbox API

Apps can communicate with the OS via postMessage:

```javascript
// Request permission
window.parent.postMessage({
  type: 'nova:request-permission',
  permission: 'fs:read'
}, '*');

// File system operations
window.parent.postMessage({
  type: 'nova:fs:read',
  path: '/documents/file.txt'
}, '*');

// Show notification
window.parent.postMessage({
  type: 'nova:notifications:show',
  title: 'Hello',
  body: 'Message content'
}, '*');

// Settings
window.parent.postMessage({
  type: 'nova:settings:get',
  key: 'theme'
}, '*');
```

### Session Manager

```javascript
// Save app state
SessionManager.saveState(appId, state);

// Restore app state
const state = SessionManager.getState(appId);

// Register handlers
SessionManager.registerAppHandlers(appId, saveFn, restoreFn);
```

---

## Security Model

### Sandboxing

All apps run in isolated iframes with:
- Content Security Policy (CSP)
- Sandbox attributes
- Cross-origin isolation
- Limited API access

### Permission System

- Permissions must be explicitly requested
- Users grant/revoke permissions
- Dangerous permissions require consent
- Permissions can be audited

### Code Signing

- Packages can be digitally signed
- Signatures are verified on install
- Trusted publisher program (future)
- Revocation list support

### Best Practices

1. **Request minimal permissions**: Only ask for what you need
2. **Handle permission denial**: App should work without optional permissions
3. **Validate all input**: Sanitize user input and file content
4. **Use HTTPS**: For external resources
5. **Avoid eval()**: Use safer alternatives
6. **Respect privacy**: Don't collect unnecessary data

---

## Security Update API

NovaByte OS 2.3.8 introduces the **Security Update API** (`js/nova-security-api.js`), which lets apps declare a minimum OS security patch level required to run. If the user's OS patch is older than required, an unskippable system dialog is shown and the app window closes automatically. The user is directed to install updates before retrying.

The current OS security patch date is always available globally:

```javascript
OS.securityPatch  // e.g. "2026-05-01"
```

---

### How Enforcement Works

Enforcement is automatic — you do not need to call anything at runtime. The OS checks every app at launch time by patching `WM.createWindow` internally.

There are two ways an app gets checked:

**1. Auto-enforcement (permission-based)**

Apps that request any of the following permissions are automatically checked, even without a `minSecurityPatch` field. The OS patch must be no older than 180 days.

| Permission | Risk |
|---|---|
| `fs:write` | High |
| `fs:delete` | Critical |
| `device:geolocation` | High |
| `system:settings` | High |
| `admin:system` | Critical |

**2. Explicit declaration (manifest-based)**

Add `minSecurityPatch` to your manifest to set a specific required date regardless of permissions. This is recommended for any app that handles passwords, tokens, encryption keys, or personal data.

---

### Manifest Field

```json
{
  "id": "com.example.passwordmanager",
  "name": "My Password Manager",
  "version": "1.0.0",
  "entry": "index.html",
  "permissions": ["fs:read", "fs:write"],
  "minSecurityPatch": "2026-03-01"
}
```

When the user's `OS.securityPatch` is older than `"2026-03-01"`, the app is blocked at launch. The dialog shows:

- The app name and reason
- The user's current patch date (highlighted in red)
- The required minimum patch date (highlighted in green)
- A 6-second countdown that auto-closes the window
- Instructions to go to **Settings → Updates**

The dialog intercepts all pointer and keyboard events — it cannot be dismissed or skipped.

---

### postMessage API (sandboxed apps)

Apps running inside a sandboxed iframe can trigger a security check at any point during their lifecycle, not just at launch. This is useful for protecting specific actions like unlocking a vault or submitting a form with credentials.

**Request a check:**

```javascript
window.parent.postMessage({
  type:         'nova:security:check',
  minPatchDate: '2026-04-01',
  reason:       'Required to store encrypted passwords safely.'
}, '*');
```

**Listen for the result:**

```javascript
window.addEventListener('message', (e) => {
  if (e.data.type === 'nova:security:result') {
    console.log(e.data.compliant); // true or false
    console.log(e.data.current);   // "2026-05-01"
    console.log(e.data.required);  // "2026-04-01"
  }
});
```

If `compliant` is `false`, the OS automatically shows the blocking dialog and closes the window — you do not need to handle it yourself.

---

### Reading the Patch Date Directly

For trusted OS-level code (not sandboxed), you can read or check the patch date directly:

```javascript
// Read the current patch date
OS.securityPatch  // "2026-05-01"

// Programmatic compliance check
NovaSecurityAPI.meetsRequirement('2026-03-01')  // true or false

// Get it as a Date object
NovaSecurityAPI.getCurrentPatchDate()  // Date object
```

---

### What NOT to do

- **Do not gate your own UI** based on the patch date. If the OS check passes, the user is compliant — trust it.
- **Do not suppress or catch** the blocking dialog. It is injected at the OS level and is intentionally unskippable.
- **Do not store secrets** without declaring `minSecurityPatch`. Auto-enforcement only covers listed sensitive permissions; explicit declaration is stronger.

---

## Best Practices

### Performance

- Minimize DOM operations
- Use CSS animations (GPU-accelerated)
- Lazy load resources
- Optimize images
- Debounce/throttle events

### User Experience

- Follow NovaByte design guidelines
- Use consistent styling
- Provide loading states
- Handle errors gracefully
- Support keyboard navigation
- Make responsive layouts

### Accessibility

- Use semantic HTML
- Add ARIA labels
- Ensure keyboard navigation
- Provide focus indicators
- Use sufficient contrast
- Test with screen readers

### Code Quality

- Use ES6+ features
- Modularize code
- Add comments
- Write tests
- Use linters
- Follow style guide

---

## Distribution

### Publishing to Marketplace

1. Create high-quality app
2. Test thoroughly
3. Sign your package
4. Submit to marketplace
5. Provide documentation
6. Handle user feedback

### Direct Distribution

- Share `.novaapp` files
- Host on your website
- Use version control
- Provide checksums
- Sign packages

### Updates

- Bump version in manifest
- Maintain changelog
- Support backward compatibility
- Notify users of updates
- Provide migration path

---

## Sample Apps

### Hello World

Location: `samples/hello-world/`

A simple app demonstrating basic structure.

### Calculator

Location: `samples/calculator/`

Interactive calculator with file history.

### Weather Dashboard

Location: `samples/weather/`

External API integration example.

---

## Troubleshooting

### App Won't Launch

- Check manifest format
- Verify entry file exists
- Check browser console for errors
- Ensure permissions are granted

### Permission Denied

- Check permission is in manifest
- Verify user granted permission
- Handle denial gracefully

### Sandbox Errors

- Check CSP violations
- Verify iframe sandbox attributes
- Ensure API calls are allowed

### Performance Issues

- Profile with DevTools
- Check for memory leaks
- Optimize DOM operations
- Reduce reflows/repaints

---

## Resources

- [API Reference](api-reference.md)
- [Security Guide](security-best-practices.md)
- [Publishing Guide](publishing-guide.md)
- [Sample Apps](../samples/)
- [GitHub Repository](https://github.com/novabyte/novaos)
- [Discord Community](https://discord.gg/novabyte)

---

## Contributing

We welcome contributions! Please see our [Contributing Guide](../CONTRIBUTING.md) for details.

### Development Setup

1. Fork the repository
2. Clone your fork
3. Install dependencies
4. Create a feature branch
5. Make your changes
6. Test thoroughly
7. Submit a pull request

### Code of Conduct

Please read our [Code of Conduct](../CODE_OF_CONDUCT.md).

---

## License

NovaByte OS is licensed under the MIT License. See [LICENSE](../LICENSE) for details.

---

**Last Updated**: April 2026  
**Version**: 1.0  
**Status**: Beta