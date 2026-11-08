import {
  ADMIN_EMAIL,
  PUBLISHED_BUCKET,
  SUBMISSION_BUCKET,
  PublisherError,
  TRUSTED_SIGNING_PUBLIC_X as NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY,
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
import {
  CommunityTemplateError,
  MAX_TEMPLATE_JSON_BYTES,
  canonicalJson,
  compareCommunityTemplateVersions,
  encodeCommunityTemplateFiles,
  parseCommunityTemplateJson,
} from '../_shared/community-template.js';

const TEMPLATE_ID = /^[a-z0-9][a-z0-9.-]{2,127}$/;
const encoder = new TextEncoder();

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

function parseTemplate(bytes: Uint8Array) {
  try {
    return parseCommunityTemplateJson(bytes).template;
  } catch (error) {
    if (error instanceof CommunityTemplateError) throw new PublisherError(error.message);
    throw error;
  }
}

function metadataFor(template: Record<string, unknown>) {
  return {
    name: template.name,
    description: template.description,
    author: template.author,
    category: template.category,
    icon: template.icon,
  };
}

function matchMetadata(template: Record<string, unknown>, metadata: Record<string, unknown>) {
  for (const key of ['name', 'description', 'author', 'category', 'icon']) {
    if (template[key] !== metadata[key]) {
      throw new PublisherError(`The reviewed template ${key} must match the submitted listing details.`);
    }
  }
}

async function getRow(table: string, column: string, value: string) {
  const result = await rest(table, {
    query: queryString({ select: '*', [column]: `eq.${value}`, limit: '1' }),
  });
  return Array.isArray(result) ? result[0] || null : null;
}

async function getSubmission(id: string) {
  return getRow('publisher_template_submissions', 'id', id);
}

export async function submitCommunityTemplate(user: { id: string; email?: string }, body: Record<string, unknown>) {
  const id = requiredText(body.submissionId, 'Submission ID', 64);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PublisherError('Invalid submission ID.');
  const submission = body.submission as Record<string, unknown> | undefined;
  if (!submission || typeof submission !== 'object') throw new PublisherError('Submission details are required.');
  const templateId = requiredText(submission.templateId, 'Template ID', 128);
  if (!TEMPLATE_ID.test(templateId)) throw new PublisherError('Template ID must use lowercase letters, digits, dots, and hyphens.');
  const type = submission.type === 'update' ? 'update' : submission.type === 'new' ? 'new' : null;
  if (!type) throw new PublisherError('Submission type must be new or update.');
  const packagePath = requiredText(submission.packagePath, 'Template upload', 180);
  if (packagePath !== `${user.id}/${id}.nbtemplate.json`) {
    throw new PublisherError('The uploaded template does not belong to this account.');
  }

  const owner = await getRow('publisher_template_owners', 'template_id', templateId);
  const existing = type === 'new' ? await getRow('publisher_catalog_templates', 'template_id', templateId) : null;
  if (type === 'new' && (owner || existing)) throw new PublisherError('That community template ID is already published.');
  if (type === 'update' && (!owner || owner.owner_id !== user.id)) {
    throw new PublisherError('You can submit updates only for community templates you own.');
  }
  const published = type === 'update' ? await getRow('publisher_catalog_templates', 'template_id', templateId) : null;
  if (type === 'update' && !published) throw new PublisherError('This community template is not currently published.');

  const bytes = await downloadSubmissionBytes(packagePath);
  if (bytes.byteLength > MAX_TEMPLATE_JSON_BYTES) throw new PublisherError('The template JSON must be no larger than 4 MiB.');
  const template = parseTemplate(bytes);
  if (type === 'update') {
    try {
      if (compareCommunityTemplateVersions(template.releaseVersion as string, published.version) <= 0) {
        throw new PublisherError('An update must use a releaseVersion newer than the currently published template.');
      }
    } catch (error) {
      if (error instanceof CommunityTemplateError) throw new PublisherError(error.message);
      throw error;
    }
  }
  const active = await rest('publisher_template_submissions', {
    query: queryString({
      select: 'id',
      template_id: `eq.${templateId}`,
      status: 'in.(pending,changes_requested)',
      limit: '1',
    }),
  });
  if (Array.isArray(active) && active.length) {
    throw new PublisherError('This community template already has a submission awaiting review.');
  }
  await rest('publisher_template_submissions', {
    method: 'POST',
    body: {
      id,
      owner_id: user.id,
      template_id: templateId,
      type,
      version: template.releaseVersion,
      metadata: metadataFor(template),
      package_path: packagePath,
      status: 'pending',
    },
  });
  const notification = await sendEmail(
    ADMIN_EMAIL,
    `Community template awaiting review: ${escapeHtml(String(template.name))} v${escapeHtml(String(template.releaseVersion))}`,
    `<p><strong>${escapeHtml(String(template.name))}</strong> (${escapeHtml(templateId)}) v${escapeHtml(String(template.releaseVersion))} is waiting for human review.</p><p>Publisher account: ${escapeHtml(user.email || 'unknown')}</p><p>Open the NovaByte Publisher Portal and select Review submissions.</p>`,
  );
  return {
    submitted: true,
    notificationSent: notification.sent,
    notificationError: notification.sent ? undefined : notification.reason,
  };
}

export async function myCommunityTemplates(user: { id: string }) {
  const [owners, submissions] = await Promise.all([
    rest('publisher_template_owners', {
      query: queryString({ select: 'template_id,created_at', owner_id: `eq.${user.id}`, order: 'created_at.desc' }),
    }),
    rest('publisher_template_submissions', {
      query: queryString({
        select: 'id,template_id,type,version,metadata,status,review_note,created_at,reviewed_at',
        owner_id: `eq.${user.id}`,
        status: 'neq.withdrawn',
        order: 'created_at.desc',
      }),
    }),
  ]);
  const ids = Array.isArray(owners)
    ? owners.map(row => row.template_id).filter((value): value is string => typeof value === 'string')
    : [];
  const templates = ids.length
    ? await rest('publisher_catalog_templates', {
      query: queryString({ select: '*', template_id: `in.(${ids.join(',')})` }),
    })
    : [];
  return {
    templates: Array.isArray(templates) ? templates : [],
    submissions: Array.isArray(submissions) ? submissions : [],
  };
}

export async function communityTemplateReviewQueue(user: { email?: string }) {
  requireAdmin(user);
  const rows = await rest('publisher_template_submissions', {
    query: queryString({
      select: 'id,owner_id,template_id,type,version,metadata,status,created_at,package_path,review_package_path',
      status: 'in.(pending,changes_requested)',
      order: 'created_at.asc',
    }),
  });
  const submissions = await Promise.all((Array.isArray(rows) ? rows : []).map(async row => ({
    ...row,
    owner_email: await getAccountEmail(row.owner_id),
    download_url: await makeSignedDownloadUrl(
      row.package_path,
      `${row.template_id}-${row.version}.nbtemplate.json`,
    ),
    has_reviewed_package: Boolean(row.review_package_path),
  })));
  return { submissions };
}

export async function uploadReviewedCommunityTemplate(
  user: { email?: string },
  id: string,
  bytes: Uint8Array,
) {
  requireAdmin(user);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PublisherError('Invalid submission ID.');
  if (!bytes.length || bytes.byteLength > MAX_TEMPLATE_JSON_BYTES) {
    throw new PublisherError('The reviewed template JSON must be between 1 byte and 4 MiB.');
  }
  const submission = await getSubmission(id);
  if (!submission || !['pending', 'changes_requested'].includes(submission.status)) {
    throw new PublisherError('This community template submission is no longer awaiting review.', 404);
  }
  const template = parseTemplate(bytes);
  if (template.releaseVersion !== submission.version) {
    throw new PublisherError('The reviewed template releaseVersion must match the submitted version.');
  }
  matchMetadata(template, submission.metadata);
  const reviewPath = `${id}/reviewed.nbtemplate.json`;
  await storageRequest(SUBMISSION_BUCKET, reviewPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-upsert': 'true',
      'cache-control': 'no-store',
    },
    body: arrayBuffer(bytes),
  });
  await rest('publisher_template_submissions', {
    method: 'PATCH',
    query: queryString({ id: `eq.${id}` }),
    body: { review_package_path: reviewPath },
    prefer: 'return=minimal',
  });
  return { uploaded: true };
}

