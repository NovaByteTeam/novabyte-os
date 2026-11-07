import {
  ADMIN_EMAIL,
  MAX_PACKAGE_BYTES,
  PUBLISHED_BUCKET,
  SUBMISSION_BUCKET,
  PublisherError,
  downloadSubmissionBytes,
  escapeHtml,
  getAccountEmail,
  makeSignedDownloadUrl,
  publicPackageUrl,
  queryString,
  requireAdmin,
  rest,
  sendEmail,
  storageRequest,
} from '../_shared/publisher.ts';
import { inspectStudioPlugin, signStudioPlugin } from '../_shared/studio-plugin.ts';

const PLUGIN_ID = /^[a-z0-9][a-z0-9.-]{2,127}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function arrayBuffer(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function requiredText(value: unknown, label: string, maximum: number, minimum = 1) {
  if (typeof value !== 'string') throw new PublisherError(`${label} is required.`);
  const result = value.trim();
  if (result.length < minimum || result.length > maximum) {
    throw new PublisherError(`${label} must be between ${minimum} and ${maximum} characters.`);
  }
  return result;
}

function normalizeSubmission(value: Record<string, unknown>) {
  const pluginId = requiredText(value.pluginId, 'Plugin ID', 128, 3);
  if (!PLUGIN_ID.test(pluginId)) throw new PublisherError('Plugin ID must use lowercase letters, digits, dots, and hyphens.');
  const name = requiredText(value.name, 'Plugin name', 100);
  const publisher = requiredText(value.publisher, 'Publisher name', 80, 2);
  const version = requiredText(value.version, 'Version', 40);
  if (!VERSION.test(version)) throw new PublisherError('Use a valid semantic version such as 1.2.3.');
  const description = requiredText(value.description, 'Description', 500, 10);
  const compatibleStudio = requiredText(value.compatibleStudio, 'Compatible Studio versions', 120);
  const changelog = requiredText(value.changelog, 'Release notes', 2000, 3);
  return { pluginId, name, publisher, version, description, compatibleStudio, changelog };
}

function semverTuple(version: string) {
  const match = VERSION.exec(version);
  if (!match) throw new PublisherError('The plugin package contains an invalid semantic version.');
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : null,
  };
}

function compareVersions(left: string, right: string) {
  const a = semverTuple(left);
  const b = semverTuple(right);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (!a.prerelease || !b.prerelease) {
    if (a.prerelease === b.prerelease) return 0;
    return a.prerelease ? -1 : 1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    if (a.prerelease[index] === b.prerelease[index]) continue;
    const leftNumeric = /^\d+$/.test(a.prerelease[index]);
    const rightNumeric = /^\d+$/.test(b.prerelease[index]);
    if (leftNumeric && rightNumeric) return Number(a.prerelease[index]) > Number(b.prerelease[index]) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return a.prerelease[index] > b.prerelease[index] ? 1 : -1;
  }
  return 0;
}

async function getPluginRow(table: string, column: string, value: string) {
  const result = await rest(table, {
    query: queryString({ select: '*', [column]: `eq.${value}`, limit: '1' }),
  });
  return Array.isArray(result) ? result[0] || null : null;
}

async function getSubmission(id: string) {
  return getPluginRow('publisher_plugin_submissions', 'id', id);
}

function validatePackage(metadata: Record<string, string>, bytes: Uint8Array) {
  const manifest = inspectStudioPlugin(bytes);
  if (manifest.id !== metadata.pluginId || manifest.version !== metadata.version) {
    throw new PublisherError('The plugin.json ID and version must match the submission details.');
  }
  if (manifest.name !== metadata.name) throw new PublisherError('The plugin.json name must match the marketplace listing.');
  const engines = manifest.engines as Record<string, unknown>;
  if (engines.studio !== metadata.compatibleStudio) {
    throw new PublisherError('The marketplace compatibility range must match plugin.json engines.studio.');
  }
  return manifest;
}

