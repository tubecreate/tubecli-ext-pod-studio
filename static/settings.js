/**
 * Content Studio — Settings Logic
 */
const API = '/api/v1/studio';
let settings = {};

const AGENTS = [
    { id: 'script_rewriter', name: 'Script Rewriter', icon: '✍️' },
    { id: 'extractor', name: 'Character & Scene Extractor', icon: '🔍' },
    { id: 'storyboard_breaker', name: 'Storyboard Breaker', icon: '🎬' },
    { id: 'voice_assigner', name: 'Voice Assigner', icon: '🎙️' },
    { id: 'prompt_generator', name: 'Image Prompt Generator', icon: '🖼️' },
];

document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    loadProviders();
    renderAgentGrid();
});

async function loadSettings() {
    try {
        const resp = await fetch(`${API}/settings`);
        settings = await resp.json();
        populateForm();
    } catch (e) {
        toast('Failed to load settings', 'error');
    }
}

function populateForm() {
    const ai = settings.ai_provider || {};
    // Source
    const source = ai.source || 'global';
    document.querySelectorAll('input[name="aiSource"]').forEach(el => {
        el.checked = el.value === source;
    });
    updateAISource();

    // Cloud
    if (ai.cloud_provider) document.getElementById('cloudProvider').value = ai.cloud_provider;
    if (ai.cloud_model) {
        const select = document.getElementById('cloudModel');
        select.innerHTML = `<option value="${ai.cloud_model}">${ai.cloud_model}</option>`;
        select.value = ai.cloud_model;
    }
    loadCloudModels(true);

    // Ollama
    if (ai.ollama_model) {
        const sel = document.getElementById('ollamaModel');
        const opt = document.createElement('option');
        opt.value = ai.ollama_model;
        opt.textContent = ai.ollama_model;
        sel.innerHTML = '';
        sel.appendChild(opt);
    }

    // Custom
    if (ai.custom_base_url) document.getElementById('customBaseUrl').value = ai.custom_base_url;
    if (ai.custom_api_key) document.getElementById('customApiKey').value = ai.custom_api_key;
    if (ai.custom_model) document.getElementById('customModel').value = ai.custom_model;

    // Temperature
    document.getElementById('temperature').value = ai.temperature || 0.7;
    document.getElementById('tempVal').textContent = ai.temperature || 0.7;
    document.getElementById('maxTokens').value = ai.max_tokens || 8192;

    // Language
    const lang = (settings.script_language || {}).default || 'vi';
    document.getElementById('defaultLanguage').value = lang;

    // Agent configs
    renderAgentGrid();
}

function updateAISource() {
    const source = document.querySelector('input[name="aiSource"]:checked')?.value || 'global';
    document.getElementById('cloudConfig').style.display = source === 'cloud_api' ? '' : 'none';
    document.getElementById('ollamaConfig').style.display = source === 'ollama' ? '' : 'none';
    document.getElementById('customConfig').style.display = source === 'custom' ? '' : 'none';

    if (source === 'ollama') loadOllamaModels();
}

async function loadProviders() {
    try {
        const resp = await fetch(`${API}/settings/ai-providers`);
        const data = await resp.json();
        // Update ollama status
        const ollama = data.providers?.find(p => p.id === 'ollama');
        if (ollama) {
            const el = document.getElementById('ollamaStatus');
            el.textContent = ollama.running ? '🟢 Running' : '🔴 Not running';
            el.className = ollama.running ? 'tag tag-success' : 'tag';
            if (ollama.models?.length) {
                const sel = document.getElementById('ollamaModel');
                sel.innerHTML = ollama.models.map(m =>
                    `<option value="${m}">${m}</option>`
                ).join('');
            }
        }
    } catch (e) {}
}

async function loadOllamaModels() {
    try {
        const resp = await fetch(`${API}/settings/ai-providers`);
        const data = await resp.json();
        const ollama = data.providers?.find(p => p.id === 'ollama');
        if (ollama?.models?.length) {
            const sel = document.getElementById('ollamaModel');
            sel.innerHTML = ollama.models.map(m =>
                `<option value="${m}">${m}</option>`
            ).join('');
        }
    } catch (e) {}
}

let cloudProvidersCache = null;

