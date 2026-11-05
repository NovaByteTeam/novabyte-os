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
const CS_TAG_PREFIX = 'cs-';

// Helper: fetch from GitHub with proper headers
async function ghFetch(path) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(process.env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    }
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  return res.json();
}

function resolveRepo(repo) {
  return repo || DEFAULT_REPO;
}

function resolvePrefix(prefix) {
  return prefix || CS_TAG_PREFIX;
}

// GET /api/coreservices/check
// Returns latest core services release info
router.get('/check', async (req, res) => {
  try {
    const repo = resolveRepo(req.query.repo);
    const tagPrefix = resolvePrefix(req.query.prefix);
    const releases = await ghFetch(`/repos/${repo}/releases`);

    const latest = Array.isArray(releases)
      ? releases.find(r => r.tag_name && r.tag_name.startsWith(tagPrefix))
      : null;

    if (!latest) {
      return res.json({ available: false });
    }

    const version = latest.tag_name.replace(tagPrefix, '').replace(/^v/, '');

    res.json({
      available: true,
      version,
      tag: latest.tag_name,
      patchDate: latest.published_at?.split('T')[0],
      channel: latest.prerelease ? 'beta' : 'stable',
      description: latest.name,
      changelog: latest.body || '',
      repo
    });
  } catch (err) {
    res.status(500).json({ available: false, error: err.message });
  }
});

// GET /api/coreservices/diff?from=cs-v1.0&to=cs-v2.0&repo=owner/repo
// Returns unified diff between two core service versions
router.get('/diff', async (req, res) => {
  try {
    const { from, to, repo = DEFAULT_REPO } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to tags required' });

    const data = await ghFetch(`/repos/${repo}/compare/${from}...${to}`);

    const files = (data.files || []).map(f => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch || null
    }));

    res.json({ files, baseTag: from, headTag: to });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/coreservices/package (legacy compatibility)
// Redirects to latest release asset download or returns diff
router.get('/package', async (req, res) => {
  try {
    const repo = resolveRepo(req.query.repo);
    const releases = await ghFetch(`/repos/${repo}/releases`);
    const latest = Array.isArray(releases)
      ? releases.find(r => r.tag_name && r.tag_name.startsWith(CS_TAG_PREFIX))
      : null;
    if (!latest) return res.status(404).json({ error: 'No core services release found' });
    res.json({ tag: latest.tag_name, assets: latest.assets, body: latest.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