export async function submitStudioPlugin(user: { id: string; email?: string }, body: Record<string, unknown>) {
  const id = requiredText(body.submissionId, 'Submission ID', 64);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PublisherError('Invalid submission ID.');
  const submission = body.submission as Record<string, unknown> | undefined;
  if (!submission || typeof submission !== 'object') throw new PublisherError('Submission details are required.');
  const metadata = normalizeSubmission(submission);
  const type = submission.type === 'update' ? 'update' : submission.type === 'new' ? 'new' : null;
  if (!type) throw new PublisherError('Submission type must be new or update.');
  const packagePath = requiredText(submission.packagePath, 'Package upload', 160);
  if (packagePath !== `${user.id}/${id}.nbplugin`) throw new PublisherError('The uploaded plugin does not belong to this account.');

  const owner = await getPluginRow('publisher_plugin_owners', 'plugin_id', metadata.pluginId);
  let published: Record<string, any> | null = null;
  if (type === 'new') {
    if (owner) throw new PublisherError('That plugin ID is already published.');
  } else {
    if (!owner || owner.owner_id !== user.id) throw new PublisherError('You can submit updates only for Studio plugins you own.');
    published = await getPluginRow('publisher_catalog_plugins', 'plugin_id', metadata.pluginId);
    if (!published) throw new PublisherError('This Studio plugin is not currently published.');
    if (compareVersions(metadata.version, published.version) <= 0) {
      throw new PublisherError('An update must use a version newer than the currently published version.');
    }
  }
  const active = await rest('publisher_plugin_submissions', {
    query: queryString({
      select: 'id',
      plugin_id: `eq.${metadata.pluginId}`,
      status: 'in.(pending,changes_requested)',
      limit: '1',
    }),
  });
  if (Array.isArray(active) && active.length) throw new PublisherError('This Studio plugin already has a submission awaiting review.');

  const bytes = await downloadSubmissionBytes(packagePath);
  validatePackage(metadata, bytes);
  const normalizedMetadata = {
    name: metadata.name,
    publisher: metadata.publisher,
    description: metadata.description,
    compatible_studio: metadata.compatibleStudio,
  };
  await rest('publisher_plugin_submissions', {
    method: 'POST',
    body: {
      id,
      owner_id: user.id,
      plugin_id: metadata.pluginId,
      type,
      version: metadata.version,
      metadata: normalizedMetadata,
      changelog: metadata.changelog,
      package_path: packagePath,
      status: 'pending',
    },
  });
  const notification = await sendEmail(
    ADMIN_EMAIL,
    `Studio plugin awaiting review: ${metadata.name} v${metadata.version}`,
    `<p><strong>${escapeHtml(metadata.name)}</strong> (${escapeHtml(metadata.pluginId)}) v${escapeHtml(metadata.version)} is waiting for review.</p><p>Publisher account: ${escapeHtml(user.email || 'unknown')}</p><p>Compatibility: Studio ${escapeHtml(metadata.compatibleStudio)}</p><p>Release notes: ${escapeHtml(metadata.changelog)}</p><p>Open the NovaByte Publisher Portal and select Review submissions.</p>`,
  );
  return {
    submitted: true,
    notificationSent: notification.sent,
    notificationError: notification.sent ? undefined : notification.reason,
  };
}

export async function myStudioPlugins(user: { id: string }) {
  const [owners, submissions] = await Promise.all([
    rest('publisher_plugin_owners', {
      query: queryString({ select: 'plugin_id,created_at', owner_id: `eq.${user.id}`, order: 'created_at.desc' }),
    }),
    rest('publisher_plugin_submissions', {
      query: queryString({
        select: 'id,plugin_id,type,version,metadata,changelog,status,review_note,created_at,reviewed_at',
        owner_id: `eq.${user.id}`,
        status: 'neq.withdrawn',
        order: 'created_at.desc',
      }),
    }),
  ]);
  const ids = Array.isArray(owners) ? owners.map(row => row.plugin_id).filter((value): value is string => typeof value === 'string') : [];
  const plugins = ids.length
    ? await rest('publisher_catalog_plugins', {
      query: queryString({ select: '*', plugin_id: `in.(${ids.join(',')})` }),
    })
    : [];
  return { plugins: Array.isArray(plugins) ? plugins : [], submissions: Array.isArray(submissions) ? submissions : [] };
}

