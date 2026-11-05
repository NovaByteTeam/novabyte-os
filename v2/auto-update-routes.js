/**
 * NovaByte OS — Auto-Update Channel Routes (GitHub Edition) (auto-update-routes.js) v2.0
 *
 * GitHub-based zero-touch "push once, all clients update" channel.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  HOW IT WORKS (GitHub Edition)                                          │
 * │                                                                         │
 * │  1.  Developer edits OS files, commits, and tags:                       │
 * │       git tag v2026.05.3 && git push --tags                             │
 * │                                                                         │
 * │  2.  Developer creates a GitHub Release at:                             │
 * │       github.com/NovaByteOfficial/novabyte-os/releases/new              │
 * │       Selects the tag, writes release notes → publishes                 │
 * │                                                                         │
 * │  3.  Every client polls GET /api/updates/check every N minutes.         │
 * │       The response is just metadata (<2 KB) — no patch payload yet.      │
 * │                                                                         │
 * │  4.  When client sees a newer version it shows a notification.          │
 * │       On user confirm (or silently if autoInstall=true):                │
 * │       Client fetches GET /api/updates/diff and runs                     │
 * │       UpdateService.install() with the returned diffs.                  │
 * │                                                                         │
 * │  5.  The existing validate/write-file/rollback pipeline is reused.      │
 * │       Protected files are skipped per nova-custom.json.                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Mount in server.js:
 *   const autoUpdateRoutes = require('./auto-update-routes');
 *   app.use('/api/updates', autoUpdateRoutes);
 *   app.use('/api/autoupdate', autoUpdateRoutes); // for backwards compatibility
 *
 * Environment variables (optional):
 *   GITHUB_TOKEN   — increases rate limit from 60 to 5000 requests/hour
 */

'use strict';

const express = require('express');
const router = express.Router();

const GITHUB_API = 'https://api.github.com';
const DEFAULT_REPO = 'NovaByteOfficial/novabyte-os';

// Bypass all security middleware for this router - public endpoints
router.use((req, res, next) => {
  console.log('[AutoUpdate] REQUEST DEBUG:');
  console.log('  - URL:', req.url);
  console.log('  - originalUrl:', req.originalUrl);
  console.log('  - query object:', req.query);
  console.log('  - query keys:', Object.keys(req.query));
  console.log('  - _parsedUrl:', req._parsedUrl);
  req.bypassSecurity = true;
  req.bypassRateLimit = true;
  req.skipSentinel = true;
  next();
});

/**
 * Helper: Parse repo reference and strip branch suffix (e.g., "owner/repo:branch" → "owner/repo")
 */
function parseRepoRef(repoRef) {
  return repoRef ? repoRef.split(':')[0] : repoRef;
}

/**
 * Helper: Fetch from GitHub API with proper headers and error handling
 */
async function ghFetch(path) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(process.env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    }
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`GitHub API error ${res.status}: ${path} - ${errText}`);
  }
  return res.json();
}

/**
 * GET /api/updates/check[?currentVersion=2026.05.1&repo=owner/repo&channel=stable]
 * GET /api/autoupdate/check (backwards compatibility)
 *
 * Lightweight poll endpoint — returns only metadata, never the full package.
 * Clients call this every N minutes. Response is <2 KB.
 */
router.get('/check', async (req, res) => {
  try {
    console.log('[AutoUpdate] GET /check - full query:', req.query);
    const { currentVersion, repo, channel = 'stable' } = req.query;
    const parsedRepo = parseRepoRef(repo || DEFAULT_REPO);
    console.log('[AutoUpdate] GET /check - repo param:', repo, '-> parsed:', parsedRepo);
    const releases = await ghFetch(`/repos/${parsedRepo}/releases`);

    // Filter by channel: stable = non-prerelease, beta = prerelease
    const filtered = releases.filter(r =>
      channel === 'beta' ? r.prerelease : !r.prerelease
    );

    const latest = filtered[0];
    if (!latest) {
      return res.json({
        available: false,
        repo: parsedRepo,
        channel,
        message: `No updates available on ${parsedRepo} (${channel})`
      });
    }

    const latestVersion = latest.tag_name.replace(/^v/, '');

    // Simple semver/date-version comparison
    const available = currentVersion ? latestVersion !== currentVersion : true;

    res.json({
      available,
      currentVersion,
      latestVersion,
      tag: latest.tag_name,
      patchDate: latest.published_at?.split('T')[0],
      channel: latest.prerelease ? 'beta' : 'stable',
      title: latest.name,
      changelog: latest.body || '',
      publishedAt: latest.published_at,
      repo: parsedRepo
    });
  } catch (err) {
    console.error('[AutoUpdate] GET /check error:', err.message);
    console.error('[AutoUpdate] Full error:', err);
    res.status(500).json({
      available: false,
      error: err.message,
      details: err.stack
    });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   GET /api/autoupdate/package[?channel=stable]
   ─────────────────────────────────────────────────────────────────────────────
   Returns the full signed package JSON so the client can run
   UpdateService.install(pkg).  Only called after the user confirms install.
   ───────────────────────────────────────────────────────────────────────────── */
router.get('/package', async (req, res) => {
  try {
    const repo = parseRepoRef(req.query.repo || DEFAULT_REPO);
    const releases = await ghFetch(`/repos/${repo}/releases`);
    const latest = releases[0];
    if (!latest) {
      return res.status(404).json({ error: `No releases found on ${repo}` });
    }
    res.json({
      tag: latest.tag_name,
      name: latest.name,
      assets: latest.assets,
      body: latest.body,
      published_at: latest.published_at
    });
  } catch (err) {
    console.error('[AutoUpdate] GET /package error:', err.message);
    res.status(500).json({
      error: err.message
    });
  }
});

/**
 * GET /api/updates/diff?from=v2026.05.1&to=v2026.05.3&repo=owner/repo
 */
router.get('/diff', async (req, res) => {
  try {
    const { from, to, repo } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to required' });
    }

    const parsedRepo = parseRepoRef(repo || DEFAULT_REPO);
    const data = await ghFetch(`/repos/${parsedRepo}/compare/${from}...${to}`);

    res.json({
      files: (data.files || []).map(f => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch || null
      })),
      totalChanges: data.files?.length || 0,
      baseTag: from,
      headTag: to,
      repo: parsedRepo
    });
  } catch (err) {
    console.error('[AutoUpdate] GET /diff error:', err.message);
    res.status(500).json({
      error: err.message
    });
  }
});

