registerApp({
  id: 'devconsole',
  name: 'Console',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiIgd2lkdGg9Ijk0IiBoZWlnaHQ9Ijk0Ij4KICA8ZGVmcz4KICAgIDxsaW5lYXJHcmFkaWVudCBpZD0iY29uLWJvZHkiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIxIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzMzNDE1NSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMwZjE3MmEiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImNvbi1iYXIiIHgxPSIwIiB5MT0iMCIgeDI9IjEiIHkyPSIwIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzQ3NTU2OSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMxZTI5M2IiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgPC9kZWZzPgogIDwhLS0gc2hhZG93IC0tPgogIDxlbGxpcHNlIGN4PSI0OCIgY3k9IjkwIiByeD0iMzAiIHJ5PSI2IiBmaWxsPSIjMDAwIiBvcGFjaXR5PSIwLjE4Ii8+CgogIDwhLS0gd2luZG93IGJvZHkgLS0+CiAgPHJlY3QgeD0iMTQiIHk9IjIwIiB3aWR0aD0iNjgiIGhlaWdodD0iNTQiIHJ4PSI4IiBmaWxsPSJ1cmwoI2Nvbi1ib2R5KSIvPgogIDwhLS0gdGl0bGUgYmFyIC0tPgogIDxyZWN0IHg9IjE0IiB5PSIyMCIgd2lkdGg9IjY4IiBoZWlnaHQ9IjE0IiByeD0iOCIgZmlsbD0idXJsKCNjb24tYmFyKSIvPgogIDxyZWN0IHg9IjE0IiB5PSIyNyIgd2lkdGg9IjY4IiBoZWlnaHQ9IjciIGZpbGw9InVybCgjY29uLWJhcikiLz4KICA8Y2lyY2xlIGN4PSIyMiIgY3k9IjI3IiByPSIyLjUiIGZpbGw9IiNmODcxNzEiLz4KICA8Y2lyY2xlIGN4PSIzMCIgY3k9IjI3IiByPSIyLjUiIGZpbGw9IiNmYmJmMjQiLz4KICA8Y2lyY2xlIGN4PSIzOCIgY3k9IjI3IiByPSIyLjUiIGZpbGw9IiM0YWRlODAiLz4KCiAgPCEtLSBwcm9tcHQgY2FyZXQgKyBjdXJzb3IgLS0+CiAgPHBvbHlsaW5lIHBvaW50cz0iMjQsNDggMzQsNTQgMjQsNjAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzRhZGU4MCIgc3Ryb2tlLXdpZHRoPSIzLjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogIDxsaW5lIHgxPSI0MCIgeTE9IjYwIiB4Mj0iNTgiIHkyPSI2MCIgc3Ryb2tlPSIjNGFkZTgwIiBzdHJva2Utd2lkdGg9IjMuMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+CiAgPHJlY3QgeD0iNjMiIHk9IjQ1IiB3aWR0aD0iNyIgaGVpZ2h0PSIxMiIgZmlsbD0iI2EzZTYzNSIgb3BhY2l0eT0iMC45Ii8+CgogIDwhLS0gaGlnaGxpZ2h0IC0tPgogIDxyZWN0IHg9IjE0IiB5PSIyMCIgd2lkdGg9IjY4IiBoZWlnaHQ9IjE0IiByeD0iOCIgZmlsbD0iI2ZmZiIgb3BhY2l0eT0iMC4wOCIvPgo8L3N2Zz4K',
  description: 'Evaluate JS in the OS context',
  category: 'developer',
  devOnly: true,
  autoGrant: true,
  defaultSize: [600, 500],
  minSize: [400, 300],
  // eval() runs with full OS-context privileges, no sandboxing here.
  // Keep this app's permission set narrow anyway — it doesn't need
  // fs/net grants of its own, since eval'd code isn't restricted by
  // the permission system to begin with. Don't read that as "safe";
  // it's the opposite: nothing in this app can be scoped down further.
  permissions: ['system:info', 'system:settings'],
  init(content, state, options) {
    if (!window.AppDirs?.getVFSDir('com.nbosp.settings', 'files')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.settings</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
      return;
    }

    if (!OS.settings.get('devMode')) {
      content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
      content.innerHTML = '<div style="font-size:32px">🔒</div><div style="font-size:14px;text-align:center">Enable Developer Mode in Settings to use Console.</div>';
      return;
    }

    content.style.cssText = 'display:flex;flex-direction:column;height:100%;background:var(--bg-default,#0f1115);color:var(--text-primary,#e6e6e6);font-family:var(--font-ui,sans-serif);overflow:auto;padding:16px;font-size:13px;';

    const inputRow = createEl('div', { style: 'display:flex;gap:8px;margin-bottom:12px;' });
    const input = createEl('input', { placeholder: 'Enter JS to evaluate, e.g. OS.windows.size', style: 'flex:1;padding:8px;background:var(--bg-elevated);border:1px solid var(--border-subtle);border-radius:4px;color:var(--text-primary);font-family:monospace;font-size:12px;' });
    const runBtn = createEl('button', { textContent: 'Run', style: 'padding:8px 16px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;' });
    const output = createEl('pre', { textContent: 'Console ready. Type an expression above and press Enter or Run.\nResults are JSON-stringified; errors are caught and shown inline.\n', style: 'padding:12px;background:var(--bg-elevated);border-radius:6px;border:1px solid var(--border-subtle);min-height:200px;max-height:400px;overflow:auto;font-size:12px;color:var(--text-muted);' });

    let hasRun = false;

    runBtn.addEventListener('click', () => {
      const code = input.value.trim();
      if (!code) return;
      if (!hasRun) {
        output.textContent = '';
        output.style.color = 'var(--text-primary)';
        hasRun = true;
      }
      try {
        const result = eval(code);
        output.textContent += `\n> ${code}\n${typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result)}\n`;
      } catch (e) {
        output.textContent += `\n> ${code}\nError: ${e.message}\n`;
      }
      input.value = '';
      output.scrollTop = output.scrollHeight;
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runBtn.click();
    });

    inputRow.appendChild(input);
    inputRow.appendChild(runBtn);
    content.appendChild(inputRow);
    content.appendChild(output);
  }
});