import {
  ADMIN_EMAIL,
  MAX_PACKAGE_BYTES,
  PUBLISHED_BUCKET,
  SUBMISSION_BUCKET,
  PublisherError,
  corsHeaders,
  downloadSubmission,
  errorResponse,
  escapeHtml,
  getAccountEmail,
  getUser,
  makeSignedDownloadUrl,
  publicPackageUrl,
  queryString,
  requireAdmin,
  requiredEnv,
  respond,
  rest,
  sendEmail,
  signAndVerifyPackage,
  storageRequest,
} from '../_shared/publisher.ts';

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
const STATIC_CATALOG_URL = Deno.env.get('PUBLIC_CATALOG_URL')
  || 'https://novabyteteam.github.io/novabyte-os/apps.json';
const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,119}$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function requiredText(value: unknown, label: string, maximum: number, minimum = 1) {
  if (typeof value !== 'string') throw new PublisherError(`${label} is required.`);
  const result = value.trim();
  if (result.length < minimum || result.length > maximum) {
    throw new PublisherError(`${label} must be between ${minimum} and ${maximum} characters.`);
  }
  return result;
}

function parseVersion(version: string) {
  const match = version.match(VERSION_PATTERN);
  if (!match) throw new PublisherError('Use a valid semantic version such as 1.2.3.');
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : null,
  };
}

function compareVersions(left: string, right: string) {
  const a = parseVersion(left);
  const b = parseVersion(right);
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

function validateLinks(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!['website', 'source', 'support'].includes(key) || typeof raw !== 'string' || !raw.trim()) continue;
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      throw new PublisherError(`${key} must be a valid HTTPS URL.`);
    }
    if (url.protocol !== 'https:') throw new PublisherError(`${key} must use HTTPS.`);
    result[key] = url.href;
  }
  return result;
}

function normalizeNewMetadata(value: Record<string, unknown>) {
  const name = requiredText(value.name, 'App name', 80, 2);
  const appId = requiredText(value.appId, 'App ID', 120, 2);
  if (!APP_ID_PATTERN.test(appId)) throw new PublisherError('App ID may contain lowercase letters, digits, dots, underscores, and hyphens.');
  const author = requiredText(value.author, 'Publisher name', 80, 2);
  const version = requiredText(value.version, 'Version', 40);
  parseVersion(version);
  const description = requiredText(value.description, 'Description', 1000, 20);
  const changelog = requiredText(value.changelog, 'Release notes', 4000, 3);
  const rawCategories: unknown[] = Array.isArray(value.categories) ? value.categories : [];
  if (!rawCategories.length || rawCategories.length > 8) {
    throw new PublisherError('Add between one and eight valid categories.');
  }
  const categories = [...new Set(rawCategories.map(item => {
    if (typeof item !== 'string') throw new PublisherError('Categories must be text values.');
    return item.toLowerCase().trim().replace(/[\s_]+/g, '-');
  }))];
  if (categories.some(item => !/^[a-z0-9-]{2,32}$/.test(item))) {
    throw new PublisherError('Categories may contain lowercase letters, numbers, and hyphens.');
  }
  return { appId, name, author, version, description, categories, links: validateLinks(value.links), changelog };
}

async function loadStaticAppIds() {
  let response: Response;
  try {
    response = await fetch(STATIC_CATALOG_URL, { cache: 'no-store' });
  } catch (error) {
    console.error('[publisher-api] Static catalog lookup failed:', error);
    throw new PublisherError('Could not confirm whether this app ID is already in use. Try again later.', 502);
  }
  if (!response.ok) throw new PublisherError('Could not confirm whether this app ID is already in use.', 502);
  const catalog: unknown = await response.json();
  if (!Array.isArray(catalog)) throw new PublisherError('The current app catalog is invalid.', 502);
  return new Set(catalog.flatMap(app => app && typeof app.id === 'string' ? [app.id] : []));
}

async function getOne(table: string, key: string, value: string) {
  const result = await rest(table, {
    query: queryString({ select: '*', [key]: `eq.${value}`, limit: '1' }),
  });
  return Array.isArray(result) ? result[0] || null : null;
}