/**
 * GET /api/updates/releases[?repo=owner/repo]
 */
router.get('/releases', async (req, res) => {
  try {
    const repo = parseRepoRef(req.query.repo || DEFAULT_REPO);
    const releases = await ghFetch(`/repos/${repo}/releases`);
    res.json(releases.map(r => ({
      tag: r.tag_name,
      name: r.name,
      date: r.published_at?.split('T')[0],
      channel: r.prerelease ? 'beta' : 'stable',
      body: r.body
    })));
  } catch (err) {
    console.error('[AutoUpdate] GET /releases error:', err.message);
    res.status(500).json({
      error: err.message
    });
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
   CORE SERVICES AUTO-UPDATE ROUTES
   ─────────────────────────────────────────────────────────────────────────────
   Pulls CS updates from the public novabyte-cs GitHub releases repo.
   No token required — repo is public. Works for every fork and git clone.

   Set CS_PUBLIC_REPO in your .env:
     CS_PUBLIC_REPO=YOUR_GITHUB_USERNAME/novabyte-cs

   GET /api/autoupdate/cs/check[?channel=stable&version=2026.05.1]
   GET /api/autoupdate/cs/package[?channel=stable]
   ───────────────────────────────────────────────────────────────────────────── */

const CS_PUBLIC_REPO = process.env.CS_PUBLIC_REPO || 'YOUR_GITHUB_USERNAME/novabyte-cs';

async function fetchCsReleases(channel) {
    const headers = {
        'Accept':     'application/vnd.github+json',
        'User-Agent': 'NovaByte-UpdateClient/1.0',
    };
    // Use GITHUB_TOKEN if available (raises rate limit from 60 to 5000 req/hr)
    if (process.env.GITHUB_TOKEN) {
        headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const url = `${GITHUB_API}/repos/${CS_PUBLIC_REPO}/releases`;
    const res  = await fetch(url, { headers });

    if (!res.ok) {
        throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
    }

    const releases = await res.json();

    // stable = latest non-prerelease, beta = latest prerelease
    if (channel === 'beta') {
        return releases.find(r => r.prerelease && r.tag_name.startsWith('cs-v')) || null;
    }
    return releases.find(r => !r.prerelease && !r.draft && r.tag_name.startsWith('cs-v')) || null;
}

/* ── GET /api/autoupdate/cs/check ─────────────────────────────────────────── */
router.get('/cs/check', async (req, res) => {
    const channel       = VALID_CHANNELS.has(req.query.channel)
        ? req.query.channel
        : (process.env.UPDATE_CHANNEL || 'stable');
    const clientVersion = req.query.version || '0.0.0';

    try {
        const release = await fetchCsReleases(channel);

        if (!release) {
            return res.json({ available: false, channel, message: `No CS updates on the ${channel} channel` });
        }

        // Tag is cs-vX.Y.Z — strip the prefix to get the semver
        const serverVersion = release.tag_name.replace(/^cs-v/, '');
        const available     = semverGt(serverVersion, clientVersion);

        audit(req, 'cs-check', { channel, clientVersion, serverVersion, available });

        res.json({
            available,
            channel,
            version:     serverVersion,
            publishedAt: release.published_at,
            changelog:   release.body || '',
            // Direct URL to the cs-package.json asset (client can verify size)
            assetUrl:    release.assets.find(a => a.name === 'cs-package.json')?.browser_download_url || null,
            sizeBytes:   release.assets.find(a => a.name === 'cs-package.json')?.size || 0,
        });
    } catch (err) {
        console.error('[AutoUpdate] CS check failed:', err.message);
        res.status(502).json({ error: 'Could not reach CS update server', detail: err.message });
    }
});

/* ── GET /api/autoupdate/cs/package ───────────────────────────────────────── */
router.get('/cs/package', async (req, res) => {
    const channel = VALID_CHANNELS.has(req.query.channel)
        ? req.query.channel
        : (process.env.UPDATE_CHANNEL || 'stable');

    try {
        const release = await fetchCsReleases(channel);

        if (!release) {
            return res.status(404).json({ error: `No CS package on the ${channel} channel` });
        }

        const asset = release.assets.find(a => a.name === 'cs-package.json');
        if (!asset) {
            return res.status(404).json({ error: 'cs-package.json asset not found in release' });
        }

        // Fetch the actual package JSON from GitHub and proxy it to the client
        const pkgRes = await fetch(asset.browser_download_url, {
            headers: { 'User-Agent': 'NovaByte-UpdateClient/1.0' },
        });

        if (!pkgRes.ok) {
            throw new Error(`Failed to fetch package asset: ${pkgRes.status}`);
        }

        const pkg = await pkgRes.json();

        audit(req, 'cs-package-download', {
            channel,
            version: release.tag_name.replace(/^cs-v/, ''),
        });

        res.json(pkg);
    } catch (err) {
        console.error('[AutoUpdate] CS package fetch failed:', err.message);
        res.status(502).json({ error: 'Could not fetch CS package', detail: err.message });
    }
});

module.exports = router;