import { PUBLISHING_CONFIG } from './publishing-config.js';

const SESSION_KEY = 'novabyte-publisher-session';
const MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_SCREENSHOTS = 5;

function errorMessage(payload, fallback) {
  if (typeof payload === 'string' && payload) return payload;
  return payload?.msg || payload?.message || payload?.error_description || payload?.error || fallback;
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function makeElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function makeField(labelText, { id, type = 'text', required = true, value = '', placeholder = '', maxLength } = {}) {
  const label = makeElement('label', 'publisher-field', labelText);
  const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
  input.id = id;
  input.name = id;
  if (type !== 'textarea') input.type = type;
  input.required = required;
  input.value = value;
  input.placeholder = placeholder;
  if (maxLength) input.maxLength = maxLength;
  label.appendChild(input);
  return { label, input };
}

class PublisherPortal {
  constructor() {
    this.baseUrl = String(PUBLISHING_CONFIG.supabaseUrl || '').replace(/\/+$/, '');
    this.anonKey = String(PUBLISHING_CONFIG.supabaseAnonKey || '');
    this.authRedirectUrl = String(PUBLISHING_CONFIG.authRedirectUrl || '').trim();
    this.adminEmail = String(PUBLISHING_CONFIG.adminEmail || '').trim().toLowerCase();
    this.user = null;
    this.session = this.readSession();
    this.onCatalogChanged = () => {};
    this.showStore = () => {};
    this.currentMode = 'signin';
    this.activeMenu = null;
    this.contentCleanup = null;
    this.nodes = {
      header: document.querySelector('.site-header'),
      store: document.getElementById('store-view'),
      detail: document.getElementById('detail-view'),
      view: document.getElementById('publisher-view'),
      content: document.getElementById('publisher-content'),
      title: document.getElementById('publisher-title'),
      subtitle: document.getElementById('publisher-subtitle'),
      notice: document.getElementById('publisher-notice'),
      back: document.getElementById('publisher-back'),
      signIn: document.getElementById('publisher-signin'),
      signUp: document.getElementById('publisher-signup'),
      publish: document.getElementById('publisher-publish'),
      myApps: document.getElementById('publisher-my-apps'),
      account: document.getElementById('publisher-account'),
      review: document.getElementById('publisher-review'),
      signOut: document.getElementById('publisher-signout'),
    };
  }

  get configured() {
    try {
      const url = new URL(this.baseUrl);
      return url.protocol === 'https:' && url.origin === this.baseUrl && this.anonKey.length > 20;
    } catch {
      return false;
    }
  }

  readSession() {
    try {
      const stored = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
      const value = JSON.parse(stored || 'null');
      if (value && !localStorage.getItem(SESSION_KEY)) {
        localStorage.setItem(SESSION_KEY, JSON.stringify(value));
        sessionStorage.removeItem(SESSION_KEY);
      }
      return value && typeof value.access_token === 'string' ? value : null;
    } catch (error) {
      console.warn('[Publisher] Could not restore the browser session:', error);
      return null;
    }
  }

  saveSession(session) {
    if (!session?.access_token || !session?.refresh_token) {
      throw new Error('The authentication service returned an incomplete session.');
    }
    const expiresIn = Number(session.expires_in) || 3600;
    this.session = {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
    sessionStorage.removeItem(SESSION_KEY);
  }

  clearSession() {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    this.session = null;
    this.user = null;
  }

  async request(path, { method = 'GET', body, token, headers = {}, rawBody } = {}) {
    if (!this.configured) throw new Error('Publisher accounts are not configured yet.');
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        apikey: this.anonKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(rawBody !== undefined ? { body: rawBody } : {}),
    });
    const text = await response.text();
    let result = null;
    if (text) {
      try {
        result = JSON.parse(text);
      } catch {
        result = text;
      }
    }
    if (!response.ok) {
      const error = new Error(errorMessage(result, `Request failed (${response.status}).`));
      error.status = response.status;
      throw error;
    }
    return result;
  }

  async refreshSession() {
    try {
      const refreshed = await this.request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: { refresh_token: this.session.refresh_token },
      });
      this.saveSession(refreshed);
    } catch (error) {
      if ([400, 401, 403].includes(error.status)) this.clearSession();
      throw error;
    }
  }

  async ensureSession() {
    if (!this.session) return null;
    if (this.session.expires_at <= Math.floor(Date.now() / 1000) + 30) {
      await this.refreshSession();
    }
    let user;
    try {
      user = await this.request('/auth/v1/user', { token: this.session.access_token });
    } catch (error) {
      if (error.status !== 401) throw error;
      await this.refreshSession();
      user = await this.request('/auth/v1/user', { token: this.session.access_token });
    }
    if (!user?.email_confirmed_at && !user?.confirmed_at) {
      this.clearSession();
      return null;
    }
    this.user = user;
    return user;
  }

  async captureVerificationCallback() {
    const params = new URLSearchParams(location.hash.slice(1));
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    if (params.has('error')) {
      const message = params.get('error_description') || params.get('error');
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      await this.open('signin');
      this.setNotice(message, 'error');
      return false;
    }
    if (!accessToken || !refreshToken) return false;
    this.saveSession({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: params.get('expires_in'),
    });
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    await this.ensureSession();
    return Boolean(this.user);
  }

  async auth(mode, values) {
    if (mode === 'signup') {
      const redirectTo = this.authRedirectUrl || `${location.origin}${location.pathname}`;
      let result;
      try {
        result = await this.request(`/auth/v1/signup?redirect_to=${encodeURIComponent(redirectTo)}`, {
          method: 'POST',
          body: {
            email: values.email,
            password: values.password,
            data: { display_name: values.name },
          },
        });
      } catch (error) {
        if (/already registered|already exists|user_already_exists|email_exists/i.test(error.message || '')) {
          throw new Error('This email is already being used. Sign in or use a different email.');
        }
        throw error;
      }
      if (Array.isArray(result?.user?.identities) && result.user.identities.length === 0) {
        throw new Error('This email is already being used. Sign in or use a different email.');
      }
      if (result?.session?.access_token) {
        this.saveSession(result.session);
        const user = await this.request('/auth/v1/user', { token: this.session.access_token });
        if (user?.email_confirmed_at || user?.confirmed_at) {
          this.user = user;
          await this.open('my-apps');
          this.setNotice('Your account is verified and ready to publish.', 'success');
          return;
        }
        this.clearSession();
      }
      this.renderAuth('signin');
      this.setNotice('Account created. Check your email and follow the verification link before signing in.', 'success');
      return;
    }

    const result = await this.request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email: values.email, password: values.password },
    });
    this.saveSession(result);
    const user = await this.request('/auth/v1/user', { token: this.session.access_token });
    if (!user?.email_confirmed_at && !user?.confirmed_at) {
      this.clearSession();
      throw new Error('Verify your email before signing in.');
    }
    this.user = user;
    this.updateNavigation();
    await this.open(user.email?.trim().toLowerCase() === this.adminEmail ? 'review' : 'my-apps');
    this.setNotice(`Signed in as ${user.email}.`, 'success');
  }

  async call(action, payload = {}) {
    await this.ensureSession();
    if (!this.user || !this.session) throw new Error('Sign in with a verified email to continue.');
    return this.request('/functions/v1/publisher-api', {
      method: 'POST',
      token: this.session.access_token,
      body: { action, ...payload },
    });
  }

  async uploadReviewedPackage(submissionId, file) {
    await this.ensureSession();
    if (!this.user || !this.session) throw new Error('Sign in with a verified email to continue.');
    const params = new URLSearchParams({
      action: 'upload-reviewed-package',
      submissionId,
    });
    const response = await fetch(`${this.baseUrl}/functions/v1/publisher-api?${params}`, {
      method: 'POST',
      headers: {
        apikey: this.anonKey,
        Authorization: `Bearer ${this.session.access_token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: file,
    });
    const text = await response.text();
    let result = null;
    if (text) {
      try {
        result = JSON.parse(text);
      } catch {
        result = text;
      }
    }
    if (!response.ok) throw new Error(errorMessage(result, `Package upload failed (${response.status}).`));
    return result;
  }

  async fetchPublishedApps() {
    if (!this.configured) return [];
    const params = new URLSearchParams({
      select: 'app_id,name,version,author,description,categories,icon,file,size,screenshots,links,release_notes,version_history',
      order: 'published_at.desc',
    });
    const result = await this.request(`/rest/v1/publisher_catalog_apps?${params}`);
    if (!Array.isArray(result)) throw new Error('The published app catalog returned an invalid response.');
    return result.map(app => ({
      id: app.app_id,
      name: app.name,
      version: app.version,
      author: app.author,
      description: app.description,
      categories: app.categories,
      icon: app.icon,
      file: app.file,
      size: app.size,
      screenshots: app.screenshots,
      links: app.links,
      releaseNotes: app.release_notes,
      versionHistory: app.version_history,
    }));
  }

  setNotice(message, kind = 'info') {
    const notice = this.nodes.notice;
    notice.textContent = message;
    notice.className = `publisher-notice is-${kind}`;
    notice.hidden = !message;
  }

  updateNavigation() {
    const signedIn = Boolean(this.user);
    this.nodes.signIn.classList.toggle('hidden', signedIn);
    this.nodes.signUp.classList.toggle('hidden', signedIn);
    this.nodes.publish.classList.toggle('hidden', !signedIn);
    this.nodes.myApps.classList.toggle('hidden', !signedIn);
    this.nodes.account.classList.toggle('hidden', !signedIn);
    this.nodes.signOut.classList.toggle('hidden', !signedIn);
    this.nodes.review.classList.toggle(
      'hidden',
      !signedIn || this.user?.email?.trim().toLowerCase() !== this.adminEmail
    );
    this.nodes.signOut.textContent = signedIn ? 'Sign out' : 'Sign out';
  }

  setPage(title, subtitle) {
    this.contentCleanup?.();
    this.contentCleanup = null;
    this.nodes.title.textContent = title;
    this.nodes.subtitle.textContent = subtitle;
    this.nodes.content.replaceChildren();
    this.setNotice('');
  }

  async open(page) {
    if (!this.configured) {
      this.nodes.view.classList.remove('hidden');
      this.nodes.store.classList.add('hidden');
      this.nodes.detail.classList.add('hidden');
      this.nodes.title.textContent = 'Publisher portal setup required';
      this.nodes.subtitle.textContent = 'Account publishing is not enabled until the site is connected to its Supabase project.';
      this.nodes.content.replaceChildren();
      const help = makeElement('p', 'publisher-help', 'Set the public Supabase project URL and anon key in src/publishing-config.js, then deploy the Supabase migration and Edge Function secrets described in supabase/README.md.');
      this.nodes.content.appendChild(help);
      this.updateNavigation();
      return;
    }

    if (!this.user) {
      await this.ensureSession();
    }
    if (page !== 'signin' && page !== 'signup' && !this.user) {
      this.renderAuth('signin');
      page = 'signin';
    }

    this.nodes.view.classList.remove('hidden');
    this.nodes.store.classList.add('hidden');
    this.nodes.detail.classList.add('hidden');
    this.nodes.header.classList.remove('hidden');
    window.scrollTo(0, 0);
    this.updateNavigation();

    if (page === 'signin' || page === 'signup') {
      this.renderAuth(page);
    } else if (page === 'publish') {
      this.renderPublish();
    } else if (page === 'my-apps') {
      await this.renderMyApps();
    } else if (page === 'account') {
      this.renderAccount();
    } else if (page === 'review') {
      this.renderReviewQueue();
    }
  }

  renderAccount() {
    const displayName = this.user?.user_metadata?.display_name || '';
    this.setPage('Manage account', 'Update your publisher profile and password.');
    const form = makeElement('form', 'publisher-card publisher-account-form');
    const identity = makeElement('div', 'publisher-account-identity');
    identity.append(
      makeElement('span', 'publisher-account-label', 'Signed in as'),
      makeElement('strong', 'publisher-account-email', this.user?.email || '')
    );
    const verified = makeElement('p', 'publisher-account-verified',
      this.user?.email_confirmed_at || this.user?.confirmed_at ? 'Email verified' : 'Email not verified');
    const name = makeField('Display name', {
      id: 'publisher-account-name',
      value: displayName,
      placeholder: 'Your name or publisher name',
      maxLength: 80,
    });
    const section = makeElement('div', 'publisher-account-section');
    section.append(
      makeElement('h2', '', 'Profile'),
      makeElement('p', 'publisher-form-intro', 'This name identifies you in your publisher profile and app listings.'),
      name.label
    );
    form.append(identity, verified, section);

    const passwordSection = makeElement('div', 'publisher-account-section');
    passwordSection.append(
      makeElement('h2', '', 'Change password'),
      makeElement('p', 'publisher-form-intro', 'Leave these fields blank to keep your current password.')
    );
    const password = makeField('New password', {
      id: 'publisher-account-password',
      type: 'password',
      required: false,
      placeholder: 'At least 10 characters',
    });
    password.input.autocomplete = 'new-password';
    password.input.minLength = 10;
    const confirmPassword = makeField('Confirm new password', {
      id: 'publisher-account-password-confirm',
      type: 'password',
      required: false,
      placeholder: 'Enter the new password again',
    });
    confirmPassword.input.autocomplete = 'new-password';
    passwordSection.append(password.label, confirmPassword.label);
    form.appendChild(passwordSection);

    const save = makeElement('button', 'publisher-submit', 'Save account changes');
    save.type = 'submit';
    form.appendChild(save);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      if (password.input.value !== confirmPassword.input.value) {
        this.setNotice('The new passwords do not match.', 'error');
        confirmPassword.input.focus();
        return;
      }
      if (password.input.value && password.input.value.length < 10) {
        this.setNotice('The new password must be at least 10 characters.', 'error');
        password.input.focus();
        return;
      }
      if (!name.input.value.trim()) {
        this.setNotice('Display name cannot be empty.', 'error');
        name.input.focus();
        return;
      }
      const updates = {
        user_metadata: {
          ...(this.user?.user_metadata || {}),
          display_name: name.input.value.trim(),
        },
      };
      if (password.input.value) updates.password = password.input.value;
      save.disabled = true;
      save.textContent = 'Saving…';
      try {
        const updatedUser = await this.request('/auth/v1/user', {
          method: 'PUT',
          token: this.session.access_token,
          body: updates,
        });
        this.user = updatedUser;
        password.input.value = '';
        confirmPassword.input.value = '';
        this.setNotice('Account changes saved.', 'success');
      } catch (error) {
        this.setNotice(error.message || String(error), 'error');
      } finally {
        save.disabled = false;
        save.textContent = 'Save account changes';
      }
    });
    this.nodes.content.appendChild(form);
  }

  renderAuth(mode) {
    this.currentMode = mode;
    const signup = mode === 'signup';
    this.setPage(signup ? 'Create publisher account' : 'Sign in', signup
      ? 'Verify your email before submitting apps for review.'
      : 'Sign in with your verified email to publish and manage apps.');
    const form = makeElement('form', 'publisher-card publisher-auth-form');
    form.noValidate = false;

    if (signup) {
      const name = makeField('Your name or publisher name', {
        id: 'publisher-name',
        required: true,
        maxLength: 80,
        placeholder: 'Studio or developer name',
      });
      form.appendChild(name.label);
    }
    const email = makeField('Email address', {
      id: 'publisher-email',
      type: 'email',
      placeholder: 'you@example.com',
    });
    const password = makeField('Password', {
      id: 'publisher-password',
      type: 'password',
      placeholder: signup ? 'At least 10 characters' : 'Your password',
    });
    password.input.autocomplete = signup ? 'new-password' : 'current-password';
    password.input.minLength = signup ? 10 : 1;
    email.input.autocomplete = 'email';
    form.append(email.label, password.label);
    const submit = makeElement('button', 'publisher-submit', signup ? 'Create account' : 'Sign in');
    submit.type = 'submit';
    form.appendChild(submit);
    const alternate = makeElement('p', 'publisher-form-alternate');
    alternate.append(
      document.createTextNode(signup ? 'Already registered? ' : 'New here? '),
      this.makeAction(signup ? 'Sign in' : 'Create an account', () => this.renderAuth(signup ? 'signin' : 'signup'))
    );
    form.appendChild(alternate);
    if (!signup) {
      form.appendChild(this.makeAction('Resend verification email', () => this.resendVerification(email.input.value.trim())));
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      submit.disabled = true;
      submit.textContent = signup ? 'Creating account…' : 'Signing in…';
      try {
        await this.auth(signup ? 'signup' : 'signin', {
          name: form.elements['publisher-name']?.value.trim(),
          email: email.input.value.trim(),
          password: password.input.value,
        });
      } catch (error) {
        this.setNotice(error.message || String(error), 'error');
      } finally {
        submit.disabled = false;
        submit.textContent = signup ? 'Create account' : 'Sign in';
      }
    });
    this.nodes.content.appendChild(form);
    if (signup) {
      this.nodes.content.appendChild(makeElement('p', 'publisher-security-note', 'A verified email is required. Never upload signing keys; NovaByte signs packages only after review.'));
    }
  }

  makeAction(text, action, className = '') {
    const button = makeElement('button', `publisher-inline-action ${className}`.trim(), text);
    button.type = 'button';
    button.addEventListener('click', action);
    return button;
  }

  async resendVerification(email) {
    if (!email) {
      this.setNotice('Enter your email address first.', 'error');
      return;
    }
    try {
      await this.request('/auth/v1/resend', {
        method: 'POST',
        body: {
          type: 'signup',
          email,
          options: { emailRedirectTo: this.authRedirectUrl || `${location.origin}${location.pathname}` },
        },
      });
      this.setNotice('If the account needs verification, a new confirmation email has been sent.', 'success');
    } catch (error) {
      this.setNotice(error.message || String(error), 'error');
    }
  }

  makePackagePicker(onPackage) {
    const field = makeField('NovaByte app package (.novaapp)', {
      id: 'publisher-package',
      type: 'file',
      placeholder: '',
    });
    field.input.accept = '.novaapp,application/json';
    field.input.addEventListener('change', async () => {
      const file = field.input.files?.[0];
      if (!file) return;
      try {
        if (file.size > MAX_PACKAGE_BYTES) throw new Error('The package exceeds the 25 MB upload limit.');
        const pkg = JSON.parse(await file.text());
        if (
          pkg?.novabyte_app !== true ||
          !pkg.manifest ||
          !pkg.files ||
          typeof pkg.files !== 'object' ||
          Array.isArray(pkg.files)
        ) {
          throw new Error('This file is not a valid .novaapp package.');
        }
        onPackage({ file, pkg });
        this.setNotice(`Loaded ${file.name} (${(file.size / 1024).toFixed(0)} KB).`, 'success');
      } catch (error) {
        field.input.value = '';
        this.setNotice(error.message || 'Could not read the package.', 'error');
      }
    });
    return { field, input: field.input };
  }

  makeAppForm({ type, app } = {}) {
    const update = type === 'update';
    this.setPage(update ? `Update ${app.name}` : 'Publish an app', update
      ? 'Submit a new .novaapp package and tell reviewers what changed in this version.'
      : 'Complete the listing details and submit your .novaapp package for review. It will not appear publicly until approved.');
    const form = makeElement('form', 'publisher-card publisher-app-form');
    const status = makeElement('p', 'publisher-form-intro', update
      ? `Updating ${app.name} (${app.id}). The submitted package must contain a newer version.`
      : 'All listing details are required. The package manifest ID and version must match the details below.');
    form.appendChild(status);
    let packageData = null;

    const packagePicker = this.makePackagePicker(data => {
      packageData = data;
      if (!update) {
        fields.name.input.value ||= data.pkg.manifest.name || '';
        fields.appId.input.value ||= data.pkg.manifest.id || '';
        fields.author.input.value ||= data.pkg.manifest.author || '';
        fields.version.input.value ||= data.pkg.manifest.version || '';
        fields.description.input.value ||= data.pkg.manifest.description || '';
        fields.categories.input.value ||= Array.isArray(data.pkg.manifest.categories)
          ? data.pkg.manifest.categories.join(', ')
          : '';
      } else {
        fields.version.input.value = data.pkg.manifest.version || '';
      }
    });
    form.appendChild(packagePicker.field.label);

    const screenshots = makeField('Screenshots (up to 5 images)', {
      id: 'listing-screenshots',
      type: 'file',
      required: false,
    });
    screenshots.input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    screenshots.input.multiple = true;
    const screenshotHelp = makeElement('p', 'publisher-form-intro',
      'Optional. PNG, JPEG, WebP, or GIF; each image may be up to 5 MB. These images will be added to the .novaapp package.');
    const screenshotPreview = makeElement('div', 'publisher-screenshot-preview');
    let screenshotObjectUrls = [];
    screenshots.input.addEventListener('change', () => {
      for (const url of screenshotObjectUrls) URL.revokeObjectURL(url);
      screenshotObjectUrls = [];
      screenshotPreview.replaceChildren();
      const selected = [...(screenshots.input.files || [])];
      if (selected.length > MAX_SCREENSHOTS) {
        screenshots.input.value = '';
        this.setNotice(`Choose no more than ${MAX_SCREENSHOTS} screenshots.`, 'error');
        return;
      }
      if (selected.some(file => !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type))) {
        screenshots.input.value = '';
        this.setNotice('Screenshots must be PNG, JPEG, WebP, or GIF images.', 'error');
        return;
      }
      if (selected.some(file => file.size > MAX_SCREENSHOT_BYTES)) {
        screenshots.input.value = '';
        this.setNotice('Each screenshot must be no larger than 5 MB.', 'error');
        return;
      }
      for (const file of selected) {
        const url = URL.createObjectURL(file);
        screenshotObjectUrls.push(url);
        const preview = makeElement('figure', 'publisher-screenshot-item');
        const image = document.createElement('img');
        image.src = url;
        image.alt = file.name;
        const caption = makeElement('figcaption', '', file.name);
        preview.append(image, caption);
        screenshotPreview.appendChild(preview);
      }
      if (selected.length) this.setNotice(`${selected.length} screenshot${selected.length === 1 ? '' : 's'} selected.`, 'info');
    });
    form.append(screenshots.label, screenshotHelp, screenshotPreview);
    this.contentCleanup = () => {
      for (const url of screenshotObjectUrls) URL.revokeObjectURL(url);
      screenshotObjectUrls = [];
    };

    const fields = {};
    if (!update) {
      fields.name = makeField('App name', { id: 'listing-name', value: '', placeholder: 'My NovaByte app', maxLength: 80 });
      fields.appId = makeField('Unique app ID', { id: 'listing-id', value: '', placeholder: 'com.example.myapp', maxLength: 120 });
      fields.author = makeField('Publisher / developer', { id: 'listing-author', value: '', placeholder: 'Your publisher name', maxLength: 80 });
      fields.version = makeField('Version', { id: 'listing-version', value: '', placeholder: '1.0.0', maxLength: 40 });
      fields.description = makeField('Description', { id: 'listing-description', type: 'textarea', value: '', placeholder: 'What does the app do?', maxLength: 1000 });
      fields.categories = makeField('Categories (comma-separated)', { id: 'listing-categories', value: '', placeholder: 'utilities, productivity', maxLength: 160 });
      fields.website = makeField('Website URL', { id: 'listing-website', value: '', required: false, placeholder: 'https://example.com', maxLength: 500 });
      fields.source = makeField('Source code URL', { id: 'listing-source', value: '', required: false, placeholder: 'https://github.com/…', maxLength: 500 });
      fields.support = makeField('Support URL', { id: 'listing-support', value: '', required: false, placeholder: 'https://example.com/support', maxLength: 500 });
      form.append(fields.name.label, fields.appId.label, fields.author.label, fields.version.label,
        fields.description.label, fields.categories.label, fields.website.label, fields.source.label, fields.support.label);
    } else {
      fields.version = makeField('New version', { id: 'update-version', value: '', placeholder: 'Read from .novaapp package', maxLength: 40 });
      fields.changelog = makeField('What’s new in this version?', { id: 'update-changelog', type: 'textarea', placeholder: 'Describe the changes in this release.', maxLength: 4000 });
      form.append(fields.version.label, fields.changelog.label);
    }
    if (!update) {
      fields.changelog = makeField('Release notes / changelog', { id: 'listing-changelog', type: 'textarea', placeholder: 'Describe the first release.', maxLength: 4000 });
      form.appendChild(fields.changelog.label);
    } else {
      fields.changelog = fields.changelog || makeField('What’s new in this version?', { id: 'update-changelog', type: 'textarea', placeholder: 'Describe the changes in this release.', maxLength: 4000 });
    }

    const submit = makeElement('button', 'publisher-submit', update ? 'Submit update for review' : 'Submit app for review');
    submit.type = 'submit';
    const cancel = this.makeAction('Cancel', () => this.open('my-apps'), 'publisher-cancel');
    form.append(submit, cancel);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      if (!packageData) {
        this.setNotice('Choose a .novaapp package before submitting.', 'error');
        return;
      }
      const version = fields.version.input.value.trim();
      if (packageData.pkg.manifest.version !== version) {
        this.setNotice('The version in the .novaapp package must match the version field.', 'error');
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Uploading package…';
      try {
        const submissionId = crypto.randomUUID();
        const packagePath = `${this.user.id}/${submissionId}.novaapp`;
        const packageForUpload = JSON.parse(JSON.stringify(packageData.pkg));
        const selectedScreenshots = [...(screenshots.input.files || [])];
        if (selectedScreenshots.length > MAX_SCREENSHOTS) {
          throw new Error(`Choose no more than ${MAX_SCREENSHOTS} screenshots.`);
        }
        if (selectedScreenshots.some(file => !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type))) {
          throw new Error('Screenshots must be PNG, JPEG, WebP, or GIF images.');
        }
        if (selectedScreenshots.some(file => file.size > MAX_SCREENSHOT_BYTES)) {
          throw new Error('Each screenshot must be no larger than 5 MB.');
        }
        if (selectedScreenshots.length) {
          const screenshotPaths = [];
          for (const [index, file] of selectedScreenshots.entries()) {
            const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' })[file.type];
            const path = `screenshots/publisher-${index + 1}.${extension}`;
            packageForUpload.files[path] = arrayBufferToBase64(await file.arrayBuffer());
            screenshotPaths.push(path);
          }
          packageForUpload.manifest.screenshots = screenshotPaths;
        }
        const uploadFile = new File([JSON.stringify(packageForUpload)], packageData.file.name, {
          type: 'application/json',
        });
        if (uploadFile.size > MAX_PACKAGE_BYTES) {
          throw new Error('The package plus screenshots exceeds the 25 MB upload limit.');
        }
        await this.request(`/storage/v1/object/publisher-submissions/${encodePath(packagePath)}`, {
          method: 'POST',
          token: this.session.access_token,
          rawBody: uploadFile,
          headers: {
            'Content-Type': 'application/json',
            'x-upsert': 'true',
          },
        });
        submit.textContent = 'Sending for review…';
        const metadata = update ? {
          type: 'update',
          appId: app.id,
          version,
          packagePath,
          changelog: fields.changelog.input.value.trim(),
        } : {
          type: 'new',
          appId: fields.appId.input.value.trim(),
          name: fields.name.input.value.trim(),
          author: fields.author.input.value.trim(),
          version,
          description: fields.description.input.value.trim(),
          categories: fields.categories.input.value.split(',').map(value => value.trim()).filter(Boolean),
          links: {
            ...(fields.website.input.value.trim() ? { website: fields.website.input.value.trim() } : {}),
            ...(fields.source.input.value.trim() ? { source: fields.source.input.value.trim() } : {}),
            ...(fields.support.input.value.trim() ? { support: fields.support.input.value.trim() } : {}),
          },
          packagePath,
          changelog: fields.changelog.input.value.trim(),
        };
        const result = await this.call('submit', { submissionId, submission: metadata });
        await this.open('my-apps');
        this.setNotice(result.notificationSent === false
          ? 'Submission queued, but the email notification could not be sent. It is still visible in the review queue.'
          : 'Submission sent for review. You will receive an email when its status changes.', result.notificationSent === false ? 'warning' : 'success');
      } catch (error) {
        this.setNotice(error.message || String(error), 'error');
      } finally {
        submit.disabled = false;
        submit.textContent = update ? 'Submit update for review' : 'Submit app for review';
      }
    });
    this.nodes.content.appendChild(form);
  }

  renderPublish() {
    this.makeAppForm({ type: 'new' });
  }

  async renderMyApps() {
    this.setPage('My apps', `Signed in as ${this.user.email}. Right-click an app or use its options menu to update or remove it from the public catalog.`);
    const loading = makeElement('p', 'publisher-help', 'Loading your apps…');
    this.nodes.content.appendChild(loading);
    try {
      const result = await this.call('my-apps');
      const published = Array.isArray(result.apps) ? result.apps : [];
      const submissions = Array.isArray(result.submissions) ? result.submissions : [];
      this.nodes.content.replaceChildren();
      const publishButton = this.makeAction('＋ Publish a new app', () => this.open('publish'), 'publisher-submit');
      this.nodes.content.appendChild(publishButton);
      if (!published.length && !submissions.length) {
        this.nodes.content.appendChild(makeElement('p', 'publisher-empty', 'You have not published or submitted any apps yet.'));
        return;
      }
      const list = makeElement('div', 'publisher-app-list');
      for (const app of published) list.appendChild(this.renderOwnedApp(app));
      for (const submission of submissions) list.appendChild(this.renderSubmission(submission));
      this.nodes.content.appendChild(list);
    } catch (error) {
      loading.textContent = error.message || 'Could not load your apps.';
      loading.classList.add('is-error');
    }
  }

  renderOwnedApp(app) {
    const card = makeElement('article', 'publisher-app-card');
    const details = makeElement('div', 'publisher-app-main');
    details.append(
      makeElement('h2', '', app.name),
      makeElement('p', 'publisher-app-meta', `${app.id} · v${app.version} · Published`),
      makeElement('p', 'publisher-app-description', app.description)
    );
    const menuButton = makeElement('button', 'publisher-menu-trigger', 'Options');
    menuButton.type = 'button';
    menuButton.setAttribute('aria-label', `Options for ${app.name}`);
    const menu = makeElement('div', 'publisher-context-menu hidden');
    const update = this.makeAction('Submit update', () => this.makeAppForm({ type: 'update', app }));
    const remove = this.makeAction('Delete from publish', async () => {
      if (!window.confirm(`Remove ${app.name} from the public catalog? This cannot be undone.`)) return;
      try {
        await this.call('delete-app', { appId: app.id });
        await this.renderMyApps();
        this.setNotice(`${app.name} was removed from the public catalog.`, 'success');
        this.onCatalogChanged();
      } catch (error) {
        this.setNotice(error.message || String(error), 'error');
      }
    }, 'is-danger');
    menu.append(update, remove);
    const toggleMenu = event => {
      event?.preventDefault();
      event?.stopPropagation();
      this.closeMenus();
      menu.classList.remove('hidden');
      this.activeMenu = menu;
    };
    card.addEventListener('contextmenu', toggleMenu);
    menuButton.addEventListener('click', toggleMenu);
    card.append(details, menuButton, menu);
    return card;
  }

  renderSubmission(submission) {
    const card = makeElement('article', 'publisher-app-card is-submission');
    const details = makeElement('div', 'publisher-app-main');
    const app = submission.metadata || {};
    details.append(
      makeElement('h2', '', app.name || submission.app_id),
      makeElement('p', 'publisher-app-meta', `${submission.app_id} · v${submission.version} · ${submission.type} · ${submission.status.replace(/_/g, ' ')}`),
      makeElement('p', 'publisher-app-description', submission.review_note || submission.changelog || 'Waiting for review.')
    );
    card.appendChild(details);
    if (['pending', 'changes_requested', 'rejected'].includes(submission.status)) {
      const withdraw = this.makeAction('Withdraw submission', async () => {
        if (!window.confirm('Withdraw this submission?')) return;
        try {
          await this.call('withdraw', { submissionId: submission.id });
          await this.renderMyApps();
          this.setNotice('Submission withdrawn.', 'success');
        } catch (error) {
          this.setNotice(error.message || String(error), 'error');
        }
      }, 'is-danger');
      card.appendChild(withdraw);
    }
    return card;
  }

  closeMenus() {
    this.activeMenu?.classList.add('hidden');
    this.activeMenu = null;
  }

  async renderReviewQueue() {
    if (this.user?.email?.trim().toLowerCase() !== this.adminEmail) {
      this.setPage('Review access denied', 'This page is only available to the authorized reviewer.');
      this.setNotice('Your verified account is not authorized to review submissions.', 'error');
      return;
    }
    this.setPage('Review Apps', 'Inspect each submitted package, download it for review, then upload the reviewed .novaapp. Approval signs that reviewed package with NovaByte’s trusted key and publishes it.');
    const loading = makeElement('p', 'publisher-help', 'Loading review queue…');
    this.nodes.content.appendChild(loading);
    try {
      const result = await this.call('review-list');
      this.nodes.content.replaceChildren();
      const queue = Array.isArray(result.submissions) ? result.submissions : [];
      if (!queue.length) {
        this.nodes.content.appendChild(makeElement('p', 'publisher-empty', 'The review queue is clear.'));
        return;
      }
      const list = makeElement('div', 'publisher-app-list');
      for (const submission of queue) {
        const item = makeElement('article', 'publisher-review-card');
        const info = submission.metadata || {};
        item.append(
          makeElement('p', 'detail-kicker', `${submission.type} · ${submission.status}`),
          makeElement('h2', '', `${info.name || submission.app_id} v${submission.version}`),
          makeElement('p', 'publisher-app-meta', `${submission.app_id} · submitted ${new Date(submission.created_at).toLocaleString()}`),
          makeElement('p', 'publisher-app-description', info.description || ''),
          makeElement('p', 'publisher-review-changelog', submission.changelog || 'No changelog supplied.')
        );
        if (submission.download_url) {
          const download = makeElement('a', 'publisher-download', 'Download package for review');
          download.href = submission.download_url;
          download.target = '_blank';
          download.rel = 'noopener noreferrer';
          download.download = `${submission.app_id}-${submission.version}.novaapp`;
          item.appendChild(download);
        }
        const reviewButton = this.makeAction('Review submission', () => this.renderReviewForm(submission));
        item.appendChild(reviewButton);
        list.appendChild(item);
      }
      this.nodes.content.appendChild(list);
    } catch (error) {
      loading.textContent = error.message || 'Could not load the review queue.';
      loading.classList.add('is-error');
    }
  }

  renderReviewForm(submission) {
    const info = submission.metadata || {};
    this.setPage(`Review ${info.name || submission.app_id}`, `Submitted by ${submission.owner_email || 'verified publisher'} · ${submission.type} · v${submission.version}`);
    const card = makeElement('article', 'publisher-card publisher-review-form');
    const lines = [
      `App ID: ${submission.app_id}`,
      `Version: ${submission.version}`,
      `Publisher: ${info.author || '—'}`,
      `Categories: ${(info.categories || []).join(', ') || '—'}`,
      `Description: ${info.description || '—'}`,
      `Changelog: ${submission.changelog || '—'}`,
    ];
    for (const line of lines) card.appendChild(makeElement('p', 'publisher-review-line', line));
    if (submission.download_url) {
      const download = makeElement('a', 'publisher-download', 'Download package for review');
      download.href = submission.download_url;
      download.target = '_blank';
      download.rel = 'noopener noreferrer';
      download.download = `${submission.app_id}-${submission.version}.novaapp`;
      card.appendChild(download);
    }
    const uploadIntro = makeElement('p', 'publisher-review-upload-help',
      submission.has_reviewed_package
        ? 'Reviewed package uploaded. You can upload another version to replace it before approval.'
        : 'After inspecting the download, upload the reviewed .novaapp. Approval is enabled only after this step; the server signs it when you publish.');
    const uploadField = makeField('Reviewed package (.novaapp)', {
      id: 'reviewed-package',
      type: 'file',
      required: false,
    });
    uploadField.input.accept = '.novaapp,application/json';
    uploadField.input.disabled = false;
    const uploadButton = this.makeAction(
      submission.has_reviewed_package ? 'Replace reviewed package' : 'Upload reviewed package',
      async () => {
        const file = uploadField.input.files?.[0];
        if (!file) {
          this.setNotice('Choose the reviewed .novaapp file first.', 'error');
          uploadField.input.focus();
          return;
        }
        if (file.size > MAX_PACKAGE_BYTES) {
          this.setNotice('The reviewed package must be no larger than 25 MB.', 'error');
          return;
        }
        uploadButton.disabled = true;
        uploadButton.textContent = 'Uploading package…';
        try {
          await this.uploadReviewedPackage(submission.id, file);
          submission.has_reviewed_package = true;
          this.renderReviewForm(submission);
          this.setNotice('Reviewed package uploaded. Approve & publish when your inspection is complete.', 'success');
        } catch (error) {
          this.setNotice(error.message || String(error), 'error');
          uploadButton.disabled = false;
          uploadButton.textContent = submission.has_reviewed_package ? 'Replace reviewed package' : 'Upload reviewed package';
        }
      },
      'is-secondary'
    );
    uploadButton.disabled = true;
    uploadField.input.addEventListener('change', () => {
      uploadButton.disabled = !uploadField.input.files?.length;
      uploadButton.textContent = submission.has_reviewed_package ? 'Replace reviewed package' : 'Upload reviewed package';
    });
    card.append(uploadIntro, uploadField.label, uploadButton);
    const note = makeField('Reviewer note (required for rejection or change requests)', {
      id: 'review-note',
      type: 'textarea',
      required: false,
      maxLength: 2000,
      placeholder: 'Private note sent to the publisher.',
    });
    card.appendChild(note.label);
    const buttons = makeElement('div', 'publisher-review-actions');
    const perform = async (action, label) => {
      const text = note.input.value.trim();
      if (['reject', 'request-changes'].includes(action) && !text) {
        this.setNotice('Add a reviewer note before requesting changes or rejecting.', 'error');
        note.input.focus();
        return;
      }
      if (action === 'publish' && !submission.has_reviewed_package) {
        this.setNotice('Upload the inspected .novaapp before approving this submission.', 'error');
        return;
      }
      buttons.querySelectorAll('button').forEach(button => { button.disabled = true; });
      try {
        const result = await this.call('review', {
          submissionId: submission.id,
          decision: action,
          reviewNote: text,
        });
        await this.renderReviewQueue();
        this.setNotice(result.notificationSent === false
          ? `${label}, but the publisher email could not be sent.`
          : `${label}.`, result.notificationSent === false ? 'warning' : 'success');
        if (action === 'publish') this.onCatalogChanged();
      } catch (error) {
        this.setNotice(error.message || String(error), 'error');
        buttons.querySelectorAll('button').forEach(button => { button.disabled = false; });
      }
    };
    buttons.append(
      this.makeAction('Request changes', () => perform('request-changes', 'Changes requested'), 'is-secondary'),
      this.makeAction('Reject', () => perform('reject', 'Submission rejected'), 'is-danger'),
      this.makeAction('Approve & publish', () => perform('publish', 'App published'), 'publisher-submit')
    );
    card.appendChild(buttons);
    card.appendChild(this.makeAction('Back to review queue', () => this.renderReviewQueue()));
    this.nodes.content.appendChild(card);
  }

  init({ onCatalogChanged, showStore }) {
    this.onCatalogChanged = onCatalogChanged || this.onCatalogChanged;
    this.showStore = showStore || this.showStore;
    const navigate = page => this.open(page).catch(error => {
      console.error(`[Publisher] Could not open ${page}:`, error);
      this.setNotice(error.message || String(error), 'error');
    });
    this.nodes.signIn.addEventListener('click', () => navigate('signin'));
    this.nodes.signUp.addEventListener('click', () => navigate('signup'));
    this.nodes.publish.addEventListener('click', () => navigate('publish'));
    this.nodes.myApps.addEventListener('click', () => navigate('my-apps'));
    this.nodes.account.addEventListener('click', () => navigate('account'));
    this.nodes.review.addEventListener('click', () => navigate('review'));
    this.nodes.signOut.addEventListener('click', async () => {
      try {
        if (this.session) {
          await this.request('/auth/v1/logout', { method: 'POST', token: this.session.access_token });
        }
      } catch (error) {
        console.warn('[Publisher] Remote sign-out failed; clearing local session:', error);
      } finally {
        this.clearSession();
        this.updateNavigation();
        this.showStore();
      }
    });
    this.nodes.back.addEventListener('click', () => this.showStore());
    document.addEventListener('click', event => {
      if (this.activeMenu && !this.activeMenu.parentElement.contains(event.target)) this.closeMenus();
    });

    this.updateNavigation();
    if (this.configured) {
      this.captureVerificationCallback()
        .then(verified => {
          if (verified) {
            this.updateNavigation();
            const page = this.user?.email?.trim().toLowerCase() === this.adminEmail ? 'review' : 'my-apps';
            this.open(page).then(() => this.setNotice('Email verified. Your publisher account is ready.', 'success'));
          } else {
            return this.ensureSession().then(user => {
              this.updateNavigation();
              if (user) this.open(user.email?.trim().toLowerCase() === this.adminEmail ? 'review' : 'my-apps');
            });
          }
        })
        .catch(error => {
          console.error('[Publisher] Could not restore authentication:', error);
          this.setNotice(`Could not restore your sign-in right now: ${error.message || String(error)} Your saved session was kept; reload to retry.`, 'error');
        });
    }
  }
}

export const publisherPortal = new PublisherPortal();
