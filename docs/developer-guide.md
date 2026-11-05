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
10. [Code Obfuscation](#code-obfuscation)
11. [Best Practices](#best-practices)
12. [Distribution](#distribution)

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

NovaByte apps are packaged as `.novaapp` files. The format depends on how the package was built:

**Standard build** (no `--obfuscate`):
- Plain JSON file containing the manifest, Base64-encoded file contents, and a SHA-256 digital signature
- Human-readable; file contents can be decoded with any Base64 decoder

**Obfuscated build** (`--obfuscate`):
- The entire package is wrapped as a JS variable assignment (`var __pkg={...};`) and run through the obfuscator
- The resulting `.novaapp` is obfuscated JavaScript, **not plain JSON** — `JSON.parse()` will fail on it
- The NovaByte runtime and CLI tools use a `vm`-based loader that executes the JS to recover the package object
- File contents, manifest fields, signatures, and file paths are all buried inside the obfuscated output

### Creating Packages

#### Using the CLI

```bash
# Build from directory
node novaapp-cli.js build ./my-app/ --out ./dist/

# Build with obfuscation (closed-source)
node novaapp-cli.js build ./my-app/ --out ./dist/ --obfuscate

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

Apps running inside a sandboxed iframe communicate with the OS via `postMessage`. Every API call follows a request/response pattern: the app sends a message with a `type` and `payload`, and the OS responds on the same channel with a matching `type:response` containing `result` or `error`.

**Request format:**

```javascript
window.parent.postMessage({
  type: 'nova:<category>:<action>',
  payload: { /* API-specific params */ }
}, '*');
```

**Response format:**

```javascript
window.addEventListener('message', (event) => {
  if (event.data.type === 'nova:<category>:<action>:response') {
    if (event.data.error) {
      console.error(event.data.error);
    } else {
      console.log(event.data.result);
    }
  }
});
```

---

#### `nova:ready` — Handshake

Sent by the app on startup to identify itself. The OS responds with app metadata and permissions.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:ready',
  appId: 'com.example.myapp'
}, '*');

// OS → App (response)
{
  success: true,
  appId: 'com.example.myapp',
  permissions: ['fs:read', 'device:notifications'],
  optionalPermissions: ['net:external'],
  osVersion: '3.0.0',
  securityPatch: '2026-05-01'
}
```

---

#### `nova:request-permission` — Request Permission

Requests a permission from the user. Shows a consent dialog if not already granted.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:request-permission',
  permission: 'fs:write',
  reason: 'Need write access to save your documents.',
  permanent: true  // optional, default true
}, '*');

// OS → App (response)
{ granted: true }   // or { granted: false }
```

**Available permissions:**

| Permission | Category | Risk |
|---|---|---|
| `fs:read` | Filesystem | Medium |
| `fs:write` | Filesystem | High |
| `fs:delete` | Filesystem | Critical |
| `fs:metadata` | Filesystem | Low |
| `net:internal` | Network | Low |
| `net:external` | Network | Medium |
| `net:websocket` | Network | Medium |
| `mail:read` | Email | High |
| `mail:write` | Email | Critical |
| `mail:send` | Email | Critical |
| `mail:delete` | Email | High |
| `calendar:read` | Calendar | Medium |
| `calendar:write` | Calendar | High |
| `calendar:delete` | Calendar | High |
| `contacts:read` | Contacts | Medium |
| `contacts:write` | Contacts | High |
| `device:notifications` | Device | Medium |
| `device:geolocation` | Device | High |
| `device:camera` | Device | Critical |
| `device:microphone` | Device | Critical |
| `system:info` | System | Low |
| `system:settings` | System | High |
| `system:apps` | System | High |
| `data:export` | Data | Medium |
| `data:backup` | Data | High |
| `admin:users` | Admin | Critical |
| `admin:system` | Admin | Critical |
| `admin:audit` | Admin | Critical |

---

#### `nova:fs:read` — Read File

Reads a file's content by path or ID.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:fs:read',
  path: '/documents/report.txt'  // or id: 'abc123'
}, '*');

// OS → App (response)
{
  success: true,
  data: 'file contents here...',
  mimeType: 'text/plain',
  name: 'report.txt',
  size: 1024,
  id: 'abc123',
  path: '/documents/report.txt',
  modified: 1715400000000,
  created: 1715300000000
}

// For folders:
{
  success: true,
  isFolder: true,
  name: 'Documents',
  id: 'def456',
  path: '/documents',
  children: [
    { id: 'abc123', name: 'report.txt', type: 'file', mimeType: 'text/plain', size: 1024, modified: 1715400000000, created: 1715300000000 }
  ]
}
```

**Required permission:** `fs:read`

---

#### `nova:fs:write` — Write File

Creates or overwrites a file.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:fs:write',
  path: '/documents/notes.txt',
  content: 'Hello, NovaByte!',
  mimeType: 'text/plain'  // optional
}, '*');