async function loadCloudModels(keepValue = false) {
    const provider = document.getElementById('cloudProvider').value;
    
    if (!cloudProvidersCache) {
        try {
            const resp = await fetch('/api/v1/cloud-api/providers');
            cloudProvidersCache = await resp.json();
        } catch(e) { }
    }
    
    const select = document.getElementById('cloudModel');
    let currentValue = select.value;
    
    if (cloudProvidersCache && cloudProvidersCache.providers) {
        const pData = cloudProvidersCache.providers.find(p => p.id === provider);
        if (pData && pData.models) {
            select.innerHTML = pData.models.map(m => `<option value="${m}">${m}</option>`).join('');
        }
    }

    if (!keepValue) {
        const models = {
            openai: 'gpt-4o',
            gemini: 'gemini-2.5-flash',
            claude: 'claude-sonnet-4-20250514',
            deepseek: 'deepseek-chat',
            grok: 'grok-2',
            openrouter: 'google/gemini-2.5-flash',
        };
        currentValue = models[provider] || '';
    }
    
    if (currentValue) {
        const exists = Array.from(select.options).some(o => o.value === currentValue);
        if (!exists) {
            select.insertAdjacentHTML('afterbegin', `<option value="${currentValue}">${currentValue}</option>`);
        }
        select.value = currentValue;
    }
}

function renderAgentGrid() {
    const grid = document.getElementById('agentGrid');
    const configs = settings.agent_configs || {};
    grid.innerHTML = AGENTS.map(a => {
        const cfg = configs[a.id] || { enabled: true, temperature: 0.7 };
        return `
            <div class="agent-row">
                <span class="agent-row-icon">${a.icon}</span>
                <span class="agent-row-name">${a.name}</span>
                <div class="toggle-switch ${cfg.enabled ? 'active' : ''}" data-agent="${a.id}" onclick="toggleAgent(this)"></div>
                <input class="input agent-temp-input" type="number" min="0" max="1" step="0.1"
                    value="${cfg.temperature}" data-agent-temp="${a.id}" />
            </div>
        `;
    }).join('');
}

function toggleAgent(el) {
    el.classList.toggle('active');
}

async function saveSettings() {
    const source = document.querySelector('input[name="aiSource"]:checked')?.value || 'global';
    const data = {
        ai_provider: {
            source,
            cloud_provider: document.getElementById('cloudProvider').value,
            cloud_model: document.getElementById('cloudModel').value,
            cloud_key_label: 'default',
            ollama_model: document.getElementById('ollamaModel').value,
            custom_base_url: document.getElementById('customBaseUrl').value,
            custom_api_key: document.getElementById('customApiKey').value,
            custom_model: document.getElementById('customModel').value,
            temperature: parseFloat(document.getElementById('temperature').value) || 0.7,
            max_tokens: parseInt(document.getElementById('maxTokens').value) || 8192,
        },
        script_language: {
            default: document.getElementById('defaultLanguage').value,
        },
        agent_configs: {},
    };

    // Collect agent configs
    AGENTS.forEach(a => {
        const toggle = document.querySelector(`.toggle-switch[data-agent="${a.id}"]`);
        const tempInput = document.querySelector(`[data-agent-temp="${a.id}"]`);
        data.agent_configs[a.id] = {
            enabled: toggle?.classList.contains('active') ?? true,
            temperature: parseFloat(tempInput?.value) || 0.7,
        };
    });

    try {
        await fetch(`${API}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        toast('Settings saved!', 'success');
    } catch (e) {
        toast('Failed to save: ' + e.message, 'error');
    }
}

async function resetDefaults() {
    if (!confirm('Reset all settings to defaults?')) return;
    try {
        // Send empty to trigger defaults
        await fetch(`${API}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ai_provider: { source: 'global', temperature: 0.7, max_tokens: 8192 },
                script_language: { default: 'vi' },
            }),
        });
        toast('Settings reset to defaults', 'success');
        loadSettings();
    } catch (e) {
        toast('Reset failed', 'error');
    }
}

async function testAI() {
    const btn = document.getElementById('btnTestAI');
    const result = document.getElementById('testResult');
    btn.disabled = true;
    result.textContent = 'Testing...';
    result.className = 'test-result';

    // Quick-save first so the test uses current form values
    await saveSettings();

    try {
        const resp = await fetch(`${API}/settings/ai-test`, { method: 'POST' });
        const data = await resp.json();
        result.textContent = data.message || data.status;
        result.className = `test-result ${data.status}`;
    } catch (e) {
        result.textContent = 'Test failed: ' + e.message;
        result.className = 'test-result error';
    } finally {
        btn.disabled = false;
    }
}

function toast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateX(40px)';
        setTimeout(() => el.remove(), 300);
    }, 3000);
}
