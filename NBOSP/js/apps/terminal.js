registerApp({
        id: 'shell', name: 'Terminal', icon: 'terminal',
        description: 'Terminal',
        defaultSize: [700, 460], minSize: [420, 260],
        init(content, state) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.shell', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.shell</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const root = createEl('div', { className: 'shell-container' });
          content.appendChild(root);

          const mainArea = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0;' });
          root.appendChild(mainArea);

          // Context menu
          root.addEventListener('contextmenu', e => {
            if (e.target.closest('.shell-output') || e.target.closest('.shell-input-line')) {
              e.preventDefault();
              const sel = window.getSelection().toString();
              ContextMenu.show(e.clientX, e.clientY, [
                ...(sel ? [{ label: 'Copy', icon: 'copy', action: () => { navigator.clipboard.writeText(sel); Notify.show({ title: 'Copied', body: 'Text copied', type: 'info', appName: 'Terminal' }); } }, { separator: true }] : []),
                { label: 'Paste', icon: 'documents', action: () => { navigator.clipboard.readText().then(text => { if (tabs[activeTabIdx]?.input) tabs[activeTabIdx].input.value += text; }); } },
                { label: 'Clear', icon: 'trash-2', action: () => { if (tabs[activeTabIdx]?.output) tabs[activeTabIdx].output.innerHTML = ''; } },
                { separator: true },
                { label: 'Select All', icon: 'maximize', action: () => document.execCommand('selectAll') }]);
            }
          });

          let tabs = [];
          let activeTabIdx = 0;

          // ── Path resolver (fixed cd) ─────────────────────────────────
          function resolvePath(cwd, arg) {
            if (!arg || arg === '~') return FS.specialFolders.desktop;
            if (arg === '.') return cwd;
            // Absolute path
            if (arg.startsWith('/')) {
              const parts = arg.split('/').filter(Boolean);
              let node = FS.rootId;
              for (const part of parts) {
                if (part === '..') { const n = FS.files.get(node); if (n && n.parentId) node = n.parentId; }
                else if (part !== '.') {
                  const ch = FS.listDir(node);
                  const found = ch.find(c => c.name === part && c.type === 'folder');
                  if (!found) return false;
                  node = found.id;
                }
              }
              return node;
            }
            // Relative path
            const parts = arg.split('/').filter(Boolean);
            let node = cwd;
            for (const part of parts) {
              if (part === '..') { const n = FS.files.get(node); if (n && n.parentId) node = n.parentId; else return false; }
              else if (part !== '.') {
                const ch = FS.listDir(node);
                const found = ch.find(c => c.name === part && c.type === 'folder');
                if (!found) return false;
                node = found.id;
              }
            }
            return node;
          }

          // ── Create session ───────────────────────────────────────────
          function createTab(label) {
            const tab = {
              label: label || 'Terminal',
              cwd: FS.specialFolders.desktop,
              prevCwd: null,
              history: [],
              historyIdx: -1,
              variables: { HOME: '/Desktop', USER: OS.username, HOSTNAME: 'novabyteOS', SHELL: '/bin/sh', TERM: 'xterm-256color', PATH: '/bin:/usr/bin:/usr/local/bin' },
              aliases: { ll: 'ls -la', la: 'ls -a', l: 'ls -lh', cls: 'clear', md: 'mkdir', rd: 'rmdir', ff: 'fastfetch' },
              element: null, output: null, input: null, prompt: null, btnEl: null
            };

            const pane = createEl('div', { style: 'flex:1;display:flex;flex-direction:column;overflow:hidden;' });
            const output = createEl('div', { className: 'shell-output', role: 'log', 'aria-label': 'Terminal output' });
            const inputLine = createEl('div', { className: 'shell-input-line' });
            const promptEl = createEl('span', { className: 'shell-prompt' });
            const inputEl = createEl('input', { className: 'shell-input', id: 'shell-command-input', name: 'shell-command', 'aria-label': 'Command input', autocomplete: 'off', spellcheck: 'false' });

            inputLine.appendChild(promptEl);
            inputLine.appendChild(inputEl);
            pane.appendChild(output);
            pane.appendChild(inputLine);

            output.addEventListener('click', () => inputEl.focus());
            pane.addEventListener('click', ev => { if (!ev.target.closest('a') && !ev.target.closest('button')) inputEl.focus(); });
            inputLine.addEventListener('click', () => inputEl.focus());

            tab.element = pane;
            tab.output = output;
            tab.input = inputEl;
            tab.prompt = promptEl;
            tab.btnEl = { classList: { toggle: () => { } } }; // stub

            tabs.push(tab);
            setupInput(tab);
            return tab;
          }

          function removeTab(idx) { /* no-op — single session */ }

          function switchTab(idx) {
            activeTabIdx = idx;
            if (tabs[idx]) {
              mainArea.innerHTML = '';
              mainArea.appendChild(tabs[idx].element);
              tabs[idx].input.focus();
              updatePrompt(tabs[idx]);
            }
          }

          // ── Terminal output helpers ──────────────────────────────────
          function getPromptStr(tab) {
            const path = FS.getPath(tab.cwd).replace(/^\/Desktop/, '~');
            return `<span class="shell-green">${escapeText(OS.username)}@novabyteOS</span>:<span class="shell-blue">${escapeText(path)}</span>$ `;
          }
          function updatePrompt(tab) { tab.prompt.innerHTML = getPromptStr(tab); }

          function writeLine(tab, text, cls) {
            const d = createEl('div'); if (cls) d.className = cls; d.textContent = text;
            tab.output.appendChild(d); tab.output.scrollTop = tab.output.scrollHeight;
          }
          function writeHTML(tab, html) {
            const d = createEl('div'); d.innerHTML = html;
            tab.output.appendChild(d); tab.output.scrollTop = tab.output.scrollHeight;
          }
          function writePromptLine(tab, cmd) {
            const d = createEl('div');
            d.innerHTML = getPromptStr(tab) + escapeText(cmd);
            tab.output.appendChild(d);
          }
          function clearOutput(tab) { tab.output.innerHTML = ''; }

          // ── Tab-completion ───────────────────────────────────────────
          function getCompletions(tab, partial) {
            const BUILTINS = ['ls', 'cd', 'pwd', 'mkdir', 'rmdir', 'rm', 'touch', 'cat', 'head', 'tail', 'wc', 'grep', 'sort', 'uniq', 'cut', 'find', 'tree', 'diff', 'stat', 'chmod', 'cp', 'mv', 'echo', 'printf', 'base64', 'date', 'sleep', 'yes', 'seq', 'expr', 'true', 'false', 'env', 'export', 'unset', 'alias', 'unalias', 'which', 'hostname', 'whoami', 'uname', 'uptime', 'history', 'clear', 'ps', 'kill', 'neofetch', 'fastfetch', 'help', 'exit'];
            const files = FS.listDir(tab.cwd).map(f => f.name + (f.type === 'folder' ? '/' : ''));
            return [...BUILTINS, ...files].filter(c => c.startsWith(partial));
          }

          // ── Input handler ────────────────────────────────────────────
          function setupInput(tab) {
            let completions = [], compIdx = 0;

            tab.input.addEventListener('keydown', async e => {
              // Stop the event from reaching the global OS shortcut listener
              // so terminal shortcuts (Ctrl+L clear, Ctrl+C cancel, etc.) don't
              // accidentally trigger OS actions (Ctrl+L lock, Ctrl+E file manager…)
              e.stopPropagation();

              if (e.key === 'Enter') {
                e.preventDefault();
                const cmd = tab.input.value.trim();
                tab.input.value = ''; completions = [];
                writePromptLine(tab, cmd);
                if (cmd) { tab.history.unshift(cmd); tab.historyIdx = -1; }
                const result = await runCommand(tab, cmd);
                if (result) {
                  const isErr = result.startsWith('bash:') || result.startsWith('cd:') || result.startsWith('Error');
                  result.split('\n').forEach(line => writeLine(tab, line, isErr ? 'shell-red' : undefined));
                }
                updatePrompt(tab);
                tab.output.scrollTop = tab.output.scrollHeight;

              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (tab.historyIdx < tab.history.length - 1) tab.input.value = tab.history[++tab.historyIdx];

              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                tab.historyIdx > 0 ? (tab.input.value = tab.history[--tab.historyIdx]) : (tab.historyIdx = -1, tab.input.value = '');

              } else if (e.key === 'Tab') {
                e.preventDefault();
                const words = tab.input.value.split(' ');
                const partial = words[words.length - 1];
                if (!completions.length) { completions = getCompletions(tab, partial); compIdx = 0; }
                if (completions.length === 1) { words[words.length - 1] = completions[0]; tab.input.value = words.join(' '); completions = []; }
                else if (completions.length > 1) {
                  if (completions.length <= 12) writeHTML(tab, `<span class="shell-dim">${completions.map(c => escapeText(c)).join('  ')}</span>`);
                  words[words.length - 1] = completions[compIdx++ % completions.length];
                  tab.input.value = words.join(' ');
                }

              } else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); clearOutput(tab); updatePrompt(tab); }
              else if (e.key === 'c' && e.ctrlKey) { e.preventDefault(); writeLine(tab, '^C', 'shell-red'); tab.input.value = ''; updatePrompt(tab); }
              else if (e.key === 'u' && e.ctrlKey) { e.preventDefault(); tab.input.value = ''; }
              else if (e.key === 'a' && e.ctrlKey) { e.preventDefault(); tab.input.setSelectionRange(0, 0); }
              else if (e.key === 'e' && e.ctrlKey) { e.preventDefault(); tab.input.setSelectionRange(tab.input.value.length, tab.input.value.length); }
              else { completions = []; compIdx = 0; }
            });
          }

          // ── Command parsing ──────────────────────────────────────────
          function tokenize(cmd) {
            const toks = []; let cur = '', inQ = false, qc = '';
            for (const ch of cmd) {
              if (inQ) { if (ch === qc) inQ = false; else cur += ch; }
              else if (ch === '"' || ch === "'") { inQ = true; qc = ch; }
              else if (ch === ' ' || ch === '\t') { if (cur) { toks.push(cur); cur = ''; } }
              else cur += ch;
            }
            if (cur) toks.push(cur);
            return toks;
          }

          function splitPipes(line) {
            const segs = []; let cur = '', inQ = false, qc = '';
            for (const ch of line) {
              if (inQ) { if (ch === qc) inQ = false; else cur += ch; }
              else if (ch === '"' || ch === "'") { inQ = true; qc = ch; }
              else if (ch === '|') { segs.push(cur.trim()); cur = ''; }
              else cur += ch;
            }
            segs.push(cur.trim()); return segs.filter(Boolean);
          }

          // ── Individual command executor ──────────────────────────────
          async function execOne(tab, cmdStr, pipeIn) {
            if (!cmdStr.trim()) return pipeIn || '';
            // Variable expansion
            cmdStr = cmdStr.replace(/\$\{?(\w+)\}?/g, (_, n) => tab.variables[n] || '');
            const toks = tokenize(cmdStr);
            if (!toks.length) return '';
            let cmd = toks[0], args = toks.slice(1);
            // Alias expansion
            if (tab.aliases[cmd]) { const at = tokenize(tab.aliases[cmd]); cmd = at[0]; args = [...at.slice(1), ...args]; }

            switch (cmd) {
              // ── Help ──
              case 'help': {
                const sections = [
                  ['Filesystem', 'ls  ll  la  l  cd  pwd  mkdir  rmdir  rm  touch  cp  mv  cat  head  tail  stat  chmod  find  tree  diff'],
                  ['Text', 'echo  printf  grep  sort  uniq  cut  wc  base64'],
                  ['System', 'clear  history  env  export  unset  alias  unalias  which  hostname  whoami  uname  uptime  date  ps  kill  sleep'],
                  ['Math', 'expr  seq'],
                  ['Fun', 'neofetch  fastfetch  yes  true  false  exit']];
                writeHTML(tab, `<span class="shell-bold shell-blue">Terminal</span> <span class="shell-dim">— ${OS.username}@novabyteOS</span>`);
                sections.forEach(([s, cmds]) => writeHTML(tab, `  <span class="shell-yellow">${s}:</span> <span class="shell-dim">${cmds}</span>`));
                writeHTML(tab, `\n  <span class="shell-dim">Shortcuts: <span class="shell-green">Tab</span>=autocomplete  <span class="shell-green">↑↓</span>=history  <span class="shell-green">Ctrl+L</span>=clear  <span class="shell-green">Ctrl+C</span>=cancel  <span class="shell-green">Ctrl+Shift+T</span>=new tab</span>`);
                return '';
              }

              case 'clear': clearOutput(tab); return '';
              case 'exit': return 'Use the window close button to exit.';
              case 'true': return '';
              case 'false': return 'Error: false returned exit code 1';
              case 'pwd': return FS.getPath(tab.cwd);
              case 'whoami': return OS.username;
              case 'hostname': return args.includes('-f') ? 'novabyteOS.local' : 'novabyteOS';
              case 'date': return args.includes('-u') ? new Date().toUTCString() : new Date().toString();
              case 'uptime': return `up  ${Math.floor(performance.now() / 3600000)}:${String(Math.floor(performance.now() / 60000) % 60).padStart(2, '0')}, load average: 0.08 0.10 0.09`;

              case 'uname': {
                if (args.includes('-a')) return 'NovaKernel novabyteOS 5.15.0-nova #1 SMP ' + new Date().toDateString() + ' x86_64 GNU/NovaByte';
                if (args.includes('-r')) return '5.15.0-nova';
                if (args.includes('-m')) return 'x86_64';
                if (args.includes('-s')) return 'NovaKernel';
                if (args.includes('-n')) return 'novabyteOS';
                return 'NovaKernel';
              }

              case 'env': {
                if (args[0]) { const [k, ...v] = args[0].split('='); if (v.length) { tab.variables[k] = v.join('='); return execOne(tab, args.slice(1).join(' '), pipeIn); } }
                return Object.entries({ ...tab.variables }).map(([k, v]) => `${k}=${v}`).join('\n');
              }

              case 'export': {
                if (!args[0]) return Object.entries(tab.variables).map(([k, v]) => `declare -x ${k}="${v}"`).join('\n');
                for (const a of args) {
                  const eq = a.indexOf('=');
                  if (eq > 0) tab.variables[a.slice(0, eq)] = a.slice(eq + 1).replace(/^["']|["']$/g, '');
                }
                return '';
              }

              case 'unset': { args.forEach(a => { delete tab.variables[a]; }); return ''; }

              case 'alias': {
                if (!args[0]) return Object.entries(tab.aliases).map(([k, v]) => `alias ${k}='${v}'`).join('\n');
                const eq = args[0].indexOf('=');
                if (eq > 0) tab.aliases[args[0].slice(0, eq)] = args[0].slice(eq + 1).replace(/^["']|["']$/g, '');
                return '';
              }

              case 'unalias': { args.forEach(a => delete tab.aliases[a]); return ''; }

              case 'which': {
                if (!args[0]) return 'which: missing argument';
                const BUILTINS = ['ls', 'cd', 'pwd', 'mkdir', 'rmdir', 'rm', 'touch', 'cat', 'head', 'tail', 'wc', 'grep', 'sort', 'uniq', 'cut', 'find', 'tree', 'diff', 'stat', 'chmod', 'cp', 'mv', 'echo', 'printf', 'base64', 'date', 'sleep', 'yes', 'seq', 'expr', 'true', 'false', 'env', 'export', 'unset', 'alias', 'unalias', 'which', 'hostname', 'whoami', 'uname', 'uptime', 'history', 'clear', 'ps', 'kill', 'neofetch', 'fastfetch', 'help', 'exit'];
                return BUILTINS.includes(args[0]) ? `/bin/${args[0]}` : `${args[0]}: not found`;
              }

              case 'history': {
                if (args[0] === '-c') { tab.history = []; return ''; }
                const n = parseInt(args[0]) || tab.history.length;
                return tab.history.slice(0, n).slice().reverse().map((c, i) => `${String(i + 1).padStart(5)}  ${c}`).join('\n') || '(empty)';
              }

              case 'echo': {
                const noNl = args[0] === '-n', en = args[0] === '-e';
                let text = args.slice((noNl || en) ? 1 : 0).join(' ');
                if (en) text = text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\033\[(\d+)m/g, '');
                return text;
              }

              case 'printf': {
                if (!args[0]) return '';
                let fmt = args[0], ai = 1, out = '';
                for (let i = 0; i < fmt.length; i++) {
                  if (fmt[i] === '%' && i + 1 < fmt.length) {
                    const spec = fmt[++i];
                    if (spec === 's') out += (args[ai++] || '');
                    else if (spec === 'd') out += parseInt(args[ai++] || '0');
                    else if (spec === 'f') out += parseFloat(args[ai++] || '0').toFixed(2);
                    else out += spec;
                  } else if (fmt[i] === '\\' && i + 1 < fmt.length) {
                    const esc = fmt[++i];
                    if (esc === 'n') out += '\n'; else if (esc === 't') out += '\t'; else out += esc;
                  } else out += fmt[i];
                }
                return out;
              }

              case 'sleep': {
                const secs = parseFloat(args[0]) || 1;
                await new Promise(r => setTimeout(r, Math.min(secs, 30) * 1000));
                return '';
              }

              case 'yes': {
                const w = args[0] || 'y';
                return Array(25).fill(w).join('\n') + '\n\x1b[2m(truncated)\x1b[0m';
              }

              case 'seq': {
                let start = 1, end = 1, step = 1;
                if (args.length === 1) end = parseInt(args[0]);
                else if (args.length === 2) { start = parseInt(args[0]); end = parseInt(args[1]); }
                else if (args.length === 3) { start = parseInt(args[0]); step = parseInt(args[1]); end = parseInt(args[2]); }
                const out = [];
                for (let i = start; i <= end && out.length < 1000; i += step) out.push(i);
                return out.join('\n');
              }

              case 'expr': {
                try {
                  const expr = args.join(' ').replace(/[^0-9+\-*\/()% ]/g, '');
                  return String(safeEvaluateArithmetic(expr));
                } catch { return 'expr: syntax error'; }
              }

              case 'base64': {
                const src = pipeIn || (args.find(a => !a.startsWith('-')) && FS.listDir(tab.cwd).find(f => f.name === args.find(a => !a.startsWith('-')))?.content) || args.filter(a => !a.startsWith('-')).join(' ');
                if (args.includes('-d') || args.includes('--decode')) {
                  try { return atob(src.trim()); } catch { return 'base64: invalid input'; }
                }
                try { return btoa(src); } catch { return 'base64: error encoding'; }
              }

              // ── Navigation ──
              case 'cd': {
                if (!args[0] || args[0] === '~') { tab.prevCwd = tab.cwd; tab.cwd = FS.specialFolders.desktop; updatePrompt(tab); return ''; }
                if (args[0] === '-') {
                  if (!tab.prevCwd) return 'cd: OLDPWD not set';
                  [tab.cwd, tab.prevCwd] = [tab.prevCwd, tab.cwd];
                  updatePrompt(tab); return FS.getPath(tab.cwd);
                }
                const resolved = resolvePath(tab.cwd, args[0]);
                if (resolved === false) return `cd: ${args[0]}: No such file or directory`;
                const node = FS.files.get(resolved);
                if (!node) return `cd: ${args[0]}: No such file or directory`;
                if (node.type !== 'folder') return `cd: ${args[0]}: Not a directory`;
                tab.prevCwd = tab.cwd; tab.cwd = resolved; updatePrompt(tab); return '';
              }

              // ── File listing ──
              case 'ls': {
                const hidden = args.some(a => ['-a', '-la', '-al', '-lah'].includes(a));
                const long = args.some(a => ['-l', '-la', '-al', '-lh', '-lah'].includes(a));
                const human = args.some(a => ['-h', '-lh', '-lah'].includes(a));
                const targetArg = args.find(a => !a.startsWith('-'));
                let tid = tab.cwd;
                if (targetArg) { const r = resolvePath(tab.cwd, targetArg); if (r === false) return `ls: cannot access '${targetArg}': No such file or directory`; tid = r; }
                let files = FS.listDir(tid);
                if (!hidden) files = files.filter(f => !f.name.startsWith('.'));
                files.sort((a, b) => a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name));
                if (!files.length) return '';
                if (long) {
                  const rows = files.map(f => {
                    const d = f.type === 'folder'; const perm = d ? 'drwxr-xr-x' : '-rw-r--r--';
                    const sz = human ? formatBytes(f.size || 0).padStart(6) : String(f.size || 0).padStart(8);
                    const dt = new Date(f.modified || Date.now()); const dateStr = dt.toLocaleDateString('en', { month: 'short', day: '2-digit', year: 'numeric' });
                    return `<span class="shell-dim">${perm}  1 ${OS.username} ${OS.username} ${sz} ${dateStr}</span> <span class="${d ? 'shell-blue shell-bold' : ''}">${escapeText(f.name)}${d ? '/' : ''}</span>`;
                  });
                  writeHTML(tab, `<span class="shell-dim">total ${files.length}</span>\n` + rows.join('\n'));
                  return '';
                }
                const cols = Math.max(1, Math.floor((tab.output.clientWidth || 600) / 120));
                const items = files.map(f => {
                  const d = f.type === 'folder';
                  return `<span class="${d ? 'shell-blue shell-bold' : ''}">${escapeText(f.name)}${d ? '/' : ''}</span>`;
                });
                for (let i = 0; i < items.length; i += cols) writeHTML(tab, items.slice(i, i + cols).join('  '));
                return '';
              }

              case 'tree': {
                let out = `<span class="shell-blue shell-bold">.</span>\n`; let count = { d: 0, f: 0 };
                function drawTree(id, prefix, depth) {
                  if (depth > 5) return;
                  const files = FS.listDir(id);
                  files.forEach((f, i) => {
                    const last = i === files.length - 1;
                    const conn = last ? '└── ' : '├── '; const ext = last ? '    ' : '│   ';
                    const isD = f.type === 'folder';
                    out += `${prefix}${conn}<span class="${isD ? 'shell-blue shell-bold' : ''}">${escapeText(f.name)}${isD ? '/' : ''}</span>\n`;
                    if (isD) { count.d++; drawTree(f.id, prefix + ext, depth + 1); } else count.f++;
                  });
                }
                drawTree(tab.cwd, '', 0);
                out += `\n<span class="shell-dim">${count.d} directories, ${count.f} files</span>`;
                writeHTML(tab, out); return '';
              }

              case 'mkdir': {
                const name = args.filter(a => !a.startsWith('-'))[0]; if (!name) return 'mkdir: missing operand';
                if (args.includes('-p')) {
                  const parts = name.split('/').filter(Boolean); let cur = tab.cwd;
                  for (const p of parts) {
                    const ch = FS.listDir(cur); const ex = ch.find(f => f.name === p && f.type === 'folder');
                    if (ex) cur = ex.id; else { const nf = await FS.createFolder(cur, p); cur = nf.id || cur; }
                  }
                } else { await FS.createFolder(tab.cwd, name); }
                renderDesktopIcons(); return '';
              }

              case 'rmdir': {
                const name = args[0]; if (!name) return 'rmdir: missing operand';
                const ch = FS.listDir(tab.cwd); const t = ch.find(f => f.name === name && f.type === 'folder');
                if (!t) return `rmdir: failed to remove '${name}': No such file or directory`;
                if (FS.listDir(t.id).length) return `rmdir: failed to remove '${name}': Directory not empty`;
                await FS.permanentDelete(t.id); renderDesktopIcons(); return '';
              }

              case 'touch': {
                if (!args[0]) return 'touch: missing file operand';
                const ch = FS.listDir(tab.cwd); const ex = ch.find(f => f.name === args[0]);
                if (ex) ex.modified = Date.now(); else await FS.createFile(tab.cwd, args[0], '', 'text/plain');
                renderDesktopIcons(); return '';
              }

              case 'rm': {
                const names = args.filter(a => !a.startsWith('-')); if (!names.length) return 'rm: missing operand';
                const rf = args.includes('-rf') || args.includes('-r') || args.includes('-f');
                for (const name of names) {
                  const ch = FS.listDir(tab.cwd); const t = ch.find(f => f.name === name);
                  if (!t) { if (!args.includes('-f')) return `rm: cannot remove '${name}': No such file or directory`; continue; }
                  if (rf) await FS.permanentDelete(t.id); else await FS.deleteToTrash(t.id);
                }
                renderDesktopIcons(); return '';
              }

              case 'cp': {
                const names = args.filter(a => !a.startsWith('-')); if (names.length < 2) return 'cp: missing destination file operand';
                const [srcName, ...rest] = names; const dst = rest[rest.length - 1];
                const ch = FS.listDir(tab.cwd); const src = ch.find(f => f.name === srcName);
                if (!src) return `cp: cannot stat '${srcName}': No such file or directory`;
                const dstFolder = resolvePath(tab.cwd, dst);
                if (dstFolder !== false) { await FS.createFile(dstFolder, srcName, src.content, src.mimeType); }
                else { await FS.createFile(tab.cwd, dst, src.content, src.mimeType); }
                renderDesktopIcons(); return '';
              }

              case 'mv': {
                const names = args.filter(a => !a.startsWith('-')); if (names.length < 2) return 'mv: missing destination file operand';
                const srcName = names[0]; const dst = names[1];
                const ch = FS.listDir(tab.cwd); const src = ch.find(f => f.name === srcName);
                if (!src) return `mv: cannot stat '${srcName}': No such file or directory`;
                const dstFolder = resolvePath(tab.cwd, dst);
                if (dstFolder !== false) { src.parentId = dstFolder; FS.files.set(src.id, src); await OS.workers.fs.call('putFiles', [src]); }
                else await FS.rename(src.id, dst);
                renderDesktopIcons(); return '';
              }

              case 'cat': {
                if (!args[0] && pipeIn !== undefined) return pipeIn || '';
                const names = args.filter(a => !a.startsWith('-'));
                if (!names.length) return pipeIn || '';
                const results = [];
                for (const n of names) {
                  const ch = FS.listDir(tab.cwd); const t = ch.find(f => f.name === n);
                  if (!t) return `cat: ${n}: No such file or directory`;
                  if (t.type === 'folder') return `cat: ${n}: Is a directory`;
                  if (args.includes('-n')) results.push((t.content || '').split('\n').map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n'));
                  else results.push(t.content || '');
                }
                return results.join('\n');
              }

              case 'head': {
                const fname = args.find(a => !a.startsWith('-')); const nFlag = args.find(a => a.startsWith('-'))?.slice(1);
                const n = nFlag && !isNaN(nFlag) ? parseInt(nFlag) : 10;
                const text = pipeIn || (fname && FS.listDir(tab.cwd).find(f => f.name === fname)?.content) || '';
                return text.split('\n').slice(0, n).join('\n');
              }

              case 'tail': {
                const fname = args.find(a => !a.startsWith('-')); const nFlag = args.find(a => a.startsWith('-'))?.slice(1);
                const n = nFlag && !isNaN(nFlag) ? parseInt(nFlag) : 10;
                const text = pipeIn || (fname && FS.listDir(tab.cwd).find(f => f.name === fname)?.content) || '';
                return text.split('\n').slice(-n).join('\n');
              }

              case 'wc': {
                const fname = args.find(a => !a.startsWith('-'));
                const text = pipeIn || (fname && FS.listDir(tab.cwd).find(f => f.name === fname)?.content) || '';
                if (args.includes('-l')) return String(text.split('\n').length);
                if (args.includes('-w')) return String(text.split(/\s+/).filter(Boolean).length);
                if (args.includes('-c')) return String(new TextEncoder().encode(text).length);
                const L = text.split('\n').length; const W = text.split(/\s+/).filter(Boolean).length; const C = text.length;
                return `${String(L).padStart(8)} ${String(W).padStart(8)} ${String(C).padStart(8)}${fname ? ' ' + fname : ''}`;
              }

              case 'grep': {
                const patternArg = args.find(a => !a.startsWith('-'));
                if (!patternArg) return 'grep: missing PATTERN';
                const fileArg = args.find((a, i) => !a.startsWith('-') && i !== args.indexOf(patternArg));
                const text = pipeIn || (fileArg && FS.listDir(tab.cwd).find(f => f.name === fileArg)?.content) || '';
                const flags = (args.includes('-i') ? 'i' : '') + (args.includes('-m') ? 'm' : '');
                const invert = args.includes('-v'); const count = args.includes('-c'); const lnum = args.includes('-n');
                let rx; try { rx = new RegExp(patternArg, flags); } catch { return `grep: invalid regexp: ${patternArg}`; }
                const lines = text.split('\n');
                const matched = lines.filter(l => invert ? !rx.test(l) : rx.test(l));
                if (count) return String(matched.length);
                if (lnum) return matched.map((l, i) => `${i + 1}:${l}`).join('\n');
                return matched.join('\n');
              }

              case 'sort': {
                const fname = args.find(a => !a.startsWith('-'));
                const text = pipeIn || (fname && FS.listDir(tab.cwd).find(f => f.name === fname)?.content) || '';
                let lines = text.split('\n');
                const rev = args.includes('-r'); const num = args.includes('-n'); const uniq = args.includes('-u');
                lines.sort((a, b) => num ? (parseFloat(a) - parseFloat(b)) : a.localeCompare(b));
                if (rev) lines.reverse();
                if (uniq) lines = [...new Set(lines)];
                return lines.join('\n');
              }

              case 'uniq': {
                const text = pipeIn || '';
                return text.split('\n').filter((l, i, a) => i === 0 || l !== a[i - 1]).join('\n');
              }

              case 'cut': {
                const text = pipeIn || '';
                const di = args.indexOf('-d'); const delim = di >= 0 ? args[di + 1] : '\t';
                const fi = args.indexOf('-f'); const field = fi >= 0 ? parseInt(args[fi + 1]) - 1 : 0;
                return text.split('\n').map(l => l.split(delim)[field] ?? '').join('\n');
              }

              case 'stat': {
                if (!args[0]) return 'stat: missing operand';
                const ch = FS.listDir(tab.cwd); const t = ch.find(f => f.name === args[0]);
                if (!t) return `stat: cannot statx '${args[0]}': No such file or directory`;
                const dt = new Date(t.modified || Date.now());
                return `  File: ${t.name}\n  Size: ${t.size || 0}\t\tBlocks: ${Math.ceil((t.size || 0) / 512)}\tIO Block: 4096  ${t.type === 'folder' ? 'directory' : 'regular file'}\nDevice: nova0\t\tInode: ${t.id.slice(-8) || 0}\tLinks: 1\nAccess: ${dt.toISOString()}\nModify: ${dt.toISOString()}\nChange: ${dt.toISOString()}`;
              }

              case 'chmod': {
                writeLine(tab, `chmod: permissions are advisory in NovaByte`, 'shell-yellow'); return '';
              }

              case 'find': {
                const startArg = args.find(a => !a.startsWith('-')) || '.';
                const nameArg = args.includes('-name') ? args[args.indexOf('-name') + 1] : null;
                const typeArg = args.includes('-type') ? args[args.indexOf('-type') + 1] : null;
                const startId = startArg === '.' ? tab.cwd : resolvePath(tab.cwd, startArg);
                if (startId === false) return `find: '${startArg}': No such file or directory`;
                const results = [];
                function search(id, prefix) {
                  const files = FS.listDir(id);
                  for (const f of files) {
                    const path = prefix + '/' + f.name;
                    const matchName = !nameArg || f.name.replace(/^\./, '') === (nameArg.replace(/^\*/, '')) || f.name.includes(nameArg.replace(/[*?]/g, ''));
                    const matchType = !typeArg || (typeArg === 'd' && f.type === 'folder') || (typeArg === 'f' && f.type !== 'folder');
                    if (matchName && matchType) results.push(path);
                    if (f.type === 'folder') search(f.id, path);
                  }
                }
                search(startId === false ? tab.cwd : startId, '.');
                return results.join('\n') || (nameArg ? '(no matches)' : '');
              }

              case 'diff': {
                if (args.length < 2) return 'diff: missing operand after diff';
                const [a1, a2] = args.filter(a => !a.startsWith('-'));
                const ch = FS.listDir(tab.cwd);
                const f1 = ch.find(f => f.name === a1); const f2 = ch.find(f => f.name === a2);
                if (!f1) return `diff: ${a1}: No such file or directory`;
                if (!f2) return `diff: ${a2}: No such file or directory`;
                const L1 = (f1.content || '').split('\n'); const L2 = (f2.content || '').split('\n');
                const max = Math.max(L1.length, L2.length); let out = ''; let hasDiff = false;
                writeHTML(tab, `<span class="shell-dim">--- ${a1}</span>\n<span class="shell-dim">+++ ${a2}</span>`);
                for (let i = 0; i < max; i++) {
                  if (L1[i] !== L2[i]) {
                    hasDiff = true;
                    if (L1[i] !== undefined) out += `<span class="shell-red">- ${escapeText(L1[i])}</span>\n`;
                    if (L2[i] !== undefined) out += `<span class="shell-green">+ ${escapeText(L2[i])}</span>\n`;
                  }
                }
                if (!hasDiff) return '(files are identical)';
                writeHTML(tab, out); return '';
              }

              case 'ps': {
                const procs = [{ pid: 1, user: 'root', stat: 'S', name: 'nova-init' }, { pid: 2, user: 'root', stat: 'S', name: 'kworker/0:0' }, { pid: 10, user: 'root', stat: 'S', name: 'nova-kernel' }, { pid: 100, user: OS.username, stat: 'S', name: 'nova-session' }, { pid: 101, user: OS.username, stat: 'S', name: 'nova-wm' }, { pid: 102, user: OS.username, stat: 'S', name: 'nova-fs' }, { pid: 103, user: OS.username, stat: 'S', name: 'nova-indexer' }];
                let pid = 200;
                for (const [, ws] of OS.windows) { const app = OS.apps[ws.appId]; if (app) procs.push({ pid: pid++, user: OS.username, stat: 'S', name: app.name.toLowerCase() }); }
                const header = '<span class="shell-bold">  PID USER     STAT COMMAND</span>';
                const rows = procs.map(p => `${String(p.pid).padStart(5)} ${p.user.padEnd(8)} ${p.stat}    ${p.name}`);
                writeHTML(tab, header); return rows.join('\n');
              }

              case 'kill': {
                if (!args[0]) return 'kill: usage: kill [-s sigspec] pid';
                if (isNaN(parseInt(args[args.length - 1]))) return `kill: ${args[args.length - 1]}: invalid signal specification`;
                return `kill: (${args[args.length - 1]}) - Operation not permitted`;
              }

              case 'neofetch':
              case 'fastfetch': {
                const cores = navigator.hardwareConcurrency || 4;
                const ram = (navigator.deviceMemory || 4) + ' GB';
                const engine = navigator.userAgent.match(/(Chrome|Firefox|Safari|Edge)\/[\d.]+/)?.[0] || 'Browser';
                writeHTML(tab,
                  `  <span class="shell-blue shell-bold">  ╔══╗  </span>  <span class="shell-bold shell-green">${OS.username}</span><span class="shell-dim">@</span><span class="shell-bold">novabyteOS</span>\n` +
                  `  <span class="shell-blue shell-bold">  ║NB║  </span>  <span class="shell-dim">────────────────────────</span>\n` +
                  `  <span class="shell-blue shell-bold">  ╚══╝  </span>  <span class="shell-blue">OS:</span>      NovaByte <span class="shell-bold">${OS.version}</span>\n` +
                  `          <span class="shell-blue">Kernel:</span>  NovaKernel 5.15.0-nova\n` +
                  `          <span class="shell-blue">Shell:</span>   Terminal\n` +
                  `          <span class="shell-blue">CPU:</span>     ${cores} cores (logical)\n` +
                  `          <span class="shell-blue">RAM:</span>     ${ram}\n` +
                  `          <span class="shell-blue">Engine:</span>  ${engine}\n` +
                  `          <span class="shell-blue">Screen:</span>  ${screen.width}×${screen.height}@${window.devicePixelRatio}x\n` +
                  `          <span class="shell-blue">Theme:</span>   NovaDark (default)\n` +
                  `          <span class="shell-blue">User:</span>    ${OS.username}`);
                return '';
              }

              default: {
                const ch = FS.listDir(tab.cwd); const ex = ch.find(f => f.name === cmd);
                if (ex) return `bash: ${cmd}: Permission denied`;
                return `bash: ${cmd}: command not found`;
              }
            }
          }

          // ── Full pipeline runner ─────────────────────────────────────
          async function runCommand(tab, line) {
            line = line.trim(); if (!line) return '';
            // Handle ; chains
            if (line.includes(';')) {
              const parts = line.split(';').map(s => s.trim()).filter(Boolean);
              let last = ''; for (const p of parts) last = await runCommand(tab, p); return last;
            }
            // Handle && chains
            if (line.includes('&&')) {
              const parts = line.split('&&').map(s => s.trim());
              let last = ''; for (const p of parts) { last = await runCommand(tab, p); if (last && (last.startsWith('bash:') || last.startsWith('Error'))) return last; }
              return last;
            }
            // Handle || chains
            if (line.includes(' || ')) {
              const parts = line.split(' || ').map(s => s.trim());
              let last = ''; for (const p of parts) { last = await runCommand(tab, p); if (!last || (typeof last === 'string' && !last.startsWith('Error') && !last.startsWith('bash:'))) return last; }
              return last;
            }
            // Handle redirects (basic)
            if (line.includes('>')) {
              const [cmdPart, filePart] = line.split('>').map(s => s.trim());
              const out = await runCommand(tab, cmdPart);
              if (filePart) { const ch = FS.listDir(tab.cwd); const ex = ch.find(f => f.name === filePart.trim()); if (ex) { ex.content = out; await OS.workers.fs.call('putFiles', [ex]); } else await FS.createFile(tab.cwd, filePart.trim(), out, 'text/plain'); return ''; }
              return out;
            }
            // Pipe chain
            const segs = splitPipes(line);
            if (segs.length === 1) return await execOne(tab, segs[0], '');
            let pipe = '';
            for (const s of segs) pipe = await execOne(tab, s, pipe);
            return pipe;
          }

          function welcomeTab(tab) {
            writeHTML(tab, `<span class="shell-bold shell-blue">Terminal</span>  <span class="shell-dim">NovaByte ${OS.version} — ${OS.username}@novabyteOS</span>`);
            writeHTML(tab, `<span class="shell-dim">Type <span class="shell-green">help</span> for commands  ·  <span class="shell-green">Tab</span> autocomplete  ·  <span class="shell-green">Ctrl+Shift+T</span> new tab</span>`);
            writeLine(tab, '');
          }

          // ── Global keyboard shortcuts ────────────────────────────────
          const _kd = e => {
            const win = content.closest('.app-window');
            if (!win || win.dataset.appId !== 'shell') return;
            if (e.ctrlKey && e.shiftKey && e.key === 'T') { e.preventDefault(); const t = createTab('Terminal ' + (tabs.length + 1)); switchTab(tabs.length - 1); welcomeTab(t); updatePrompt(t); }
            if (e.ctrlKey && e.shiftKey && e.key === 'W') { e.preventDefault(); removeTab(activeTabIdx); }
          };
          document.addEventListener('keydown', _kd);
          state.cleanups.push(() => document.removeEventListener('keydown', _kd));

          // ── Init first tab ───────────────────────────────────────────
          const t0 = createTab('Terminal');
          switchTab(0);
          welcomeTab(t0);
          updatePrompt(t0);
          requestAnimationFrame(() => t0.input.focus());
        }
      });