export async function studioPluginReviewQueue(user: { email?: string }) {
  requireAdmin(user);
  const rows = await rest('publisher_plugin_submissions', {
    query: queryString({
      select: 'id,owner_id,plugin_id,type,version,metadata,changelog,status,created_at,package_path,review_package_path,safety_rating',
      status: 'in.(pending,changes_requested)',
      order: 'created_at.asc',
    }),
  });
  const submissions = await Promise.all((Array.isArray(rows) ? rows : []).map(async row => ({
    ...row,
    owner_email: await getAccountEmail(row.owner_id),
    download_url: await makeSignedDownloadUrl(row.package_path, `${row.plugin_id}-${row.version}.nbplugin`),
    has_reviewed_package: Boolean(row.review_package_path),
  })));
  return { submissions };
}

export async function uploadReviewedStudioPlugin(user: { email?: string }, id: string, bytes: Uint8Array) {
  requireAdmin(user);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PublisherError('Invalid submission ID.');
  if (!bytes.length || bytes.byteLength > MAX_PACKAGE_BYTES) {
    throw new PublisherError('The reviewed .nbplugin must be between 1 byte and 25 MB.');
  }
  const submission = await getSubmission(id);
  if (!submission || !['pending', 'changes_requested'].includes(submission.status)) {
    throw new PublisherError('This Studio plugin submission is no longer awaiting review.', 404);
  }
  const metadata = {
    pluginId: submission.plugin_id,
    name: submission.metadata.name,
    version: submission.version,
    compatibleStudio: submission.metadata.compatible_studio,
  };
  validatePackage(metadata, bytes);
  const reviewPath = `${id}/reviewed.nbplugin`;
  await storageRequest(SUBMISSION_BUCKET, reviewPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-upsert': 'true',
      'cache-control': 'no-store',
    },
    body: arrayBuffer(bytes),
  });
  await rest('publisher_plugin_submissions', {
    method: 'PATCH',
    query: queryString({ id: `eq.${id}` }),
    body: { review_package_path: reviewPath },
    prefer: 'return=minimal',
  });
  return { uploaded: true };
}

async function publishStudioPlugin(submission: Record<string, any>) {
  const reviewedBytes = await downloadSubmissionBytes(submission.review_package_path);
  const metadata = {
    pluginId: submission.plugin_id,
    name: submission.metadata.name,
    version: submission.version,
    compatibleStudio: submission.metadata.compatible_studio,
  };
  validatePackage(metadata, reviewedBytes);
  const { bytes, manifest } = await signStudioPlugin(reviewedBytes);
  if (manifest.id !== submission.plugin_id || manifest.version !== submission.version) {
    throw new PublisherError('The signed plugin no longer matches the reviewed submission.');
  }
  const objectPath = `${submission.plugin_id}/${submission.version}.nbplugin`;
  await storageRequest(PUBLISHED_BUCKET, objectPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-upsert': 'true',
      'cache-control': '3600',
    },
    body: arrayBuffer(bytes),
  });
  const metadataRow = submission.metadata;
  const plugin = {
    plugin_id: submission.plugin_id,
    name: metadataRow.name,
    version: submission.version,
    publisher: metadataRow.publisher,
    description: metadataRow.description,
    compatible_studio: metadataRow.compatible_studio,
    file: publicPackageUrl(objectPath),
    size: bytes.byteLength,
    release_notes: submission.changelog,
    published_at: new Date().toISOString(),
  };
  await rest('rpc/commit_publisher_plugin_publish', {
    method: 'POST',
    body: { p_submission_id: submission.id, p_plugin: plugin },
    prefer: 'return=minimal',
  });
  return plugin;
}