async function submit(user: { id: string; email?: string }, body: Record<string, unknown>) {
  const id = requiredText(body.submissionId, 'Submission ID', 64);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PublisherError('Invalid submission ID.');
  const submission = body.submission as Record<string, unknown> | undefined;
  if (!submission || typeof submission !== 'object') throw new PublisherError('Submission details are required.');
  const packagePath = requiredText(submission.packagePath, 'Package upload', 160);
  if (packagePath !== `${user.id}/${id}.novaapp`) throw new PublisherError('The uploaded package does not belong to this account.');

  const type = submission.type === 'update' ? 'update' : submission.type === 'new' ? 'new' : null;
  if (!type) throw new PublisherError('Submission type must be new or update.');
  const appId = requiredText(submission.appId, 'App ID', 120, 2);
  if (!APP_ID_PATTERN.test(appId)) throw new PublisherError('App ID may contain lowercase letters, digits, dots, underscores, and hyphens.');
  const version = requiredText(submission.version, 'Version', 40);
  parseVersion(version);
  const changelog = requiredText(submission.changelog, 'Release notes', 4000, 3);
  const existingOwner = await getOne('publisher_app_owners', 'app_id', appId);
  let metadata: Record<string, unknown>;

  if (type === 'new') {
    if (existingOwner) throw new PublisherError('That app ID is already published.');
    const staticIds = await loadStaticAppIds();
    if (staticIds.has(appId)) throw new PublisherError('That app ID is already used in the public catalog.');
    const active = await rest('publisher_submissions', {
      query: queryString({
        select: 'id',
        app_id: `eq.${appId}`,
        status: 'in.(pending,changes_requested)',
        limit: '1',
      }),
    });
    if (Array.isArray(active) && active.length) throw new PublisherError('This app already has a submission awaiting review.');
    const normalized = normalizeNewMetadata(submission);
    if (normalized.appId !== appId || normalized.version !== version || normalized.changelog !== changelog) {
      throw new PublisherError('App details changed during submission. Refresh and try again.');
    }
    metadata = {
      name: normalized.name,
      author: normalized.author,
      description: normalized.description,
      categories: normalized.categories,
      links: normalized.links,
    };
  } else {
    if (!existingOwner || existingOwner.owner_id !== user.id) {
      throw new PublisherError('You can submit updates only for apps you own.');
    }
    const published = await getOne('publisher_catalog_apps', 'app_id', appId);
    if (!published) throw new PublisherError('This app is not currently published.');
    if (compareVersions(version, published.version) !== 1) {
      throw new PublisherError('An update must use a version newer than the currently published version.');
    }
    const active = await rest('publisher_submissions', {
      query: queryString({
        select: 'id',
        app_id: `eq.${appId}`,
        status: 'in.(pending,changes_requested)',
        limit: '1',
      }),
    });
    if (Array.isArray(active) && active.length) throw new PublisherError('This app already has an update awaiting review.');
    metadata = {
      name: published.name,
      author: published.author,
      description: published.description,
      categories: published.categories,
      links: published.links,
    };
  }

  const { pkg, byteLength } = await downloadSubmission(packagePath);
  if (pkg.novabyte_app !== true || !pkg.manifest || pkg.manifest.id !== appId) {
    throw new PublisherError('The package manifest ID does not match this submission.');
  }
  if (pkg.manifest.version !== version) throw new PublisherError('The package manifest version does not match this submission.');
  if (!pkg.files || typeof pkg.files !== 'object' || Array.isArray(pkg.files)) {
    throw new PublisherError('The package does not contain a valid file map.');
  }
  const files = Object.entries(pkg.files);
  const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!files.length || files.some(([path, encoded]) =>
    !path || path.startsWith('/') || path.includes('\\')
    || path.split('/').some(part => !part || part === '.' || part === '..')
    || typeof encoded !== 'string' || !encoded || !base64Pattern.test(encoded)
  )) {
    throw new PublisherError('The package contains an invalid file or unsafe path.');
  }
  if (byteLength > MAX_PACKAGE_BYTES) throw new PublisherError('The package exceeds the 25 MB upload limit.');

  await rest('publisher_submissions', {
    method: 'POST',
    body: {
      id,
      owner_id: user.id,
      app_id: appId,
      type,
      version,
      metadata,
      changelog,
      package_path: packagePath,
      status: 'pending',
    },
  });
  const notification = await sendEmail(
    ADMIN_EMAIL,
    `NovaByte app ${type} submitted: ${String(metadata.name)} v${version}`,
    `<p>A verified publisher submitted an app for review.</p><p><strong>${escapeHtml(metadata.name)}</strong> (${escapeHtml(appId)}) v${escapeHtml(version)}</p><p>Publisher account: ${escapeHtml(user.email || 'unknown')}</p><p>Type: ${escapeHtml(type)}</p><p>Changelog: ${escapeHtml(changelog)}</p><p>Open the NovaByte Publisher Portal and select Review Apps.</p>`,
  );
  return { submitted: true, notificationSent: notification.sent, notificationError: notification.sent ? undefined : notification.reason };
}

