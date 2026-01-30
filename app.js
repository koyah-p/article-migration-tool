document.addEventListener('DOMContentLoaded', () => {
    const srcSelect = document.getElementById('src-site');
    const tgtSelect = document.getElementById('tgt-site');
    const btnConvert = document.getElementById('btn-convert');
    const btnCopy = document.getElementById('btn-copy');
    const inputArea = document.getElementById('input-html');
    const outputArea = document.getElementById('output-html');
    const previewArea = document.getElementById('preview-container');
    const statusMsg = document.getElementById('status-msg');

    // Registration UI
    const btnToggleReg = document.getElementById('btn-toggle-reg');
    const regArea = document.getElementById('reg-area');
    const btnRegister = document.getElementById('btn-register');
    const regNameInput = document.getElementById('reg-site-name');
    const regFileInput = document.getElementById('reg-file-upload');
    const siteList = document.getElementById('site-list'); // UL element

    // Tabs
    const tabs = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    let registry = { sites: [] }; // Initial empty structure
    let engine = new MigrationEngine();

    // Load Registry
    fetch('resources/parts_registry.json')
        .then(res => res.json())
        .then(data => {
            // Priority: LocalStorage > JSON Defaults
            if (!loadRegistry()) {
                registry = data;
                saveRegistry(); // Save initial defaults
            }

            updateUI();
            statusMsg.textContent = "準備完了";

            // Set Defaults if nothing selected
            if (findSiteId('mf') && !srcSelect.value) srcSelect.value = 'mf';
            if (findSiteId('mediface') && !tgtSelect.value) tgtSelect.value = 'mediface';
        })
        .catch(err => {
            console.error(err);
            // Even if fetch fails, try storage
            if (loadRegistry()) {
                updateUI();
                statusMsg.textContent = "保存された設定を読み込みました (初期ファイル読込失敗)";
            } else {
                statusMsg.textContent = "設定ファイルの読み込みに失敗しました";
            }
        });

    function findSiteId(id) {
        return registry.sites.find(s => s.id === id);
    }

    function updateUI() {
        populateSelects();
        renderSiteList();
    }

    function populateSelects() {
        // Save current selection
        const currentSrc = srcSelect.value;
        const currentTgt = tgtSelect.value;

        srcSelect.innerHTML = '';
        tgtSelect.innerHTML = '';

        registry.sites.forEach(site => {
            // Use name only? or ID.
            const opt1 = new Option(site.name, site.id);
            const opt2 = new Option(site.name, site.id);
            srcSelect.add(opt1);
            tgtSelect.add(opt2);
        });

        // Restore or Default
        if (currentSrc && findSiteId(currentSrc)) srcSelect.value = currentSrc;
        if (currentTgt && findSiteId(currentTgt)) tgtSelect.value = currentTgt;

        // If nothing selected and items exist
        if (!srcSelect.value && srcSelect.options.length > 0) srcSelect.selectedIndex = 0;
        if (!tgtSelect.value && tgtSelect.options.length > 1) tgtSelect.selectedIndex = 1;
    }

    function renderSiteList() {
        siteList.innerHTML = '';
        registry.sites.forEach(site => {
            const li = document.createElement('li');
            li.style.padding = '8px 10px';
            li.style.borderBottom = '1px solid #f1f5f9';
            li.style.display = 'flex';
            li.style.justifyContent = 'space-between';
            li.style.alignItems = 'center';

            const info = document.createElement('span');
            info.textContent = `${site.name} (${site.parts.length}パーツ)`;
            info.style.fontSize = '0.9rem';

            const delBtn = document.createElement('button');
            delBtn.textContent = '削除';
            delBtn.style.fontSize = '0.75rem';
            delBtn.style.padding = '2px 8px';
            delBtn.style.color = '#ef4444';
            delBtn.style.background = 'transparent';
            delBtn.style.border = '1px solid #ef4444';
            delBtn.style.borderRadius = '4px';
            delBtn.style.cursor = 'pointer';

            delBtn.onclick = () => deleteSite(site.id);

            li.appendChild(info);
            li.appendChild(delBtn);
            siteList.appendChild(li);
        });
    }

    function deleteSite(id) {
        if (!confirm('本当にこのサイト定義を削除しますか？')) return;
        registry.sites = registry.sites.filter(s => s.id !== id);
        saveRegistry(); // Save changes
        updateUI();
    }

    // Persistence
    function saveRegistry() {
        localStorage.setItem('migration_tool_sites', JSON.stringify(registry.sites));
    }

    function loadRegistry() {
        const stored = localStorage.getItem('migration_tool_sites');
        if (stored) {
            try {
                const parsed = JSON.parse(stored);
                // We should merge with defaults? Or just use stored?
                // If we use stored, we might miss updates to the JSON file.
                // Strategy: Load JSON defaults, then merge "Custom" sites from Text?
                // Or simply: If localStorage exists, USE IT ENTIRELY (User has full control).
                // But if user deletes everything, they might want defaults back.
                // Let's Just Append "Custom" ones? No, user might want to delete defaults.
                // Simple: Use Stored.
                registry.sites = parsed;
                return true;
            } catch (e) {
                console.error("Storage parse error", e);
                return false;
            }
        }
        return false;
    }

    // Toggle Registration
    btnToggleReg.addEventListener('click', () => {
        regArea.style.display = regArea.style.display === 'none' ? 'block' : 'none';
    });

    // Register New Site
    btnRegister.addEventListener('click', () => {
        const name = regNameInput.value.trim();
        const file = regFileInput.files[0];

        if (!name) {
            alert("サイト名を入力してください");
            return;
        }
        if (!file) {
            alert("パーツ定義ファイル（.md）を選択してください");
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const content = e.target.result;
                const parts = engine.parseMarkdownParts(content);

                if (parts.length === 0) {
                    alert("有効なパーツ定義が見つかりませんでした。フォーマットを確認してください。");
                    return;
                }

                // Check update or new
                // For simplicity, always create new ID unless we implement explicit 'Update' logic.
                // But user wants "Re-upload". So if name matches, we overwrite?
                // Let's check by name.

                const existingIndex = registry.sites.findIndex(s => s.name === name);

                if (existingIndex !== -1) {
                    if (!confirm(`サイト「${name}」は既に存在します。上書きしますか？`)) return;
                    // Update parts
                    registry.sites[existingIndex].parts = parts;
                    alert(`サイト「${name}」定義を更新しました。(${parts.length}パーツ)`);
                } else {
                    const id = 'custom_' + Date.now();
                    const newSite = {
                        id: id,
                        name: name,
                        parts: parts
                    };
                    registry.sites.push(newSite);
                    alert(`新規サイト「${name}」を追加しました。(${parts.length}パーツ)`);
                }

                saveRegistry(); // Save changes
                updateUI();

                // Clear inputs
                regNameInput.value = '';
                regFileInput.value = '';

            } catch (err) {
                console.error(err);
                alert("ファイルの解析中にエラーが発生しました。");
            }
        };
        reader.readAsText(file);
    });

    // Convert Action
    btnConvert.addEventListener('click', () => {
        if (!registry) return;

        const srcId = srcSelect.value;
        const tgtId = tgtSelect.value;
        const sourceHtml = inputArea.value;

        if (!sourceHtml.trim()) {
            statusMsg.textContent = "HTMLを貼り付けてください";
            return;
        }

        const srcSite = registry.sites.find(s => s.id === srcId);
        const tgtSite = registry.sites.find(s => s.id === tgtId);

        if (!srcSite || !tgtSite) {
            statusMsg.textContent = "サイトが選択されていません";
            return;
        }

        statusMsg.textContent = "変換中...";

        // Run Migration
        try {
            const result = engine.migrate(sourceHtml, srcSite.parts, tgtSite.parts);

            // Update Output
            outputArea.value = result.code;
            previewArea.innerHTML = result.preview;

            statusMsg.textContent = "完了しました";
        } catch (e) {
            console.error(e);
            statusMsg.textContent = "変換中にエラーが発生しました";
        }
    });

    // Copy Action
    btnCopy.addEventListener('click', () => {
        if (!outputArea.value) return;
        navigator.clipboard.writeText(outputArea.value).then(() => {
            const originalText = btnCopy.textContent;
            btnCopy.textContent = "コピーしました！";
            setTimeout(() => btnCopy.textContent = originalText, 2000);
        });
    });

    // Tab Switching
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Remove active
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));

            // Add active
            tab.classList.add('active');
            const targetId = `tab-${tab.dataset.tab}`;
            document.getElementById(targetId).classList.add('active');
        });
    });
});