// OS → App (response)
{ success: true, id: 'abc123', path: '/documents/notes.txt' }
```

**Required permission:** `fs:write`

---

#### `nova:fs:delete` — Delete File

Moves a file to Trash by default, or permanently deletes it.

```javascript
// App → OS (trash)
window.parent.postMessage({
  type: 'nova:fs:delete',
  path: '/documents/old-file.txt'
}, '*');

// App → OS (permanent delete)
window.parent.postMessage({
  type: 'nova:fs:delete',
  path: '/documents/old-file.txt',
  permanent: true
}, '*');

// OS → App (response)
{ success: true }
```

**Required permission:** `fs:delete`

---

#### `nova:fs:list` — List Directory

Lists the contents of a folder.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:fs:list',
  path: '/documents'  // or id: 'def456'
}, '*');

// OS → App (response)
{
  success: true,
  path: '/documents',
  files: [
    { id: 'abc123', name: 'report.txt', type: 'file', mimeType: 'text/plain', size: 1024, modified: 1715400000000, created: 1715300000000 },
    { id: 'ghi789', name: 'Photos', type: 'folder', mimeType: 'inode/directory', size: 0, modified: 1715200000000, created: 1715100000000 }
  ]
}
```

**Required permission:** `fs:read`

---

#### `nova:fs:mkdir` — Create Folder

Creates a new folder.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:fs:mkdir',
  name: 'New Project',
  path: '/documents'  // optional, defaults to root
}, '*');

// OS → App (response)
{ success: true, id: 'xyz999', path: '/documents/New Project' }
```

**Required permission:** `fs:write`

---

#### `nova:fs:stat` — File Metadata

Gets metadata for a file or folder without reading its contents.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:fs:stat',
  path: '/documents/report.txt'  // or id: 'abc123'
}, '*');

// OS → App (response)
{
  success: true,
  stat: {
    id: 'abc123', name: 'report.txt', type: 'file',
    mimeType: 'text/plain', size: 1024,
    path: '/documents/report.txt',
    parentId: 'def456',
    created: 1715300000000, modified: 1715400000000, accessed: 1715400000000,
    permissions: { read: true, write: true, execute: false },
    sha256: 'e3b0c44298fc1c149afbf4c8996fb924...',
    tags: []
  }
}
```

**Required permission:** `fs:read`

---

#### `nova:fs:rename` — Rename File/Folder

Renames a file or folder in place.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:fs:rename',
  path: '/documents/old-name.txt',
  name: 'new-name.txt'
}, '*');

// OS → App (response)
{ success: true, name: 'new-name.txt' }
```

**Required permission:** `fs:write`

---

#### `nova:fs:move` — Move File/Folder

Moves a file or folder to a different parent folder.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:fs:move',
  path: '/documents/report.txt',
  destPath: '/archive'
}, '*');

// OS → App (response)
{ success: true, path: '/archive/report.txt' }
```

**Required permission:** `fs:write`

---

#### `nova:notifications:show` — Show Notification

Displays a desktop notification to the user.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:notifications:show',
  title: 'Download Complete',
  body: 'Your file has been downloaded successfully.',
  type: 'success',       // 'info' | 'success' | 'warning' | 'error'
  icon: 'download',      // optional icon
  category: 'download',  // optional category
  action: () => { /* callback */ },       // optional action callback
  actionLabel: 'Open'    // optional action button label
}, '*');