async function myApps(user: { id: string }) {
  const [owners, submissions] = await Promise.all([
    rest('publisher_app_owners', {
      query: queryString({ select: 'app_id,created_at', owner_id: `eq.${user.id}`, order: 'created_at.desc' }),
    }),
    rest('publisher_submissions', {
      query: queryString({
        select: 'id,app_id,type,version,metadata,changelog,status,review_note,created_at,reviewed_at',
        owner_id: `eq.${user.id}`,
        status: 'neq.withdrawn',
        order: 'created_at.desc',
      }),
    }),
  ]);
  const ids = Array.isArray(owners) ? owners.map(row => row.app_id).filter((id): id is string => typeof id === 'string') : [];
  const apps = ids.length
    ? await rest('publisher_catalog_apps', {
      query: queryString({ select: '*', app_id: `in.(${ids.join(',')})` }),
    })
    : [];
  return { apps: Array.isArray(apps) ? apps : [], submissions: Array.isArray(submissions) ? submissions : [] };
}

async function reviewQueue(user: { email?: string }) {
  requireAdmin(user);
  const rows = await rest('publisher_submissions', {
    query: queryString({
      select: 'id,owner_id,app_id,type,version,metadata,changelog,status,created_at,package_path,review_package_path',
      status: 'in.(pending,changes_requested)',
      order: 'created_at.asc',
    }),
  });
  const submissions = await Promise.all((Array.isArray(rows) ? rows : []).map(async row => ({
    ...row,
    owner_email: await getAccountEmail(row.owner_id),
    download_url: await makeSignedDownloadUrl(
      row.package_path,
      `${row.app_id}-${row.version}.novaapp`,
    ),
    has_reviewed_package: Boolean(row.review_package_path),
  })));
  return { submissions };
}

function imageDataUri(pkg: Record<string, any>, value: unknown) {
  if (typeof value !== 'string') return null;
  if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,/i.test(value)) return value;
  const encoded = pkg.files?.[value];
  if (typeof encoded !== 'string') return null;
  const extension = value.split('.').pop()?.toLowerCase();
  const mime = extension === 'svg' ? 'image/svg+xml'
    : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
    : extension === 'gif' ? 'image/gif'
    : extension === 'webp' ? 'image/webp'
    : extension === 'png' ? 'image/png'
    : null;
  return mime ? `data:${mime};base64,${encoded}` : null;
}

