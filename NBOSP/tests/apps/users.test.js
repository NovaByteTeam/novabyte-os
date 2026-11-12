// The Users admin console renders a Role chip per account. createEl has no
// `html` option, so the chip used to come out empty; this pins the rendered
// text, and that markup in a server-supplied field stays inert text.
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

const read = rel => readFile(new URL(rel, import.meta.url), 'utf8');

async function mountUsersApp(users) {
  const [baseUtils, appSource] = await Promise.all([
    read('../../js/core/utils/base-utils.js'),
    read('../../js/apps/users/app.js'),
  ]);
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only' });
  const { window } = dom;

  let config;
  window.registerApp = cfg => { config = cfg; };
  window.NovaUserScope = { enabled: () => true };
  window.SessionManager = {
    isAdmin: () => true,
    authFetch: async path => ({
      status: 200,
      json: { success: true, data: path.endsWith('/usage') ? { usage: [] } : { users } },
    }),
  };

  window.eval(baseUtils);
  window.eval(appSource);
  const host = window.document.getElementById('host');
  await config.init(host, { cleanups: [] }, {});
  return { window, host };
}

describe('Users app account table', () => {
  it('shows each account\'s role and status as text', async () => {
    const { window, host } = await mountUsersApp([
      { uid: 'u1', username: 'ada', displayName: 'Ada', role: 'owner', roleLabel: 'Owner', status: 'active' },
      { uid: 'u2', username: 'sam', displayName: 'Sam', role: 'standard', roleLabel: 'Standard', status: 'disabled', locked: true },
    ]);
    try {
      expect(host.style.background).toBe('var(--bg-base)');
      expect(host.style.color).toBe('var(--text-primary)');
      expect(host.querySelector('style').textContent).toContain('.nbusers-event.warn { border-left-color:var(--text-warning); }');
      const rows = [...host.querySelectorAll('.nbusers-table tbody tr')];
      expect(rows).toHaveLength(2);

      const chips = row => [...row.querySelectorAll('.nbusers-chip')].map(chip => chip.textContent);
      expect(chips(rows[0])).toEqual(['Owner', 'active']);
      expect(chips(rows[1])).toEqual(['Standard', 'disabled', 'locked']);
      expect(rows[0].querySelector('.nbusers-chip.owner')).not.toBeNull();
    } finally {
      window.close();
    }
  });

  it('renders markup in a display field as plain text', async () => {
    const { window, host } = await mountUsersApp([
      { uid: 'u1', username: 'ada', displayName: 'Ada', role: 'admin', roleLabel: '<img src=x onerror=alert(1)>', status: 'active' },
    ]);
    try {
      expect(host.querySelector('.nbusers-table img')).toBeNull();
      expect(host.querySelector('.nbusers-chip.admin').textContent).toBe('<img src=x onerror=alert(1)>');
    } finally {
      window.close();
    }
  });
});