// OS → App (response)
{ success: true }
```

**Required permission:** `device:notifications`

---

#### `nova:notifications:clear` — Clear Notifications

Clears all notifications from the notification panel.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:notifications:clear'
}, '*');

// OS → App (response)
{ success: true }
```

**Required permission:** `device:notifications`

---

#### `nova:settings:get` — Read Setting

Reads a user or system setting value.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:settings:get',
  key: 'theme'
}, '*');

// OS → App (response)
{ success: true, value: 'nova-dark' }
```

No permission required for reading.

---

#### `nova:settings:set` — Write Setting

Writes a user or system setting value.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:settings:set',
  key: 'wallpaper',
  value: 'aurora'
}, '*');

// OS → App (response)
{ success: true }
```

**Required permission:** `system:settings`

---

#### `nova:window:close` — Close Window

Closes the app's own window.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:window:close'
}, '*');

// OS → App (response)
{ success: true }
```

---

#### `nova:window:minimize` — Minimize Window

Minimizes the app's own window.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:window:minimize'
}, '*');

// OS → App (response)
{ success: true }
```

---

#### `nova:window:maximize` — Maximize/Restore Window

Toggles maximization of the app's own window.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:window:maximize'
}, '*');

// OS → App (response)
{ success: true }
```

---

#### `nova:window:setTitle` — Set Window Title

Updates the title bar text.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:window:setTitle',
  title: 'My App — Document 1'
}, '*');

// OS → App (response)
{ success: true }
```

---

#### `nova:window:resize` — Resize Window

Resizes the app's window to the specified dimensions.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:window:resize',
  width: 1024,
  height: 768
}, '*');

// OS → App (response)
{ success: true }
```

---

#### `nova:window:getState` — Get Window State

Retrieves the current window position and state.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:window:getState'
}, '*');

// OS → App (response)
{
  success: true,
  id: 'win-abc123',
  x: 100, y: 50,
  width: 800, height: 600,
  maximized: false,
  minimized: false
}
```

---

#### `nova:clipboard:read` — Read Clipboard

Reads the current clipboard content.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:clipboard:read'
}, '*');

// OS → App (response)
{ success: true, data: 'Copied text content' }
```

---

#### `nova:clipboard:write` — Write Clipboard

Writes text to the system clipboard.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:clipboard:write',
  data: 'Text to copy'
}, '*');

// OS → App (response)
{ success: true }
```

---

#### `nova:app:launch` — Launch Another App

Opens another app by its ID.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:app:launch',
  appId: 'vault',
  options: { width: 900, height: 600 }  // optional
}, '*');

// OS → App (response)
{ success: true, windowId: 'win-xyz789' }
```

---

#### `nova:app:info` — Get App Info

Returns the current app's metadata.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:app:info'
}, '*');

// OS → App (response)
{
  success: true,
  id: 'com.example.myapp',
  name: 'My App',
  version: '1.0.0',
  icon: 'app-window',
  type: 'blank',
  permissions: ['fs:read'],
  optionalPermissions: ['device:notifications']
}
```

---

#### `nova:events:subscribe` / `nova:events:unsubscribe` — Event Bus

Subscribes to or unsubscribes from OS-level events. Events are delivered asynchronously via `nova:events:event` messages.

```javascript
// App → OS (subscribe)
window.parent.postMessage({
  type: 'nova:events:subscribe',
  event: 'settings:changed'
}, '*');

// OS → App (event delivery)
{ type: 'nova:events:event', event: 'settings:changed', data: { key: 'theme', value: 'nova-light' } }

// App → OS (unsubscribe)
window.parent.postMessage({
  type: 'nova:events:unsubscribe',
  event: 'settings:changed'
}, '*');

// OS → App (response)
{ success: true, subscribed: 'settings:changed' }   // subscribe response
{ success: true, unsubscribed: 'settings:changed' } // unsubscribe response
```

