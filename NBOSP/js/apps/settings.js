registerApp({
  id: 'nook',
  name: 'Settings',
  icon: 'settings',
  version: '3.0.2',
  description: 'System Settings',
  defaultSize: [700, 500],
  minSize: [500, 400],
  init(content, state, options) {
    'use strict';

    // Runtime guard — this app needs the NovaByte virtual filesystem
    if (!window.AppDirs?.getVFSDir('com.nbosp.settings', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      const iconEl = createEl('div', { style: 'font-size:32px', textContent: '\u26A0\uFE0F' });
      const msg = createEl('div', { style: 'font-size:14px;text-align:center' });
      msg.appendChild(createEl('b', { textContent: 'com.nbosp.settings' }));
      msg.appendChild(createEl('br'));
      msg.appendChild(document.createTextNode('App data directory missing.'));
      msg.appendChild(createEl('br'));
      msg.appendChild(document.createTextNode('This app requires NovaByte OS.'));
      content.append(iconEl, msg);
      return;
    }

    // Sidebar sections
    const SECTIONS = [
      { id: 'appearance',      name: 'Appearance',      icon: 'image'         },
      { id: 'accessibility',   name: 'Accessibility',   icon: 'eye'           },
      { id: 'desktop',         name: 'Desktop',         icon: 'layers'        },
      { id: 'system',          name: 'System',           icon: 'processor'     },
      { id: 'date-and-region', name: 'Date and Region',  icon: 'calendar'      },
      { id: 'storage',         name: 'Storage',          icon: 'database'      },
      { id: 'privacy',         name: 'Privacy',          icon: 'lock'          },
      { id: 'apps',            name: 'Apps',             icon: 'package'       },
      { id: 'default-apps',    name: 'Default Apps',     icon: 'default-apps'  },
      { id: 'about',           name: 'About',            icon: 'info'          }
    ];

    const THEMES      = ['nova-dark', 'nova-light', 'nord', 'dracula', 'catppuccin', 'tokyo-night', 'gruvbox'];
    const THEME_NAMES = ['Nova Dark', 'Nova Light', 'Nord', 'Dracula', 'Catppuccin', 'Tokyo Night', 'Gruvbox'];

    const ACCENT_COLORS = ['#58a6ff', '#3fb950', '#f85149', '#d29922', '#bc8cff', '#ff7b72', '#79c0ff', '#56d4dd'];

    const PRESET_WALLPAPERS = [
      { id: 'stock-blue',   name: 'Nova Blue',   gradient: 'radial-gradient(ellipse at 28% 38%, #1a5fbf 0%, #0a3070 35%, transparent 65%), linear-gradient(160deg, #020c1e 0%, #041428 45%, #061830 75%, #020c1e 100%)' },
      { id: 'stock-dark',   name: 'Obsidian',    gradient: 'radial-gradient(ellipse at 70% 25%, #160a28 0%, transparent 55%), radial-gradient(ellipse at 25% 75%, #0c0818 0%, transparent 50%), linear-gradient(150deg, #080810 0%, #0e0818 50%, #08080e 100%)' },
      { id: 'stock-light',  name: 'Frost',       gradient: 'radial-gradient(ellipse at 40% 30%, #ffffff 0%, #e8f0ff 45%, transparent 70%), linear-gradient(160deg, #dde8f8 0%, #eaf0ff 45%, #d8e6f5 100%)' },
      { id: 'stock-green',  name: 'Evergreen',   gradient: 'radial-gradient(ellipse at 30% 40%, #0a5c2a 0%, #043818 38%, transparent 65%), linear-gradient(155deg, #020c06 0%, #040e08 45%, #060e06 75%, #020c06 100%)' },
      { id: 'stock-purple', name: 'Deep Violet', gradient: 'radial-gradient(ellipse at 62% 32%, #4a1272 0%, #2c0858 40%, transparent 65%), radial-gradient(ellipse at 22% 70%, #1e084a 0%, transparent 50%), linear-gradient(155deg, #0a0414 0%, #140628 50%, #0a0414 100%)' },
      { id: 'stock-red',    name: 'Ember Core',  gradient: 'radial-gradient(ellipse at 35% 42%, #8c1a10 0%, #5c0808 40%, transparent 65%), radial-gradient(ellipse at 75% 70%, #3a0c0c 0%, transparent 50%), linear-gradient(155deg, #0e0404 0%, #180808 45%, #0e0404 100%)' },
      { id: 'stock-gray',   name: 'Steel',       gradient: 'radial-gradient(ellipse at 50% 32%, #2c3c4e 0%, #1a2838 40%, transparent 65%), linear-gradient(155deg, #0c1018 0%, #16202c 45%, #0c1218 75%, #0c1018 100%)' },
      { id: 'stock-teal',   name: 'Abyss',       gradient: 'radial-gradient(ellipse at 38% 36%, #0a5e70 0%, #044050 40%, transparent 65%), radial-gradient(ellipse at 72% 68%, #042835 0%, transparent 50%), linear-gradient(155deg, #020c10 0%, #041520 45%, #021018 100%)' }
    ];

    const TASKBAR_SIZES = [
      { value: 'compact', label: 'Compact', height: '36px' },
      { value: 'normal',  label: 'Normal',  height: '48px' },
      { value: 'large',   label: 'Large',   height: '64px' }
    ];

    const ICON_SIZES = [
      { value: 'normal', label: 'Normal',  transform: 'scale(1)'   },
      { value: 'large',  label: 'Large',   transform: 'scale(1.5)' },
      { value: 'xlarge', label: 'X-Large', transform: 'scale(2)'   }
    ];

    const SHORTCUTS_LIST = [
      { action: 'Open File Manager', key: 'Win+E'        },
      { action: 'Open Terminal',     key: 'Win+T'        },
      { action: 'Open Launchpad',    key: 'Win+Space'    },
      { action: 'Lock Screen',       key: 'Win+L'        },
      { action: 'Show Desktop',      key: 'Win+D'        },
      { action: 'Switch Apps',       key: 'Alt+Tab'      },
      { action: 'Close Window',      key: 'Alt+F4'       },
      { action: 'Fullscreen',        key: 'F11'          },
      { action: 'Screenshot',        key: 'Print Screen' },
      { action: 'New Tab (Browser)', key: 'Ctrl+T'       },
      { action: 'Close Tab',         key: 'Ctrl+W'       },
      { action: 'Find in Page',      key: 'Ctrl+F'       },
      { action: 'Quick Commands',    key: 'Ctrl+K'       }
    ];

    const PERM_LABELS = {
      'vfs:read': 'Read files', 'vfs:write': 'Write files', 'vfs:delete': 'Delete files', 'vfs:metadata': 'File metadata',
      'net:internal': 'Internal network', 'net:external': 'External network', 'net:websocket': 'WebSocket',
      'mail:read': 'Read emails', 'mail:write': 'Compose emails', 'mail:send': 'Send emails', 'mail:delete': 'Delete emails',
      'calendar:read': 'Read calendar', 'calendar:write': 'Edit calendar', 'calendar:delete': 'Delete events',
      'contacts:read': 'Read contacts', 'contacts:write': 'Edit contacts',
      'device:camera': 'Camera', 'device:microphone': 'Microphone',
      'device:geolocation': 'Location', 'device:notifications': 'Notifications',
      'system:info': 'System info', 'system:settings': 'System settings', 'system:apps': 'Manage apps',
      'system:background': 'Background tasks', 'system:background:live': 'Keep running in background', 'system:autostart': 'Start at launch',
      'admin:apps': 'Manage apps (admin)', 'admin:system': 'System administration', 'admin:users': 'Manage users', 'admin:audit': 'Audit logs'
    };

    const RISK_COLOR = { low: '#3fb950', medium: '#d29922', high: '#f0883e', critical: '#f85149' };
    const RISK_BG    = { low: 'rgba(63,185,80,0.1)', medium: 'rgba(210,153,34,0.1)', high: 'rgba(240,136,62,0.1)', critical: 'rgba(248,81,73,0.1)' };

    // Region data — declared once here, not rebuilt on every render.
    // Previously these lived inside renderDateAndRegion(), so every visit
    // to that tab re-allocated ~200 region entries, ~200 currency mappings,
    // ~400 timezone strings, and ~200 region→timezone pairs.
    const REGIONS = [
      { code: 'fa-AF', name: '\u0627\u0641\u063A\u0627\u0646\u0633\u062A\u0627\u0646' },
      { code: 'sv-AX', name: '\u00C5land' },
      { code: 'sq-AL', name: 'Albania' },
      { code: 'fr-DZ', name: 'Alg\u00E9rie' },
      { code: 'pt-AO', name: 'Angola' },
      { code: 'en-AG', name: 'Antigua and Barbuda' },
      { code: 'es-AR', name: 'Argentina' },
      { code: 'hy-AM', name: 'Hayast\u00E1n' },
      { code: 'en-AU', name: 'Australia' },
      { code: 'de-AT', name: '\u00D6sterreich' },
      { code: 'az-AZ', name: 'Az\u0259rbaycan' },
      { code: 'en-BS', name: 'Bahamas' },
      { code: 'ar-BH', name: '\u0627\u0644\u0628\u062D\u0631\u064A\u0646' },
      { code: 'bn-BD', name: '\u09AC\u09BE\u0982\u09B2\u09BE\u09A6\u09C7\u09B6' },
      { code: 'en-BB', name: 'Barbados' },
      { code: 'be-BY', name: '\u0411\u0435\u043B\u0430\u0440\u0443\u0441\u044C' },
      { code: 'fr-BE', name: 'Belgique' },
      { code: 'en-BZ', name: 'Belize' },
      { code: 'en-BM', name: 'Bermuda' },
      { code: 'dz-BT', name: '\u0F60\u0F56\u0FB2\u0F74\u0F42\u0F0B\u0F61\u0F74\u0F62' },
      { code: 'es-BO', name: 'Bolivia' },
      { code: 'bs-BA', name: 'Bosna i Hercegovina' },
      { code: 'tn-BW', name: 'Botswana' },
      { code: 'pt-BR', name: 'Brasil' },
      { code: 'ms-BN', name: 'Brunei' },
      { code: 'bg-BG', name: '\u0411\u044A\u043B\u0433\u0430\u0440\u0438\u044F' },
      { code: 'fr-BF', name: 'Burkina Faso' },
      { code: 'fr-BI', name: 'Burundi' },
      { code: 'pt-CV', name: 'Cabo Verde' },
      { code: 'km-KH', name: '\u1780\u1798\u17D2\u1796\u17BB\u1787\u17B6' },
      { code: 'fr-CM', name: 'Cameroun' },
      { code: 'fr-CA', name: 'Canada' },
      { code: 'en-KY', name: 'Cayman Islands' },
      { code: 'fr-CF', name: 'RCA' },
      { code: 'fr-TD', name: 'Tchad' },
      { code: 'es-CL', name: 'Chile' },
      { code: 'zh-CN', name: '\u4E2D\u56FD' },
      { code: 'es-CO', name: 'Colombia' },
      { code: 'fr-CG', name: 'Congo' },
      { code: 'es-CR', name: 'Costa Rica' },
      { code: 'fr-CI', name: 'C\u00F4te d\'Ivoire' },
      { code: 'hr-HR', name: 'Hrvatska' },
      { code: 'es-CU', name: 'Cuba' },
      { code: 'el-CY', name: '\u039A\u03CD\u03C0\u03C1\u03BF\u03C2' },
      { code: 'cs-CZ', name: '\u010Cesk\u00E1 republika' },
      { code: 'da-DK', name: 'Danmark' },
      { code: 'ar-DJ', name: '\u062C\u064A\u0628\u0648\u062A\u064A' },
      { code: 'en-DM', name: 'Dominica' },
      { code: 'es-DO', name: 'Rep\u00FAblica Dominicana' },
      { code: 'fr-CD', name: 'RDC' },
      { code: 'es-EC', name: 'Ecuador' },
      { code: 'ar-EG', name: '\u0645\u0635\u0631' },
      { code: 'es-SV', name: 'El Salvador' },
      { code: 'ti-ER', name: 'Eritrea' },
      { code: 'et-EE', name: 'Eesti' },
      { code: 'am-ET', name: '\u12A2\u1275\u12EE\u1335\u12EB' },
      { code: 'fo-FO', name: 'F\u00F8royar' },
      { code: 'fj-FJ', name: 'Fiji' },
      { code: 'fi-FI', name: 'Suomi' },
      { code: 'fr-FR', name: 'France' },
      { code: 'ty-PF', name: 'Polyn\u00E9sie fran\u00E7aise' },
      { code: 'fr-GA', name: 'Gabon' },
      { code: 'en-GM', name: 'Gambia' },
      { code: 'ka-GE', name: '\u10E1\u10D0\u10E5\u10D0\u10E0\u10D7\u10D5\u10D4\u10DA\u10DD' },
      { code: 'de-DE', name: 'Deutschland' },
      { code: 'en-GH', name: 'Ghana' },
      { code: 'el-GR', name: '\u0395\u03BB\u03BB\u03AC\u03B4\u03B1' },
      { code: 'kl-GL', name: 'Kalaallit Nunaat' },
      { code: 'en-GD', name: 'Grenada' },
      { code: 'es-GT', name: 'Guatemala' },
      { code: 'fr-GG', name: 'Guernesey' },
      { code: 'pt-GW', name: 'Guin\u00E9-Bissau' },
      { code: 'fr-GY', name: 'Guyane' },
      { code: 'es-HN', name: 'Honduras' },
      { code: 'zh-HK', name: '\u9999\u6E2F' },
      { code: 'hu-HU', name: 'Magyarorsz\u00E1g' },
      { code: 'is-IS', name: '\u00CDsland' },
      { code: 'hi-IN', name: '\u092D\u093E\u0930\u0924' },
      { code: 'id-ID', name: 'Indonesia' },
      { code: 'fa-IR', name: '\u0627\u06CC\u0631\u0627\u0646' },
      { code: 'ar-IQ', name: '\u0627\u0644\u0639\u0631\u0627\u0642' },
      { code: 'ga-IE', name: '\u00C9ire' },
      { code: 'gv-IM', name: 'Ellan Vannin' },
      { code: 'he-IL', name: '\u05D9\u05E9\u05E8\u05D0\u05DC' },
      { code: 'it-IT', name: 'Italia' },
      { code: 'en-JM', name: 'Jamaica' },
      { code: 'ja-JP', name: '\u65E5\u672C' },
      { code: 'fr-JE', name: 'Jersey' },
      { code: 'ar-JO', name: '\u0627\u0644\u0623\u0631\u062F\u0646' },
      { code: 'kk-KZ', name: '\u049A\u0430\u0437\u0430\u049B\u0441\u0442\u0430\u043D' },
      { code: 'sw-KE', name: 'Kenya' },
      { code: 'en-KI', name: 'Kiribati' },
      { code: 'ar-KW', name: '\u0627\u0644\u0643\u0648\u064A\u062A' },
      { code: 'ky-KG', name: '\u041A\u044B\u0440\u0433\u044B\u0437\u0441\u0442\u0430\u043D' },
      { code: 'lo-LA', name: '\u0E9B\u0EB0\u0E97\u0EB4\u0E94\u0EA5\u0EB2\u0EA7' },
      { code: 'lv-LV', name: 'Latvija' },
      { code: 'ar-LB', name: '\u0644\u0628\u0646\u0627\u0646' },
      { code: 'en-LR', name: 'Liberia' },
      { code: 'ar-LY', name: '\u0644\u064A\u0628\u064A\u0627' },
      { code: 'lt-LT', name: 'Lietuva' },
      { code: 'lb-LU', name: 'L\u00EBtzebuerg' },
      { code: 'zh-MO', name: '\u6FB3\u9580' },
      { code: 'mg-MG', name: 'Madagascar' },
      { code: 'en-MW', name: 'Malawi' },
      { code: 'ms-MY', name: 'Malaysia' },
      { code: 'dv-MV', name: '\u078B\u07A8\u0788\u07AC\u0780\u07A8\u0783\u07A7\u0787\u07B0\u0796\u07AC' },
      { code: 'fr-ML', name: 'Mali' },
      { code: 'mt-MT', name: 'Malta' },
      { code: 'en-MH', name: 'Marshall Islands' },
      { code: 'ar-MR', name: '\u0645\u0648\u0631\u064A\u062A\u0627\u0646\u064A\u0627' },
      { code: 'fr-MU', name: 'Maurice' },
      { code: 'es-MX', name: 'M\u00E9xico' },
      { code: 'en-FM', name: 'Micronesia' },
      { code: 'ru-MD', name: 'Moldova' },
      { code: 'mn-MN', name: '\u041C\u043E\u043D\u0433\u043E\u043B' },
      { code: 'ar-MA', name: '\u0627\u0644\u0645\u063A\u0631\u0628' },
      { code: 'pt-MZ', name: 'Mo\u00E7ambique' },
      { code: 'my-MM', name: '\u1019\u103C\u1014\u103A\u1019\u102C' },
      { code: 'af-NA', name: 'Afrika (Namibi\u00EB)' },
      { code: 'en-NR', name: 'Nauru' },
      { code: 'ne-NP', name: '\u0928\u0947\u092A\u093E\u0932' },
      { code: 'nl-NL', name: 'Nederland' },
      { code: 'fr-NC', name: 'Nouvelle-Cal\u00E9donie' },
      { code: 'mi-NZ', name: 'Aotearoa' },
      { code: 'es-NI', name: 'Nicaragua' },
      { code: 'fr-NE', name: 'Niger' },
      { code: 'en-NG', name: 'Nigeria' },
      { code: 'ko-KP', name: '\uC870\uC120\uBBFC\uC8FC\uC8FC\uC758\uC778\uBBFC\uACF5\uD654\uAD6D' },
      { code: 'mk-MK', name: '\u041C\u0430\u043A\u0435\u0434\u043E\u043D\u0438\u0458\u0430' },
      { code: 'nb-NO', name: 'Norge' },
      { code: 'ar-OM', name: '\u0639\u064F\u0645\u0627\u0646' },
      { code: 'ur-PK', name: '\u067E\u0627\u06A9\u0633\u062A\u0627\u0646' },
      { code: 'en-PW', name: 'Palau' },
      { code: 'ar-PS', name: '\u0641\u0644\u0633\u0637\u064A\u0646' },
      { code: 'es-PA', name: 'Panam\u00E1' },
      { code: 'en-PG', name: 'Papua New Guinea' },
      { code: 'gn-PY', name: 'Paragu\u00E1i' },
      { code: 'es-PE', name: 'Per\u00FA' },
      { code: 'fil-PH', name: 'Pilipinas' },
      { code: 'pl-PL', name: 'Polska' },
      { code: 'pt-PT', name: 'Portugal' },
      { code: 'es-PR', name: 'Puerto Rico' },
      { code: 'ar-QA', name: '\u0642\u0637\u0631' },
      { code: 'fr-RE', name: 'R\u00E9union' },
      { code: 'ro-RO', name: 'Rom\u00E2nia' },
      { code: 'ru-RU', name: '\u0420\u043E\u0441\u0441\u0438\u044F' },
      { code: 'fr-RW', name: 'Rwanda' },
      { code: 'en-KN', name: 'Saint Kitts and Nevis' },
      { code: 'en-LC', name: 'Saint Lucia' },
      { code: 'en-VC', name: 'Saint Vincent' },
      { code: 'sm-WS', name: 'S\u0101moa' },
      { code: 'pt-ST', name: 'S\u00E3o Tom\u00E9 e Pr\u00EDncipe' },
      { code: 'ar-SA', name: 'Arab Saudi' },
      { code: 'fr-SN', name: 'S\u00E9n\u00E9gal' },
      { code: 'sr-RS', name: '\u0421\u0440\u0431\u0438\u0458\u0430' },
      { code: 'fr-SC', name: 'Seychelles' },
      { code: 'en-SL', name: 'Sierra Leone' },
      { code: 'zh-SG', name: '\u65B0\u52A0\u5761' },
      { code: 'sk-SK', name: 'Slovensko' },
      { code: 'sl-SI', name: 'Slovenija' },
      { code: 'en-SB', name: 'Solomon Islands' },
      { code: 'so-SO', name: 'Soomaaliya' },
      { code: 'zu-ZA', name: 'South Africa' },
      { code: 'ko-KR', name: '\uB300\uD55C\uBBFC\uAD6D' },
      { code: 'ar-SS', name: 'South Sudan' },
      { code: 'es-ES', name: 'Espa\u00F1a' },
      { code: 'si-LK', name: '\u0DC1\u0DCA\u200D\u0DBB\u0DD3 \u0DBD\u0D82\u0D9A\u0DCF' },
      { code: 'ar-SD', name: '\u0627\u0644\u0633\u0648\u062F\u0627\u0646' },
      { code: 'nl-SR', name: 'Suriname' },
      { code: 'sv-SE', name: 'Sverige' },
      { code: 'de-CH', name: 'Schweiz' },
      { code: 'ar-SY', name: '\u0633\u0648\u0631\u064A\u0627' },
      { code: 'zh-TW', name: '\u53F0\u7063' },
      { code: 'tg-TJ', name: '\u0422\u043E\u04B7\u0438\u043A\u0438\u0441\u0442\u043E\u043D' },
      { code: 'sw-TZ', name: 'Tanzania' },
      { code: 'th-TH', name: '\u0E44\u0E17\u0E22' },
      { code: 'pt-TL', name: 'Timor-Leste' },
      { code: 'to-TO', name: 'Tonga' },
      { code: 'en-TT', name: 'Trinidad and Tobago' },
      { code: 'ar-TN', name: '\u062A\u0648\u0646\u0633' },
      { code: 'tr-TR', name: 'T\u00FCrkiye' },
      { code: 'tk-TM', name: 'T\u00FCrkmenistan' },
      { code: 'en-TV', name: 'Tuvalu' },
      { code: 'sw-UG', name: 'Uganda' },
      { code: 'uk-UA', name: '\u0423\u043A\u0440\u0430\u0457\u043D\u0430' },
      { code: 'ar-AE', name: '\u0627\u0644\u0625\u0645\u0627\u0631\u0627\u062A' },
      { code: 'en-GB', name: 'United Kingdom' },
      { code: 'en-US', name: 'United States' },
      { code: 'es-UY', name: 'Uruguay' },
      { code: 'uz-UZ', name: 'O\'zbekiston' },
      { code: 'en-VU', name: 'Vanuatu' },
      { code: 'es-VE', name: 'Venezuela' },
      { code: 'vi-VN', name: 'Vi\u1EC7t Nam' },
      { code: 'fr-WF', name: 'Wallis et Futuna' },
      { code: 'ar-YE', name: '\u0627\u0644\u064A\u0645\u0646' },
      { code: 'en-ZM', name: 'Zambia' },
      { code: 'en-ZW', name: 'Zimbabwe' }
    ];

    // Maps a country code (the part after the hyphen in a region code,
    // e.g. 'DE' in 'de-DE') to its ISO 4217 currency code, so the region
    // preview reflects the selected region instead of always showing USD.
    const REGION_CURRENCY = {
      AE: 'AED', AF: 'AFN', AG: 'XCD', AL: 'ALL', AM: 'AMD', AO: 'AOA', AR: 'ARS', AT: 'EUR', AU: 'AUD', AX: 'EUR',
      AZ: 'AZN', BA: 'BAM', BB: 'BBD', BD: 'BDT', BE: 'EUR', BF: 'XOF', BG: 'BGN', BH: 'BHD', BI: 'BIF', BM: 'BMD',
      BN: 'BND', BO: 'BOB', BR: 'BRL', BS: 'BSD', BT: 'BTN', BW: 'BWP', BY: 'BYN', BZ: 'BZD', CA: 'CAD', CD: 'CDF',
      CF: 'XAF', CG: 'XAF', CH: 'CHF', CI: 'XOF', CL: 'CLP', CM: 'XAF', CN: 'CNY', CO: 'COP', CR: 'CRC', CU: 'CUP',
      CV: 'CVE', CY: 'EUR', CZ: 'CZK', DE: 'EUR', DJ: 'DJF', DK: 'DKK', DM: 'XCD', DO: 'DOP', DZ: 'DZD', EC: 'USD',
      EE: 'EUR', EG: 'EGP', ER: 'ERN', ES: 'EUR', ET: 'ETB', FI: 'EUR', FJ: 'FJD', FM: 'USD', FO: 'DKK', FR: 'EUR',
      GA: 'XAF', GB: 'GBP', GD: 'XCD', GE: 'GEL', GG: 'GBP', GH: 'GHS', GL: 'DKK', GM: 'GMD', GR: 'EUR', GT: 'GTQ',
      GW: 'XOF', GY: 'GYD', HK: 'HKD', HN: 'HNL', HR: 'EUR', HU: 'HUF', ID: 'IDR', IE: 'EUR', IL: 'ILS', IM: 'GBP',
      IN: 'INR', IQ: 'IQD', IR: 'IRR', IS: 'ISK', IT: 'EUR', JE: 'GBP', JM: 'JMD', JO: 'JOD', JP: 'JPY', KE: 'KES',
      KG: 'KGS', KH: 'KHR', KI: 'AUD', KN: 'XCD', KP: 'KPW', KR: 'KRW', KW: 'KWD', KY: 'KYD', KZ: 'KZT', LA: 'LAK',
      LB: 'LBP', LC: 'XCD', LK: 'LKR', LR: 'LRD', LT: 'EUR', LU: 'EUR', LV: 'EUR', LY: 'LYD', MA: 'MAD', MD: 'MDL',
      MG: 'MGA', MH: 'USD', MK: 'MKD', ML: 'XOF', MM: 'MMK', MN: 'MNT', MO: 'MOP', MR: 'MRU', MT: 'EUR', MU: 'MUR',
      MV: 'MVR', MW: 'MWK', MX: 'MXN', MY: 'MYR', MZ: 'MZN', NA: 'NAD', NC: 'XPF', NE: 'XOF', NG: 'NGN', NI: 'NIO',
      NL: 'EUR', NO: 'NOK', NP: 'NPR', NR: 'AUD', NZ: 'NZD', OM: 'OMR', PA: 'PAB', PE: 'PEN', PF: 'XPF', PG: 'PGK',
      PH: 'PHP', PK: 'PKR', PL: 'PLN', PR: 'USD', PS: 'ILS', PT: 'EUR', PW: 'USD', PY: 'PYG', QA: 'QAR', RE: 'EUR',
      RO: 'RON', RS: 'RSD', RU: 'RUB', RW: 'RWF', SA: 'SAR', SB: 'SBD', SC: 'SCR', SD: 'SDG', SE: 'SEK', SG: 'SGD',
      SI: 'EUR', SK: 'EUR', SL: 'SLE', SN: 'XOF', SO: 'SOS', SR: 'SRD', SS: 'SSP', ST: 'STN', SV: 'USD', SY: 'SYP',
      TD: 'XAF', TH: 'THB', TJ: 'TJS', TL: 'USD', TM: 'TMT', TN: 'TND', TO: 'TOP', TR: 'TRY', TT: 'TTD', TV: 'AUD',
      TW: 'TWD', TZ: 'TZS', UA: 'UAH', UG: 'UGX', US: 'USD', UY: 'UYU', UZ: 'UZS', VC: 'XCD', VE: 'VES', VN: 'VND',
      VU: 'VUV', WF: 'XPF', WS: 'WST', YE: 'YER', ZA: 'ZAR', ZM: 'ZMW', ZW: 'ZWL'
    };

    const TIMEZONES = [
      'Africa/Abidjan', 'Africa/Accra', 'Africa/Addis_Ababa', 'Africa/Algiers',
      'Africa/Asmara', 'Africa/Bamako', 'Africa/Bangui', 'Africa/Banjul',
      'Africa/Bissau', 'Africa/Blantyre', 'Africa/Brazzaville', 'Africa/Bujumbura',
      'Africa/Cairo', 'Africa/Casablanca', 'Africa/Dakar', 'Africa/Dar_es_Salaam',
      'Africa/Djibouti', 'Africa/Douala', 'Africa/Freetown', 'Africa/Gaborone',
      'Africa/Harare', 'Africa/Johannesburg', 'Africa/Juba', 'Africa/Kampala',
      'Africa/Khartoum', 'Africa/Kigali', 'Africa/Kinshasa', 'Africa/Lagos',
      'Africa/Libreville', 'Africa/Luanda', 'Africa/Lusaka', 'Africa/Maputo',
      'Africa/Mogadishu', 'Africa/Monrovia', 'Africa/Nairobi', 'Africa/Ndjamena',
      'Africa/Niamey', 'Africa/Nouakchott', 'Africa/Ouagadougou', 'Africa/Sao_Tome',
      'Africa/Tripoli', 'Africa/Tunis', 'Africa/Windhoek', 'America/Anchorage',
      'America/Antigua', 'America/Argentina/Buenos_Aires', 'America/Asuncion', 'America/Barbados',
      'America/Belize', 'America/Bogota', 'America/Caracas', 'America/Cayman',
      'America/Chicago', 'America/Costa_Rica', 'America/Denver', 'America/Dominica',
      'America/El_Salvador', 'America/Grenada', 'America/Guatemala', 'America/Guayaquil',
      'America/Guyana', 'America/Havana', 'America/Jamaica', 'America/La_Paz',
      'America/Lima', 'America/Los_Angeles', 'America/Managua', 'America/Mexico_City',
      'America/Montevideo', 'America/Nassau', 'America/New_York', 'America/Noronha',
      'America/Nuuk', 'America/Panama', 'America/Paramaribo', 'America/Phoenix',
      'America/Port_of_Spain', 'America/Puerto_Rico', 'America/Regina', 'America/Santiago',
      'America/Santo_Domingo', 'America/Sao_Paulo', 'America/St_Johns', 'America/St_Kitts',
      'America/St_Lucia', 'America/St_Vincent', 'America/Tegucigalpa', 'America/Tijuana',
      'America/Toronto', 'America/Vancouver', 'Antarctica/Casey', 'Antarctica/Davis',
      'Antarctica/DumontDUrville', 'Antarctica/Macquarie', 'Antarctica/Mawson', 'Antarctica/McMurdo',
      'Antarctica/Palmer', 'Antarctica/Rothera', 'Antarctica/South_Pole', 'Antarctica/Syowa',
      'Antarctica/Troll', 'Antarctica/Vostok', 'Asia/Aden', 'Asia/Almaty',
      'Asia/Amman', 'Asia/Anadyr', 'Asia/Ashgabat', 'Asia/Baghdad',
      'Asia/Bahrain', 'Asia/Baku', 'Asia/Bangkok', 'Asia/Barnaul',
      'Asia/Beirut', 'Asia/Bishkek', 'Asia/Brunei', 'Asia/Calcutta',
      'Asia/Chongqing', 'Asia/Colombo', 'Asia/Dacca', 'Asia/Damascus',
      'Asia/Dhaka', 'Asia/Dili', 'Asia/Dubai', 'Asia/Dushanbe',
      'Asia/Gaza', 'Asia/Harbin', 'Asia/Ho_Chi_Minh', 'Asia/Hong_Kong',
      'Asia/Irkutsk', 'Asia/Jakarta', 'Asia/Jayapura', 'Asia/Jerusalem',
      'Asia/Kabul', 'Asia/Kamchatka', 'Asia/Karachi', 'Asia/Kashgar',
      'Asia/Kathmandu', 'Asia/Katmandu', 'Asia/Kolkata', 'Asia/Krasnoyarsk',
      'Asia/Kuala_Lumpur', 'Asia/Kuwait', 'Asia/Macao', 'Asia/Macau',
      'Asia/Magadan', 'Asia/Makassar', 'Asia/Manila', 'Asia/Muscat',
      'Asia/Nicosia', 'Asia/Novokuznetsk', 'Asia/Novosibirsk', 'Asia/Omsk',
      'Asia/Phnom_Penh', 'Asia/Pyongyang', 'Asia/Qatar', 'Asia/Rangoon',
      'Asia/Riyadh', 'Asia/Sakhalin', 'Asia/Seoul', 'Asia/Shanghai',
      'Asia/Singapore', 'Asia/Taipei', 'Asia/Tashkent', 'Asia/Tbilisi',
      'Asia/Tehran', 'Asia/Thimbu', 'Asia/Thimphu', 'Asia/Tokyo',
      'Asia/Tomsk', 'Asia/Ulaanbaatar', 'Asia/Urumqi', 'Asia/Vientiane',
      'Asia/Vladivostok', 'Asia/Yakutsk', 'Asia/Yangon', 'Asia/Yekaterinburg',
      'Asia/Yerevan', 'Atlantic/Azores', 'Atlantic/Bermuda', 'Atlantic/Cape_Verde',
      'Atlantic/Faroe', 'Atlantic/Reykjavik', 'Atlantic/South_Georgia', 'Australia/Adelaide',
      'Australia/Brisbane', 'Australia/Currie', 'Australia/Darwin', 'Australia/Eucla',
      'Australia/Hobart', 'Australia/Lindeman', 'Australia/Lord_Howe', 'Australia/Melbourne',
      'Australia/Perth', 'Australia/Sydney', 'Europe/Amsterdam', 'Europe/Astrakhan',
      'Europe/Athens', 'Europe/Belfast', 'Europe/Belgrade', 'Europe/Berlin',
      'Europe/Bratislava', 'Europe/Brussels', 'Europe/Bucharest', 'Europe/Budapest',
      'Europe/Chisinau', 'Europe/Copenhagen', 'Europe/Dublin', 'Europe/Guernsey',
      'Europe/Helsinki', 'Europe/Isle_of_Man', 'Europe/Istanbul', 'Europe/Jersey',
      'Europe/Kaliningrad', 'Europe/Kyiv', 'Europe/Lisbon', 'Europe/Ljubljana',
      'Europe/London', 'Europe/Luxembourg', 'Europe/Madrid', 'Europe/Malta',
      'Europe/Minsk', 'Europe/Moscow', 'Europe/Oslo', 'Europe/Paris',
      'Europe/Prague', 'Europe/Riga', 'Europe/Rome', 'Europe/Sarajevo',
      'Europe/Saratov', 'Europe/Skopje', 'Europe/Sofia', 'Europe/Stockholm',
      'Europe/Tallinn', 'Europe/Tirane', 'Europe/Ulyanovsk', 'Europe/Vienna',
      'Europe/Vilnius', 'Europe/Volgograd', 'Europe/Warsaw', 'Europe/Zagreb',
      'Europe/Zurich', 'Indian/Antananarivo', 'Indian/Chagos', 'Indian/Christmas',
      'Indian/Cocos', 'Indian/Kerguelen', 'Indian/Mahe', 'Indian/Maldives',
      'Indian/Mauritius', 'Indian/Reunion', 'Pacific/Apia', 'Pacific/Auckland',
      'Pacific/Chuuk', 'Pacific/Efate', 'Pacific/Fiji', 'Pacific/Funafuti',
      'Pacific/Gambier', 'Pacific/Guadalcanal', 'Pacific/Guam', 'Pacific/Honolulu',
      'Pacific/Johnston', 'Pacific/Kiritimati', 'Pacific/Kosrae', 'Pacific/Kwajalein',
      'Pacific/Majuro', 'Pacific/Marquesas', 'Pacific/Midway', 'Pacific/Nauru',
      'Pacific/Niue', 'Pacific/Norfolk', 'Pacific/Noumea', 'Pacific/Pago_Pago',
      'Pacific/Palau', 'Pacific/Pohnpei', 'Pacific/Ponape', 'Pacific/Port_Moresby',
      'Pacific/Rarotonga', 'Pacific/Saipan', 'Pacific/Tahiti', 'Pacific/Tarawa',
      'Pacific/Tongatapu', 'Pacific/Truk', 'Pacific/Wallis', 'Pacific/Yap'
    ];

    // Region code → canonical IANA timezone, used to auto-switch the timezone
    // select when the user picks a new region.
    const REGION_TO_TIMEZONE = {
      'fa-AF': 'Asia/Kabul', 'sv-AX': 'Europe/Helsinki', 'sq-AL': 'Europe/Tirane', 'fr-DZ': 'Africa/Algiers',
      'pt-AO': 'Africa/Luanda', 'en-AG': 'America/Antigua', 'es-AR': 'America/Argentina/Buenos_Aires',
      'hy-AM': 'Asia/Yerevan', 'en-AU': 'Australia/Sydney', 'de-AT': 'Europe/Vienna', 'az-AZ': 'Asia/Baku',
      'en-BS': 'America/Nassau', 'ar-BH': 'Asia/Bahrain', 'bn-BD': 'Asia/Dhaka', 'en-BB': 'America/Barbados',
      'be-BY': 'Europe/Minsk', 'fr-BE': 'Europe/Brussels', 'en-BZ': 'America/Belize', 'en-BM': 'Atlantic/Bermuda',
      'dz-BT': 'Asia/Thimphu', 'es-BO': 'America/La_Paz', 'bs-BA': 'Europe/Sarajevo', 'tn-BW': 'Africa/Gaborone',
      'pt-BR': 'America/Sao_Paulo', 'ms-BN': 'Asia/Brunei', 'bg-BG': 'Europe/Sofia', 'fr-BF': 'Africa/Ouagadougou',
      'fr-BI': 'Africa/Bujumbura', 'pt-CV': 'Atlantic/Cape_Verde', 'km-KH': 'Asia/Phnom_Penh',
      'fr-CM': 'Africa/Douala', 'fr-CA': 'America/Toronto', 'en-KY': 'America/Cayman', 'fr-CF': 'Africa/Bangui',
      'fr-TD': 'Africa/Ndjamena', 'es-CL': 'America/Santiago', 'zh-CN': 'Asia/Shanghai', 'es-CO': 'America/Bogota',
      'fr-CG': 'Africa/Brazzaville', 'es-CR': 'America/Costa_Rica', 'fr-CI': 'Africa/Abidjan', 'hr-HR': 'Europe/Zagreb',
      'es-CU': 'America/Havana', 'el-CY': 'Asia/Nicosia', 'cs-CZ': 'Europe/Prague', 'da-DK': 'Europe/Copenhagen',
      'ar-DJ': 'Africa/Djibouti', 'en-DM': 'America/Dominica', 'es-DO': 'America/Santo_Domingo',
      'fr-CD': 'Africa/Kinshasa', 'es-EC': 'America/Guayaquil', 'ar-EG': 'Africa/Cairo', 'es-SV': 'America/El_Salvador',
      'ti-ER': 'Africa/Asmara', 'et-EE': 'Europe/Tallinn', 'am-ET': 'Africa/Addis_Ababa', 'fo-FO': 'Atlantic/Faroe',
      'fj-FJ': 'Pacific/Fiji', 'fi-FI': 'Europe/Helsinki', 'fr-FR': 'Europe/Paris', 'ty-PF': 'Pacific/Tahiti',
      'fr-GA': 'Africa/Libreville', 'en-GM': 'Africa/Banjul', 'ka-GE': 'Asia/Tbilisi', 'de-DE': 'Europe/Berlin',
      'en-GH': 'Africa/Accra', 'el-GR': 'Europe/Athens', 'kl-GL': 'America/Nuuk', 'en-GD': 'America/Grenada',
      'es-GT': 'America/Guatemala', 'fr-GG': 'Europe/Guernsey', 'pt-GW': 'Africa/Bissau', 'fr-GY': 'America/Guyana',
      'es-HN': 'America/Tegucigalpa', 'zh-HK': 'Asia/Hong_Kong', 'hu-HU': 'Europe/Budapest', 'is-IS': 'Atlantic/Reykjavik',
      'hi-IN': 'Asia/Kolkata', 'id-ID': 'Asia/Jakarta', 'fa-IR': 'Asia/Tehran', 'ar-IQ': 'Asia/Baghdad',
      'ga-IE': 'Europe/Dublin', 'gv-IM': 'Europe/Isle_of_Man', 'he-IL': 'Asia/Jerusalem', 'it-IT': 'Europe/Rome',
      'en-JM': 'America/Jamaica', 'ja-JP': 'Asia/Tokyo', 'fr-JE': 'Europe/Jersey', 'ar-JO': 'Asia/Amman',
      'kk-KZ': 'Asia/Almaty', 'sw-KE': 'Africa/Nairobi', 'en-KI': 'Pacific/Tarawa', 'ar-KW': 'Asia/Kuwait',
      'ky-KG': 'Asia/Bishkek', 'lo-LA': 'Asia/Vientiane', 'lv-LV': 'Europe/Riga', 'ar-LB': 'Asia/Beirut',
      'en-LR': 'Africa/Monrovia', 'ar-LY': 'Africa/Tripoli', 'lt-LT': 'Europe/Vilnius', 'lb-LU': 'Europe/Luxembourg',
      'zh-MO': 'Asia/Macau', 'mg-MG': 'Indian/Antananarivo', 'en-MW': 'Africa/Blantyre', 'ms-MY': 'Asia/Kuala_Lumpur',
      'dv-MV': 'Indian/Maldives', 'fr-ML': 'Africa/Bamako', 'mt-MT': 'Europe/Malta', 'en-MH': 'Pacific/Majuro',
      'ar-MR': 'Africa/Nouakchott', 'fr-MU': 'Indian/Mauritius', 'es-MX': 'America/Mexico_City', 'en-FM': 'Pacific/Chuuk',
      'ru-MD': 'Europe/Chisinau', 'mn-MN': 'Asia/Ulaanbaatar', 'ar-MA': 'Africa/Casablanca', 'pt-MZ': 'Africa/Maputo',
      'my-MM': 'Asia/Yangon', 'af-NA': 'Africa/Windhoek', 'en-NR': 'Pacific/Nauru', 'ne-NP': 'Asia/Kathmandu',
      'nl-NL': 'Europe/Amsterdam', 'fr-NC': 'Pacific/Noumea', 'mi-NZ': 'Pacific/Auckland', 'es-NI': 'America/Managua',
      'fr-NE': 'Africa/Niamey', 'en-NG': 'Africa/Lagos', 'ko-KP': 'Asia/Pyongyang', 'mk-MK': 'Europe/Skopje',
      'nb-NO': 'Europe/Oslo', 'ar-OM': 'Asia/Muscat', 'ur-PK': 'Asia/Karachi', 'en-PW': 'Pacific/Palau',
      'ar-PS': 'Asia/Gaza', 'es-PA': 'America/Panama', 'en-PG': 'Pacific/Port_Moresby', 'gn-PY': 'America/Asuncion',
      'es-PE': 'America/Lima', 'fil-PH': 'Asia/Manila', 'pl-PL': 'Europe/Warsaw', 'pt-PT': 'Europe/Lisbon',
      'es-PR': 'America/Puerto_Rico', 'ar-QA': 'Asia/Qatar', 'fr-RE': 'Indian/Reunion', 'ro-RO': 'Europe/Bucharest',
      'ru-RU': 'Europe/Moscow', 'fr-RW': 'Africa/Kigali', 'en-KN': 'America/St_Kitts', 'en-LC': 'America/St_Lucia',
      'en-VC': 'America/St_Vincent', 'sm-WS': 'Pacific/Apia', 'pt-ST': 'Africa/Sao_Tome', 'ar-SA': 'Asia/Riyadh',
      'fr-SN': 'Africa/Dakar', 'sr-RS': 'Europe/Belgrade', 'fr-SC': 'Indian/Mahe', 'en-SL': 'Africa/Freetown',
      'zh-SG': 'Asia/Singapore', 'sk-SK': 'Europe/Bratislava', 'sl-SI': 'Europe/Ljubljana', 'en-SB': 'Pacific/Guadalcanal',
      'so-SO': 'Africa/Mogadishu', 'zu-ZA': 'Africa/Johannesburg', 'ko-KR': 'Asia/Seoul', 'ar-SS': 'Africa/Juba',
      'es-ES': 'Europe/Madrid', 'si-LK': 'Asia/Colombo', 'ar-SD': 'Africa/Khartoum', 'nl-SR': 'America/Paramaribo',
      'sv-SE': 'Europe/Stockholm', 'de-CH': 'Europe/Zurich', 'ar-SY': 'Asia/Damascus', 'zh-TW': 'Asia/Taipei',
      'tg-TJ': 'Asia/Dushanbe', 'sw-TZ': 'Africa/Dar_es_Salaam', 'th-TH': 'Asia/Bangkok', 'pt-TL': 'Asia/Dili',
      'to-TO': 'Pacific/Tongatapu', 'en-TT': 'America/Port_of_Spain', 'ar-TN': 'Africa/Tunis', 'tr-TR': 'Europe/Istanbul',
      'tk-TM': 'Asia/Ashgabat', 'en-TV': 'Pacific/Funafuti', 'sw-UG': 'Africa/Kampala', 'uk-UA': 'Europe/Kyiv',
      'ar-AE': 'Asia/Dubai', 'en-GB': 'Europe/London', 'en-US': 'America/New_York', 'es-UY': 'America/Montevideo',
      'uz-UZ': 'Asia/Tashkent', 'en-VU': 'Pacific/Efate', 'es-VE': 'America/Caracas', 'vi-VN': 'Asia/Ho_Chi_Minh',
      'fr-WF': 'Pacific/Wallis', 'ar-YE': 'Asia/Aden', 'en-ZM': 'Africa/Lusaka', 'en-ZW': 'Africa/Harare'
    };

    // Keys that must never be restored from an imported JSON file — they're
    // machine/session-specific and overwriting them from an untrusted file
    // would be a security or stability hole.
    const IMPORT_PROTECTED_KEYS = new Set([
      'nova_manual_recovery', 'nova_safe_mode', 'nova_boot_attempts', 'nova_force_recovery'
    ]);

    // i18next is optional — load it once at init, not on every render
    let i18n = null;
    try { i18n = require('i18next'); } catch { /* i18next not installed */ }

    // State
    const validIds = new Set(SECTIONS.map(s => s.id));
    const opts = options || {};
    let currentSection = validIds.has(opts.section) ? opts.section : 'appearance';
    // Set when another app opened us via apps.openDefaultAppsSettings() —
    // used only to highlight a row / show an informational banner.
    const highlightCategory = typeof opts.highlightCategory === 'string' ? opts.highlightCategory : null;
    const requestingAppId   = typeof opts.requestingAppId   === 'string' ? opts.requestingAppId   : null;

    // Lifecycle — AbortController fires when init returns its cleanup.
    // Every addEventListener in this file passes { signal } so listeners
    // are torn down automatically. Async callbacks check isAlive() before
    // touching the DOM so a slow fetch can't update a detached tree.
    const lifecycle = new AbortController();
    const isAlive = () => !lifecycle.signal.aborted && content.isConnected;

    // Tracks overlays (pickers, dialogs, key-capture) mounted on document.body
    // so we can close them when the section changes or the app closes.
    const trackedOverlays = new Map(); // element -> AbortController

    function mountOverlay(el) {
      const ac = new AbortController();
      trackedOverlays.set(el, ac);
      document.body.appendChild(el);
      return ac;
    }

    function dismissOverlay(el) {
      const ac = trackedOverlays.get(el);
      if (ac) ac.abort();
      trackedOverlays.delete(el);
      if (el.isConnected) el.remove();
    }

    function closeAllOverlays() {
      for (const [el, ac] of trackedOverlays) {
        ac.abort();
        if (el.isConnected) el.remove();
      }
      trackedOverlays.clear();
    }

    // Small helper to log in dev mode only — replaces silent catch blocks
    const devLog = (...args) => {
      try { if (typeof OS !== 'undefined' && OS.settings?.get('devMode')) console.warn('[Settings]', ...args); } catch { /* settings not ready */ }
    };

    // DOM skeleton
    const container   = createEl('div', { className: 'nook-container' });
    const sidebar     = createEl('nav', { className: 'nook-sidebar', 'aria-label': 'Settings sections' });
    const mainContent = createEl('div', { className: 'nook-content' });

    // Sidebar — built once; only the active class changes on navigation
    const sidebarBtns = new Map();

    function buildSidebar() {
      const frag = document.createDocumentFragment();
      for (const s of SECTIONS) {
        const btn = createEl('button', {
          className: 'nook-section-btn',
          'aria-label': s.name,
          'aria-current': currentSection === s.id ? 'true' : 'false'
        });
        const iconSpan = createEl('span', { 'aria-hidden': 'true' });
        iconSpan.innerHTML = svgIcon(s.icon, 16);
        btn.append(iconSpan, createEl('span', { textContent: s.name }));
        btn.addEventListener('click', () => {
          currentSection = s.id;
          updateSidebarActive();
          renderContent();
        }, { signal: lifecycle.signal });
        sidebarBtns.set(s.id, btn);
        frag.appendChild(btn);
      }
      sidebar.appendChild(frag);
      updateSidebarActive();
    }

    function updateSidebarActive() {
      for (const [id, btn] of sidebarBtns) {
        const active = id === currentSection;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-current', active ? 'true' : 'false');
      }
    }

    // Content router
    function renderContent() {
      if (!isAlive()) return;
      closeAllOverlays();
      mainContent.replaceChildren();
      // renderAbout sets padding to '0' — reset so other sections get their
      // default padding back (previously it stayed at '0' after visiting About)
      mainContent.style.padding = '';
      mainContent.dataset.currentTab = currentSection;
      switch (currentSection) {
        case 'appearance':        renderAppearance();      break;
        case 'accessibility':     renderAccessibility();   break;
        case 'system':            renderSystem();          break;
        case 'date-and-region':   renderDateAndRegion();   break;
        case 'storage':           renderStorage();         break;
        case 'shortcuts':         renderShortcuts();       break;
        case 'privacy':           renderPrivacy();         break;
        case 'apps':              renderApps();            break;
        case 'default-apps':      renderDefaultApps();     break;
        case 'desktop':           renderDesktop();         break;
        case 'about':             renderAbout();           break;
        default:
          mainContent.appendChild(createEl('div', { className: 'empty-state', textContent: 'Section coming soon' }));
      }
    }

    // Appearance
    function renderAppearance() {
      mainContent.appendChild(createEl('h2', { textContent: 'Appearance', style: { marginBottom: '20px' } }));

      const wallpaperLocked = OS.settings.get('prohibitWallpaperChange');
      const currentTheme    = OS.settings.get('theme');
      const currentAccent   = OS.settings.get('accentColor');

      // Theme
      const themeGroup = createEl('div', { className: 'nook-group' });
      themeGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Theme' }));
      for (let i = 0; i < THEMES.length; i++) {
        const t = THEMES[i];
        const row = createEl('div', { className: 'nook-row' });
        row.appendChild(createEl('span', { className: 'nook-row-label', textContent: THEME_NAMES[i] }));
        const isActive = currentTheme === t;
        const btn = createEl('button', {
          className: 'btn btn-sm' + (isActive ? ' btn-primary' : ''),
          textContent: isActive ? 'Active' : 'Select',
          'aria-pressed': String(isActive)
        });
        btn.addEventListener('click', () => {
          OS.settings.set('theme', t);
          applyTheme(t);
          // applyTheme resets --accent to the theme default, so re-apply
          // the user's saved custom accent on top of it.
          const savedAccent = OS.settings.get('accentColor');
          if (savedAccent) {
            document.documentElement.style.setProperty('--accent', savedAccent);
            document.documentElement.style.setProperty('--accent-hover', savedAccent + 'dd');
            document.documentElement.style.setProperty('--accent-muted', savedAccent + '26');
          }
          renderContent();
        }, { signal: lifecycle.signal });
        row.appendChild(btn);
        themeGroup.appendChild(row);
      }
      mainContent.appendChild(themeGroup);

      // Accent color
      const accentGroup = createEl('div', { className: 'nook-group' });
      accentGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Accent Color' }));
      if (wallpaperLocked) {
        accentGroup.appendChild(createEl('div', {
          style: 'font-size:11px;color:var(--text-warning,#d29922);padding:4px 0;',
          textContent: '\uD83D\uDD12 Accent colour changes are restricted by policy.'
        }));
      }
      const colorRow = createEl('div', { className: 'nook-row' });
      for (const c of ACCENT_COLORS) {
        const selected = currentAccent === c;
        const btn = createEl('button', {
          className: 'btn btn-sm',
          style: {
            width: '32px', height: '32px', background: c,
            border: selected ? '2px solid white' : 'none',
            borderRadius: '50%', padding: '0',
            opacity: wallpaperLocked ? '0.4' : '1',
            cursor: wallpaperLocked ? 'not-allowed' : 'pointer'
          },
          'aria-label': 'Color ' + c,
          'aria-pressed': String(selected),
          disabled: !!wallpaperLocked
        });
        if (!wallpaperLocked) {
          btn.addEventListener('click', () => {
            OS.settings.set('accentColor', c);
            document.documentElement.style.setProperty('--accent', c);
            document.documentElement.style.setProperty('--accent-hover', c + 'dd');
            document.documentElement.style.setProperty('--accent-muted', c + '22');
            renderContent();
          }, { signal: lifecycle.signal });
        }
        colorRow.appendChild(btn);
      }
      accentGroup.appendChild(colorRow);
      mainContent.appendChild(accentGroup);

      // Clock format
      const clockGroup = createEl('div', { className: 'nook-group' });
      clockGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Clock' }));
      const clockRow = createEl('div', { className: 'nook-row' });
      clockRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Time Format' }));
      const is24h = OS.settings.get('clockFormat') === '24h';
      const clockToggle = createEl('button', {
        className: 'toggle' + (is24h ? ' active' : ''),
        role: 'switch',
        'aria-checked': String(is24h),
        'aria-label': 'Toggle 24-hour time'
      });
      clockToggle.addEventListener('click', () => {
        const was24 = OS.settings.get('clockFormat') === '24h';
        OS.settings.set('clockFormat', was24 ? '12h' : '24h');
        clockToggle.classList.toggle('active', !was24);
        clockToggle.setAttribute('aria-checked', String(!was24));
        // Force the tray clock to update immediately instead of waiting for the next tick
        const timeEl = document.getElementById('tray-time');
        if (timeEl) {
          const now = new Date();
          const h = now.getHours(), m = now.getMinutes();
          if (!was24) {
            timeEl.textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
          } else {
            const h12 = h % 12 || 12;
            timeEl.textContent = h12 + ':' + String(m).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM');
          }
        }
      }, { signal: lifecycle.signal });
      clockRow.appendChild(clockToggle);
      clockGroup.appendChild(clockRow);
      mainContent.appendChild(clockGroup);
    }

    // System
    function renderSystem() {
      mainContent.appendChild(createEl('h2', { textContent: 'System', style: { marginBottom: '20px' } }));

      // User
      const userGroup = createEl('div', { className: 'nook-group' });
      userGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'User' }));
      const userRow = createEl('div', { className: 'nook-row' });
      const userLabel = createEl('label', { className: 'nook-row-label', htmlFor: 'system-username-input', textContent: 'Username' });
      userRow.appendChild(userLabel);
      const userInput = createEl('input', {
        className: 'input', id: 'system-username-input', name: 'system-username',
        style: { width: '150px' }, value: OS.username
      });
      userInput.addEventListener('change', () => {
        OS.username = userInput.value || 'user';
        OS.settings.set('username', OS.username);
      }, { signal: lifecycle.signal });
      userRow.appendChild(userInput);
      userGroup.appendChild(userRow);
      mainContent.appendChild(userGroup);

      // Lock screen
      const lockGroup = createEl('div', { className: 'nook-group' });
      lockGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Lock Screen' }));
      const pinRow = createEl('div', { className: 'nook-row' });
      pinRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'PIN Lock' }));

      const pinBtn = createEl('button', { className: 'btn btn-sm', textContent: OS.lockPin ? 'Change PIN' : 'Set PIN' });
      pinBtn.addEventListener('click', async () => {
        if (OS.lockPin) {
          const currentPin = await showModal('Change PIN', 'Enter current PIN:', [
            { label: 'Cancel' }, { label: 'Next', value: 'next' }
          ], 'password');
          if (!isAlive()) return;
          if (!currentPin) return;
          const hash = await OS.workers.crypto.call('pbkdf2', currentPin, getPinSalt());
          if (hash !== OS.lockPin) {
            showModal('Incorrect PIN', 'The current PIN you entered is incorrect.');
            return;
          }
        }

        const pin1 = await showModal(OS.lockPin ? 'New PIN' : 'Set PIN', 'Enter a 4-digit PIN:', [
          { label: 'Cancel' }, { label: 'Next', value: 'next' }
        ], 'password');
        if (!isAlive()) return;
        if (!pin1 || pin1.length !== 4 || !/^\d{4}$/.test(pin1)) {
          if (pin1) showModal('Invalid PIN', 'PIN must be exactly 4 digits.');
          return;
        }

        const pin2 = await showModal('Confirm PIN', 'Re-enter your PIN:', [
          { label: 'Cancel' }, { label: 'Set PIN', value: 'confirm' }
        ], 'password');
        if (!isAlive()) return;
        if (pin1 !== pin2) {
          showModal('PIN Mismatch', 'The PINs do not match. Please try again.');
          return;
        }

        const wasSet  = !!OS.lockPin;
        const newHash = await OS.workers.crypto.call('pbkdf2', pin1, getPinSalt());
        if (!isAlive()) return;
        OS.lockPin    = newHash;
        OS.settings.set('lockPin', newHash);
        Notify.show({ title: wasSet ? 'PIN Updated' : 'PIN Set', body: wasSet ? 'Lock screen PIN has been updated' : 'Lock screen PIN has been set', type: 'success', appName: 'Settings' });
        renderContent();
      }, { signal: lifecycle.signal });
      pinRow.appendChild(pinBtn);

      if (OS.lockPin) {
        const removePinBtn = createEl('button', { className: 'btn btn-sm btn-danger', textContent: 'Remove', style: { marginLeft: '8px' } });
        removePinBtn.addEventListener('click', async () => {
          const result = await showModal('Remove PIN', 'Are you sure you want to remove PIN lock?', [
            { label: 'Cancel' }, { label: 'Remove PIN', danger: true, value: 'confirm' }
          ]);
          if (!isAlive()) return;
          if (result === 'confirm') {
            OS.settings.set('lockPin', null);
            OS.lockPin = null;
            Notify.show({ title: 'PIN Removed', body: 'PIN lock has been disabled', type: 'success', appName: 'Settings' });
            renderContent();
          }
        }, { signal: lifecycle.signal });
        pinRow.appendChild(removePinBtn);
      }
      lockGroup.appendChild(pinRow);
      mainContent.appendChild(lockGroup);

      // Recovery
      const recoveryGroup = createEl('div', { className: 'nook-group' });
      recoveryGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Recovery' }));
      const recoveryRow = createEl('div', { className: 'nook-row' });
      recoveryRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Recovery Environment' }));
      const recoveryBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Boot to Recovery', style: { background: '#6c5ce7' } });
      recoveryBtn.addEventListener('click', async () => {
        const confirmed = await showModal(
          'Boot to Recovery Environment',
          'This will restart and show the recovery options screen.',
          [{ label: 'Cancel' }, { label: 'Boot to Recovery', value: 'confirm', primary: true }]
        );
        if (!isAlive()) return;
        if (confirmed !== 'confirm') return;
        // Set the manual recovery flag so init.js knows this is intentional.
        // init.js's manual-recovery branch clears nova_boot_attempts itself,
        // so we don't write fake boot-attempt entries here.
        localStorage.setItem('nova_manual_recovery', '1');
        localStorage.removeItem('nova_safe_mode');
        location.reload();
      }, { signal: lifecycle.signal });
      recoveryRow.appendChild(recoveryBtn);
      recoveryGroup.appendChild(recoveryRow);
      mainContent.appendChild(recoveryGroup);

      // Developer Mode
      const devGroup = createEl('div', { className: 'nook-group' });
      devGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Developer' }));
      const devRow = createEl('div', { className: 'nook-toggle-row' });
      devRow.appendChild(createEl('span', { textContent: 'Developer Mode' }));
      const devOn = !!OS.settings.get('devMode');
      const devToggle = createEl('button', {
        className: 'toggle' + (devOn ? ' active' : ''),
        role: 'switch',
        'aria-checked': String(devOn),
        'aria-label': 'Toggle developer mode'
      });
      devToggle.addEventListener('click', async () => {
        const next = !OS.settings.get('devMode');
        if (next) {
          const confirmed = await showDevModeWarning();
          if (!isAlive()) return;
          if (confirmed !== 'confirm') return;
        }
        OS.settings.set('devMode', next);
        devToggle.classList.toggle('active', next);
        devToggle.setAttribute('aria-checked', String(next));
        if (window.DebugOverlay) {
          next ? window.DebugOverlay.enable() : window.DebugOverlay.disable();
        }
        Notify.show({
          title: next ? 'Developer Mode Enabled' : 'Developer Mode Disabled',
          body: next ? 'Press F3 to toggle debug overlay' : undefined,
          type: 'info',
          appName: 'Settings'
        });
      }, { signal: lifecycle.signal });
      devRow.appendChild(devToggle);
      devGroup.appendChild(devRow);
      mainContent.appendChild(devGroup);
    }

    // Developer mode confirmation dialog — built with DOM nodes, tracked
    // for cleanup if the section changes while it's open.
    function showDevModeWarning() {
      return new Promise(resolve => {
        const overlay = createEl('div', {
          style: 'position:fixed;inset:0;z-index:99001;background:rgba(0,0,0,0.45);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;animation:fadeIn 150ms ease;'
        });
        const ac = mountOverlay(overlay);
        let settled = false;
        const finish = (v) => {
          if (settled) return;
          settled = true;
          dismissOverlay(overlay);
          resolve(v);
        };
        ac.signal.addEventListener('abort', () => finish(null));

        const dialog = createEl('div', {
          style: 'background:var(--bg-elevated,#1b1f23);border:1px solid var(--text-danger,#f85149);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgba(248,81,73,0.25);padding:28px;max-width:520px;width:92%;animation:modalIn 200ms ease-out;'
        });

        const header = createEl('div', { style: 'display:flex;align-items:center;gap:12px;margin-bottom:16px;' });
        header.appendChild(createEl('span', { textContent: '\u26A0\uFE0F', style: 'font-size:22px;line-height:1;' }));
        header.appendChild(createEl('div', {
          textContent: 'Developer Mode — Security Warning',
          style: 'font-size:17px;font-weight:700;color:var(--text-danger,#f85149);letter-spacing:0.2px;'
        }));
        dialog.appendChild(header);

        const body = createEl('div', {
          style: 'font-size:14px;color:var(--text-secondary,#aaa);line-height:1.55;margin-bottom:18px;white-space:pre-line;max-height:340px;overflow-y:auto;padding-right:4px;'
        });
        body.textContent =
          'WARNING: Developer Mode lowers the system\'s security posture and grants elevated access to internal components.\n\n' +
          'When enabled, the following restrictions are relaxed:\n' +
          '\u2022 Unrestricted access to the filesystem, networks, and system APIs\n' +
          '\u2022 Elevated permissions to internal system modules and runtime internals\n' +
          '\u2022 Visibility into running processes, memory, and module state\n' +
          '\u2022 The ability to inspect, alter, or revoke app permissions\n' +
          '\u2022 The ability to install, remove, or modify system packages\n\n' +
          'The following internal apps and tools become accessible:\n' +
          '\u2022 Console — runs arbitrary JavaScript in the full OS context with no sandboxing\n' +
          '\u2022 Inspector — can force-close arbitrary windows and export app state\n' +
          '\u2022 Packages — can install unsigned or unverified packages into the live registry, and can add a locally-generated signing key to this device\u2019s trust store for the current session (only affects installs on this machine; never affects other clones, forks, or devices)\n' +
          '\u2022 Modules — can dynamically import arbitrary module paths for live code execution\n' +
          '\u2022 Permissions — can bulk-grant or revoke permissions for any app without user consent\n' +
          '\u2022 Perf — exposes detailed runtime performance data, memory usage, and per-window DOM breakdowns\n' +
          '\u2022 SysAccess — can read the virtual filesystem and probe internal network/SSRF configuration\n' +
          '\u2022 Events — full visibility into all system-wide activity, including console output, permission checks, package operations, and app event data payloads across every app and OS component\n' +
          '\u2022 Debug Overlay — persistent always-on-top diagnostics overlay exposing GPU, memory, URLs, and OS internals (F3)\n\n' +
          'Developer Mode is intended solely for development, debugging, and system maintenance. Enable it only when you understand the risks. Leave it disabled during normal use.';
        dialog.appendChild(body);

        const actions = createEl('div', { style: 'display:flex;gap:10px;justify-content:flex-end;' });
        const cancelBtn = createEl('button', { className: 'btn', textContent: 'Cancel' });
        const confirmBtn = createEl('button', { className: 'btn btn-danger', textContent: 'Turn On Anyway' });
        actions.append(cancelBtn, confirmBtn);
        dialog.appendChild(actions);
        overlay.appendChild(dialog);

        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) { finish(null); return; }
          const btn = e.target.closest('button');
          if (btn && actions.contains(btn)) {
            finish(btn === confirmBtn ? 'confirm' : null);
          }
        }, { signal: ac.signal });

        confirmBtn.focus();
      });
    }

    // Date and Region
    function renderDateAndRegion() {
      mainContent.appendChild(createEl('h2', { textContent: 'Date and Region', style: { marginBottom: '20px' } }));

      const savedRegion = OS.settings.get('region') || navigator.language || 'en-US';
      const currentRegion = REGIONS.some(r => r.code === savedRegion) ? savedRegion : 'en-US';

      const detectedTz = (typeof Intl !== 'undefined' && Intl.DateTimeFormat) ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
      const savedTimezone = OS.settings.get('timezone') || detectedTz;
      const currentTimezone = TIMEZONES.includes(savedTimezone) ? savedTimezone : detectedTz;

      // Region select
      const regionGroup = createEl('div', { className: 'nook-group' });
      regionGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Region' }));
      const regionRow = createEl('div', { className: 'nook-row' });
      const regionLabel = createEl('label', { className: 'nook-row-label', htmlFor: 'region-select', textContent: 'Date & Currency Format' });
      regionRow.appendChild(regionLabel);

      const regionSelect = document.createElement('select');
      regionSelect.className = 'input';
      regionSelect.id = 'region-select';
      for (const r of REGIONS) {
        const opt = document.createElement('option');
        opt.value = r.code;
        opt.textContent = r.name;
        if (r.code === currentRegion) opt.selected = true;
        regionSelect.appendChild(opt);
      }
      regionRow.appendChild(regionSelect);
      regionGroup.appendChild(regionRow);
      mainContent.appendChild(regionGroup);

      // Timezone select
      const timezoneSelect = document.createElement('select');
      timezoneSelect.className = 'input';
      timezoneSelect.id = 'timezone-select';
      for (const tz of TIMEZONES) {
        const opt = document.createElement('option');
        opt.value = tz;
        opt.textContent = tz;
        if (tz === currentTimezone) opt.selected = true;
        timezoneSelect.appendChild(opt);
      }
      timezoneSelect.addEventListener('change', () => {
        OS.settings.set('timezone', timezoneSelect.value);
        renderContent();
      }, { signal: lifecycle.signal });

      const timezoneGroup = createEl('div', { className: 'nook-group' });
      timezoneGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Timezone' }));
      const timezoneRow = createEl('div', { className: 'nook-row' });
      const tzLabel = createEl('label', { className: 'nook-row-label', htmlFor: 'timezone-select', textContent: 'Current Timezone' });
      timezoneRow.appendChild(tzLabel);
      timezoneRow.appendChild(timezoneSelect);
      timezoneGroup.appendChild(timezoneRow);
      mainContent.appendChild(timezoneGroup);

      regionSelect.addEventListener('change', async () => {
        const selected = regionSelect.value;
        OS.settings.set('region', selected);
        const mappedTz = REGION_TO_TIMEZONE[selected];
        if (mappedTz && TIMEZONES.includes(mappedTz)) {
          OS.settings.set('timezone', mappedTz);
          timezoneSelect.value = mappedTz;
        }
        if (i18n) {
          try { await i18n.changeLanguage(selected); } catch (err) { devLog('i18next changeLanguage failed:', err); }
        }
        try { document.documentElement.lang = selected; } catch { /* read-only */ }
        renderContent();
      }, { signal: lifecycle.signal });

      // Keyboard layout
      const kbGroup = createEl('div', { className: 'nook-group' });
      kbGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Keyboard Layout' }));
      const kbRow = createEl('div', { className: 'nook-row' });
      kbRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Detected Layout' }));
      const kbValue = createEl('span', { style: 'color:var(--text-primary);font-weight:500;', textContent: 'Detecting...' });
      kbRow.appendChild(kbValue);
      kbGroup.appendChild(kbRow);
      mainContent.appendChild(kbGroup);

      // Live preview
      const previewGroup = createEl('div', { className: 'nook-group' });
      previewGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Live Preview' }));
      const previewRow = createEl('div', { style: 'padding:12px 0;font-size:12.5px;color:var(--text-secondary);', id: 'region-preview' });
      previewGroup.appendChild(previewRow);
      mainContent.appendChild(previewGroup);

      function getEffectiveLocale() {
        if (i18n && typeof i18n.language === 'string' && i18n.language) return i18n.language;
        return OS.settings.get('region') || navigator.language || 'en-US';
      }

      function updatePreview(region, timezone) {
        const previewEl = document.getElementById('region-preview');
        if (!previewEl || !isAlive()) return;
        const now = new Date();
        const locale = getEffectiveLocale();
        const tz = timezone || OS.settings.get('timezone');
        const opts = { dateStyle: 'full', timeStyle: 'long' };
        if (tz) opts.timeZone = tz;
        const dateStr = new Intl.DateTimeFormat(locale, opts).format(now);
        // Derive currency from the selected region's country code instead
        // of hardcoding USD, falling back to the locale and then USD.
        const effectiveRegion = region || locale;
        const countryCode = String(effectiveRegion).split('-')[1]?.toUpperCase();
        const currencyCode = (countryCode && REGION_CURRENCY[countryCode]) || 'USD';
        let currencyStr;
        try {
          currencyStr = new Intl.NumberFormat(locale, { style: 'currency', currency: currencyCode }).format(1234.56);
        } catch {
          // Intl throws on unrecognized currency codes — fall back to USD
          currencyStr = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(1234.56);
        }
        // Build via DOM nodes — safe even if date/currency strings contained markup
        const dtDiv = createEl('div', { style: 'margin-bottom:8px;' });
        dtDiv.appendChild(createEl('strong', { textContent: 'Date & Time: ' }));
        dtDiv.appendChild(document.createTextNode(dateStr));
        const curDiv = createEl('div');
        curDiv.appendChild(createEl('strong', { textContent: 'Currency: ' }));
        curDiv.appendChild(document.createTextNode(currencyStr));
        previewEl.replaceChildren(dtDiv, curDiv);
      }

      // Keyboard layout detection — async, so guard against the section
      // being destroyed before the promise settles.
      if (navigator.keyboard && typeof navigator.keyboard.getLayoutMap === 'function') {
        navigator.keyboard.getLayoutMap().then(map => {
          if (!isAlive()) return;
          const a = map.get('KeyA');
          const q = map.get('KeyQ');
          let layout = 'Unknown';
          if (a === 'a' && q === 'q') layout = 'QWERTY';
          else if (a === 'q' && q === 'a') layout = 'AZERTY';
          else if (a === 'a' && q === 'w') layout = 'QWERTZ';
          else if (a) layout = 'Custom (' + a + ')';
          kbValue.textContent = layout;
        }).catch(() => { if (isAlive()) kbValue.textContent = 'Not available'; });
      } else {
        kbValue.textContent = 'Not supported';
      }

      updatePreview(currentRegion);
    }

    // Storage
    async function renderStorage() {
      mainContent.appendChild(createEl('h2', { textContent: 'Storage', style: { marginBottom: '20px' } }));

      try {
        const est = await navigator.storage.estimate();
        if (!isAlive()) return;

        const usageGroup = createEl('div', { className: 'nook-group' });
        usageGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Storage Usage' }));

        const usedRow = createEl('div', { className: 'nook-row' });
        usedRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Used' }));
        usedRow.appendChild(createEl('span', { textContent: formatBytes(est.usage || 0) }));
        usageGroup.appendChild(usedRow);

        const quotaRow = createEl('div', { className: 'nook-row' });
        quotaRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Quota' }));
        quotaRow.appendChild(createEl('span', { textContent: formatBytes(est.quota || 0) }));
        usageGroup.appendChild(quotaRow);

        const ratio = Math.min(100, (est.usage || 0) / (est.quota || 1) * 100);
        const bar  = createEl('div', { className: 'lens-bar' });
        const fill = createEl('div', { className: 'lens-bar-fill', style: { width: ratio + '%' } });
        bar.appendChild(fill);
        usageGroup.appendChild(bar);
        mainContent.appendChild(usageGroup);
      } catch (err) {
        devLog('storage.estimate() failed:', err);
        mainContent.appendChild(createEl('p', { textContent: 'Unable to retrieve storage information.' }));
      }

      // Clear data buttons
      const clearGroup = createEl('div', { className: 'nook-group' });
      clearGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Clear Data' }));

      const clearCacheBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Clear Cache' });
      clearCacheBtn.addEventListener('click', async () => {
        const cleared = [];

        if ('caches' in window) {
          try {
            const cacheNames = await caches.keys();
            if (cacheNames.length) {
              await Promise.all(cacheNames.map(n => caches.delete(n)));
              cleared.push(cacheNames.length + ' SW cache' + (cacheNames.length > 1 ? 's' : ''));
            }
          } catch (err) { devLog('caches.keys() failed:', err); }
        }

        try {
          const tempKeys = Object.keys(localStorage).filter(k =>
            k.includes('_cache') || k.includes('_temp') ||
            k === 'nova_boot_attempts' || k === 'nova_force_recovery'
          );
          if (tempKeys.length) {
            for (const k of tempKeys) localStorage.removeItem(k);
            cleared.push(tempKeys.length + ' temp key' + (tempKeys.length > 1 ? 's' : ''));
          }
        } catch (err) { devLog('localStorage sweep failed:', err); }

        if (!isAlive()) return;
        if (cleared.length) {
          Notify.show({ title: 'Cache Cleared', body: 'Removed: ' + cleared.join(', '), type: 'success', appName: 'Settings' });
        } else {
          Notify.show({ title: 'Nothing to Clear', body: 'Cache is already empty', type: 'info', appName: 'Settings' });
        }
      }, { signal: lifecycle.signal });
      clearGroup.appendChild(clearCacheBtn);

      const wipeBtn = createEl('button', { className: 'btn btn-danger btn-sm', style: { marginLeft: '8px' }, textContent: 'Wipe All Data' });
      wipeBtn.addEventListener('click', async () => {
        const wipeConfirm = await showModal('Wipe All Data', 'This will delete all files, settings, and data. This action cannot be undone.', [
          { label: 'Cancel' }, { label: 'Wipe Everything', danger: true, value: 'wipe' }
        ]);
        if (!isAlive()) return;
        if (wipeConfirm !== 'wipe') return;
        Notify.show({ title: 'Wiping Data', body: 'Please wait...', type: 'warning', appName: 'Settings' });
        localStorage.clear();
        sessionStorage.clear();
        // Delete IndexedDB databases sequentially
        for (const dbName of ['NovaByte_FS', 'novabyte_opfs_fallback']) {
          await new Promise(resolve => {
            const req = indexedDB.deleteDatabase(dbName);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          });
        }
        try {
          if (typeof OPFS !== 'undefined' && OPFS.clear) await OPFS.clear();
        } catch (err) { devLog('OPFS.clear() failed:', err); }
        // Each installed .novaapp runs in its own isolated webview storage
        // partition (persist:app_<id>). That's separate from the stores
        // above, so it survives unless cleared per app.
        try {
          const appIds = (typeof OS !== 'undefined' && OS.apps) ? Object.keys(OS.apps) : [];
          if (typeof AppSandbox !== 'undefined' && AppSandbox.clearAppPartitions) {
            await AppSandbox.clearAppPartitions(appIds);
          }
        } catch (err) { devLog('clearAppPartitions failed:', err); }
        // nova:storage is a third IndexedDB (NovaByte_AppStorage) that apps
        // read/write via window.nova.ipc('nova:storage:*', ...). Not scoped
        // to currently-installed appIds, since a full wipe should also catch
        // rows left behind by uninstalled apps.
        try {
          if (typeof AppSandbox !== 'undefined' && AppSandbox.clearAllStorage) {
            await AppSandbox.clearAllStorage();
          }
        } catch (err) { devLog('clearAllStorage failed:', err); }
        location.reload();
      }, { signal: lifecycle.signal });
      clearGroup.appendChild(wipeBtn);
      mainContent.appendChild(clearGroup);
    }

    // Desktop
    function renderDesktop() {
      mainContent.appendChild(createEl('h2', { textContent: 'Desktop', style: { marginBottom: '20px' } }));

      // Wallpaper
      const wallpaperGroup = createEl('div', { className: 'nook-group' });
      wallpaperGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Wallpaper' }));

      const presetRow = createEl('div', { className: 'nook-row' });
      presetRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Preset Wallpapers' }));
      const presetContainer = createEl('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;' });

      const savedWallpaperId = OS.settings.get('wallpaperId');
      const currentWallpaperId = PRESET_WALLPAPERS.some(wp => wp.id === savedWallpaperId)
        ? savedWallpaperId : 'stock-blue';

      // Direct references to cards for O(1) visual updates on click
      const wpCards = [];

      PRESET_WALLPAPERS.forEach((wp, idx) => {
        const isActive = currentWallpaperId === wp.id;
        const wpCard = createEl('div', {
          role: 'button',
          tabindex: '0',
          'aria-label': 'Wallpaper: ' + wp.name + (isActive ? ' (active)' : ''),
          'aria-pressed': String(isActive),
          title: wp.name,
          style: 'width:64px;height:48px;border-radius:6px;cursor:pointer;border:2px solid ' + (isActive ? 'var(--accent)' : 'transparent') + ';background:' + wp.gradient + ';transition:all 0.15s;' + (isActive ? 'box-shadow:0 0 0 2px var(--window-bg), 0 0 8px var(--accent);' : 'opacity:0.7;')
        });

        function applyWallpaper() {
          const desktop = document.getElementById('desktop');
          if (desktop) desktop.style.backgroundImage = wp.gradient;
          OS.settings.set('wallpaperId', wp.id);
          OS.settings.set('customWallpaper', null);
          wallpaperInput.value = '';
          for (let i = 0; i < wpCards.length; i++) {
            const on = i === idx;
            wpCards[i].style.borderColor = on ? 'var(--accent)' : 'transparent';
            wpCards[i].style.boxShadow   = on ? '0 0 0 2px var(--window-bg), 0 0 8px var(--accent)' : 'none';
            wpCards[i].style.opacity     = on ? '1' : '0.7';
            wpCards[i].setAttribute('aria-pressed', String(on));
          }
          Notify.show({ title: 'Wallpaper Changed', body: 'Applied ' + wp.name, type: 'success', appName: 'Settings' });
        }

        wpCard.addEventListener('click', applyWallpaper, { signal: lifecycle.signal });
        wpCard.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); applyWallpaper(); }
        }, { signal: lifecycle.signal });

        wpCards.push(wpCard);
        presetContainer.appendChild(wpCard);
      });

      presetRow.appendChild(presetContainer);
      wallpaperGroup.appendChild(presetRow);

      // Apply current wallpaper on render
      const desktopEl = document.getElementById('desktop');
      if (desktopEl) {
        desktopEl.style.backgroundImage = '';
        desktopEl.style.backgroundSize = '';
        desktopEl.style.backgroundPosition = '';
        desktopEl.style.backgroundRepeat = '';
        const customWallpaper = OS.settings.get('customWallpaper');
        if (customWallpaper) {
          desktopEl.style.backgroundImage   = 'url(' + customWallpaper + ')';
          desktopEl.style.backgroundSize    = 'cover';
          desktopEl.style.backgroundPosition = 'center';
          desktopEl.style.backgroundRepeat  = 'no-repeat';
        } else {
          const currentWp = PRESET_WALLPAPERS.find(wp => wp.id === currentWallpaperId);
          if (currentWp) desktopEl.style.backgroundImage = currentWp.gradient;
        }
      }

      const wallpaperRow = createEl('div', { className: 'nook-row', style: 'margin-top:16px;' });
      wallpaperRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Custom Image' }));

      const wallpaperInput = createEl('input', {
        id: 'wallpaper-upload', name: 'wallpaper-upload', type: 'file', accept: 'image/*', style: { width: '200px' }
      });
      wallpaperInput.addEventListener('change', () => {
        const file = wallpaperInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          if (!isAlive()) return;
          const dataUrl = reader.result;
          const desktop = document.getElementById('desktop');
          if (desktop) {
            desktop.style.backgroundImage    = 'url(' + dataUrl + ')';
            desktop.style.backgroundSize     = 'cover';
            desktop.style.backgroundPosition = 'center';
            desktop.style.backgroundRepeat   = 'no-repeat';
          }
          OS.settings.set('customWallpaper', dataUrl);
          OS.settings.set('wallpaperId', null);
          Notify.show({ title: 'Wallpaper Changed', body: 'Custom wallpaper applied', type: 'success', appName: 'Settings' });
        };
        reader.onerror = () => { devLog('FileReader error during wallpaper upload'); };
        reader.readAsDataURL(file);
      }, { signal: lifecycle.signal });
      wallpaperRow.appendChild(wallpaperInput);

      const resetBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Reset to Default', style: { marginLeft: '8px' } });
      resetBtn.addEventListener('click', () => {
        const desktop = document.getElementById('desktop');
        if (desktop) {
          desktop.style.backgroundImage   = PRESET_WALLPAPERS[0].gradient;
          desktop.style.backgroundSize    = '';
          desktop.style.backgroundPosition = '';
          desktop.style.backgroundRepeat  = '';
        }
        OS.settings.set('customWallpaper', null);
        OS.settings.set('wallpaperId', 'stock-blue');
        wallpaperInput.value = '';
        for (let i = 0; i < wpCards.length; i++) {
          const on = i === 0;
          wpCards[i].style.borderColor = on ? 'var(--accent)' : 'transparent';
          wpCards[i].style.boxShadow   = on ? '0 0 0 2px var(--window-bg), 0 0 8px var(--accent)' : 'none';
          wpCards[i].style.opacity     = on ? '1' : '0.7';
          wpCards[i].setAttribute('aria-pressed', String(on));
        }
        Notify.show({ title: 'Wallpaper Reset', body: 'Default wallpaper restored', type: 'success', appName: 'Settings' });
      }, { signal: lifecycle.signal });
      wallpaperRow.appendChild(resetBtn);
      wallpaperGroup.appendChild(wallpaperRow);
      mainContent.appendChild(wallpaperGroup);

      // Taskbar
      const clockGroup = createEl('div', { className: 'nook-group' });
      clockGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Taskbar' }));

      const tbClockRow = createEl('div', { className: 'nook-toggle-row' });
      tbClockRow.appendChild(createEl('span', { textContent: 'Show Clock in Taskbar' }));
      const clockVisible = OS.settings.get('showTaskbarClock') !== false;
      const clockToggle = createEl('button', {
        className: 'toggle' + (clockVisible ? ' active' : ''),
        role: 'switch',
        'aria-checked': String(clockVisible),
        'aria-label': 'Toggle clock in taskbar'
      });
      clockToggle.addEventListener('click', () => {
        const wasVisible = OS.settings.get('showTaskbarClock') !== false;
        OS.settings.set('showTaskbarClock', !wasVisible);
        clockToggle.classList.toggle('active', !wasVisible);
        clockToggle.setAttribute('aria-checked', String(!wasVisible));
        const clockEl = document.getElementById('tray-clock');
        if (clockEl) clockEl.style.display = wasVisible ? 'none' : 'flex';
      }, { signal: lifecycle.signal });
      tbClockRow.appendChild(clockToggle);
      clockGroup.appendChild(tbClockRow);

      // Taskbar size
      const sizeRow = createEl('div', { className: 'nook-row' });
      sizeRow.appendChild(createEl('span', { className: 'nook-row-label', textContent: 'Size' }));
      const currentSize = OS.settings.get('taskbarSize') || 'normal';
      for (const sz of TASKBAR_SIZES) {
        const active = currentSize === sz.value;
        const btn = createEl('button', {
          className: 'btn btn-sm' + (active ? ' btn-primary' : ''),
          textContent: sz.label, style: { marginRight: '8px' },
          'aria-pressed': String(active)
        });
        btn.addEventListener('click', () => {
          OS.settings.set('taskbarSize', sz.value);
          document.documentElement.style.setProperty('--taskbar-height', sz.height);
          renderContent();
        }, { signal: lifecycle.signal });
        sizeRow.appendChild(btn);
      }
      clockGroup.appendChild(sizeRow);

      mainContent.appendChild(clockGroup);
    }

    // Accessibility
    function renderAccessibility() {
      mainContent.appendChild(createEl('h2', { textContent: 'Accessibility', style: { marginBottom: '20px' } }));

      // Reduce Motion
      const motionGroup = createEl('div', { className: 'nook-group' });
      motionGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Motion' }));
      const motionRow = createEl('div', { className: 'nook-toggle-row' });
      motionRow.appendChild(createEl('span', { textContent: 'Reduce Motion' }));
      const motionOn = !!OS.settings.get('reduceMotion');
      const motionToggle = createEl('button', {
        className: 'toggle' + (motionOn ? ' active' : ''),
        role: 'switch',
        'aria-checked': String(motionOn),
        'aria-label': 'Toggle reduced motion'
      });
      motionToggle.addEventListener('click', () => {
        const next = !OS.settings.get('reduceMotion');
        OS.settings.set('reduceMotion', next);
        document.documentElement.classList.toggle('reduce-motion', next);
        document.documentElement.style.setProperty('--anim-speed', next ? '0.001' : '1');
        const wallpaperEl = document.getElementById('wallpaper');
        if (wallpaperEl) wallpaperEl.style.animation = next ? 'none' : '';
        motionToggle.classList.toggle('active', next);
        motionToggle.setAttribute('aria-checked', String(next));
      }, { signal: lifecycle.signal });
      motionRow.appendChild(motionToggle);
      motionGroup.appendChild(motionRow);
      mainContent.appendChild(motionGroup);

      // Transparency
      const transparencyGroup = createEl('div', { className: 'nook-group' });
      transparencyGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Transparency' }));
      const transparencyRow = createEl('div', { className: 'nook-toggle-row' });
      transparencyRow.appendChild(createEl('span', { textContent: 'Remove Transparency' }));
      const transOn = !!OS.settings.get('removeTransparency');
      const transparencyToggle = createEl('button', {
        className: 'toggle' + (transOn ? ' active' : ''),
        role: 'switch',
        'aria-checked': String(transOn),
        'aria-label': 'Toggle transparency removal'
      });
      transparencyToggle.addEventListener('click', () => {
        const next = !OS.settings.get('removeTransparency');
        OS.settings.set('removeTransparency', next);
        document.documentElement.classList.toggle('no-transparency', next);
        transparencyToggle.classList.toggle('active', next);
        transparencyToggle.setAttribute('aria-checked', String(next));
      }, { signal: lifecycle.signal });
      transparencyRow.appendChild(transparencyToggle);
      transparencyGroup.appendChild(transparencyRow);
      mainContent.appendChild(transparencyGroup);
      mainContent.appendChild(createEl('p', {
        textContent: 'Makes windows, menus, and panels fully solid — removes blur and see-through backgrounds everywhere.',
        style: { color: 'var(--text-secondary)', fontSize: '12px', marginTop: '-8px', marginBottom: '20px' }
      }));

      // Icon Size
      const iconSizeGroup = createEl('div', { className: 'nook-group' });
      iconSizeGroup.appendChild(createEl('div', { className: 'nook-group-title', textContent: 'Icon Size' }));
      const currentIconSize = OS.settings.get('cursorSize') || 'normal';
      for (const opt of ICON_SIZES) {
        const row = createEl('div', { className: 'nook-row' });
        row.appendChild(createEl('span', { textContent: opt.label }));
        const active = currentIconSize === opt.value;
        const btn = createEl('button', {
          className: 'btn btn-sm' + (active ? ' btn-primary' : ''),
          textContent: active ? 'Active' : 'Select',
          'aria-pressed': String(active)
        });
        btn.addEventListener('click', () => {
          OS.settings.set('cursorSize', opt.value);
          let cursorStyles = document.getElementById('cursor-custom-styles');
          if (!cursorStyles) {
            cursorStyles = document.createElement('style');
            cursorStyles.id = 'cursor-custom-styles';
            document.head.appendChild(cursorStyles);
          }
          cursorStyles.textContent = '#desktop .desktop-icon { transform: ' + opt.transform + ' }';
          renderContent();
        }, { signal: lifecycle.signal });
        row.appendChild(btn);
        iconSizeGroup.appendChild(row);
      }
      mainContent.appendChild(iconSizeGroup);
    }

    // Apps
    function renderApps() {
      mainContent.appendChild(createEl('h2', { textContent: 'App Permissions', style: { marginBottom: '4px' } }));
      mainContent.appendChild(createEl('p', {
        textContent: 'Manage what each app is allowed to access. Denied permissions can be re-enabled here.',
        style: { color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '20px' }
      }));

      const mgr  = typeof AppPermissionManager !== 'undefined' ? AppPermissionManager : null;
      const pmap = typeof AppPermissionsMap    !== 'undefined' ? AppPermissionsMap    : null;

      if (!mgr || !pmap) {
        const warn = createEl('div', { style: 'padding:16px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);font-size:13px;' });
        warn.textContent = 'Permission system not available.';
        mainContent.appendChild(warn);
        return;
      }

      const appIds = new Set(Object.keys(pmap));
      if (typeof OS !== 'undefined' && OS.apps) {
        for (const id of Object.keys(OS.apps)) {
          if (id.startsWith('wa_')) appIds.add(id);
        }
      }

      let novaApps = [];
      try { novaApps = JSON.parse(localStorage.getItem('nova_installed_apps') || '[]'); }
      catch (err) { devLog('nova_installed_apps parse failed:', err); novaApps = []; }
      const novaAppIds = new Set(novaApps.map(a => a.id));

      const builtIns = [...appIds].filter(id => !id.startsWith('wa_') && !novaAppIds.has(id)).sort();
      const webApps  = [...appIds].filter(id =>  id.startsWith('wa_')).sort();

      const devMode = !!OS.settings.get('devMode');
      const visibleBuiltIns = builtIns.filter(id => {
        if (devMode) return true;
        const entry = OS.apps?.[id];
        return !entry?.devOnly;
      });

      function buildAppCard(appId, novaData) {
        const entry   = (typeof OS !== 'undefined' && OS.apps) ? OS.apps[appId] : null;
        const appName = novaData?.name ?? entry?.name ?? appId;

        let dangerous, normal, appVersion, appVerified, appAuthor;
        if (novaData) {
          dangerous   = [...(novaData.permissions || []), ...(novaData.optionalPermissions || [])];
          normal      = [];
          appVersion  = novaData.version  || null;
          appVerified = novaData.verified  ?? false;
          appAuthor   = novaData.author    || null;
        } else {
          const mapEntry = pmap[appId];
          dangerous   = mapEntry?.dangerous ?? ['net:external', 'device:camera', 'device:microphone', 'device:geolocation'];
          normal      = mapEntry?.normal    ?? [];
          appVersion  = null;
          appVerified = null;
          appAuthor   = null;
        }

        if (dangerous.length === 0 && normal.length === 0 && !novaData && !appId.startsWith('wa_')) return null;

        const card = createEl('div', {
          style: 'background:var(--bg-elevated);border:1px solid var(--border);border-radius:10px;margin-bottom:12px;overflow:hidden;'
        });

        const header     = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:12px 14px;cursor:pointer;user-select:none;' });
        const headerLeft = createEl('div', { style: 'display:flex;align-items:center;gap:10px;' });

        // App icon — built via DOM API to avoid XSS from app-provided data URIs
        const iconEl = createEl('div', {
          style: 'width:34px;height:34px;border-radius:8px;background:var(--accent-muted,rgba(88,166,255,0.15));display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:var(--accent);flex-shrink:0;overflow:hidden;'
        });
        const iconVal  = novaData?.icon ?? entry?.icon ?? null;
        const isEmoji  = iconVal && /\p{Emoji}/u.test(iconVal) && iconVal.length <= 4;
        const isSvgKey = iconVal && !isEmoji && /^[a-z][a-z0-9-]*$/.test(iconVal);
        const isDataUri = iconVal && typeof iconVal === 'string' && iconVal.startsWith('data:image/svg+xml;base64,');
        if (isSvgKey && typeof svgIcon === 'function') {
          iconEl.innerHTML = svgIcon(iconVal, 18);
          iconEl.style.color = 'var(--accent)';
        } else if (isEmoji) {
          iconEl.style.fontSize = '20px';
          iconEl.textContent = iconVal;
        } else if (isDataUri) {
          // Use DOM API + src property — safe even if the data URI contains quote chars
          iconEl.style.background = 'transparent';
          const img = createEl('img', { src: iconVal, width: 18, height: 18, alt: '', draggable: false });
          img.style.display = 'block';
          iconEl.replaceChildren(img);
        } else {
          iconEl.textContent = appName.charAt(0).toUpperCase();
        }
        headerLeft.appendChild(iconEl);

        const nameEl = createEl('div');
        nameEl.appendChild(createEl('div', { textContent: appName, style: 'font-weight:600;font-size:13.5px;color:var(--text-primary);' }));

        // Badge row — refreshed in-place on toggle
        const badgeRow = createEl('div', { style: 'display:flex;gap:4px;margin-top:3px;flex-wrap:wrap;' });
        function refreshBadges() {
          badgeRow.replaceChildren();
          const grantedCount = dangerous.filter(p => mgr.isGranted(p, appId)).length;
          const deniedCount  = dangerous.filter(p => mgr.isDenied ? mgr.isDenied(p, appId) : false).length;
          const pendingCount = dangerous.length - grantedCount - deniedCount;
          if (grantedCount > 0) badgeRow.appendChild(createEl('span', { textContent: grantedCount + ' allowed',    style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(63,185,80,0.12);color:#3fb950;border:1px solid rgba(63,185,80,0.3);' }));
          if (deniedCount  > 0) badgeRow.appendChild(createEl('span', { textContent: deniedCount  + ' denied',     style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(248,81,73,0.12);color:#f85149;border:1px solid rgba(248,81,73,0.3);' }));
          if (pendingCount > 0) badgeRow.appendChild(createEl('span', { textContent: pendingCount + ' not asked',  style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(255,255,255,0.06);color:var(--text-muted);border:1px solid var(--border-subtle);' }));
          if (dangerous.length === 0 && normal.length === 0)
            badgeRow.appendChild(createEl('span', { textContent: 'No permissions',           style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(255,255,255,0.06);color:var(--text-muted);border:1px solid var(--border-subtle);' }));
          else if (dangerous.length === 0)
            badgeRow.appendChild(createEl('span', { textContent: 'No sensitive permissions', style: 'font-size:10px;padding:1px 7px;border-radius:20px;background:rgba(255,255,255,0.06);color:var(--text-muted);border:1px solid var(--border-subtle);' }));
        }
        refreshBadges();

        if (appVersion || appAuthor || appVerified !== null) {
          const metaRow = createEl('div', { style: 'display:flex;gap:8px;margin-top:3px;align-items:center;flex-wrap:wrap;' });
          if (appVersion)        metaRow.appendChild(createEl('span', { textContent: 'v' + appVersion,  style: 'font-size:10px;color:var(--text-muted);font-family:monospace;' }));
          if (appAuthor)         metaRow.appendChild(createEl('span', { textContent: 'by ' + appAuthor, style: 'font-size:10px;color:var(--text-muted);' }));
          if (appVerified === true)  metaRow.appendChild(createEl('span', { textContent: '\u2713 Verified',   style: 'font-size:10px;color:#3fb950;' }));
          if (appVerified === false) metaRow.appendChild(createEl('span', { textContent: '\u26A0 Unverified', style: 'font-size:10px;color:#d29922;' }));
          nameEl.appendChild(metaRow);
        }
        nameEl.appendChild(badgeRow);
        headerLeft.appendChild(nameEl);
        header.appendChild(headerLeft);

        const chevron = createEl('span', { style: 'color:var(--text-muted);font-size:12px;transition:transform 0.2s;', textContent: '\u25B6', 'aria-hidden': 'true' });
        header.appendChild(chevron);
        card.appendChild(header);

        // Expandable body
        const body = createEl('div', { style: 'display:none;border-top:1px solid var(--border-subtle);' });

        // References to each permission's toggle for in-place sync
        const toggleEls = {};

        if (dangerous.length > 0) {
          const section = createEl('div', { style: 'padding:10px 14px 6px;' });
          section.appendChild(createEl('div', {
            textContent: 'SENSITIVE PERMISSIONS',
            style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin-bottom:8px;'
          }));

          for (const perm of dangerous) {
            const cat       = AppPermissionManager.PERMISSION_CATEGORIES?.[perm];
            const risk      = cat?.risk ?? 'medium';
            const label     = PERM_LABELS[perm] ?? perm;
            const isGranted = mgr.isGranted(perm, appId);
            const isDenied  = mgr.isDenied ? mgr.isDenied(perm, appId) : false;

            const row = createEl('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-subtle);' });
            const left = createEl('div', { style: 'display:flex;align-items:center;gap:8px;' });

            const riskBadge = createEl('span', {
              textContent: risk.charAt(0).toUpperCase() + risk.slice(1),
              style: 'font-size:9px;padding:1px 6px;border-radius:20px;background:' + RISK_BG[risk] + ';color:' + RISK_COLOR[risk] + ';border:1px solid ' + RISK_COLOR[risk] + '40;font-weight:600;'
            });
            const labelEl = createEl('div');
            labelEl.appendChild(createEl('div', { textContent: label, style: 'font-size:13px;color:var(--text-primary);font-weight:500;' }));
            labelEl.appendChild(createEl('div', { textContent: perm,  style: 'font-size:10px;color:var(--text-muted);font-family:monospace;' }));
            left.append(riskBadge, labelEl);
            row.appendChild(left);

            const toggleWrap  = createEl('label', { style: 'position:relative;display:inline-block;width:40px;height:22px;flex-shrink:0;cursor:pointer;' });
            const toggleInput = createEl('input', { type: 'checkbox' });
            toggleInput.style.cssText = 'opacity:0;position:absolute;inset:0;width:100%;height:100%;cursor:pointer;z-index:2;';
            toggleInput.checked = isGranted;
            toggleInput.setAttribute('aria-label', label);
            const slider = createEl('span', {
              style: 'position:absolute;inset:0;border-radius:22px;transition:background 0.2s;background:' + (isGranted ? 'var(--accent)' : (isDenied ? 'rgba(248,81,73,0.3)' : 'var(--bg-elevated)')) + ';border:1px solid var(--border-subtle);'
            });
            const knob = createEl('span', {
              style: 'position:absolute;top:2px;left:' + (isGranted ? '20px' : '2px') + ';width:16px;height:16px;border-radius:50%;background:#fff;transition:left 0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.3);'
            });
            slider.appendChild(knob);
            toggleWrap.append(toggleInput, slider);

            toggleEls[perm] = { toggleInput, slider, knob };

            toggleInput.addEventListener('change', async () => {
              if (toggleInput.checked) {
                // Clear any prior denial, then grant once
                if (mgr.resetPermission) await Promise.resolve(mgr.resetPermission(perm, appId)).catch(err => devLog('resetPermission failed:', err));
                await mgr.grantPermission(perm, appId, { permanent: true, reason: 'Manually granted via Settings', grantedBy: 'user' });
                slider.style.background = 'var(--accent)';
                knob.style.left = '20px';
              } else {
                await mgr.revokePermission(perm, appId);
                slider.style.background = 'rgba(248,81,73,0.3)';
                knob.style.left = '2px';
              }
              refreshBadges();
            });

            row.appendChild(toggleWrap);
            section.appendChild(row);
          }
          body.appendChild(section);
        }

        if (normal.length > 0) {
          const normSection = createEl('div', { style: 'padding:8px 14px 10px;' });
          normSection.appendChild(createEl('div', {
            textContent: 'AUTOMATIC PERMISSIONS',
            style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin-bottom:6px;'
          }));
          const normList = createEl('div', { style: 'display:flex;flex-wrap:wrap;gap:5px;' });
          for (const perm of normal) {
            normList.appendChild(createEl('span', {
              textContent: PERM_LABELS[perm] ?? perm,
              style: 'font-size:11px;padding:2px 8px;border-radius:20px;background:rgba(63,185,80,0.08);color:#3fb950;border:1px solid rgba(63,185,80,0.2);'
            }));
          }
          normSection.appendChild(normList);
          body.appendChild(normSection);
        }

        if (dangerous.length > 0) {
          const footer   = createEl('div', { style: 'padding:8px 14px;border-top:1px solid var(--border-subtle);display:flex;justify-content:flex-end;' });
          const resetBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Reset All Permissions', style: 'font-size:11px;' });
          resetBtn.addEventListener('click', async () => {
            if (mgr.resetPermission) {
              for (const p of dangerous) await mgr.resetPermission(p, appId);
            } else {
              await mgr.revokeAllPermissions(appId);
            }
            // Sync every toggle's checked state + slider/knob visuals now
            // that the underlying grants have been cleared.
            for (const p of dangerous) {
              const t = toggleEls[p];
              if (!t) continue;
              t.toggleInput.checked = false;
              t.slider.style.background = 'var(--bg-elevated)';
              t.knob.style.left = '2px';
            }
            Notify.show({ title: 'Permissions Reset', body: appName + ' will be asked again next launch.', type: 'info', appName: 'Settings' });
            refreshBadges();
          }, { signal: lifecycle.signal });
          footer.appendChild(resetBtn);
          body.appendChild(footer);
        }

        card.appendChild(body);

        let expanded = false;
        header.addEventListener('click', () => {
          expanded = !expanded;
          body.style.display       = expanded ? 'block' : 'none';
          chevron.style.transform  = expanded ? 'rotate(90deg)' : 'rotate(0deg)';
        }, { signal: lifecycle.signal });

        return card;
      }

      if (visibleBuiltIns.length > 0) {
        mainContent.appendChild(createEl('div', { textContent: 'BUILT-IN APPS', style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin-bottom:10px;' }));
        for (const id of visibleBuiltIns) {
          const card = buildAppCard(id);
          if (card) mainContent.appendChild(card);
        }
      }

      if (novaApps.length > 0) {
        mainContent.appendChild(createEl('div', { textContent: 'INSTALLED PACKAGES', style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin:16px 0 10px;' }));
        for (const novaData of novaApps) {
          const card = buildAppCard(novaData.id, novaData);
          if (card) mainContent.appendChild(card);
        }
      }

      if (webApps.length > 0) {
        mainContent.appendChild(createEl('div', { textContent: 'WEB APPS', style: 'font-size:10px;font-weight:700;letter-spacing:0.07em;color:var(--text-muted);margin:16px 0 10px;' }));
        for (const id of webApps) {
          const card = buildAppCard(id);
          if (card) mainContent.appendChild(card);
        }
      }

      if (visibleBuiltIns.length === 0 && webApps.length === 0 && novaApps.length === 0) {
        const empty = createEl('div', { style: 'text-align:center;color:var(--text-muted);padding:40px 0;font-size:13px;' });
        empty.textContent = 'No apps found.';
        mainContent.appendChild(empty);
      }
    }

    // Default Apps
    function renderDefaultApps() {
      mainContent.appendChild(createEl('h2', { textContent: 'Default Apps', style: { marginBottom: '4px' } }));
      mainContent.appendChild(createEl('p', {
        textContent: 'Choose which app opens each type of file or link. Only apps that support a category are shown.',
        style: { color: 'var(--text-secondary)', fontSize: '13px', marginBottom: '20px' }
      }));

      if (typeof DefaultApps === 'undefined') {
        const warn = createEl('div', { style: 'padding:16px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;color:var(--text-secondary);font-size:13px;' });
        warn.textContent = 'Default apps system not available.';
        mainContent.appendChild(warn);
        return;
      }

      // Banner shown when another app deep-linked here via
      // apps.openDefaultAppsSettings() — purely informational.
      if (requestingAppId && highlightCategory && DefaultApps.CATEGORIES[highlightCategory]) {
        const requestingName = (typeof OS !== 'undefined' && OS.apps?.[requestingAppId]?.name) || requestingAppId;
        const banner = createEl('div', {
          style: 'display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--accent-muted,rgba(88,166,255,0.12));border:1px solid var(--accent);border-radius:8px;margin-bottom:16px;font-size:12.5px;color:var(--text-primary);'
        });
        banner.textContent = requestingName + ' would like to be your default ' + DefaultApps.CATEGORIES[highlightCategory].name + '.';
        mainContent.appendChild(banner);
      }

      const list = createEl('div', { style: 'display:flex;flex-direction:column;gap:2px;' });
      mainContent.appendChild(list);

      function iconFor(iconVal, name) {
        const el = createEl('div', {
          style: 'width:32px;height:32px;border-radius:8px;background:var(--accent-muted,rgba(88,166,255,0.15));display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;color:var(--accent);'
        });
        if (iconVal && typeof svgIcon === 'function') {
          el.innerHTML = svgIcon(iconVal, 16);
        } else {
          el.style.fontSize = '14px';
          el.style.fontWeight = '700';
          el.textContent = (name || '?').charAt(0).toUpperCase();
        }
        return el;
      }

      // One row per category: icon, category name, current default, Change button.
      // Rows self-refresh after a choice is made — no full section re-render.
      function buildCategoryRow(categoryId, category) {
        const isHighlighted = categoryId === highlightCategory;
        const row = createEl('div', {
          style: 'display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--bg-elevated);border:1px solid ' + (isHighlighted ? 'var(--accent)' : 'var(--border)') + ';border-radius:10px;margin-bottom:8px;'
        });

        const left = createEl('div', { style: 'display:flex;align-items:center;gap:12px;' });
        const iconWrap = createEl('div');
        left.appendChild(iconWrap);

        const textWrap = createEl('div');
        textWrap.appendChild(createEl('div', { textContent: category.name, style: 'font-weight:600;font-size:13.5px;color:var(--text-primary);' }));
        const currentLabel = createEl('div', { style: 'font-size:12px;color:var(--text-muted);margin-top:2px;' });
        textWrap.appendChild(currentLabel);
        left.appendChild(textWrap);
        row.appendChild(left);

        const changeBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Change' });
        row.appendChild(changeBtn);

        function refreshCurrent() {
          const candidates = DefaultApps.getAppsForCategory(categoryId);
          const chosenId   = DefaultApps.getDefault(categoryId);
          const chosen     = candidates.find(a => a.id === chosenId) || candidates[0] || null;

          iconWrap.replaceChildren();
          iconWrap.appendChild(iconFor(chosen?.icon, chosen?.name));

          if (chosen) {
            currentLabel.textContent = chosen.name + (chosenId ? '' : ' (default)');
          } else {
            currentLabel.textContent = 'No app available';
          }
          changeBtn.disabled = candidates.length === 0;
          changeBtn.style.opacity = candidates.length === 0 ? '0.5' : '';
        }
        refreshCurrent();

        changeBtn.addEventListener('click', () => openPicker(categoryId, category, refreshCurrent), { signal: lifecycle.signal });

        return row;
      }

      // Picker popup — lists every app that declared support for this category.
      function openPicker(categoryId, category, onChosen) {
        const candidates = DefaultApps.getAppsForCategory(categoryId);
        const currentId  = DefaultApps.getDefault(categoryId);

        const overlay = createEl('div', {
          tabIndex: -1,
          style: 'position:fixed;inset:0;z-index:99001;background:rgba(0,0,0,0.45);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;'
        });
        const ac = mountOverlay(overlay);

        const card = createEl('div', {
          style: 'background:var(--bg-elevated);border:1px solid var(--border);border-radius:12px;width:360px;max-height:70vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.5);'
        });

        const header = createEl('div', { style: 'padding:16px 18px 12px;border-bottom:1px solid var(--border-subtle);' });
        header.appendChild(createEl('div', { textContent: 'Default ' + category.name, style: 'font-weight:600;font-size:14px;color:var(--text-primary);' }));
        header.appendChild(createEl('div', { textContent: 'Detected from installed apps that support this type.', style: 'font-size:11.5px;color:var(--text-muted);margin-top:2px;' }));
        card.appendChild(header);

        const body = createEl('div', { style: 'padding:8px;' });

        if (candidates.length === 0) {
          body.appendChild(createEl('div', {
            textContent: 'No installed apps support this category yet.',
            style: 'padding:16px;text-align:center;color:var(--text-muted);font-size:12.5px;'
          }));
        }

        for (const app of candidates) {
          const optRow = createEl('div', {
            role: 'radio',
            tabindex: '0',
            'aria-checked': String(app.id === currentId),
            style: 'display:flex;align-items:center;gap:10px;padding:10px 10px;border-radius:8px;cursor:pointer;'
          });
          optRow.addEventListener('mouseenter', () => optRow.style.background = 'var(--bg-hover, rgba(255,255,255,0.05))');
          optRow.addEventListener('mouseleave', () => optRow.style.background = '');

          optRow.appendChild(iconFor(app.icon, app.name));

          optRow.appendChild(createEl('div', { textContent: app.name, style: 'flex:1;font-size:13px;color:var(--text-primary);' }));

          const radio = createEl('div', {
            style: 'width:16px;height:16px;border-radius:50%;border:2px solid ' + (app.id === currentId ? 'var(--accent)' : 'var(--border)') + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;'
          });
          if (app.id === currentId) {
            radio.appendChild(createEl('div', { style: 'width:8px;height:8px;border-radius:50%;background:var(--accent);' }));
          }
          optRow.appendChild(radio);

          const choose = () => {
            DefaultApps.setDefault(categoryId, app.id);
            dismissOverlay(overlay);
            onChosen();
          };
          optRow.addEventListener('click', choose, { signal: ac.signal });
          optRow.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
          }, { signal: ac.signal });

          body.appendChild(optRow);
        }

        card.appendChild(body);
        overlay.appendChild(card);

        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) dismissOverlay(overlay);
        }, { signal: ac.signal });
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') dismissOverlay(overlay);
        }, { signal: ac.signal });
      }

      for (const [categoryId, category] of Object.entries(DefaultApps.CATEGORIES)) {
        list.appendChild(buildCategoryRow(categoryId, category));
      }
    }

    // Privacy & Security
    function renderPrivacy() {
      mainContent.appendChild(createEl('h2', { textContent: 'Privacy & Security', style: { marginBottom: '20px' } }));

      // Data management
      const exportSection = createEl('div', { className: 'nook-privacy-section' });
      exportSection.appendChild(createEl('h3', { textContent: 'Data Management' }));
      const exportActions = createEl('div', { className: 'nook-data-actions' });

      const exportBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Export All Data (JSON)' });
      exportBtn.addEventListener('click', async () => {
        exportBtn.disabled = true;
        const prevLabel = exportBtn.textContent;
        exportBtn.textContent = 'Exporting\u2026';
        try {
          // Pull every real data domain, not just the in-memory settings cache.
          const [settings, files] = await Promise.all([
            OS.workers.fs.call('getAllSettings').catch(() => ({ ...(OS.settings._cache || {}) })),
            OS.workers.fs.call('getAllFiles').catch(() => [])
          ]);
          if (!isAlive()) return;

          // localStorage holds per-app data with no shared key prefix —
          // sweep it wholesale (this is a dedicated app window, not a shared origin).
          const localStorageData = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            localStorageData[key] = localStorage.getItem(key);
          }

          const data = {
            settings,
            files,
            localStorage: localStorageData,
            version:    OS.version,
            exportDate: new Date().toISOString()
          };
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const url  = URL.createObjectURL(blob);
          const a    = createEl('a', { href: url, download: 'novabyte-export.json' });
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          Notify.show({ title: 'Data Exported', body: 'All data has been exported', type: 'success', appName: 'Nook' });
        } catch (err) {
          Notify.show({ title: 'Export Failed', body: err?.message || 'Could not export data', type: 'error', appName: 'Nook' });
        } finally {
          if (isAlive()) {
            exportBtn.disabled = false;
            exportBtn.textContent = prevLabel;
          }
        }
      }, { signal: lifecycle.signal });
      exportActions.appendChild(exportBtn);

      const importBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Import Data' });
      importBtn.addEventListener('click', () => {
        const input = createEl('input', { type: 'file', accept: '.json', id: 'settings-import-input', name: 'settings-import', style: 'display:none' });
        document.body.appendChild(input);
        input.addEventListener('change', async () => {
          const file = input.files[0];
          input.remove();
          if (!file) return;
          try {
            const text = await file.text();
            const data = JSON.parse(text);

            const writes = [];
            if (data.settings && typeof data.settings === 'object') {
              for (const [k, v] of Object.entries(data.settings)) {
                OS.settings._cache[k] = v;
                writes.push(OS.workers.fs.call('putSetting', k, v));
              }
            }
            if (Array.isArray(data.files) && data.files.length) {
              writes.push(OS.workers.fs.call('putFiles', data.files));
            }

            // Wait for every fs-backed write to actually land before reporting success
            const results = await Promise.allSettled(writes);
            if (!isAlive()) return;
            const failed = results.some(r => r.status === 'rejected');

            if (data.localStorage && typeof data.localStorage === 'object') {
              for (const [k, v] of Object.entries(data.localStorage)) {
                // Skip machine/session-specific keys that must never be
                // restored from an untrusted file
                if (IMPORT_PROTECTED_KEYS.has(k)) {
                  devLog('Skipping protected key during import:', k);
                  continue;
                }
                try { localStorage.setItem(k, v); } catch (err) { devLog('localStorage.setItem failed for', k, err); }
              }
            }

            if (data.settings && typeof data.settings === 'object') {
              OS.events.emit('settings:changed', { key: null, value: null, bulk: true });
            }

            if (!isAlive()) return;
            if (failed) {
              Notify.show({ title: 'Import Incomplete', body: 'Some data could not be saved. Try again.', type: 'error', appName: 'Nook' });
            } else {
              Notify.show({ title: 'Data Imported', body: 'All data has been imported. Restart to apply fully.', type: 'success', appName: 'Nook' });
            }
          } catch (err) {
            devLog('Import failed:', err);
            Notify.show({ title: 'Import Failed', body: 'Invalid JSON file', type: 'error', appName: 'Nook' });
          }
        }, { signal: lifecycle.signal });
        input.click();
      }, { signal: lifecycle.signal });
      exportActions.appendChild(importBtn);
      exportSection.appendChild(exportActions);
      mainContent.appendChild(exportSection);

      // Admin access — controls the server-side admin-state flag that
      // req.user.role derives from. Off by default. Turning this on doesn't
      // itself give any app access; it just makes the machine capable of
      // honoring an admin:*-granted app's requests.
      const adminSection = createEl('div', { className: 'nook-privacy-section' });
      adminSection.appendChild(createEl('h3', { textContent: 'Admin Access' }));
      adminSection.appendChild(createEl('p', {
        textContent: 'Lets apps you\u2019ve granted admin permissions to (audit logs, system settings, sessions) actually use them. Off by default — most people never need this.',
        style: { color: 'var(--text-secondary, #8b949e)', fontSize: '13px', marginBottom: '12px' }
      }));
      const adminRow = createEl('div', { className: 'nook-toggle-row' });
      adminRow.appendChild(createEl('span', { textContent: 'Enable admin mode on this device' }));
      const adminToggle = createEl('button', {
        className: 'toggle',
        role: 'switch',
        'aria-checked': 'false',
        'aria-label': 'Toggle admin mode',
        disabled: true
      });
      adminRow.appendChild(adminToggle);
      adminSection.appendChild(adminRow);
      mainContent.appendChild(adminSection);

      // State lives server-side (not OS.settings/localStorage), so fetch the
      // current value and enable the control once known, rather than flash
      // an incorrect initial state.
      (async () => {
        try {
          const res = await fetch('/api/security/admin-mode');
          const json = await res.json();
          if (!isAlive()) return;
          if (json && json.success) {
            adminToggle.classList.toggle('active', !!json.adminEnabled);
            adminToggle.setAttribute('aria-checked', String(!!json.adminEnabled));
          }
        } catch {
          if (!isAlive()) return;
          // Leave disabled — can't safely toggle a value we couldn't confirm.
          adminSection.appendChild(createEl('p', {
            textContent: 'Could not reach the server to check admin status.',
            style: { color: 'var(--danger, #f85149)', fontSize: '12px', marginTop: '8px' }
          }));
          return;
        }
        if (isAlive()) adminToggle.disabled = false;
      })();

      adminToggle.addEventListener('click', async () => {
        if (adminToggle.disabled) return;
        const next = !adminToggle.classList.contains('active');
        adminToggle.disabled = true;
        try {
          const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
          const res = await fetch('/api/security/admin-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({ enabled: next })
          });
          const json = await res.json();
          if (!isAlive()) return;
          if (json && json.success) {
            adminToggle.classList.toggle('active', !!json.adminEnabled);
            adminToggle.setAttribute('aria-checked', String(!!json.adminEnabled));
            Notify.show({
              title: json.adminEnabled ? 'Admin Mode Enabled' : 'Admin Mode Disabled',
              body: json.adminEnabled
                ? 'Apps granted admin permissions can now use them.'
                : 'Admin permission grants are now inert again.',
              type: 'success', appName: 'Nook'
            });
          } else {
            throw new Error(json?.message || 'Request failed');
          }
        } catch (err) {
          if (!isAlive()) return;
          Notify.show({ title: 'Could Not Update Admin Mode', body: err?.message || 'Try again', type: 'error', appName: 'Nook' });
        } finally {
          if (isAlive()) adminToggle.disabled = false;
        }
      }, { signal: lifecycle.signal });
    }

    // Shortcuts
    function renderShortcuts() {
      mainContent.appendChild(createEl('h2', { textContent: 'Keyboard Shortcuts', style: { marginBottom: '20px' } }));

      const searchWrapper = createEl('div', { className: 'nook-shortcuts-search' });
      const search        = createEl('input', { id: 'shortcuts-search-input', name: 'shortcuts-search', placeholder: 'Search shortcuts...', type: 'search' });
      searchWrapper.appendChild(search);
      mainContent.appendChild(searchWrapper);

      const table = createEl('table', { className: 'nook-shortcuts-table' });
      const thead = createEl('thead');
      const hRow  = createEl('tr');
      for (const text of ['Action', 'Shortcut', '']) hRow.appendChild(createEl('th', { textContent: text }));
      thead.appendChild(hRow);
      table.appendChild(thead);

      const tbody = createEl('tbody');

      // Parse custom shortcuts once — corrupt localStorage no longer crashes
      let customShortcuts;
      try { customShortcuts = JSON.parse(localStorage.getItem('novabyte-shortcuts') || '{}'); }
      catch (err) { devLog('novabyte-shortcuts parse failed:', err); customShortcuts = {}; }

      function captureKeyBinding(action) {
        return new Promise(resolve => {
          const overlay = createEl('div', {
            tabIndex: -1,
            style: 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:9999;outline:none'
          });
          const ac = mountOverlay(overlay);
          let settled = false;
          const finish = (value) => {
            if (settled) return;
            settled = true;
            dismissOverlay(overlay);
            resolve(value);
          };
          ac.signal.addEventListener('abort', () => finish(null));

          const msg      = createEl('div', { style: 'background:var(--bg-elevated);padding:30px 40px;border-radius:12px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.5)' });
          const title    = createEl('h3', { style: 'margin-bottom:15px;color:var(--text-primary)', textContent: 'Rebind: ' + action });
          const subtitle = createEl('p',   { textContent: 'Press any key combination...', style: 'color:var(--text-secondary);margin-bottom:20px' });
          const captureEl = createEl('div', {
            textContent: 'Waiting...',
            style: 'font-family:var(--font-mono);font-size:18px;padding:10px 20px;background:var(--bg-sunken);border-radius:6px;color:var(--accent)'
          });
          msg.append(title, subtitle, captureEl);
          overlay.appendChild(msg);

          function keyHandler(e) {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') { finish(null); return; }
            const parts = [];
            if (e.ctrlKey)  parts.push('Ctrl');
            if (e.altKey)   parts.push('Alt');
            if (e.shiftKey) parts.push('Shift');
            if (e.metaKey)  parts.push('Win');
            if (e.key && !['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
              parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
            }
            if (parts.length > 0) {
              captureEl.textContent = parts.join('+');
              setTimeout(() => finish(parts.join('+')), 400);
            }
          }

          overlay.addEventListener('keydown', keyHandler, true);
          overlay.style.cursor = 'wait';
          requestAnimationFrame(() => overlay.focus());
        });
      }

      // Build rows and cache their text for fast search filtering
      const rows = [];
      const rowTexts = [];

      for (const s of SHORTCUTS_LIST) {
        const row      = createEl('tr');
        const actionTd = createEl('td', { textContent: s.action });
        const keyTd  = createEl('td');
        const keySpan = createEl('span', { className: 'nook-shortcut-key', textContent: customShortcuts[s.action] || s.key });
        keyTd.appendChild(keySpan);
        const rebindTd = createEl('td');
        const btn = createEl('button', { className: 'btn btn-sm nook-rebind-btn', textContent: 'Rebind' });
        btn.addEventListener('click', async () => {
          const newKey = await captureKeyBinding(s.action);
          if (!isAlive()) return;
          if (newKey) {
            customShortcuts[s.action] = newKey;
            localStorage.setItem('novabyte-shortcuts', JSON.stringify(customShortcuts));
            keySpan.textContent = newKey;
            // Update cached search text so the new binding is findable
            const idx = rows.indexOf(row);
            if (idx !== -1) rowTexts[idx] = (s.action + ' ' + newKey).toLowerCase();
          }
        }, { signal: lifecycle.signal });
        rebindTd.appendChild(btn);
        row.append(actionTd, keyTd, rebindTd);
        tbody.appendChild(row);
        rows.push(row);
        rowTexts.push((s.action + ' ' + (customShortcuts[s.action] || s.key)).toLowerCase());
      }

      table.appendChild(tbody);
      mainContent.appendChild(table);

      // Search — uses cached text instead of re-reading textContent per keystroke
      search.addEventListener('input', () => {
        const query = search.value.toLowerCase();
        for (let i = 0; i < rows.length; i++) {
          rows[i].style.display = rowTexts[i].includes(query) ? '' : 'none';
        }
      }, { signal: lifecycle.signal });
    }

    // About
    function renderAbout() {
      mainContent.style.padding = '0';
      const body = createEl('div', { style: 'padding:24px 28px;display:flex;flex-direction:column;gap:18px;overflow-y:auto;flex:1;' });

      function mkSection(title, icon) {
        const wrap = createEl('div', { style: 'background:var(--bg-sunken);border:1px solid var(--border-subtle);border-radius:12px;overflow:hidden;' });
        const hdr  = createEl('div', { style: 'padding:11px 16px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:8px;background:rgba(255,255,255,0.025);' });
        hdr.appendChild(createEl('span', { textContent: icon,  style: 'font-size:13px;', 'aria-hidden': 'true' }));
        hdr.appendChild(createEl('span', { textContent: title, style: 'font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.09em;color:var(--text-muted);' }));
        const rows = createEl('div', { style: 'padding:0 16px;' });
        wrap.append(hdr, rows);
        return { wrap, rows };
      }

      function mkRow(label, value, last) {
        const row = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:9px 0;font-size:12.5px;' + (last ? '' : 'border-bottom:1px solid var(--border-subtle);') });
        const lbl = createEl('span', { textContent: label, style: 'color:var(--text-secondary);flex-shrink:0;margin-right:12px;' });
        const val = createEl('span', { style: 'color:var(--text-primary);font-weight:500;text-align:right;max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' });
        val.textContent = value;
        row.append(lbl, val);
        return row;
      }

      // Software
      const { wrap: swWrap, rows: swRows } = mkSection('Software Information', '\uD83D\uDCBF');

      const logoRow = createEl('div', { style: 'padding:18px 0 14px;display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--border-subtle);' });
      const logoBox = createEl('div', { style: 'width:54px;height:54px;border-radius:15px;background:linear-gradient(135deg,#3d8eff 0%,#7c5cfc 55%,#c45cff 100%);display:flex;align-items:center;justify-content:center;box-shadow:0 6px 22px rgba(88,166,255,0.32),0 2px 8px rgba(0,0,0,0.4),inset 0 1px 0 rgba(255,255,255,0.22);flex-shrink:0;' });
      // Static SVG literal — no user input, safe to set via innerHTML
      logoBox.innerHTML = '<svg viewBox="0 0 120 120" width="32" height="32" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="abt-g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#58a6ff"/><stop offset="100%" stop-color="#a371f7"/></linearGradient></defs><polygon points="60,5 110,30 110,85 60,115 10,85 10,30" fill="rgba(88,166,255,0.05)" stroke="url(#abt-g)" stroke-width="2.5" opacity="0.9"/><polygon points="60,15 100,35 100,80 60,105 20,80 20,35" fill="none" stroke="url(#abt-g)" stroke-width="1.5" opacity="0.38"/><polygon points="60,28 88,43 88,76 60,91 32,76 32,43" fill="rgba(163,113,247,0.05)" stroke="url(#abt-g)" stroke-width="1" opacity="0.3"/><text x="60" y="69" text-anchor="middle" fill="url(#abt-g)" font-family="system-ui,-apple-system,sans-serif" font-size="30" font-weight="700">NB</text></svg>';
      const logoMeta = createEl('div');
      const lgTitle  = createEl('div', { style: 'font-size:17px;font-weight:800;background:linear-gradient(130deg,#e6edf3 25%,#a371f7 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:4px;line-height:1.15;', textContent: 'NovaByte' });
      const verBadge = createEl('div', { style: 'display:inline-flex;align-items:center;gap:5px;background:rgba(88,166,255,0.12);border:1px solid rgba(88,166,255,0.3);border-radius:20px;padding:2px 11px;font-size:11px;font-weight:700;color:var(--accent);margin-bottom:3px;', textContent: 'v' + OS.version });
      const tagline = createEl('div', { style: 'font-size:10.5px;color:var(--text-muted);font-style:italic;', textContent: '' });
      logoMeta.append(lgTitle, verBadge, tagline);
      logoRow.append(logoBox, logoMeta);
      swRows.appendChild(logoRow);

      // Version row — easter egg: 7 clicks launches Snake
      const novaVersionRow = createEl('div', {
        className: 'nook-row clickable',
        style: 'display:flex;justify-content:space-between;align-items:center;padding:9px 0;font-size:12.5px;border-bottom:1px solid var(--border-subtle);cursor:pointer;transition:background 0.15s;border-radius:6px;',
        role: 'button',
        tabindex: '0',
        'aria-label': 'NovaByte version (click 7 times for a surprise)'
      });
      novaVersionRow.addEventListener('mouseenter', () => { novaVersionRow.style.background = 'rgba(88,166,255,0.08)'; });
      novaVersionRow.addEventListener('mouseleave', () => { novaVersionRow.style.background = 'transparent'; });
      const novaVerLabel = createEl('span', { textContent: 'NovaByte Version', style: 'color:var(--text-secondary);flex-shrink:0;margin-right:12px;' });
      const novaVerValue = createEl('span', { style: 'color:var(--text-primary);font-weight:500;text-align:right;max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', textContent: 'v' + OS.version });
      novaVersionRow.append(novaVerLabel, novaVerValue);

      let clickCount = 0;
      let clickTimeout = null;
      function handleVersionClick() {
        clickCount++;
        if (clickCount >= 7) {
          clickCount = 0;
          if (clickTimeout) { clearTimeout(clickTimeout); clickTimeout = null; }
          launchSnakeGame();
          return;
        }
        if (clickTimeout) clearTimeout(clickTimeout);
        clickTimeout = setTimeout(() => { clickCount = 0; clickTimeout = null; }, 1500);
      }
      novaVersionRow.addEventListener('click', handleVersionClick, { signal: lifecycle.signal });
      novaVersionRow.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleVersionClick(); }
      }, { signal: lifecycle.signal });
      swRows.appendChild(novaVersionRow);
      swRows.appendChild(mkRow('Source Date',  '2026-08-02'));

      const secRow      = createEl('div', { style: 'display:flex;justify-content:space-between;align-items:center;padding:9px 0;font-size:12.5px;border-top:1px solid var(--border-subtle);border-radius:6px;' });
      const secRowLeft  = createEl('div', { style: 'display:flex;align-items:center;gap:6px;' });
      secRowLeft.appendChild(createEl('span', { textContent: 'Security Patch Level', style: 'color:var(--text-secondary);' }));
      secRow.appendChild(secRowLeft);
      const secRowRight = createEl('div', { style: 'display:flex;align-items:center;gap:6px;' });
      const secBadge    = createEl('span', { style: 'display:inline-flex;align-items:center;gap:5px;background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.3);border-radius:20px;padding:2px 10px;font-size:10.5px;font-weight:700;color:#3fb950;', textContent: '\uD83D\uDD12 2026-08-02' });
      secRowRight.appendChild(secBadge);
      secRow.appendChild(secRowRight);
      swRows.appendChild(secRow);
      body.appendChild(swWrap);

      // Hardware
      const { wrap: hwWrap, rows: hwRows } = mkSection('Hardware', '\uD83D\uDDA5\uFE0F');
      [
        ['Screen Resolution', screen.width + '\u00D7' + screen.height,                                               false],
        ['Colour Depth',      screen.colorDepth + ' bit',                                                             false],
        ['Pixel Ratio',       window.devicePixelRatio + '\u00D7',                                                     false],
        ['CPU Cores',         String(navigator.hardwareConcurrency || 'Unknown'),                                      false],
        ['Device Memory',     navigator.deviceMemory ? navigator.deviceMemory + ' GB (approx.)' : 'Not reported',    false],
        ['Touch Points',      navigator.maxTouchPoints > 0 ? String(navigator.maxTouchPoints) + ' point(s)' : 'None', true]
      ].forEach(([lbl, val, last]) => hwRows.appendChild(mkRow(lbl, val, last)));
      body.appendChild(hwWrap);

      // Environment
      const { wrap: envWrap, rows: envRows } = mkSection('Environment', '\uD83C\uDF10');
      let tz = 'Unknown';
      try { tz = OS.settings.get('timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown'; } catch { /* sandboxed */ }
      [
        ['Browser',         detectBrowser(),                                                                          false],
        ['Platform',        navigator.platform,                                                                        false],
        ['Region',          OS.settings.get('region') || navigator.language,                                          false],
        ['Timezone',        tz,                                                                                        false],
        ['Do Not Track',    navigator.doNotTrack === '1' ? 'Enabled \u2713' : 'Not set',                             false],
        ['Cookies',         navigator.cookieEnabled ? 'Enabled \u2713' : 'Disabled',                                 false],
        ['Service Workers', ('serviceWorker' in navigator) ? 'Supported \u2713' : 'Not supported',                    true]
      ].forEach(([lbl, val, last]) => envRows.appendChild(mkRow(lbl, val, last)));
      body.appendChild(envWrap);

      // Legal
      const { wrap: lgWrap, rows: lgRows } = mkSection('Legal \u0026 Licences', '\u2696\uFE0F');
      lgRows.appendChild(mkRow('Licence',   'Apache 2.0'));
      lgRows.appendChild(mkRow('Copyright', '\u00A9 2026 NovaByteOfficial'));
      body.appendChild(lgWrap);

      // Copy system info
      const copyBtn = createEl('button', { className: 'btn btn-sm', textContent: '\uD83D\uDCCB Copy System Info' });
      copyBtn.addEventListener('click', () => {
        let tzCopy = 'Unknown';
        try { tzCopy = OS.settings.get('timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown'; } catch { /* sandboxed */ }
        const lines = [
          'NovaByte v' + OS.version,
          'Security Update: 2026-08-02',
          'Browser: '   + detectBrowser(),
          'Platform: '  + navigator.platform,
          'Screen: '    + screen.width + '\u00D7' + screen.height,
          'CPU Cores: ' + (navigator.hardwareConcurrency || 'Unknown'),
          'Region: '    + (OS.settings.get('region') || navigator.language),
          'Timezone: '  + tzCopy
        ];
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(lines.join('\n')).then(
            () => Notify.show({ title: 'Copied', body: 'System info copied to clipboard', type: 'success', appName: 'Nook' }),
            (err) => { devLog('clipboard.writeText failed:', err); Notify.show({ title: 'Copy Failed', body: 'Clipboard not available', type: 'error', appName: 'Nook' }); }
          );
        } else {
          Notify.show({ title: 'Copy Failed', body: 'Clipboard not available', type: 'error', appName: 'Nook' });
        }
      }, { signal: lifecycle.signal });
      body.appendChild(copyBtn);
      mainContent.appendChild(body);
    }

    // Bootstrap
    container.append(sidebar, mainContent);
    content.appendChild(container);

    buildSidebar();
    renderContent();

    // Re-render when relevant settings change elsewhere in the system.
    // Guarded with isAlive() so the handler is a no-op once this window
    // is closed (the listener itself is removed by the returned cleanup).
    if (typeof OS !== 'undefined' && OS.events && typeof OS.events.on === 'function') {
      const settingsHandler = ({ key }) => {
        if (!isAlive()) return;
        if (key === 'devMode' && currentSection === 'apps') renderContent();
        if (key === 'region' && currentSection === 'about') renderContent();
      };
      OS.events.on('settings:changed', settingsHandler);

      // Return cleanup so the host can tear us down cleanly
      return () => {
        lifecycle.abort();
        closeAllOverlays();
        try {
          if (typeof OS.events.off === 'function') OS.events.off('settings:changed', settingsHandler);
        } catch { /* off may not exist — listener is isAlive-guarded */ }
      };
    }
  }
});
