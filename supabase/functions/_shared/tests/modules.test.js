// Smoke test: every Edge Function action module must load under the Deno shim
// and export the full action surface the site's client depends on. This
// catches broken imports and syntax errors across the TypeScript sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../tests/deno-shim.mjs';

const publisher = await import('../publisher.ts');
const validation = await import('../validation.js');
const studioPlugins = await import('../../publisher-api/studio-plugins.ts');
const communityTemplates = await import('../../publisher-api/community-templates.ts');

test('publisher.ts exports the shared infrastructure surface', () => {
  for (const name of [
    'ADMIN_EMAIL', 'MAX_PACKAGE_BYTES', 'PUBLISHED_BUCKET', 'SUBMISSION_BUCKET',
    'TRUSTED_SIGNING_PUBLIC_X', 'PublisherError', 'corsHeaders', 'respond',
    'errorResponse', 'requiredEnv', 'rest', 'queryString', 'getUser',
    'requireAdmin', 'encodePath', 'storageRequest', 'downloadSubmission',
    'downloadSubmissionBytes', 'downloadPublishedPackage', 'deleteSubmissionQuietly',
    'makeSignedDownloadUrl', 'sendEmail', 'getAccountEmail', 'escapeHtml',
    'publicPackageUrl', 'signAndVerifyPackage', 'signPackageWithJwk',
    'fetchWithTimeout', 'patchStatusGuarded', 'countActiveSubmissions',
    'assertSubmissionQuota', 'assertNoActiveSubmission',
  ]) {
    assert.ok(name in publisher, `publisher.ts must export ${name}`);
  }
});

test('validation.js exports the pure rule surface', () => {
  for (const name of [
    'UUID_PATTERN', 'APP_ID_PATTERN', 'LISTING_ID_PATTERN', 'VERSION_PATTERN',
    'ACTIVE_SUBMISSION_STATUSES', 'WITHDRAWABLE_APP_STATUSES',
    'WITHDRAWABLE_LISTING_STATUSES', 'MAX_ACTIVE_SUBMISSIONS_PER_USER',
    'ValidationError', 'requiredText', 'assertSubmissionId', 'assertAppId',
    'assertListingId', 'parseVersion', 'compareVersions', 'validateLinks',
    'normalizeCategories', 'normalizeNewMetadata', 'isSafePackagePath',
    'isCanonicalBase64', 'assertSafePackageFiles', 'screenshotReferences',
    'packageScreenshots', 'preserveSubmissionScreenshots', 'missingPackageScreenshots',
    'readBoundedBody', 'readJsonBody', 'escapeHtml',
  ]) {
    assert.ok(name in validation, `validation.js must export ${name}`);
  }
});

test('studio-plugins.ts and community-templates.ts export every action handler', () => {
  for (const name of [
    'submitStudioPlugin', 'myStudioPlugins', 'studioPluginReviewQueue',
    'uploadReviewedStudioPlugin', 'reviewStudioPlugin', 'withdrawStudioPlugin',
  ]) {
    assert.equal(typeof studioPlugins[name], 'function', `studio-plugins.ts ${name}`);
  }
  for (const name of [
    'submitCommunityTemplate', 'myCommunityTemplates', 'communityTemplateReviewQueue',
    'uploadReviewedCommunityTemplate', 'reviewCommunityTemplate', 'withdrawCommunityTemplate',
  ]) {
    assert.equal(typeof communityTemplates[name], 'function', `community-templates.ts ${name}`);
  }
});