async function signCommunityTemplate(template: Record<string, unknown>) {
  const privateKeyText = Deno.env.get('NOVABYTE_SIGNING_PRIVATE_JWK');
  if (!privateKeyText) {
    throw new PublisherError('NovaByte trusted signing is not configured. Publishing is disabled.', 503);
  }
  let privateJwk: JsonWebKey;
  try {
    privateJwk = JSON.parse(privateKeyText);
  } catch {
    throw new PublisherError('The trusted signing key configuration is invalid.', 503);
  }
  if (privateJwk.kty !== 'OKP' || privateJwk.crv !== 'Ed25519'
    || typeof privateJwk.d !== 'string' || privateJwk.x !== NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY) {
    throw new PublisherError('The configured signing key does not match NovaByte Trusted Signing.', 503);
  }
  const unsigned = {
    format: 'novapack-studio-user-template',
    version: 1,
    template: encodeCommunityTemplateFiles(template as {
      files: Record<string, string>;
      [key: string]: unknown;
    }),
  };
  const payload = encoder.encode(canonicalJson(unsigned));
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'Ed25519' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, payload));
  const verifyKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', x: NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY },
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  if (!await crypto.subtle.verify({ name: 'Ed25519' }, verifyKey, signature, payload)) {
    throw new PublisherError('The signing key failed its self-check; the template was not published.', 503);
  }
  let binary = '';
  for (const byte of signature) binary += String.fromCharCode(byte);
  return {
    ...unsigned,
    signature: {
      algorithm: 'Ed25519',
      publicKey: NOVABYTE_TEMPLATE_SIGNING_PUBLIC_KEY,
      signature: btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''),
    },
  };
}