**Available events:** `settings:changed`, `fs:created`, `fs:updated`, `fs:deleted`, `fs:moved`, `app:opened`, `app:closed`, `theme:changed`

---

#### `nova:net:fetch` — Network Request

Performs an HTTP request through the OS network layer, respecting network permissions.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:net:fetch',
  url: 'https://api.example.com/data',
  method: 'GET',  // optional, default GET
  headers: { 'Accept': 'application/json' },  // optional
  body: null  // optional
}, '*');

// OS → App (response)
{
  success: true,
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  body: '{"data": "value"}'
}
```

**Required permission:** `net:internal` for internal URLs, `net:external` for external URLs

---

#### `nova:storage:get` / `nova:storage:set` / `nova:storage:delete` / `nova:storage:clear` / `nova:storage:keys` — Per-App Storage

Key-value storage scoped to the individual app.

```javascript
// Set a value
window.parent.postMessage({
  type: 'nova:storage:set',
  key: 'userPrefs',
  value: JSON.stringify({ darkMode: true })
}, '*');

// Get a value
window.parent.postMessage({
  type: 'nova:storage:get',
  key: 'userPrefs'
}, '*');

// OS → App (response)
{ success: true, value: '{"darkMode":true}' }  // get response
{ success: true }                              // set/delete/clear response

// List all keys
window.parent.postMessage({
  type: 'nova:storage:keys'
}, '*');

// OS → App (response)
{ success: true, keys: ['userPrefs', 'lastSync'] }

// Delete a key
window.parent.postMessage({
  type: 'nova:storage:delete',
  key: 'lastSync'
}, '*');
```

No special permissions required — storage is automatically scoped per app ID.

---

#### `nova:device:geolocation` — Geolocation

Requests the device's current geographic position.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:device:geolocation',
  options: { enableHighAccuracy: true, timeout: 10000 }  // optional
}, '*');

// OS → App (response)
{
  success: true,
  coords: {
    latitude: 51.5074,
    longitude: -0.1278,
    altitude: null,
    accuracy: 25,
    altitudeAccuracy: null,
    heading: null,
    speed: null
  },
  timestamp: 1715400000000
}
```

**Required permission:** `device:geolocation`

---

#### `nova:system:info` — System Information

Returns basic OS information.

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:system:info'
}, '*');

// OS → App (response)
{
  success: true,
  os: {
    version: '3.0.0',
    securityPatch: '2026-05-01',
    username: 'user',
    uptime: 3600000
  }
}
```

---

#### `nova:security:check` — Security Patch Check

Checks if the OS meets a minimum security patch level. (Handled by `js/nova-security-api.js`.)

```javascript
// App → OS
window.parent.postMessage({
  type: 'nova:security:check',
  minPatchDate: '2026-04-01',
  reason: 'Required to store encrypted passwords safely.'
}, '*');

// OS → App (response)
{ compliant: true, current: '2026-05-01', required: '2026-04-01' }
```

---

#### `nova:dialog:open` / `nova:dialog:save` — File Picker Dialogs

Opens a native-style file picker dialog for opening or saving files.

```javascript
// App → OS (open)
window.parent.postMessage({
  type: 'nova:dialog:open',
  title: 'Select a document',
  filter: ['.txt', '.md'],  // optional
  accept: 'text/plain'      // optional MIME filter
}, '*');

// App → OS (save)
window.parent.postMessage({
  type: 'nova:dialog:save',
  title: 'Save your document',
  suggestedName: 'report.txt',
  mimeType: 'text/plain',
  content: 'File contents here'
}, '*');

// OS → App (response)
{
  success: true,
  file: {
    id: 'abc123',
    name: 'report.txt',
    content: 'file contents',
    mimeType: 'text/plain',
    size: 1024,
    path: '/documents/report.txt'
  }
}