export async function reviewStudioPlugin(user: { email?: string }, body: Record<string, unknown>) {
  requireAdmin(user);
  const id = requiredText(body.submissionId, 'Submission ID', 64);
  const decision = body.decision;
  const note = typeof body.reviewNote === 'string' ? body.reviewNote.trim().slice(0, 2000) : '';
  if (!['publish', 'reject', 'request-changes'].includes(String(decision))) {
    throw new PublisherError('Choose publish, reject, or request-changes.');
  }
  if (decision !== 'publish' && !note) throw new PublisherError('Add a reviewer note before requesting changes or rejecting.');
  const safetyRating = body.safetyRating === undefined || body.safetyRating === null ? null : Number(body.safetyRating);
  if (safetyRating !== null && (!Number.isInteger(safetyRating) || safetyRating < 1 || safetyRating > 100)) {
    throw new PublisherError('The safety confidence rating must be a whole number from 1 to 100.');
  }
  if (decision === 'publish' && safetyRating === null) {
    throw new PublisherError('Set a safety confidence rating before publishing.');
  }
  const submission = await getSubmission(id);
  if (!submission || !['pending', 'changes_requested'].includes(submission.status)) {
    throw new PublisherError('This Studio plugin submission is no longer awaiting review.', 404);
  }
  if (decision === 'publish') {
    if (!submission.review_package_path) {
      throw new PublisherError('Upload the inspected .nbplugin before approving this submission.');
    }
    await rest('publisher_plugin_submissions', {
      method: 'PATCH',
      query: queryString({ id: `eq.${id}` }),
      body: { safety_rating: safetyRating },
      prefer: 'return=minimal',
    });
    await publishStudioPlugin(submission);
  } else {
    await rest('publisher_plugin_submissions', {
      method: 'PATCH',
      query: queryString({ id: `eq.${id}` }),
      body: {
        status: decision === 'reject' ? 'rejected' : 'changes_requested',
        reviewed_at: new Date().toISOString(),
        review_note: note,
        ...(safetyRating !== null ? { safety_rating: safetyRating } : {}),
      },
    });
  }
  const recipient = await getAccountEmail(submission.owner_id);
  const label = decision === 'publish' ? 'published' : decision === 'reject' ? 'rejected' : 'needs changes';
  const notification = await sendEmail(
    recipient,
    `NovaByte Studio plugin ${label}: ${submission.plugin_id} v${submission.version}`,
    `<p>Your submission for <strong>${escapeHtml(submission.plugin_id)}</strong> v${escapeHtml(submission.version)} was ${escapeHtml(label)}.</p>${note ? `<p>Reviewer note: ${escapeHtml(note)}</p>` : ''}${decision === 'publish' ? '<p>Your digitally signed plugin is now in the NovaByte Studio Plugins catalog.</p>' : '<p>Sign in to My Studio Plugins to see the review status.</p>'}`,
  );
  return { reviewed: true, notificationSent: notification.sent, notificationError: notification.sent ? undefined : notification.reason };
}

export async function withdrawStudioPlugin(user: { id: string }, body: Record<string, unknown>) {
  const id = requiredText(body.submissionId, 'Submission ID', 64);
  const submission = await getSubmission(id);
  if (!submission || submission.owner_id !== user.id) throw new PublisherError('Submission not found.', 404);
  if (!['pending', 'changes_requested', 'rejected'].includes(submission.status)) {
    throw new PublisherError('This Studio plugin submission can no longer be withdrawn.');
  }
  await rest('publisher_plugin_submissions', {
    method: 'PATCH',
    query: queryString({ id: `eq.${id}` }),
    body: { status: 'withdrawn' },
    prefer: 'return=minimal',
  });
  await storageRequest(SUBMISSION_BUCKET, submission.package_path, { method: 'DELETE' });
  if (submission.review_package_path) {
    await storageRequest(SUBMISSION_BUCKET, submission.review_package_path, { method: 'DELETE' });
  }
  return { withdrawn: true };
}