async function publishSubmission(submission: Record<string, any>) {
  const metadata = submission.metadata || {};
  const packagePath = submission.review_package_path || submission.package_path;
  const { pkg, byteLength } = await downloadSubmission(packagePath);
  if (pkg.novabyte_app !== true || pkg.manifest?.id !== submission.app_id || pkg.manifest?.version !== submission.version) {
    throw new PublisherError('The package no longer matches the reviewed app ID and version.');
  }

  pkg.manifest = {
    ...pkg.manifest,
    id: submission.app_id,
    name: metadata.name,
    author: metadata.author,
    description: metadata.description,
    version: submission.version,
    categories: metadata.categories,
    links: metadata.links,
    releaseNotes: submission.changelog,
  };
  const signedPackage = await signAndVerifyPackage(pkg);
  const previous = await getOne('publisher_catalog_apps', 'app_id', submission.app_id);
  if (submission.type === 'new') {
    if (previous) throw new PublisherError('This app ID was published by another account while this submission was under review.');
    if ((await loadStaticAppIds()).has(submission.app_id)) {
      throw new PublisherError('This app ID was added to the public catalog while the submission was under review.');
    }
  }
  if (submission.type === 'update') {
    if (!previous) throw new PublisherError('The app is no longer published.');
    if (compareVersions(submission.version, previous.version) !== 1) {
      throw new PublisherError('The submitted update is no longer newer than the published version.');
    }
  }

  const path = `${submission.app_id}/${submission.version}.novaapp`;
  const packageBody = JSON.stringify(signedPackage);
  if (new TextEncoder().encode(packageBody).byteLength > MAX_PACKAGE_BYTES) {
    throw new PublisherError('The signed package exceeds the 25 MB publishing limit.');
  }
  await storageRequest(PUBLISHED_BUCKET, path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-upsert': 'true',
      'cache-control': '3600',
    },
    body: packageBody,
  });

  const date = new Date().toISOString().slice(0, 10);
  const versionHistory = [
    ...(Array.isArray(previous?.version_history) ? previous.version_history : []),
    { version: submission.version, date, notes: submission.changelog },
  ].slice(-50);
  const appRow = {
    app_id: submission.app_id,
    name: metadata.name,
    version: submission.version,
    author: metadata.author,
    description: metadata.description,
    categories: metadata.categories,
    icon: imageDataUri(signedPackage, signedPackage.manifest.icon),
    file: publicPackageUrl(path),
    size: `${Math.max(1, Math.round(byteLength / 1024))} KB`,
    screenshots: Array.isArray(signedPackage.manifest.screenshots)
      ? signedPackage.manifest.screenshots.filter((item: unknown) => typeof item === 'string')
      : [],
    links: metadata.links || {},
    release_notes: submission.changelog,
    version_history: versionHistory,
    published_at: new Date().toISOString(),
  };
  await rest('rpc/commit_publisher_publish', {
    method: 'POST',
    body: { p_submission_id: submission.id, p_app: appRow },
    prefer: 'return=minimal',
  });
  return appRow;
}

async function review(user: { email?: string }, body: Record<string, unknown>) {
  requireAdmin(user);
  const id = requiredText(body.submissionId, 'Submission ID', 64);
  const decision = body.decision;
  const note = typeof body.reviewNote === 'string' ? body.reviewNote.trim().slice(0, 2000) : '';
  if (!['publish', 'reject', 'request-changes'].includes(String(decision))) {
    throw new PublisherError('Choose publish, reject, or request-changes.');
  }
  if (decision !== 'publish' && !note) throw new PublisherError('Add a reviewer note before requesting changes or rejecting.');
  const submission = await getOne('publisher_submissions', 'id', id);
  if (!submission || !['pending', 'changes_requested'].includes(submission.status)) {
    throw new PublisherError('This submission is no longer awaiting review.', 404);
  }
  if (decision === 'publish') {
    if (!submission.review_package_path) {
      throw new PublisherError('Upload the inspected .novaapp package before approving this submission.');
    }
    await publishSubmission(submission);
  } else {
    await rest('publisher_submissions', {
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
    `NovaByte app ${label}: ${submission.app_id} v${submission.version}`,
    `<p>Your submission for <strong>${escapeHtml(submission.app_id)}</strong> v${escapeHtml(submission.version)} was ${escapeHtml(label)}.</p>${note ? `<p>Reviewer note: ${escapeHtml(note)}</p>` : ''}${decision === 'publish' ? '<p>Your app is now available in the NovaByte catalog.</p>' : '<p>Sign in to My Apps to see the review status.</p>'}`,
  );
  return { reviewed: true, notificationSent: notification.sent, notificationError: notification.sent ? undefined : notification.reason };
}

async function deletePublishedApp(user: { id: string }, body: Record<string, unknown>) {
  const appId = requiredText(body.appId, 'App ID', 120);
  const owner = await getOne('publisher_app_owners', 'app_id', appId);
  if (!owner || owner.owner_id !== user.id) throw new PublisherError('You can remove only apps published from your account.', 403);

  const matching = await rest('publisher_catalog_apps', {
    query: queryString({ select: 'app_id', app_id: `eq.${appId}` }),
  });
  if (!Array.isArray(matching) || !matching.length) throw new PublisherError('This app is not currently published.', 404);

  const listResponse = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${PUBLISHED_BUCKET}`, {
    method: 'POST',
    headers: {
      apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
      Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefix: `${appId}/`, limit: 1000 }),
  });
  const objects = await listResponse.json();
  if (!listResponse.ok) {
    console.error('[publisher-api] Could not list packages for removal:', objects);
    throw new PublisherError('Could not remove the published packages. The catalog entry remains available.', 502);
  }
  const paths = Array.isArray(objects)
    ? objects.filter(item => typeof item?.name === 'string').map(item => `${appId}/${item.name}`)
    : [];
  if (paths.length) {
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${PUBLISHED_BUCKET}`, {
      method: 'DELETE',
      headers: {
        apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefixes: paths }),
    });
    if (!response.ok) {
      console.error('[publisher-api] Could not delete published packages:', await response.text());
      throw new PublisherError('Could not remove the published packages. The catalog entry remains available.', 502);
    }
  }
  await rest('publisher_catalog_apps', { method: 'DELETE', query: queryString({ app_id: `eq.${appId}` }), prefer: 'return=minimal' });
  return { deleted: true };
}

