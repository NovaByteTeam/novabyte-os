const express = require('express');
const router = express.Router();

router.use((req, res, next) => {
  req.bypassSecurity = true;
  req.bypassRateLimit = true;
  req.skipSentinel = true;
  next();
});

const GITHUB_API = 'https://api.github.com';
const DEFAULT_REPO = 'NovaByteOfficial/novabyte-os';

async function ghFetch(path) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(process.env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    }
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${path}`);
  return res.json();
}

function resolveRepo(repo) {
  return repo || DEFAULT_REPO;
}

router.get('/check', async (req, res) => {
  try {
    const { currentVersion, repo = DEFAULT_REPO, channel = 'stable' } = req.query;
    const releases = await ghFetch(`/repos/${resolveRepo(repo)}/releases`);

    const filtered = (Array.isArray(releases) ? releases : []).filter(r =>
      channel === 'beta' ? r.prerelease : !r.prerelease
    );

    const latest = filtered[0];
    if (!latest) return res.json({ available: false });

    const latestVersion = latest.tag_name.replace(/^v/, '');
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
      repo: resolveRepo(repo)
    });
  } catch (err) {
    res.status(500).json({ available: false, error: err.message });
  }
});

router.get('/diff', async (req, res) => {
  try {
    const { from, to, repo = DEFAULT_REPO } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });

    const data = await ghFetch(`/repos/${resolveRepo(repo)}/compare/${from}...${to}`);

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
      headTag: to
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/releases', async (req, res) => {
  try {
    const { repo = DEFAULT_REPO } = req.query;
    const releases = await ghFetch(`/repos/${resolveRepo(repo)}/releases`);
    res.json((Array.isArray(releases) ? releases : []).map(r => ({
      tag: r.tag_name,
      name: r.name,
      date: r.published_at?.split('T')[0],
      channel: r.prerelease ? 'beta' : 'stable',
      body: r.body
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
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