// Cancelled:
{ success: true, cancelled: true }
```

**Required permissions:** `fs:read` for open, `fs:write` for save

---

### Response Error Codes

| Code | Meaning |
|---|---|
| `PERMISSION_DENIED` | App lacks the required permission |
| `NOT_FOUND` | File or resource does not exist |
| `INVALID_ARGS` | Missing or invalid parameters |
| `INVALID_OPERATION` | Operation not supported for this resource type |
| `UNKNOWN_API` | Unrecognized API type |
| `NETWORK_ERROR` | Network request failed |
| `STORAGE_FULL` | localStorage quota exceeded |
| `GEOLOCATION_ERROR` | Geolocation request failed |
| `INTERNAL_ERROR` | Unexpected OS-side error |
| `ALREADY_SUBSCRIBED` | Already subscribed to this event |
| `WRITE_ERROR` | File write failed |
| `UNAVAILABLE` | Feature not available in this context |

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

## Code Obfuscation

NovaByte OS supports closed-source app distribution through built-in code obfuscation. When the `--obfuscate` flag is passed to the `build` command, the **entire `.novaapp` package file** is obfuscated — not just the JS files inside it. The package is serialised as a JavaScript variable assignment and run through the obfuscator, so the output is obfuscated JS rather than plain JSON.

This means:
- `JSON.parse()` will **fail** on an obfuscated `.novaapp` — this is expected
- The CLI tools (`inspect`, `verify`, `list-actions`) automatically detect the format and use a `vm`-based loader to handle both plain and obfuscated packages
- The NovaByte OS runtime must use the same `vm`-based loader when installing obfuscated packages

### Setup

Install the obfuscator once per development machine:

```bash
npm install javascript-obfuscator
```

### Building a Closed-Source Package

```bash
node novaapp-cli.js build ./my-app/ --out ./dist/ --obfuscate
```

Without `--obfuscate`, the `.novaapp` is plain JSON and file contents can be read by anyone who decodes the Base64 payload. With it, the entire package file is obfuscated JavaScript.

### What Gets Obfuscated

| Scope | Behaviour |
|-------|-----------|
| Entire `.novaapp` file | Wrapped as `var __pkg={...};` and fully obfuscated |
| `.js` files inside the package | Obfuscated before being embedded |
| `.html` / `.htm` files inside the package | Every inline `<script>` block is obfuscated; external `src=` scripts and `type="application/json"` blocks are left untouched |
| All other files | Passed through unchanged (but still buried in the obfuscated output) |

The manifest, signature, and file list are not removed — the OS needs them — but they are obfuscated along with everything else and cannot be read without executing the package JS.

### Loading Obfuscated Packages

The CLI uses a `loadPackage()` helper that tries `JSON.parse` first (standard builds) and falls back to `vm.runInContext` (obfuscated builds). If you are building tooling on top of `.novaapp` files, do the same:

```javascript
const vm = require('vm');

function loadPackage(src) {
  try { return JSON.parse(src); } catch (_) {}
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  return ctx.__pkg;
}
```

### Obfuscation Techniques Applied

The following transformations are applied in a single pass:

- **Identifier renaming** — variable and function names become `_0x1a2b3c`-style hex strings
- **RC4-encrypted string array** — every string literal is extracted into a lookup table and RC4-encrypted; strings are decoded at runtime
- **String splitting** — string literals are further broken into 4-character chunks
- **Control flow flattening** — `if`/`switch`/loop structures are replaced with state-machine dispatchers
- **Dead code injection** — unreachable branches are injected to confuse static analysis tools
- **Debug protection** — a continuous interval polls the debugger; attaching DevTools breaks execution
- **Self-defending** — the output detects code reformatting or prettifying attempts and breaks itself
- **Number expressions** — numeric literals are replaced with equivalent expressions (e.g. `42` → `0x6 * 0x7`)
- **Object key transform** — `obj.key` accesses are rewritten as computed `obj['key']` properties

### When to Use It

- Any app you intend to sell or distribute commercially
- Apps that contain proprietary algorithms or business logic
- Any app where you do not want to share the source code with end users

> **Note:** Obfuscation is not encryption. A sufficiently determined reverse engineer with enough time may still recover some logic. For the strongest protection, combine obfuscation with server-side logic where possible.

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

**Last Updated**: May 2026  
**Version**: 1.1  
**Status**: Beta