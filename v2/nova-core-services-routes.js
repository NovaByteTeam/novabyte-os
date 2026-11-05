/**
 * NovaByte OS — Nova Core Services System Update Routes (GitHub Edition)
 * (nova-core-services-routes.js) v2.0
 *
 * GitHub-based update pipeline for Nova Core Services — the JS-layer runtime
 * components that can be updated without a full OS package release.
 *
 * Unlike the OS updater (auto-update-routes.js) which patches index.html and
 * server-side files, Core Services targets the /js/ folder: nova-security-api,
 * session-manager, update-service, and other runtime modules.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  HOW IT WORKS (GitHub Edition)                                          │
 * │                                                                         │
 * │  1. Developer edits Core Services files and commits to GitHub           │
 * │     Then tags the release: git tag cs-v2026.05.2 && git push --tags    │
 * │                                                                         │
 * │  2. Developer creates a GitHub Release at                              │
 * │     github.com/NovaByteOfficial/novabyte-os/releases/new               │
 * │     Release notes become the changelog shown to users automatically     │
 * │                                                                         │
 * │  3. Clients call GitHub API directly (or via server proxy):            │
 * │     GET /api/coreservices/check                                         │
 * │     ↳ Returns release metadata — no patch payload                      │
 * │                                                                         │
 * │  4. On user confirm, client fetches the diff:                          │
 * │     GET /api/coreservices/diff?from=cs-v1.0&to=cs-v2.0                 │
 * │     ↳ Returns unified diffs for changed files                          │
 * │                                                                         │
 * │  5. Client applies diffs via existing UpdateService.install() pipeline │
 * │     Patched files: only paths under js/ that are in WRITABLE_PATHS    │
 * │                                                                         │
 * │  6. Protected files (fork customizations) are skipped per nova-custom.json │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Mount in server.js:
 *   const coreServicesRoutes = require('./nova-core-services-routes');
 *   app.use('/api/coreservices', coreServicesRoutes);
 *
 * Also add '/api/coreservices/' to the CSRF bypass list in server.js.
 *
 * Environment variables (optional):
 *   GITHUB_TOKEN   — increases rate limit from 60 to 5000 requests/hour
 *                    Useful for private repos or high-traffic deployments.
 */

'use strict';

const express = require('express');
const router = express.Router();

const GITHUB_API = 'https://api.github.com';
const DEFAULT_REPO = 'NovaByteOfficial/novabyte-cs';
const CS_TAG_PREFIX = 'cs-';

// Bypass security middleware — public read endpoints, no authentication required
router.use((req, res, next) => {
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
 * GET /api/coreservices/check[?repo=owner/repo]
 *
 * Returns metadata for the latest Core Services release.
 * Does NOT return the full patch payload — only version info and changelog.
 * Response is lightweight (<2 KB) suitable for frequent polling.
 */
router.get('/check', async (req, res) => {
  try {
    const repo = parseRepoRef(req.query.repo || DEFAULT_REPO);
    const releases = await ghFetch(`/repos/${repo}/releases`);

    // Find latest release whose tag starts with the CS prefix
    const latest = releases.find(r => r.tag_name.startsWith(CS_TAG_PREFIX));

    if (!latest) {
      return res.json({
        available: false,
        repo,
        message: `No Core Services releases found on ${repo}`
      });
    }

    const version = latest.tag_name.replace(CS_TAG_PREFIX, '').replace(/^v/, '');

    res.json({
      available: true,
      version,
      tag: latest.tag_name,
      patchDate: latest.published_at?.split('T')[0],
      channel: latest.prerelease ? 'beta' : 'stable',
      description: latest.name,
      changelog: latest.body || '',
      publishedAt: latest.published_at,
      repo
    });
  } catch (err) {
    console.error('[CoreServices] GET /check error:', err.message);
    console.error('[CoreServices] Full error:', err);
    res.status(500).json({
      available: false,
      error: err.message,
      details: err.stack
    });
  }
});

/**
 * GET /api/coreservices/diff?from=cs-v1.0&to=cs-v2.0&repo=owner/repo
 *
 * Returns unified diffs between two Core Services versions.
 * The 'patch' field on each file IS a standard unified diff.
 * The existing patching logic already handles these diffs.
 */
router.get('/diff', async (req, res) => {
  try {
    const { from, to } = req.query;
    const repo = parseRepoRef(req.query.repo || DEFAULT_REPO);

    if (!from || !to) {
      return res.status(400).json({
        error: 'Missing required query parameters: from and to (tag names)'
      });
    }

    const data = await ghFetch(`/repos/${repo}/compare/${from}...${to}`);

    const files = (data.files || []).map(f => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch || null
    }));

    res.json({
      files,
      totalChanges: files.length,
      baseTag: from,
      headTag: to,
      repo
    });
  } catch (err) {
    console.error('[CoreServices] GET /diff error:', err.message);
    res.status(500).json({
      error: err.message
    });
  }
});

/**
 * GET /api/coreservices/package[?repo=owner/repo]
 *
 * Returns the full release asset list and metadata (for legacy compatibility).
 * Most clients now call /check and /diff directly instead.
 */
router.get('/package', async (req, res) => {
  try {
    const repo = parseRepoRef(req.query.repo || DEFAULT_REPO);
    const releases = await ghFetch(`/repos/${repo}/releases`);

    const latest = releases.find(r => r.tag_name.startsWith(CS_TAG_PREFIX));
    if (!latest) {
      return res.status(404).json({
        error: `No core services release found on ${repo}`
      });
    }

    res.json({
      tag: latest.tag_name,
      name: latest.name,
      assets: latest.assets,
      body: latest.body,
      published_at: latest.published_at
    });
  } catch (err) {
    console.error('[CoreServices] GET /package error:', err.message);
    res.status(500).json({
      error: err.message
    });
  }
});

/**
 * GET /api/coreservices/releases[?repo=owner/repo]
 *
 * Returns list of all Core Services releases for version history UI.
 */
router.get('/releases', async (req, res) => {
  try {
    const repo = parseRepoRef(req.query.repo || DEFAULT_REPO);
    const releases = await ghFetch(`/repos/${repo}/releases`);

    const csReleases = releases
      .filter(r => r.tag_name.startsWith(CS_TAG_PREFIX))
      .map(r => ({
        tag: r.tag_name,
        version: r.tag_name.replace(CS_TAG_PREFIX, '').replace(/^v/, ''),
        name: r.name,
        date: r.published_at?.split('T')[0],
        channel: r.prerelease ? 'beta' : 'stable',
        body: r.body
      }));

    res.json(csReleases);
  } catch (err) {
    console.error('[CoreServices] GET /releases error:', err.message);
    res.status(500).json({
      error: err.message
    });
  }
});

module.exports = router;
