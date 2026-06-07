registerApp({
        id: 'quill', name: 'TextEdit', icon: 'pen-tool',
        description: 'Text Editor',
        defaultSize: [680, 500], minSize: [360, 260],
        init(content, state, options) {
          // ── NovaByte runtime guard — refuses to launch without AppDirs ──
          if (!window.AppDirs?.getVFSDir('com.nbosp.quill', 'files')) {
            content.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;font-family:var(--font-ui,sans-serif);color:var(--text-muted,#888);';
            content.innerHTML = '<div style="font-size:32px">⚠️</div><div style="font-size:14px;text-align:center"><b>com.nbosp.quill</b><br>App data directory missing.<br>This app requires NovaByte OS.</div>';
            return;
          }
          const container = createEl('div', { className: 'quill-container' });

          // Single file state
          const file = { id: null, name: 'untitled.txt', content: '', modified: false };

          // Toolbar
          const toolbar = createEl('div', { className: 'quill-toolbar' });
          const saveBtn = createEl('button', { className: 'btn btn-sm btn-primary', textContent: 'Save' });
          const saveAsBtn = createEl('button', { className: 'btn btn-sm', textContent: 'Save As…' });
          saveBtn.title = 'Save (Ctrl+S)';
          saveAsBtn.title = 'Save a copy with a new name';
          toolbar.append(saveBtn, saveAsBtn);
          container.appendChild(toolbar);

          // Editor wrapper
          const editorWrap = createEl('div', { className: 'quill-editor-wrap' });

          const gutter = createEl('div', { className: 'quill-gutter', 'aria-hidden': 'true' });

          const textarea = createEl('textarea', {
            className: 'quill-textarea',
            id: 'quill-text-editor',
            name: 'quill-editor',
            spellcheck: 'false',
            'aria-label': 'Text editor',
            role: 'textbox',
            'aria-multiline': 'true'
          });

          editorWrap.appendChild(gutter);
          editorWrap.appendChild(textarea);

          const statusBar = createEl('div', { className: 'quill-statusbar', role: 'status' });

          container.appendChild(editorWrap);
          container.appendChild(statusBar);
          content.appendChild(container);

          // Context menu
          editorWrap.addEventListener('contextmenu', e => {
            e.preventDefault();
            ContextMenu.show(e.clientX, e.clientY, [
              { label: 'Cut', icon: 'scissors', shortcut: 'Ctrl+X', action: () => document.execCommand('cut') },
              { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', action: () => document.execCommand('copy') },
              { label: 'Paste', icon: 'documents', shortcut: 'Ctrl+V', action: () => document.execCommand('paste') },
              { separator: true },
              { label: 'Select All', icon: 'maximize', shortcut: 'Ctrl+A', action: () => document.execCommand('selectAll') },
              { separator: true },
              {
                label: 'Word Count', icon: 'info', action: () => {
                  const words = textarea.value.trim().split(/\s+/).filter(Boolean).length;
                  Notify.show({ title: 'Word Count', body: `${words} words`, type: 'info', appName: 'TextEdit' });
                }
              }]);
          });

          editorWrap.addEventListener('click', e => {
            if (e.target === gutter) textarea.focus();
          });

          function updateGutter() {
            const lines = textarea.value.split('\n').length;
            let html = '';
            for (let i = 1; i <= lines; i++) html += i + '\n';
            gutter.textContent = html;
          }

          function updateStatus() {
            const val = textarea.value;
            const pos = textarea.selectionStart;
            let line = 1, col = 1;
            for (let i = 0; i < pos; i++) { if (val[i] === '\n') { line++; col = 1; } else col++; }
            const words = val.split(/\s+/).filter(Boolean).length;
            statusBar.textContent = `Ln ${line}, Col ${col}  ·  ${words} words`;
          }

          // Save TextEdit files to com.nbosp.quill/files/ (Android-style private app storage)
          function getQuillFilesDir() {
            return AppDirs.getVFSDir('com.nbosp.quill', 'files') || FS.specialFolders.documents;
          }

          async function saveFile() {
            if (file.id) {
              await FS.writeFile(file.id, textarea.value);
              file.modified = false; file.content = textarea.value;
              Notify.show({ title: 'Saved', body: file.name, type: 'success', appName: 'TextEdit' });
            } else {
              const name = await showPrompt('Save As', file.name);
              if (name) {
                const node = await FS.createFile(getQuillFilesDir(), name, textarea.value, 'text/plain');
                file.id = node.id; file.name = name; file.modified = false; file.content = textarea.value;
                renderDesktopIcons();
                Notify.show({ title: 'Saved', body: name, type: 'success', appName: 'TextEdit' });
              }
            }
          }

          saveBtn.addEventListener('click', () => saveFile());
          saveAsBtn.addEventListener('click', async () => {
            const name = await showPrompt('Save As', file.name);
            if (!name) return;
            const node = await FS.createFile(getQuillFilesDir(), name, textarea.value, 'text/plain');
            file.id = node.id; file.name = name; file.modified = false; file.content = textarea.value;
            renderDesktopIcons();
            Notify.show({ title: 'Saved', body: name, type: 'success', appName: 'TextEdit' });
          });

          textarea.addEventListener('input', () => { file.modified = true; updateGutter(); updateStatus(); }, { passive: true });
          textarea.addEventListener('scroll', () => { gutter.scrollTop = textarea.scrollTop; }, { passive: true });
          textarea.addEventListener('click', updateStatus);
          textarea.addEventListener('keyup', updateStatus);

          textarea.addEventListener('keydown', e => {
            if (e.key === 'Tab') {
              e.preventDefault();
              const s = textarea.selectionStart, end = textarea.selectionEnd;
              textarea.value = textarea.value.substring(0, s) + '  ' + textarea.value.substring(end);
              textarea.selectionStart = textarea.selectionEnd = s + 2;
              updateGutter();
            }
            if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveFile(); }
            // Auto-close brackets
            const pairs = { '(': ')', '{': '}', '[': ']', "'": "'", '"': '"', '`': '`' };
            if (pairs[e.key]) {
              const s = textarea.selectionStart, end = textarea.selectionEnd;
              if (s !== end) return;
              e.preventDefault();
              textarea.value = textarea.value.substring(0, s) + e.key + pairs[e.key] + textarea.value.substring(end);
              textarea.selectionStart = textarea.selectionEnd = s + 1;
            }
          });

          // Load file
          if (options?.fileId) {
            const f = FS.files.get(options.fileId);
            if (f) { file.id = f.id; file.name = f.name; file.content = f.content || ''; textarea.value = file.content; }
          }
          updateGutter();
          updateStatus();
          requestAnimationFrame(() => textarea.focus());
        },

        async onDrop(file, state) {
          try {
            const fileId = generateId();
            const fileData = await file.text();
            FS.files.set(fileId, { id: fileId, name: file.name, type: 'text/plain', size: file.size, content: fileData, mimeType: file.type });
            WM.createWindow('quill', { fileId });
            Notify.show({ title: 'File Opened', body: file.name, type: 'success', appName: 'TextEdit' });
          } catch {
            Notify.show({ title: 'Error', body: 'Failed to open file.', type: 'error', appName: 'TextEdit' });
          }
        }
      });