async function publishCommunityTemplate(submission: Record<string, any>) {
  const reviewedBytes = await downloadSubmissionBytes(submission.review_package_path);
  if (reviewedBytes.byteLength > MAX_TEMPLATE_JSON_BYTES) {
    throw new PublisherError('The reviewed template JSON exceeds the 4 MiB limit.');
  }
  const template = parseTemplate(reviewedBytes);
  if (template.releaseVersion !== submission.version) {
    throw new PublisherError('The reviewed template no longer matches the submitted version.');
  }
  matchMetadata(template, submission.metadata);

  const previous = await getRow('publisher_catalog_templates', 'template_id', submission.template_id);
  if (submission.type === 'new' && previous) {
    throw new PublisherError('This template ID was published while the submission was under review.');
  }
  if (submission.type === 'update') {
    if (!previous) throw new PublisherError('The community template is no longer published.');
    try {
      if (compareCommunityTemplateVersions(submission.version, previous.version) <= 0) {
        throw new PublisherError('The reviewed template version is no longer newer than the published version.');
      }
    } catch (error) {
      if (error instanceof CommunityTemplateError) throw new PublisherError(error.message);
      throw error;
    }
  }

  const signedPackage = await signCommunityTemplate(template);
  const packageBytes = encoder.encode(JSON.stringify(signedPackage));
  if (packageBytes.byteLength > MAX_TEMPLATE_JSON_BYTES) {
    throw new PublisherError('The signed template JSON exceeds the 4 MiB publishing limit.');
  }
  const path = `${submission.template_id}/${submission.version}.nbtemplate`;
  await storageRequest(PUBLISHED_BUCKET, path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-upsert': 'true',
      'cache-control': '3600',
    },
    body: arrayBuffer(packageBytes),
  });
  const metadata = submission.metadata;
  const row = {
    template_id: submission.template_id,
    name: metadata.name,
    version: submission.version,
    author: metadata.author,
    description: metadata.description,
    category: metadata.category,
    file: publicPackageUrl(path),
    size: packageBytes.byteLength,
    published_at: new Date().toISOString(),
  };
  await rest('rpc/commit_publisher_template_publish', {
    method: 'POST',
    body: { p_submission_id: submission.id, p_template: row },
    prefer: 'return=minimal',
  });
  return row;
}

export async function reviewCommunityTemplate(user: { email?: string }, body: Record<string, unknown>) {
  requireAdmin(user);
  const id = requiredText(body.submissionId, 'Submission ID', 64);
  const decision = body.decision;
  const note = typeof body.reviewNote === 'string' ? body.reviewNote.trim().slice(0, 2000) : '';
  if (!['publish', 'reject', 'request-changes'].includes(String(decision))) {
    throw new PublisherError('Choose publish, reject, or request-changes.');
  }
  if (decision !== 'publish' && !note) {
    throw new PublisherError('Add a reviewer note before requesting changes or rejecting.');
  }
  const submission = await getSubmission(id);
  if (!submission || !['pending', 'changes_requested'].includes(submission.status)) {
    throw new PublisherError('This community template submission is no longer awaiting review.', 404);
  }
  if (decision === 'publish') {
    if (!submission.review_package_path) {
      throw new PublisherError('Upload the exact inspected template JSON before approving this submission.');
    }
    await publishCommunityTemplate(submission);
  } else {
    await rest('publisher_template_submissions', {
      method: 'PATCH',
      query: queryString({ id: `eq.${id}` }),
      body: {
        status: decision === 'reject' ? 'rejected' : 'changes_requested',
        reviewed_at: new Date().toISOString(),
        review_note: note,
      },
    });
  }
  const recipient = await getAccountEmail(submission.owner_id);
  const label = decision === 'publish' ? 'published' : decision === 'reject' ? 'rejected' : 'needs changes';
  const notification = await sendEmail(
    recipient,
    `NovaByte community template ${label}: ${escapeHtml(submission.template_id)} v${escapeHtml(submission.version)}`,
    `<p>Your submission for <strong>${escapeHtml(submission.template_id)}</strong> v${escapeHtml(submission.version)} was ${escapeHtml(label)}.</p>${note ? `<p>Reviewer note: ${escapeHtml(note)}</p>` : ''}${decision === 'publish' ? '<p>NovaByte reviewed and signed your community template. It is now available in the Studio template catalog.</p>' : '<p>Sign in to My Community Templates to see the review status.</p>'}`,
  );
  return {
    reviewed: true,
    notificationSent: notification.sent,
    notificationError: notification.sent ? undefined : notification.reason,
  };
}

export async function withdrawCommunityTemplate(user: { id: string }, body: Record<string, unknown>) {
  const id = requiredText(body.submissionId, 'Submission ID', 64);
  const submission = await getSubmission(id);
  if (!submission || submission.owner_id !== user.id) throw new PublisherError('Submission not found.', 404);
  if (!['pending', 'changes_requested', 'rejected'].includes(submission.status)) {
    throw new PublisherError('This community template submission can no longer be withdrawn.');
  }
  await rest('publisher_template_submissions', {
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