async function withdraw(user: { id: string }, body: Record<string, unknown>) {
  const id = requiredText(body.submissionId, 'Submission ID', 64);
  const submission = await getOne('publisher_submissions', 'id', id);
  if (!submission || submission.owner_id !== user.id) throw new PublisherError('Submission not found.', 404);
  if (!['pending', 'changes_requested', 'rejected'].includes(submission.status)) {
    throw new PublisherError('This submission can no longer be withdrawn.');
  }
  await rest('publisher_submissions', {
    method: 'PATCH',
    query: queryString({ id: `eq.${id}` }),
    body: { status: 'withdrawn' },
  });
  await storageRequest(SUBMISSION_BUCKET, submission.package_path, { method: 'DELETE' });
  return { withdrawn: true };
}

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return respond({ error: 'Method not allowed.' }, 405);

  try {
    requiredEnv('SUPABASE_URL', SUPABASE_URL);
    requiredEnv('SUPABASE_SERVICE_ROLE_KEY', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '');
    const user = await getUser(request);
    const url = new URL(request.url);
    if (url.searchParams.get('action') === 'upload-reviewed-package') {
      requireAdmin(user);
      const id = requiredText(url.searchParams.get('submissionId'), 'Submission ID', 64);
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PublisherError('Invalid submission ID.');
      const submission = await getOne('publisher_submissions', 'id', id);
      if (!submission || !['pending', 'changes_requested'].includes(submission.status)) {
        throw new PublisherError('This submission is no longer awaiting review.', 404);
      }
      const contentLength = Number(request.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_PACKAGE_BYTES) {
        throw new PublisherError('The reviewed package must be no larger than 25 MB.');
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (!bytes.length || bytes.byteLength > MAX_PACKAGE_BYTES) {
        throw new PublisherError('The reviewed package must be between 1 byte and 25 MB.');
      }
      let pkg: Record<string, any>;
      try {
        pkg = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new PublisherError('The reviewed file is not valid .novaapp package JSON.');
      }
      if (
        !pkg ||
        pkg.novabyte_app !== true ||
        pkg.manifest?.id !== submission.app_id ||
        pkg.manifest?.version !== submission.version ||
        !pkg.files ||
        typeof pkg.files !== 'object' ||
        Array.isArray(pkg.files)
      ) {
        throw new PublisherError('The reviewed package must match the submission app ID and version and contain package files.');
      }
      const reviewPath = `${id}/reviewed.novaapp`;
      await storageRequest(SUBMISSION_BUCKET, reviewPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-upsert': 'true',
          'cache-control': 'no-store',
        },
        body: bytes,
      });
      await rest('publisher_submissions', {
        method: 'PATCH',
        query: queryString({ id: `eq.${id}` }),
        body: { review_package_path: reviewPath },
        prefer: 'return=minimal',
      });
      return respond({ uploaded: true });
    }
    const body = await request.json();
    const action = body?.action;
    if (typeof action !== 'string') throw new PublisherError('Choose a publisher action.');

    if (action === 'submit') return respond(await submit(user, body));
    if (action === 'my-apps') return respond(await myApps(user));
    if (action === 'review-list') return respond(await reviewQueue(user));
    if (action === 'review') return respond(await review(user, body));
    if (action === 'delete-app') return respond(await deletePublishedApp(user, body));
    if (action === 'withdraw') return respond(await withdraw(user, body));
    if (user.email?.trim().toLowerCase() === ADMIN_EMAIL) requireAdmin(user);
    throw new PublisherError('Unknown publisher action.', 404);
  } catch (error) {
    return errorResponse(error);
  }
});
