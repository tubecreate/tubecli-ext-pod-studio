/**
 * POD Studio — Frontend Logic
 * Handles CRUD, SSE streaming, pipeline steps, and sidebar navigation.
 */

const API = '/api/v1/pod_studio';

// ── State ──────────────────────────────────────────────────
let campaigns = [];
let currentEpisode = null; window._fc_getEpisode = () => currentEpisode;
let currentCampaign = null;   window._fc_getCampaign = () => currentCampaign;
let currentStep = 'raw';
let isStreaming = false;

// ── Step Registry & Pipeline Templates ─────────────────────
const STEP_REGISTRY = {
    raw:        { id: 'raw',        label: 'Raw Content',  icon: '📝', panelId: 'stepRaw' },
    rewrite:    { id: 'rewrite',    label: 'AI Rewrite',   icon: '✍️', panelId: 'stepScript' },
    extract:    { id: 'extract',    label: 'Extract',      icon: '🔍', panelId: 'stepExtract' },
    storyboard: { id: 'storyboard', label: 'Storyboard',   icon: '🎬', panelId: 'stepStoryboard' },
    images:     { id: 'images',     label: 'Images',       icon: '🖼', panelId: 'stepImages' },
    videos:     { id: 'videos',     label: 'AI Video',     icon: '🎞', panelId: 'stepAIVideo' },
    audio:      { id: 'audio',      label: 'Audio TTS',    icon: '🎙', panelId: 'stepAudio' },
    video:      { id: 'video',      label: 'Video',        icon: '🎥', panelId: 'stepVideo' },
    publish:    { id: 'publish',    label: 'Publish',      icon: '🚀', panelId: 'stepPublish' },
};

const PIPELINE_TEMPLATES = {
    campaign_scene:  { label: '🎞 Campaign Cinematic (Raw → Rewrite → Extract → Storyboard → Grok Video → Audio → Video → Publish)', steps: ['raw', 'rewrite', 'extract', 'storyboard', 'videos', 'audio', 'video', 'publish'] },
    campaign_ad:     { label: '🛒 Campaign Ads (Raw → Rewrite → Extract → Video → Publish)', steps: ['raw', 'rewrite', 'extract', 'videos', 'publish'] },
    campaign_full:   { label: '📺 Campaign Slideshow',  steps: ['raw', 'rewrite', 'extract', 'storyboard', 'images', 'audio', 'video', 'publish'] },
    audio_story:  { label: '🎧 Audio Story',      steps: ['raw', 'rewrite', 'audio', 'video'] },
    content_only: { label: '📝 Content Only',     steps: ['raw', 'rewrite'] },
    custom:       { label: '🎬 Custom',           steps: [] },
};

function getCurrentPipeline() {
    if (currentCampaign) {
        try {
            const meta = JSON.parse(currentCampaign.metadata || '{}');
            if (meta.pipeline && Array.isArray(meta.pipeline) && meta.pipeline.length > 0) {
                return meta.pipeline;
            }
        } catch(e) {}
    }
    // Fallback: legacy projects get the old 5-step pipeline
    return ['raw', 'rewrite', 'extract', 'storyboard', 'images'];
}

// ── Init ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    syncPresetsWithServer().then(() => {
        loadCampaigns();
        loadAiModelInfo();
    });
});

// ── API Helpers ────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
    const resp = await fetch(`${API}${path}`, {
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        ...opts,
    });
    if (!resp.ok) {
        const raw = await resp.text();
        let detail = raw;
        try {
            const parsed = JSON.parse(raw);
            detail = parsed.detail || parsed.message || raw;
        } catch(_) {}
        throw new Error(`[${resp.status}] ${detail}`);
    }
    return resp.json();
}

// ── AI Model Info ──────────────────────────────────────────
async function loadAiModelInfo() {
    const label = document.getElementById('aiModelLabel');
    const dot = document.getElementById('aiModelDot');
    const badge = document.getElementById('aiModelBadge');
    if (!label || !dot) return;

    try {
        const info = await apiFetch('/settings/ai-info');

        if (!info.has_key || !info.model || info.model === '(not configured)') {
            // RED: No API key configured
            dot.style.background = '#ef4444';
            label.textContent = 'AI chưa cấu hình';
            label.style.color = '#ef4444';
            badge.title = 'Chưa có API Key — vào Settings để cấu hình';
            return;
        }

        // Show model name immediately with yellow (checking...)
        label.textContent = info.model;
        dot.style.background = '#eab308'; // yellow = checking
        badge.title = `Đang kiểm tra kết nối... | ${info.source} | ${info.base_url_host}`;

        // Run health check in background
        try {
            const test = await apiFetch('/settings/ai-test', { method: 'POST' });
            if (test.status === 'success') {
                // GREEN: AI is working
                dot.style.background = '#22c55e';
                badge.title = `✅ Hoạt động tốt | ${info.model} | ${info.source} | ${info.base_url_host}`;
            } else {
                // YELLOW: Key exists but test returned error (quota, wrong model, etc.)
                dot.style.background = '#eab308';
                label.style.color = '#eab308';
                badge.title = `⚠️ ${test.message || 'AI test failed'} | ${info.model}`;
            }
        } catch (testErr) {
            // YELLOW: couldn't reach test endpoint
            dot.style.background = '#eab308';
            badge.title = `⚠️ Không thể kiểm tra AI: ${testErr.message}`;
        }
    } catch (e) {
        // RED: API endpoint unreachable
        dot.style.background = '#ef4444';
        label.textContent = 'Lỗi tải AI';
        label.style.color = '#ef4444';
        badge.title = `❌ ${e.message}`;
    }
}

// ── Campaign CRUD ─────────────────────────────────────────────
async function loadCampaigns() {
    try {
        const data = await apiFetch('/campaigns');
        campaigns = data.items || [];
        renderSidebar();
        document.getElementById('projectCount').textContent = `${campaigns.length} projects`;
        if (!campaigns.length) {
            showWelcome();
        }
    } catch (e) {
        toast('Failed to load projects', 'error');
    }
}

window.showCreateCampaign = function() {
    document.getElementById('wizardModal').style.display = 'flex';
    document.getElementById('wizStep1').style.display = '';
    document.getElementById('wizStep2').style.display = 'none';
    document.getElementById('wizStep3').style.display = 'none';
    document.getElementById('wizStepProgress').style.display = 'none';
    
    // Update Stepper
    document.getElementById('wizInd1').className = 'wiz-step active';
    document.getElementById('wizInd2').className = 'wiz-step';
    document.getElementById('wizInd3').className = 'wiz-step';
    document.getElementById('wizLine1').className = 'wiz-step-line';
    document.getElementById('wizLine2').className = 'wiz-step-line';

    // Clear out setup
    document.getElementById('wizTitle').value = '';
    document.getElementById('wizPremise').value = '';
    document.getElementById('wizOutlineReview').textContent = '';

    // Load presets dropdown
    loadWizPresets();
    
    // Load Product & Model Gallery categories into the dropdown FIRST,
    // THEN restore last-used config (order matters — gallery options must exist before restore)
    loadWizGalleryCategories().then(() => {
        restoreLastWizConfig();
    });

    document.getElementById('wizTitle').focus();
}

function hideWizard() {
    document.getElementById('wizardModal').style.display = 'none';
    if (apPollingInterval) {
        clearInterval(apPollingInterval);
        apPollingInterval = null;
    }
}

function wizGoToStep2(e) {
    e.preventDefault();
    const title = document.getElementById('wizTitle').value.trim();
    if (!title) return;
    document.getElementById('wizStep1').style.display = 'none';
    document.getElementById('wizStep2').style.display = '';
    
    // Update Stepper
    document.getElementById('wizInd1').className = 'wiz-step done';
    document.getElementById('wizInd2').className = 'wiz-step active';
    document.getElementById('wizLine1').className = 'wiz-step-line active';
    
    document.getElementById('wizPremise').focus();
    updateWizPremiseCount();
}

function wizGoToStep1() {
    document.getElementById('wizStep1').style.display = '';
    document.getElementById('wizStep2').style.display = 'none';
    
    // Update Stepper
    document.getElementById('wizInd1').className = 'wiz-step active';
    document.getElementById('wizInd2').className = 'wiz-step';
    document.getElementById('wizLine1').className = 'wiz-step-line';
}

function toggleCustomStyleInput(selectId, inputId) {
    const sel = document.getElementById(selectId);
    const inp = document.getElementById(inputId);
    if (!sel || !inp) return;
    if (sel.value === '__custom__') {
        inp.style.display = '';
        inp.focus();
    } else {
        inp.style.display = 'none';
        inp.value = '';
    }
}

// ── Wizard Preset System ──────────────────────────────────
const WIZ_PRESETS_KEY = 'studio_wiz_presets';
const WIZ_LAST_KEY = 'studio_wiz_last';

const WIZ_FIELD_IDS = [
    'wizContentFormat', 'wizEpisodes', 'wizStyle', 'wizStyleCustom',
    'wizCharacterStyle', 'wizCharStyleCustom', 'wizCameraAngle',
    'wizEthnicity', 'wizPromptFocus', 'wizAspectRatio',
    'wizNarrationSource', 'wizLanguage', 'wizPipelineTemplate',
    'wizGalleryCategory', 'wizNoTextPrompt', 'wizVideoLength'
];
const WIZ_CHECKBOX_IDS = [];

function _getWizValues() {
    const data = {};
    for (const id of WIZ_FIELD_IDS) {
        const el = document.getElementById(id);
        if (el) data[id] = el.value;
    }
    for (const id of WIZ_CHECKBOX_IDS) {
        const el = document.getElementById(id);
        if (el) data[id] = el.checked;
    }
    return data;
}

function _setWizValues(data) {
    if (!data) return;
    for (const id of WIZ_FIELD_IDS) {
        const el = document.getElementById(id);
        if (el && data[id] !== undefined) {
            let val = data[id];
            // Backward compat: old presets stored wizNoTextPrompt as boolean
            if (id === 'wizNoTextPrompt' && typeof val === 'boolean') {
                val = val ? 'notext' : 'none';
            }
            el.value = val;
            // Show custom input if needed
            if (id === 'wizStyle' && val === '__custom__') toggleCustomStyleInput('wizStyle', 'wizStyleCustom');
            if (id === 'wizCharacterStyle' && val === '__custom__') toggleCustomStyleInput('wizCharacterStyle', 'wizCharStyleCustom');
        }
    }
    for (const id of WIZ_CHECKBOX_IDS) {
        const el = document.getElementById(id);
        if (el && data[id] !== undefined) el.checked = data[id];
    }
}

async function syncPresetsWithServer() {
    try {
        const res = await apiFetch('/presets', { method: 'GET' });
        if (res && res.success && res.presets) {
            let localPresets = _getPresets();
            let changed = false;
            let hasLocalOnly = false;
            
            // Merge server presets into local
            for (const [name, data] of Object.entries(res.presets)) {
                if (!localPresets[name]) {
                    localPresets[name] = data;
                    changed = true;
                }
            }
            // Check for local-only presets to upload
            for (const name of Object.keys(localPresets)) {
                if (!res.presets[name]) {
                    hasLocalOnly = true;
                }
            }
            if (changed) {
                localStorage.setItem(WIZ_PRESETS_KEY, JSON.stringify(localPresets));
            }
            if (hasLocalOnly) {
                apiFetch('/presets', {
                    method: 'POST',
                    body: JSON.stringify({ presets: localPresets })
                }).catch(()=>{});
            }
        }
    } catch (e) {
        console.error("Failed to sync presets", e);
    }
}

function _getPresets() {
    try { return JSON.parse(localStorage.getItem(WIZ_PRESETS_KEY) || '{}'); }
    catch { return {}; }
}

function _savePresets(presets, singleName = null, singleData = null) {
    localStorage.setItem(WIZ_PRESETS_KEY, JSON.stringify(presets));
    // Also save to server silently
    const payload = singleName ? { name: singleName, data: singleData } : { presets: presets };
    apiFetch('/presets', {
        method: 'POST',
        body: JSON.stringify(payload)
    }).catch(()=>{});
}

function loadWizPresets() {
    const sel = document.getElementById('wizPresetSelect');
    if (!sel) return;
    const presets = _getPresets();
    // Keep default option, clear rest
    sel.innerHTML = '<option value="">-- Mặc định --</option>';
    for (const name of Object.keys(presets).sort()) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
    }
}

function saveWizPreset() {
    const name = prompt('Đặt tên cho preset này:');
    if (!name || !name.trim()) return;
    const presets = _getPresets();
    const data = _getWizValues();
    presets[name.trim()] = data;
    _savePresets(presets, name.trim(), data);
    loadWizPresets();
    document.getElementById('wizPresetSelect').value = name.trim();
    toast(`💾 Preset "${name.trim()}" đã lưu!`, 'success');
}

function applyWizPreset() {
    const sel = document.getElementById('wizPresetSelect');
    if (!sel || !sel.value) return;
    const presets = _getPresets();
    const data = presets[sel.value];
    if (data) {
        _setWizValues(data);
        toast(`⚡ Đã áp dụng preset "${sel.value}"`, 'success');
    }
}

function deleteWizPreset() {
    const sel = document.getElementById('wizPresetSelect');
    if (!sel || !sel.value) { toast('Chọn preset cần xóa', 'info'); return; }
    if (!confirm(`Xóa preset "${sel.value}"?`)) return;
    const presets = _getPresets();
    const nameToDelete = sel.value;
    delete presets[nameToDelete];
    localStorage.setItem(WIZ_PRESETS_KEY, JSON.stringify(presets));
    apiFetch(`/presets/${encodeURIComponent(nameToDelete)}`, { method: 'DELETE' }).catch(()=>{});
    loadWizPresets();
    toast('🗑 Preset đã xóa', 'success');
}

function saveLastWizConfig() {
    localStorage.setItem(WIZ_LAST_KEY, JSON.stringify(_getWizValues()));
}

function restoreLastWizConfig() {
    try {
        const data = JSON.parse(localStorage.getItem(WIZ_LAST_KEY) || 'null');
        if (data) _setWizValues(data);
    } catch {}
}

async function wizSkipToManual() {
    const campaign = await _createCampaignFromWiz();
    if (campaign) {
        hideWizard();
        toast('Project created! Welcome to manual mode.', 'success');
        await loadCampaigns();
        await selectCampaign(campaign.id);
    }
}

async function _createCampaignFromWiz() {
    const title = document.getElementById('wizTitle').value.trim();
    const vStyleSel = document.getElementById('wizStyle').value;
    const cStyleSel = document.getElementById('wizCharacterStyle').value;
    const vStyle = vStyleSel === '__custom__' ? (document.getElementById('wizStyleCustom')?.value.trim() || 'Default') : vStyleSel;
    const cStyle = cStyleSel === '__custom__' ? (document.getElementById('wizCharStyleCustom')?.value.trim() || 'Default') : cStyleSel;
    const finalStyle = `Visual Style: ${vStyle} | Model/Product Style: ${cStyle}`;
    
    const metadata = {};
    
    // Save pipeline config
    const pipeline = getWizPipeline();
    metadata.pipeline = pipeline;
    metadata.pipeline_template = document.getElementById('wizPipelineTemplate').value;
    metadata.camera_angle = document.getElementById('wizCameraAngle').value;
    metadata.ethnicity = document.getElementById('wizEthnicity').value;
    metadata.prompt_focus = document.getElementById('wizPromptFocus').value;
    metadata.aspect_ratio = document.getElementById('wizAspectRatio').value;
    metadata.content_format = document.getElementById('wizContentFormat').value;
    metadata.narration_source = document.getElementById('wizNarrationSource').value;
    metadata.text_in_video = document.getElementById('wizNoTextPrompt')?.value || 'notext';
    metadata.video_length = document.getElementById('wizVideoLength')?.value || 'standard';
    metadata.scene_gen_mode = document.getElementById('wizSceneGenMode')?.value || 'per_shot';
    metadata.image_engine = document.getElementById('wizImageEngine')?.value || 'grok';
    metadata.image_browser_profile = document.getElementById('wizImageBrowserProfile')?.value || '';
    
    const galleryCatId = document.getElementById('wizGalleryCategory').value;
    if (galleryCatId) {
        metadata.gallery_category_id = parseInt(galleryCatId);
    }
    
    // Save TTS voice config
    const voiceSelect = document.getElementById('wizVoiceProfileExec');
    if (voiceSelect && voiceSelect.value) {
        const opt = voiceSelect.selectedOptions[0];
        metadata.tts_voice = voiceSelect.value;
        metadata.tts_engine = opt?.dataset?.engine || 'edge';
    }

    // Save upload targets from wizard
    const wizUploadTargets = [];
    const wizYtVal = document.getElementById('wizYtChannel')?.value;
    if (wizYtVal) try { wizUploadTargets.push(JSON.parse(wizYtVal)); } catch(e) {}
    const wizFbVal = document.getElementById('wizFbPage')?.value;
    if (wizFbVal) try { wizUploadTargets.push(JSON.parse(wizFbVal)); } catch(e) {}
    if (wizUploadTargets.length > 0) {
        metadata.upload_targets = wizUploadTargets;
        metadata.upload_privacy = document.getElementById('wizUploadPrivacy')?.value || 'private';
    }

    // Save last used config to localStorage for next time
    saveLastWizConfig();

    try {
        return await apiFetch('/campaigns', {
            method: 'POST',
            body: JSON.stringify({
                title: title,
                total_episodes: parseInt(document.getElementById('wizEpisodes').value) || 0,
                style: finalStyle,
                language: document.getElementById('wizLanguage').value,
                metadata: metadata,
            }),
        });
    } catch (e) {
        toast('Failed to create project', 'error');
        return null;
    }
}

function wizUpdatePipelinePreview() {
    const tpl = document.getElementById('wizPipelineTemplate').value;
    document.getElementById('wizCustomSteps').style.display = tpl === 'custom' ? '' : 'none';
}

function getWizPipeline() {
    const tpl = document.getElementById('wizPipelineTemplate').value;
    if (tpl !== 'custom' && PIPELINE_TEMPLATES[tpl]) {
        return PIPELINE_TEMPLATES[tpl].steps;
    }
    // Custom: collect checked steps
    const steps = ['raw']; // raw is always included
    document.querySelectorAll('.wizCustomCheck:checked').forEach(cb => {
        steps.push(cb.value);
    });
    return steps;
}

// Global reference for generating outline
let pendingAutoPilotCampaignId = null;

async function wizFetchYoutube() {
    const url = document.getElementById('wizYoutubeUrl').value.trim();
    if (!url) {
        toast("Please enter a YouTube URL", "error");
        return;
    }
    const btn = document.querySelector('button[onclick="wizFetchYoutube()"]');
    const oldText = btn.innerHTML;
    btn.innerHTML = "Fetching...";
    btn.disabled = true;
    try {
        const payload = {
            url: url,
        };
        const res = await fetch("/api/v1/subtitle/extract/youtube", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success && data.subtitles) {
            const text = data.subtitles.map(s => s.text).join("\n");
            document.getElementById('wizPremise').value = text;
            updateWizPremiseCount();
            const langInfo = data.original_language ? ` (${data.original_language})` : '';
            const titleInfo = data.title ? ` — ${data.title.substring(0, 40)}` : '';
            toast(`✅ ${data.count} subtitles fetched${langInfo}${titleInfo}`, "success");
        } else {
            toast(data.message || data.detail || "Failed to fetch YouTube subtitles", "error");
        }
    } catch (e) {
        toast("Error connecting to subtitle service: " + e.message, "error");
    } finally {
        btn.innerHTML = oldText;
        btn.disabled = false;
    }
}

const WIZ_PREMISE_LIMIT = 2000;

function updateWizPremiseCount() {
    const ta = document.getElementById('wizPremise');
    const len = ta.value.length;
    const countEl = document.getElementById('wizPremiseCount');
    const warnEl = document.getElementById('wizPremiseWarning');
    const trimBtn = document.getElementById('wizPremiseTrimBtn');
    const lenSpan = document.getElementById('wizPremiseLen');

    if (countEl) countEl.textContent = `${len.toLocaleString()} chars`;
    const tooLong = len > WIZ_PREMISE_LIMIT;
    if (warnEl) warnEl.style.display = tooLong ? '' : 'none';
    if (trimBtn) trimBtn.style.display = tooLong ? '' : 'none';
    if (lenSpan) lenSpan.textContent = len.toLocaleString();
    if (countEl) countEl.style.color = tooLong ? '#fbbf24' : '';
}

function trimWizPremise() {
    const ta = document.getElementById('wizPremise');
    if (ta && ta.value.length > WIZ_PREMISE_LIMIT) {
        ta.value = ta.value.substring(0, WIZ_PREMISE_LIMIT);
        updateWizPremiseCount();
        toast(`✂️ Đã cắt còn ${WIZ_PREMISE_LIMIT} ký tự`, 'info');
    }
}

async function wizGenerateOutline() {
    let premise = document.getElementById('wizPremise').value.trim();
    
    // If premise is empty, auto-generate from gallery items + campaign settings
    if (!premise) {
        const galleryId = document.getElementById('wizGalleryCategory')?.value;
        if (!galleryId) {
            toast("Nhập kịch bản hoặc thêm sản phẩm vào Gallery trước", "error");
            return;
        }
        try {
            const galleryRes = await apiFetch(`/gallery/items?category_id=${galleryId}`);
            const galleryItems = galleryRes?.items || [];
            if (galleryItems.length === 0) {
                toast("Gallery trống — thêm sản phẩm/model trước hoặc nhập kịch bản", "error");
                return;
            }
            // Build auto-premise from gallery
            const format = document.getElementById('wizContentFormat')?.value || 'Quảng cáo';
            const ethnicity = document.getElementById('wizEthnicity')?.value || 'Default';
            const aspect = document.getElementById('wizAspectRatio')?.value || '9:16';
            const language = document.getElementById('wizLanguage')?.value || 'Tiếng Việt';
            
            let productLines = [];
            let modelLines = [];
            for (const gi of galleryItems) {
                const isPrimary = gi.is_primary ? ' ⭐ (SẢN PHẨM CHÍNH)' : '';
                const desc = gi.appearance || gi.description || '';
                const fabric = gi.fabric_material ? `, Chất liệu: ${gi.fabric_material}` : '';
                const acc = gi.accessory_material ? `, Phụ kiện: ${gi.accessory_material}` : '';
                if (gi.role_type === 'presenter' || gi.char_type === 'individual') {
                    modelLines.push(`- Model: ${gi.name} (${gi.gender || ''}, ${gi.age_range || ''}). ${desc}`);
                } else {
                    productLines.push(`- Sản phẩm${isPrimary}: ${gi.name}. ${desc}${fabric}${acc}`);
                }
            }
            
            const ethDesc = ethnicity !== 'Default' ? `\nDân tộc nhân vật: ${ethnicity}` : '';
            premise = `Tự động tạo kịch bản video ${format} tối ưu cho các sản phẩm/model sau:\n\n` +
                (productLines.length ? `SẢN PHẨM:\n${productLines.join('\n')}\n\n` : '') +
                (modelLines.length ? `MODEL:\n${modelLines.join('\n')}\n\n` : '') +
                `Định dạng: ${format}\nTỉ lệ video: ${aspect}\nNgôn ngữ: ${language}${ethDesc}\n\n` +
                `Yêu cầu: Tạo kịch bản quảng cáo hấp dẫn, tối ưu cho sản phẩm trên. ` +
                `Tập trung vào sản phẩm chính (⭐). Kịch bản ngắn gọn, phù hợp video ngắn.`;
            
            toast("🤖 Tự động tạo kịch bản từ Gallery...", "info");
        } catch(e) {
            toast("Lỗi đọc Gallery: " + e.message, "error");
            return;
        }
    }

    // Clear any previous error
    let errBox = document.getElementById('wizOutlineError');
    if (errBox) errBox.remove();

    const btn = document.querySelector('#wizStep2 .btn-primary');
    const oldHtml = btn.innerHTML;
    btn.innerHTML = 'Creating Project...';
    btn.disabled = true;

    toast("Creating project and generating outline...", "info");
    
    // Create campaign first so we have an ID
    const campaign = await _createCampaignFromWiz();
    if (!campaign) {
        btn.innerHTML = oldHtml;
        btn.disabled = false;
        return;
    }
    pendingAutoPilotCampaignId = campaign.id;
    
    const rawCount = parseInt(document.getElementById('wizEpisodes').value);
    const count = isNaN(rawCount) ? 1 : rawCount;
    
    btn.innerHTML = 'Generating Outline...';

    try {
        const res = await apiFetch(`/campaigns/${campaign.id}/generate-outline`, {
            method: 'POST',
            body: JSON.stringify({ premise, episode_count: count })
        });
        
        document.getElementById('wizStep2').style.display = 'none';
        document.getElementById('wizStep3').style.display = '';
        
        // Load browser profiles into chip selector for new project
        _loadBrowserProfilesIntoSelect('wizBrowserProfileExec').then(() => {
            _initChipsFromSaved();
        });

        
        // Voice profile loading and display logic
        const pSteps = getWizPipeline();
        const vWrap = document.getElementById('wizVoiceProfileWrap');
        if (vWrap) {
            if (pSteps.includes('audio') || pSteps.includes('videos')) {
                vWrap.style.display = 'flex';
                // Also update the browser profile label if videos included
                if (pSteps.includes('videos')) {
                    const bpLabel = document.querySelector('label.field span.field-label:not(#wizVoiceProfileWrap span)');
                    if (bpLabel && bpLabel.textContent.includes('Browser')) {
                        bpLabel.textContent = _getVideoEngine() === 'veo3' ? '🌐 Browser Profile (Veo3 AI Gen)' : '🌐 Browser Profile (Grok AI Gen)';
                    }
                }
                const targetLan = document.getElementById('wizLanguage') ? document.getElementById('wizLanguage').value : null;
                _loadVoiceProfilesIntoSelect('wizVoiceProfileExec', targetLan);
            } else {
                vWrap.style.display = 'none';
            }
        }
        
        // Update Stepper
        document.getElementById('wizInd2').className = 'wiz-step done';
        document.getElementById('wizInd3').className = 'wiz-step active';
        document.getElementById('wizLine2').className = 'wiz-step-line active';
        
        document.getElementById('wizOutlineTitle').textContent = res.outline.series_title || "Proposed Episodes";
        
        let outlineHtml = '';
        if (res.outline && res.outline.episodes) {
            res.outline.episodes.forEach((ep) => {
                outlineHtml += `
                    <div style="background:var(--bg-2); border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:10px;">
                        <h4 style="margin:0 0 5px 0; color:var(--accent);">Episode ${ep.episode_number}: ${esc(ep.title)}</h4>
                        <p style="margin:0; font-size:13px; color:var(--text-2); line-height:1.4;">${esc(ep.plot_outline)}</p>
                    </div>
                `;
            });
        }
        document.getElementById('wizOutlineReview').innerHTML = outlineHtml;
    } catch (e) {
        // Show full error details inline in wizard (doesn't disappear)
        let errMsg = e.message || String(e);
        // Try to extract backend detail from JSON error body
        try {
            const match = errMsg.match(/\{.*\}/s);
            if (match) {
                const parsed = JSON.parse(match[0]);
                errMsg = parsed.detail || parsed.message || errMsg;
            }
        } catch(_) {}
        
        const errDiv = document.createElement('div');
        errDiv.id = 'wizOutlineError';
        errDiv.style.cssText = 'margin-top:14px; background:#2d1515; border:1px solid #7f1d1d; border-radius:6px; padding:12px; color:#fca5a5; font-size:12px; font-family:var(--font-mono); white-space:pre-wrap; max-height:150px; overflow-y:auto;';
        errDiv.textContent = '❌ Error: ' + errMsg;
        btn.parentNode.insertBefore(errDiv, btn.nextSibling);
        
        toast("Outline generation failed — see error below", "error");
    } finally {
        btn.innerHTML = oldHtml;
        btn.disabled = false;
    }
}

function customConfirm(title, message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirmModal');
        document.getElementById('confirmModalTitle').textContent = title || 'Xác nhận';
        document.getElementById('confirmModalMessage').textContent = message || 'Bạn có chắc chắn không?';
        modal.style.display = 'flex';

        const btnCancel = document.getElementById('confirmModalCancel');
        const btnOk = document.getElementById('confirmModalOK');

        function cleanup() {
            modal.style.display = 'none';
            btnCancel.onclick = null;
            btnOk.onclick = null;
        }

        btnCancel.onclick = () => { cleanup(); resolve(false); };
        btnOk.onclick = () => { cleanup(); resolve(true); };
    });
}

async function deleteCampaign(campaignId, event) {
    if (event) event.stopPropagation();
    
    const confirmed = await customConfirm('⚠️ Xác nhận xoá', 'Delete this project? This cannot be undone.');
    if (!confirmed) return;
    
    try {
        await apiFetch(`/campaigns/${campaignId}`, { method: 'DELETE' });
        toast('Project deleted', 'success');
        if (currentCampaign && currentCampaign.id === campaignId) {
            currentCampaign = null;
            currentEpisode = null;
            showWelcome();
        }
        await loadCampaigns();
    } catch (e) {
        toast('Failed to delete: ' + e.message, 'error');
    }
}

async function selectCampaign(campaignId) {
    try {
        // Close Pipeline Queue view if open
        _closePipelineView();

        currentCampaign = await apiFetch(`/campaigns/${campaignId}`);
        renderSidebar();
        // Auto-select first episode or create one
        if (currentCampaign.episodes && currentCampaign.episodes.length) {
            await selectEpisode(currentCampaign.episodes[0].id);
        } else {
            await addEpisode(campaignId);
        }
    } catch (e) {
        toast('Failed to load project', 'error');
    }
}

// ── Episode CRUD ───────────────────────────────────────────
async function addEpisode(campaignId) {
    try {
        const ep = await apiFetch(`/campaigns/${campaignId}/episodes`, {
            method: 'POST',
            body: JSON.stringify({}),
        });
        if (currentCampaign) {
            currentCampaign.episodes = currentCampaign.episodes || [];
            currentCampaign.episodes.push(ep);
        }
        // Also update the global campaigns array so renderSidebar shows the new episode
        const campaignInList = campaigns.find(d => d.id == campaignId);
        if (campaignInList) {
            campaignInList.episodes = campaignInList.episodes || [];
            campaignInList.episodes.push(ep);
        }
        await selectEpisode(ep.id);
        renderSidebar();
    } catch (e) {
        toast('Failed to create episode', 'error');
    }
}

async function selectEpisode(episodeId) {
    try {
        // Close Pipeline Queue view if open
        _closePipelineView();

        currentEpisode = await apiFetch(`/episodes/${episodeId}`);
        showEditor();
        renderSidebar();
        
        // Lazy: characters, scenes, storyboards will load when user clicks their tab
        // (see setStep → loadEpisodeImages, loadEpisodeVideos, etc.)
        
        // Pre-cache extract data in background (lightweight, no render)
        if (currentCampaign && !window.currentCampaignCharacters) {
            Promise.all([
                apiFetch(`/campaigns/${currentCampaign.id}/characters`),
                apiFetch(`/campaigns/${currentCampaign.id}/scenes`)
            ]).then(([charRes, sceneRes]) => {
                window.currentCampaignCharacters = charRes.items || [];
                window.currentCampaignScenes = sceneRes.items || [];
            }).catch(() => {});
        }

    } catch (e) {
        toast('Failed to load episode', 'error');
    }
}

async function saveCurrentEpisode() {
    if (!currentEpisode) return;
    try {
        const rawEl = document.getElementById('rawTextarea');
        const scriptEl = document.getElementById('scriptTextarea');
        const data = {};
        if (rawEl) data.content = rawEl.value;
        if (scriptEl && scriptEl.style.display !== 'none') data.script_content = scriptEl.value;
        currentEpisode = await apiFetch(`/episodes/${currentEpisode.id}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
        toast('Saved!', 'success');
    } catch (e) {
        toast('Failed to save', 'error');
    }
}

// ── Sidebar Rendering ──────────────────────────────────────
function renderSidebar() {
    const list = document.getElementById('sidebarList');
    if (!campaigns.length) {
        list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-3);font-size:12px">No projects yet</div>';
        return;
    }
    list.innerHTML = campaigns.map(d => {
        const isActive = currentCampaign && currentCampaign.id === d.id;
        // For the active project, use currentCampaign (which has full episodes list)
        // For others, use lightweight data (only episode_count)
        const eps = isActive && currentCampaign.episodes ? currentCampaign.episodes : [];
        const epCount = isActive ? eps.length : (d.episode_count || d.episodes?.length || 0);
        return `
            <div class="sidebar-project">
                <div class="sidebar-project-head ${isActive ? 'active' : ''}" onclick="selectCampaign(${d.id})">
                    <span class="project-icon">🎬</span>
                    <span class="project-name">${esc(d.title)}</span>
                    <span class="project-ep-count">${epCount}</span>
                    <button class="sidebar-delete-btn" onclick="deleteCampaign(${d.id}, event)" title="Delete">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
                    </button>
                </div>
                ${isActive ? `
                    <div class="sidebar-episodes">
                        ${eps.map(ep => {
                            const epActive = currentEpisode && currentEpisode.id === ep.id;
                            const hasScript = ep.script_content || ep.scriptContent;
                            const meta = typeof ep.metadata === 'string' ? JSON.parse(ep.metadata || '{}') : (ep.metadata || {});
                            const isExtracted = meta.extract_completed;
                            return `
                                <div class="sidebar-episode ${epActive ? 'active' : ''} ${hasScript ? 'has-script' : ''}" onclick="selectEpisode(${ep.id})">
                                    <span class="ep-dot ${isExtracted ? 'extracted' : ''}"></span>
                                    <span>Ep ${ep.episode_number || ep.episodeNumber || '?'}</span>
                                </div>
                            `;
                        }).join('')}
                        <div class="sidebar-add-ep" onclick="addEpisode(${d.id})">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            Add Episode
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
}

// ── Editor ─────────────────────────────────────────────────
function showWelcome() {
    document.getElementById('welcomeState').style.display = '';
    document.getElementById('editorState').style.display = 'none';
    
    // Ensure mainPanel is visible and other tabs are hidden
    document.getElementById('mainPanel').style.display = 'flex';
    const pipelineView = document.getElementById('pipelineView');
    const galleryView = document.getElementById('galleryView');
    if (pipelineView) pipelineView.style.display = 'none';
    if (galleryView) galleryView.style.display = 'none';
}

function showEditor() {
    document.getElementById('welcomeState').style.display = 'none';
    document.getElementById('editorState').style.display = '';
    
    // Ensure mainPanel is visible and other tabs are hidden
    document.getElementById('mainPanel').style.display = 'flex';
    const pipelineView = document.getElementById('pipelineView');
    const galleryView = document.getElementById('galleryView');
    if (pipelineView) pipelineView.style.display = 'none';
    if (galleryView) galleryView.style.display = 'none';

    // Populate header
    document.getElementById('editorTitle').textContent = currentCampaign?.title || 'Untitled';
    document.getElementById('editorChip').textContent = `Episode ${currentEpisode?.episode_number || '?'}`;
    document.getElementById('metaChars').textContent = `${(currentCampaign?.characters || []).length} characters`;
    document.getElementById('metaScenes').textContent = `${(currentCampaign?.scenes || []).length} scenes`;
    // ── Refresh header counters from actual DB ──
    if (currentCampaign) {
        Promise.all([
            apiFetch(`/campaigns/${currentCampaign.id}/characters`),
            apiFetch(`/campaigns/${currentCampaign.id}/scenes`)
        ]).then(([charRes, sceneRes]) => {
            document.getElementById('metaChars').textContent = `${(charRes.items || []).length} characters`;
            document.getElementById('metaScenes').textContent = `${(sceneRes.items || []).length} scenes`;
        }).catch(() => {});
    }

    // Populate textarea
    const rawEl = document.getElementById('rawTextarea');
    rawEl.value = currentEpisode?.content || '';
    updateRawCount();

    // Check if audio exists
    const audioContainer = document.getElementById('rawAudioPlayerContainer');
    const audioPlayer = document.getElementById('rawAudioPlayer');
    const audioDownload = document.getElementById('rawAudioDownload');
    
    if (currentEpisode && currentEpisode.audio_url) {
        audioPlayer.src = currentEpisode.audio_url;
        audioDownload.href = currentEpisode.audio_url;
        audioContainer.style.display = 'flex';
    } else {
        audioContainer.style.display = 'none';
        audioPlayer.src = "";
        audioDownload.href = "";
    }

    const scriptEl = document.getElementById('scriptTextarea');
    const scriptContent = currentEpisode?.script_content || '';
    scriptEl.value = scriptContent;

    // Show/hide script empty state
    updateScriptUI(scriptContent);

    // Render dynamic pipeline tabs for this campaign
    renderPipelineNav();
    setStep('raw');
}

function goBack() {
    currentEpisode = null;
    currentCampaign = null;
    showWelcome();
    renderSidebar();
}

// ── Pipeline Steps ─────────────────────────────────────────
function renderPipelineNav() {
    const nav = document.getElementById('pipelineNav');
    if (!nav) return;
    const pipeline = getCurrentPipeline();
    nav.innerHTML = '';
    pipeline.forEach((stepId, idx) => {
        const reg = STEP_REGISTRY[stepId];
        if (!reg) return;
        const btn = document.createElement('button');
        btn.className = 'pipe-step' + (stepId === currentStep ? ' active' : '');
        btn.dataset.step = stepId;
        btn.onclick = () => setStep(stepId);
        btn.innerHTML = `<span class="pipe-num">${String(idx + 1).padStart(2, '0')}</span><span class="pipe-label">${reg.icon} ${reg.label}</span>`;
        nav.appendChild(btn);
    });
}

function setStep(step) {
    currentStep = step;
    const pipeline = getCurrentPipeline();

    // Update nav highlights
    document.querySelectorAll('.pipe-step').forEach(el => {
        el.classList.toggle('active', el.dataset.step === step);
    });

    // Show/hide all known panels
    for (const [key, reg] of Object.entries(STEP_REGISTRY)) {
        const el = document.getElementById(reg.panelId);
        if (el) el.style.display = key === step ? 'flex' : 'none';
    }

    // Step-specific triggers (lazy load)
    if (step === 'extract') loadExtractData();
    if (step === 'storyboard') loadStoryboardData();
    if (step === 'images') loadEpisodeImages();
    if (step === 'videos') loadEpisodeVideos();
    if (step === 'audio') loadEpisodeAudio();
    if (step === 'video') loadEpisodeVideo();
    if (step === 'publish') loadPublishData();
}

// ── Lazy Tab Loaders ───────────────────────────────────────
async function loadExtractData() {
    if (!currentCampaign || !currentEpisode) return;
    try {
        const [charRes, sceneRes] = await Promise.all([
            apiFetch(`/campaigns/${currentCampaign.id}/characters`),
            apiFetch(`/campaigns/${currentCampaign.id}/scenes`)
        ]);
        const characters = window.currentCampaignCharacters = charRes.items || [];
        const scenes = window.currentCampaignScenes = sceneRes.items || [];
        if (characters.length > 0 || scenes.length > 0) {
            document.getElementById('extractEmpty').style.display = 'none';
            renderExtractResults({ characters, scenes });
        } else {
            document.getElementById('extractEmpty').style.display = '';
            document.getElementById('charsSection').style.display = 'none';
            document.getElementById('scenesSection').style.display = 'none';
            renderPanoramaSection();
        }
    } catch(e) {
        console.warn('Failed to load extract data', e);
    }
}

async function loadStoryboardData() {
    if (!currentEpisode) return;
    try {
        const sbRes = await apiFetch(`/episodes/${currentEpisode.id}/storyboards`);
        const storyboards = sbRes.items || [];
        
        let hasGridPrompt = false;
        let gridImageUrl = '';
        try {
            if (currentEpisode.metadata) {
                const meta = typeof currentEpisode.metadata === 'string' ? JSON.parse(currentEpisode.metadata) : currentEpisode.metadata;
                if (meta.master_grid_prompt) hasGridPrompt = true;
                if (meta.grid_image_url) gridImageUrl = meta.grid_image_url;
            }
        } catch(e) {}

        const gridPanel = document.getElementById('gridConceptPanel');
        if (gridPanel) {
            if (hasGridPrompt && storyboards.length > 0) {
                gridPanel.style.display = 'block';
                const btnSlice = document.getElementById('btnSliceGrid');
                const imgPreview = document.getElementById('gridImagePreview');
                const imgPlaceholder = document.getElementById('gridImagePlaceholder');
                
                if (gridImageUrl) {
                    imgPreview.src = gridImageUrl;
                    imgPreview.style.display = 'block';
                    if (imgPlaceholder) imgPlaceholder.style.display = 'none';
                    if (btnSlice) btnSlice.style.display = 'inline-block';
                } else {
                    imgPreview.style.display = 'none';
                    if (imgPlaceholder) imgPlaceholder.style.display = 'block';
                    if (btnSlice) btnSlice.style.display = 'none';
                }
            } else {
                gridPanel.style.display = 'none';
            }
        }

        if (storyboards.length > 0) {
            document.getElementById('storyboardEmpty').style.display = 'none';
            renderStoryboard(storyboards);
            document.getElementById('sbList').style.display = '';
        } else {
            document.getElementById('storyboardEmpty').style.display = '';
            document.getElementById('sbList').style.display = 'none';
            document.getElementById('sbCount').textContent = '0 shots';
        }
    } catch(e) {
        console.warn('Failed to load storyboard data', e);
    }
}

// ── AI Rewrite ─────────────────────────────────────────────
async function doRewrite() {
    if (isStreaming) return;
    const raw = document.getElementById('rawTextarea').value.trim();
    const promptMsg = raw 
        ? `Please rewrite the following content into a formatted screenplay:\n\n${raw}` 
        : `Please write the formatted screenplay for this episode. If this is a continuation, pick up seamlessly from the previous episode's events without repeating them.`;

    setStep('script');
    isStreaming = true;

    // Show loading
    document.getElementById('scriptEmpty').style.display = 'none';
    document.getElementById('scriptLoading').style.display = '';
    document.getElementById('scriptTextarea').style.display = 'none';
    document.getElementById('btnRewrite').disabled = true;

    try {
        const response = await fetch(`${API}/agent/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agent_type: 'script_rewriter',
                message: promptMsg,
                episode_id: currentEpisode?.id,
                campaign_id: currentCampaign?.id,
            }),
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';

        // Show textarea for streaming
        document.getElementById('scriptLoading').style.display = 'none';
        const ta = document.getElementById('scriptTextarea');
        ta.style.display = '';
        ta.value = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            const lines = text.split('\n');
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') break;
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.content) {
                        fullText += parsed.content;
                        ta.value = fullText;
                        ta.scrollTop = ta.scrollHeight;
                    }
                    if (parsed.event === 'saved') {
                        toast('Script auto-saved', 'success');
                    }
                } catch (e) {}
            }
        }

        updateScriptCount();
        // Check if AI returned an error instead of content
        if (fullText.startsWith('\u274c')) {
            toast('AI Error: ' + fullText.substring(0, 200), 'error');
        } else {
            toast('Rewrite complete!', 'success');
        }
    } catch (e) {
        toast(`Rewrite failed: ${e.message}`, 'error');
        document.getElementById('scriptLoading').style.display = 'none';
        document.getElementById('scriptEmpty').style.display = '';
    } finally {
        isStreaming = false;
        document.getElementById('btnRewrite').disabled = false;
    }
}

function skipRewrite() {
    const raw = document.getElementById('rawTextarea').value;
    const ta = document.getElementById('scriptTextarea');
    ta.value = raw;
    updateScriptUI(raw);
    if (currentEpisode) {
        apiFetch(`/episodes/${currentEpisode.id}`, {
            method: 'PUT',
            body: JSON.stringify({ script_content: raw }),
        }).then(() => toast('Content copied to script', 'success'));
    }
}

function updateScriptUI(content) {
    const hasContent = content && content.trim().length > 0;
    document.getElementById('scriptEmpty').style.display = hasContent ? 'none' : '';
    document.getElementById('scriptTextarea').style.display = hasContent ? '' : 'none';
    document.getElementById('scriptLoading').style.display = 'none';
}

// ── Extract (Models & Products & Scenes) ──────────────────────────
async function doExtract() {
    if (isStreaming) return;
    if (!currentEpisode) {
        toast('Select an episode first', 'error');
        return;
    }

    let script = currentEpisode?.script_content || currentEpisode?.content || '';
    const scriptEl = document.getElementById('scriptTextarea');
    if (scriptEl && scriptEl.value.trim().length > 0) {
        script = scriptEl.value;
    }
    const rawEl = document.getElementById('rawTextarea');
    if (!script.trim() && rawEl && rawEl.value.trim().length > 0) {
        script = rawEl.value;
    }

    if (!script.trim()) {
        toast('No script content. Complete AI Rewrite first (Step 02)', 'error');
        setStep('script');
        return;
    }

    setStep('extract');
    isStreaming = true;
    document.getElementById('btnExtract').disabled = true;

    // ── Resolve browser profile for auto char-image gen ──────────────────────
    // Priority: campaign metadata → chip UI selection → localStorage fallback
    let extractBrowserProfile = '';
    try {
        const existingMeta = JSON.parse(currentCampaign?.metadata || '{}');
        extractBrowserProfile = existingMeta.browser_profile_name || '';
        if (!extractBrowserProfile) {
            // Try chip UI first (most up-to-date selection)
            const chipProfile = (_chipSelectedProfiles && _chipSelectedProfiles.length > 0) ? _chipSelectedProfiles[0] : '';
            // Then localStorage saved value
            const lsProfile = (localStorage.getItem('cs_last_browser_profile_video') || localStorage.getItem('cs_last_browser_profile') || '').split(',').filter(Boolean)[0] || '';
            extractBrowserProfile = chipProfile || lsProfile;
            // Save discovered profile back to campaign metadata so future ops find it
            if (extractBrowserProfile && currentCampaign) {
                existingMeta.browser_profile_name = extractBrowserProfile;
                await apiFetch(`/campaigns/${currentCampaign.id}`, {
                    method: 'PUT',
                    body: JSON.stringify({ metadata: JSON.stringify(existingMeta) })
                });
                currentCampaign.metadata = JSON.stringify(existingMeta);
            }
        }
    } catch(e) { console.warn('[doExtract] Could not resolve browser profile', e); }
    // ─────────────────────────────────────────────────────────────────────────

    // Show loading state inside extract panel
    const extractResults = document.getElementById('extractResults');
    document.getElementById('extractEmpty').style.display = 'none';
    extractResults.insertAdjacentHTML('afterbegin',
        `<div class="step-loading" id="extractLoading">
            <div class="spinner"></div>
            <div class="loading-text">AI is analyzing the script...</div>
            <div class="loading-meta" style="font-size:11px;color:var(--text-3);font-family:var(--font-mono);margin-top:4px">
                <span id="exProgressChars">0</span> chars received · <span id="exProgressTime">0</span>s elapsed
            </div>
        </div>`
    );
    const exStartTime = Date.now();
    let exCharCount = 0;
    const exTimer = setInterval(() => {
        const el = document.getElementById('exProgressTime');
        if (el) el.textContent = Math.floor((Date.now() - exStartTime) / 1000);
    }, 1000);

    try {
        const response = await fetch(`${API}/episodes/${currentEpisode.id}/extract`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ profile_name: extractBrowserProfile }),
            signal: typeof realtimeAbortController !== 'undefined' && realtimeAbortController ? realtimeAbortController.signal : undefined
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(err);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let extractedData = null;

        while (true) {
            if (typeof realtimeAbortController !== 'undefined' && realtimeAbortController && realtimeAbortController.signal.aborted) {
                reader.cancel();
                throw new Error("Aborted by user");
            }
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            const lines = text.split('\n');
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') break;
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.event === 'status') {
                        const loadEl = document.getElementById('extractLoading');
                        if (loadEl) {
                            const lt = loadEl.querySelector('.loading-text');
                            if (lt) lt.textContent = parsed.message;
                        }
                        // Live-refresh character cards when an image is generated
                        if (parsed.message && (parsed.message.includes('✅') || parsed.message.includes('Hoàn thành'))) {
                            try {
                                const charRes = await apiFetch(`/campaigns/${currentCampaign.id}/characters`);
                                const sceneRes = await apiFetch(`/campaigns/${currentCampaign.id}/scenes`);
                                renderExtractResults({ characters: charRes.items || [], scenes: sceneRes.items || [] });
                            } catch(e) {}
                        }
                    }
                    if (parsed.event === 'progress' && parsed.content) {
                        exCharCount += parsed.content.length;
                        const cEl = document.getElementById('exProgressChars');
                        if (cEl) cEl.textContent = exCharCount;
                    }
                    if (parsed.event === 'progress_reasoning') {
                        const loadEl = document.getElementById('extractLoading');
                        if (loadEl) {
                            const lt = loadEl.querySelector('.loading-text');
                            if (lt) lt.textContent = `Thinking / Reasoning...`;
                        }
                    }
                    // ── Live render characters/scenes as they are saved ──
                    if (parsed.event === 'chars_saved' || parsed.event === 'scenes_saved') {
                        try {
                            const charRes = await apiFetch(`/campaigns/${currentCampaign.id}/characters`);
                            const sceneRes = await apiFetch(`/campaigns/${currentCampaign.id}/scenes`);
                            renderExtractResults({ characters: charRes.items || [], scenes: sceneRes.items || [] });
                            // Update header counters
                            document.getElementById('metaChars').textContent = `${(charRes.items || []).length} characters`;
                            document.getElementById('metaScenes').textContent = `${(sceneRes.items || []).length} scenes`;
                        } catch(e) {}
                    }
                    if (parsed.event === 'complete') {
                        extractedData = parsed;
                    }
                    if (parsed.event === 'error') {
                        throw new Error("BACKEND_ERR:" + parsed.message);
                    }
                } catch (e) {
                    if (e.message && e.message.startsWith("BACKEND_ERR:")) {
                        throw new Error(e.message.replace("BACKEND_ERR:", ""));
                    }
                    if (e.message && !e.message.includes('JSON')) throw e;
                }
            }
        }

        // Remove loading
        clearInterval(exTimer);
        const loadEl = document.getElementById('extractLoading');
        if (loadEl) loadEl.remove();

        if (extractedData) {
            toast(`Extracted ${extractedData.saved_characters} characters, ${extractedData.saved_scenes} scenes!`, 'success');

            // Mark extract as completed in episode metadata
            if (currentEpisode) {
                try {
                    let epMeta = {};
                    try { epMeta = JSON.parse(currentEpisode.metadata || '{}'); } catch(e) {}
                    epMeta.extract_completed = true;
                    await apiFetch(`/episodes/${currentEpisode.id}`, {
                        method: 'PUT',
                        body: JSON.stringify({ metadata: JSON.stringify(epMeta) })
                    });
                    currentEpisode.metadata = JSON.stringify(epMeta);
                } catch(e) { console.warn('[doExtract] Could not save extract_completed flag', e); }
            }

            // Refresh campaign data for header counters and global list
            if (currentCampaign) {
                const [d, charRes, sceneRes] = await Promise.all([
                    apiFetch(`/campaigns/${currentCampaign.id}`),
                    apiFetch(`/campaigns/${currentCampaign.id}/characters`),
                    apiFetch(`/campaigns/${currentCampaign.id}/scenes`)
                ]);
                currentCampaign = d;
                document.getElementById('metaChars').textContent = `${(d.characters || []).length} characters`;
                document.getElementById('metaScenes').textContent = `${(d.scenes || []).length} scenes`;
                
                renderExtractResults({
                    characters: charRes.items || [],
                    scenes: sceneRes.items || []
                });
            }
        } else {
            document.getElementById('extractEmpty').style.display = '';
            toast('No data extracted', 'error');
            throw new Error(`No data extracted (received ${exCharCount} chars from AI)`);
        }
    } catch (e) {
        if (e.name === 'AbortError' || e.message === 'Aborted by user') {
            toast("Extraction aborted by user.", "info");
            throw e;
        }
        clearInterval(exTimer);
        const loadEl = document.getElementById('extractLoading');
        if (loadEl) loadEl.remove();
        document.getElementById('extractEmpty').style.display = '';
        
        // Better error message for network errors
        let errMsg = e.message || 'Unknown error';
        if (errMsg.toLowerCase().includes('network') || errMsg.toLowerCase().includes('failed to fetch')) {
            errMsg = `AI stream interrupted after ~${exCharCount.toLocaleString()} chars received. This usually means the AI response was too long and got cut off. Try again — the retry should succeed.`;
        }
        toast(`Extraction failed: ${errMsg}`, 'error', 10000);
        throw e;
    } finally {
        isStreaming = false;
        document.getElementById('btnExtract').disabled = false;
    }
}

function renderExtractResults(data) {
    const characters = data.characters || [];
    const scenes = data.scenes || [];

    // Models & Products section
    const charsSection = document.getElementById('charsSection');
    const charsGrid = document.getElementById('charsGrid');
    const charsCount = document.getElementById('charsCount');

    if (characters.length > 0) {
        charsSection.style.display = '';
        charsCount.textContent = characters.length;
        charsGrid.className = 'ref-gallery';
        charsGrid.innerHTML = characters.map(c => {
            const refImgUrl = _getCharRefUrl(c);
            return `
                <div class="ref-card" onclick="openCharacterDetail(${c.id})">
                    <div class="ref-card-img" ondragover="event.preventDefault();this.querySelector('.ref-upload-overlay').style.display='flex'" ondragleave="this.querySelector('.ref-upload-overlay').style.display='none'" ondrop="event.preventDefault();this.querySelector('.ref-upload-overlay').style.display='none';handleCharRefDrop(event,${c.id})">
                        ${refImgUrl
                          ? `<img src="${refImgUrl}" alt="${esc(c.name)}" />`
                          : `<div class="ref-placeholder">
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                                <span>Drop image or click to upload</span>
                             </div>`}
                        <div class="ref-upload-overlay">📷 Drop image here</div>
                    </div>
                    <div class="ref-card-body">
                        <div class="ref-card-name">${esc(c.name)}</div>
                        <div class="ref-card-role">${esc(c.role || 'character')}</div>
                        ${c.appearance ? `<div class="ref-card-desc">${esc(c.appearance)}</div>` : ''}
                    </div>
                    <div class="ref-card-actions">
                        <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();triggerCharRefUpload(${c.id})" title="Upload reference image">📷 Upload</button>
                        <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();generateCharRefAI(${c.id})" title="Generate with Grok AI" id="btnGenChar${c.id}">🎨 AI Gen</button>
                        <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();openCharacterDetail(${c.id})" title="Edit character details">✏️ Edit</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    // Scenes section - only show individual scenes in per_shot mode
    const scenesSection = document.getElementById('scenesSection');
    const scenesGrid = document.getElementById('scenesGrid');
    const scenesCount = document.getElementById('scenesCount');
    let _sceneMode = 'per_shot';
    if (currentCampaign) { try { _sceneMode = JSON.parse(currentCampaign.metadata || '{}').scene_gen_mode || 'per_shot'; } catch(e) {} }
    const _isPanoramaMode = (_sceneMode === 'panoramic_grid');

    if (scenes.length > 0 && !_isPanoramaMode) {
        scenesSection.style.display = '';
        scenesCount.textContent = scenes.length;
        scenesGrid.className = 'ref-gallery';
        scenesGrid.innerHTML = scenes.map(s => {
            const sceneImgUrl = _getSceneRefUrl(s);
            return `
                <div class="ref-card" onclick="openSceneDetail(${s.id})">
                    <div class="ref-card-img" style="aspect-ratio:16/9" ondragover="event.preventDefault();this.querySelector('.ref-upload-overlay').style.display='flex'" ondragleave="this.querySelector('.ref-upload-overlay').style.display='none'" ondrop="event.preventDefault();this.querySelector('.ref-upload-overlay').style.display='none';handleSceneRefDrop(event,${s.id})">
                        ${sceneImgUrl
                          ? `<img src="${sceneImgUrl}" alt="${esc(s.location)}" />`
                          : `<div class="ref-placeholder">
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                                <span>Drop scene image</span>
                             </div>`}
                        <div class="ref-upload-overlay">🖼️ Drop image here</div>
                    </div>
                    <div class="ref-card-body">
                        <div class="ref-card-name">${esc(s.location)}</div>
                        ${s.time ? `<div class="ref-card-role">${esc(s.time)}</div>` : ''}
                        ${s.description ? `<div class="ref-card-desc">${esc(s.description)}</div>` : ''}
                    </div>
                    <div class="ref-card-actions">
                        <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();triggerSceneRefUpload(${s.id})" title="Upload scene image">📷 Upload</button>
                        <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();generateSceneRefAI(${s.id})" title="Generate with Grok AI" id="btnGenScene${s.id}">🎨 AI Gen</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    // Force hide scenes section in panorama mode
    if (_isPanoramaMode && scenesSection) { scenesSection.style.display = 'none'; }

        // Update extract count
    document.getElementById('extractCount').textContent = `${characters.length} characters · ${scenes.length} scenes`;

    // Render panorama section
    renderPanoramaSection();
}

// ── Character/Scene Reference Helpers ──────────────────────
function _getCharRefUrl(c) {
    if (c.image_url) {
        // Gallery images already have a web URL like /api/v1/pod_studio/gallery/image/...
        if (c.image_url.startsWith('/api/')) return c.image_url;
        // Absolute file paths — extract filename and serve via /references/
        const fname = c.image_url.replace(/\\/g, '/').split('/').pop();
        return `/api/v1/pod_studio/references/${encodeURIComponent(fname)}`;
    }
    return null;
}

function _getSceneRefUrl(s) {
    if (s.image_url) {
        const fname = s.image_url.replace(/\\/g, '/').split('/').pop();
        return `/api/v1/pod_studio/references/${encodeURIComponent(fname)}`;
    }
    return null;
}

function triggerCharRefUpload(charId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
        if (!input.files[0]) return;
        await _uploadRefFile(`/characters/${charId}/upload-ref`, input.files[0]);
        loadExtractData();
    };
    input.click();
}

function triggerSceneRefUpload(sceneId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
        if (!input.files[0]) return;
        await _uploadRefFile(`/scenes/${sceneId}/upload-ref`, input.files[0]);
        loadExtractData();
    };
    input.click();
}

async function handleCharRefDrop(event, charId) {
    const file = event.dataTransfer?.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    await _uploadRefFile(`/characters/${charId}/upload-ref`, file);
    loadExtractData();
}

async function handleSceneRefDrop(event, sceneId) {
    const file = event.dataTransfer?.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    await _uploadRefFile(`/scenes/${sceneId}/upload-ref`, file);
    loadExtractData();
}

async function _uploadRefFile(endpoint, file) {
    const formData = new FormData();
    formData.append('file', file);
    try {
        const resp = await fetch(`${API}${endpoint}`, { method: 'POST', body: formData });
        if (!resp.ok) throw new Error('Upload failed');
        const result = await resp.json();
        toast('Reference image uploaded!', 'success');
        return result;
    } catch(e) {
        toast('Upload failed: ' + e.message, 'error');
        return null;
    }
}

// ── Scene Panorama ─────────────────────────────────────────
function renderPanoramaSection() {
    const section = document.getElementById('panoramaSection');
    if (!section || !currentEpisode) return;
    // Only show panorama in panoramic_grid mode
    let _pMode = 'per_shot';
    if (currentCampaign) { try { _pMode = JSON.parse(currentCampaign.metadata || '{}').scene_gen_mode || 'per_shot'; } catch(e) {} }
    if (_pMode !== 'panoramic_grid') { section.style.display = 'none'; return; }
    section.style.display = '';

    let epMeta = {};
    try { epMeta = JSON.parse(currentEpisode.metadata || '{}'); } catch(e) {}
    const panoramaUrl = epMeta.panorama_image_url || null;
    const zone = document.getElementById('panoramaUploadZone');
    const content = document.getElementById('panoramaContent');
    const locInfo = document.getElementById('panoramaLocationInfo');

    if (panoramaUrl) {
        zone.classList.add('has-image');
        content.innerHTML = `
            <div class="panorama-img-wrap">
                <img src="${panoramaUrl}" alt="Scene Panorama" onerror="this.alt='Failed to load'" />
                <div class="panorama-img-overlay">
                    <span class="panorama-label">📍 ${esc(epMeta.scene_location || 'Scene Location')}</span>
                    <div class="panorama-actions">
                        <button onclick="event.stopPropagation();triggerPanoramaUpload()">🔄 Replace</button>
                        <button onclick="event.stopPropagation();removePanorama()">🗑️ Remove</button>
                    </div>
                </div>
            </div>`;
        const scenes = window.currentCampaignScenes || [];
        if (scenes.length > 0) {
            const mainScene = scenes[0];
            locInfo.style.display = '';
            document.getElementById('panoramaLocationName').textContent = mainScene.location || '—';
            document.getElementById('panoramaLocationTime').textContent = mainScene.time || '—';
            document.getElementById('panoramaLocationMood').textContent = mainScene.mood || mainScene.description?.substring(0, 40) || '—';
        }
    } else {
        zone.classList.remove('has-image');
        content.innerHTML = `
            <div class="panorama-placeholder">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><circle cx="8" cy="10" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                <span>Drop panoramic scene image here or click to upload</span>
                <span style="font-size:11px;color:var(--text-3);">This image will be used as the spatial map for camera blocking</span>
            </div>`;
        locInfo.style.display = 'none';
    }
}

function triggerPanoramaUpload() {
    if (!currentEpisode) { toast('Select a scene first', 'error'); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
        if (!input.files[0]) return;
        const formData = new FormData();
        formData.append('file', input.files[0]);
        try {
            const resp = await fetch(`${API}/episodes/${currentEpisode.id}/upload-panorama`, {
                method: 'POST', body: formData
            });
            if (!resp.ok) throw new Error('Upload failed');
            const data = await resp.json();
            if (data.success) {
                let meta = {};
                try { meta = JSON.parse(currentEpisode.metadata || '{}'); } catch(e) {}
                meta.panorama_image_url = data.panorama_url;
                meta.scene_mode = true;
                currentEpisode.metadata = JSON.stringify(meta);
                toast('✅ Panorama uploaded!', 'success');
                renderPanoramaSection();
            }
        } catch(e) { toast('Upload failed: ' + e.message, 'error'); }
    };
    input.click();
}

async function handlePanoramaDrop(event) {
    const file = event.dataTransfer?.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    if (!currentEpisode) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
        const resp = await fetch(`${API}/episodes/${currentEpisode.id}/upload-panorama`, {
            method: 'POST', body: formData
        });
        if (!resp.ok) throw new Error('Upload failed');
        const data = await resp.json();
        if (data.success) {
            let meta = {};
            try { meta = JSON.parse(currentEpisode.metadata || '{}'); } catch(e) {}
            meta.panorama_image_url = data.panorama_url;
            meta.scene_mode = true;
            currentEpisode.metadata = JSON.stringify(meta);
            toast('✅ Panorama uploaded!', 'success');
            renderPanoramaSection();
        }
    } catch(e) { toast('Upload failed: ' + e.message, 'error'); }
}

async function removePanorama() {
    if (!currentEpisode) return;
    let meta = {};
    try { meta = JSON.parse(currentEpisode.metadata || '{}'); } catch(e) {}
    delete meta.panorama_image_url;
    currentEpisode.metadata = JSON.stringify(meta);
    try {
        await apiFetch(`/episodes/${currentEpisode.id}`, {
            method: 'PUT',
            body: JSON.stringify({ metadata: currentEpisode.metadata })
        });
        toast('Panorama removed', 'info');
        renderPanoramaSection();
    } catch(e) { toast('Failed to remove: ' + e.message, 'error'); }
}

function copyPanoramaPrompt() {
    const chars = window.currentCampaignCharacters || [];
    const scenes = window.currentCampaignScenes || [];
    const campaign = currentCampaign || {};
    let cMeta = {};
    try { cMeta = JSON.parse(campaign.metadata || '{}'); } catch(e) {}

    const style = campaign.style || 'Cinematic Realistic';
    const ms = scenes[0] || {};
    const location = ms.location || 'a cinematic interior space';
    const time = ms.time || 'Day';
    const mood = ms.mood || ms.description || 'dramatic cinematic';
    const lighting = ms.lighting_style || 'Natural cinematic lighting';
    const desc = ms.description || '';

    const mainChars = chars.filter(c => c.role !== 'product' && c.role !== 'prop');
    const products = chars.filter(c => c.role === 'product' || c.role === 'prop' || c.role === 'hero_product');

    const charBlock = mainChars.slice(0, 2).map(c => {
        const app = (c.appearance || '').substring(0, 120);
        return `  - ${c.name}: ${app}`;
    }).join('\n');

    const productBlock = products.slice(0, 2).map(p => {
        const app = (p.appearance || '').substring(0, 100);
        return `  - ${p.name}: ${app}`;
    }).join('\n');

    const script = currentEpisode?.script_content || currentEpisode?.content || '';
    const scriptExcerpt = script.substring(0, 3000).replace(/\n/g, ' ').trim();
    const showMatches = script.match(/\[SHOW:/g);
    const shotCount = showMatches ? Math.min(showMatches.length, 6) : 5;

    // Detect architecture mode
    const isArchitecture = (cMeta.content_format || '').includes('Architecture') || (cMeta.content_format || '').includes('Interior');

    // Build floor plan section (shared)
    let floorPlanSection = '';
    try {
        const outline = cMeta.series_outline || {};
        const spatialMap = outline.shared_spatial_map;
        const episodes = outline.episodes || [];
        if (spatialMap && spatialMap.zones && spatialMap.zones.length > 0) {
            const epNum = currentEpisode?.episode_number || 1;
            const currentEpPlan = episodes.find(e => e.episode_number === epNum) || {};
            const currentZoneId = currentEpPlan.spatial_zone || '';
            const totalEps = episodes.length;
            const zoneLabels = spatialMap.zones.map(z => {
                const isCurrent = z.zone_id === currentZoneId;
                return `  ${isCurrent ? '\u2192 ' : '  '}Zone ${z.zone_id}: ${z.name} \u2014 ${(z.description || '').substring(0, 100)}${isCurrent ? ' [CURRENT SCENE - HIGHLIGHT]' : ''}`;
            }).join('\n');
            const connections = spatialMap.zones.filter(z => z.connects_to && z.connects_to.length).map(z =>
                `  Zone ${z.zone_id} \u2192 Zone ${z.connects_to.join(', ')}: ${z.connection_description || 'connected'}`
            ).join('\n');
            floorPlanSection = `CRITICAL: Show the COMPLETE connected floor plan of the ENTIRE space (all ${spatialMap.zones.length} zones).\nThis is Screen ${epNum} of ${totalEps} \u2014 camera is currently in Zone ${currentZoneId}.\nOVERALL SPACE: ${spatialMap.description || ''}\nALL ZONES (show all, highlight current):\n${zoneLabels}\nCONNECTIONS between zones:\n${connections}\nDraw the FULL floor plan with ALL zones connected. Highlight Zone ${currentZoneId} with a colored border/glow.\nShow camera position in Zone ${currentZoneId} with numbered icons and movement arrows.\nShow doorways/passages between zones with labeled arrows.`;
        }
    } catch(e) {}

    if (!floorPlanSection) {
        floorPlanSection = isArchitecture
            ? `A TOP-DOWN architectural floor plan of the space showing:\n  - Room/space layout with walls, doors, windows\n  - Furniture/prop positions as simple shapes\n  - Camera positions marked as numbered icons (Cut 1, Cut 2, Cut 3...)\n  - Camera angle arrows showing direction each cut is facing\n  - Dotted lines showing camera movement paths\n  - NO character icons (architecture only)`
            : `A TOP-DOWN architectural floor plan of the scene showing:\n  - Room/space layout with walls, doors, windows\n  - Furniture/prop positions as simple shapes\n  - Camera positions marked as numbered icons (Cut 1, Cut 2, Cut 3...)\n  - Camera angle arrows showing direction each cut is facing\n  - Dotted lines showing camera movement paths\n  - Character position(s) marked with figure icons`;
    }

    // Detect aspect ratio and build layout instructions
    const aspectRatio = cMeta.aspect_ratio || '16:9';
    const isPortrait = aspectRatio === '9:16' || aspectRatio === '3:4';
    const isSquare = aspectRatio === '1:1';
    let layoutInstruction = '';
    let charAngleLayout = '';
    let storyboardLayout = '';
    if (isPortrait) {
        layoutInstruction = `\nIMAGE ASPECT RATIO: ${aspectRatio} (PORTRAIT / VERTICAL)\nCRITICAL LAYOUT RULE: The entire design board MUST be in PORTRAIT orientation (tall, vertical).\nArrange ALL zones in a VERTICAL STACK (top to bottom), NOT side-by-side.\nZone widths should be 100% (full width of the board).\nOrder from top to bottom: Zone 1 → Zone 2 → Zone 3 → Zone 5 → Zone 4.\n`;
        charAngleLayout = isArchitecture
            ? 'Arrange furniture/material reference images in a 2-column vertical grid.'
            : 'Show the main character angles in a VERTICAL STRIP (stacked top-to-bottom):\n  TOP: FACE CLOSE-UP\n  FRONT VIEW\n  SIDE VIEW\n  BACK VIEW\n  COSTUME DETAIL\n  BOTTOM: FULL BODY';
        storyboardLayout = `Arrange ${shotCount} CUTS in a VERTICAL column (stacked top-to-bottom), each as a wide horizontal frame.`;
    } else if (isSquare) {
        layoutInstruction = `\nIMAGE ASPECT RATIO: 1:1 (SQUARE)\nLayout: Use a 2x2 grid arrangement for zones. Zone 3 (Storyboard) spans full width in the middle.\n`;
        charAngleLayout = isArchitecture
            ? 'Arrange furniture/material reference images in a 2x3 grid.'
            : 'Show the main character from 6 angles in a horizontal strip:\n  FRONT | SIDE | BACK | FACE CLOSE-UP | SIDE CLOSE-UP | COSTUME DETAIL';
        storyboardLayout = `${shotCount} sequential cinematic CUTS arranged horizontally (Cut 1, Cut 2, Cut 3...).`;
    } else {
        // 16:9 landscape (default)
        layoutInstruction = `\nIMAGE ASPECT RATIO: ${aspectRatio} (LANDSCAPE / HORIZONTAL)\nCRITICAL LAYOUT RULE: The entire design board MUST be in LANDSCAPE orientation (wide, horizontal).\nArrange zones in a structured HORIZONTAL GRID:\n  TOP ROW: Zone 1 (left ~40%) + Zone 2 (right ~60%)\n  MIDDLE ROW: Zone 3 (full width)\n  BOTTOM ROW: Zone 5 (left ~60%) + Zone 4 (right ~40%)\n`;
        charAngleLayout = isArchitecture
            ? 'Arrange furniture/material reference images in a 2x3 grid.'
            : 'Show the main character from 6 angles in a HORIZONTAL STRIP:\n  FRONT | SIDE | BACK | FACE CLOSE-UP | SIDE CLOSE-UP | COSTUME DETAIL';
        storyboardLayout = `${shotCount} sequential cinematic CUTS arranged horizontally (Cut 1, Cut 2, Cut 3...).`;
    }

    let prompt;

    if (isArchitecture) {
        const spaceBlock = chars.slice(0, 4).map(c => {
            const app = (c.appearance || '').substring(0, 150);
            return `  - ${c.name}: ${app}`;
        }).join('\n');

        prompt = `Create a professional cinematic PRODUCTION DESIGN BOARD for ARCHITECTURE / INTERIOR "${campaign.name || 'Scene'}" \u2014 a single comprehensive reference sheet image with ALL zones on a dark navy background (#0a1628) with subtle grid lines and cyan/teal accent borders.\nCRITICAL: This is ARCHITECTURE ONLY. ZERO people, ZERO characters anywhere. Only spaces, furniture, materials, light.${layoutInstruction}\nZONE 1 \u2014 FURNITURE + MATERIAL REFERENCE\nTitle label: "1. FURNITURE + MATERIAL REFERENCE"\n${charAngleLayout}\n${spaceBlock || '  - Key furniture and fixtures from the interior space'}\nBelow: COLOR PALETTE (5-6 color swatches with hex codes) + MATERIAL NOTES (wood type, stone, fabric, metal finishes)\n\nZONE 2 \u2014 ENVIRONMENT / SET DESIGN\nTitle label: "2. ENVIRONMENT / SET DESIGN"\nMAIN ENVIRONMENT STILL: One large cinematic establishing shot of: ${location} \u2014 ${time}. NO PEOPLE.\n${desc ? `Scene: ${desc}` : ''}\n3 SUPPLEMENTARY VIEWS (all empty, no people): wide angle, detail/texture close-up, overhead layout.\nMATERIALS STRIP: Small thumbnails of key materials/textures.\n\nZONE 3 \u2014 STORYBOARD\nTitle label: "3. STORYBOARD"\n${storyboardLayout}\nEach cut shows a different camera angle of the SAME space with NO PEOPLE.\nCamera progression: WIDE \u2192 DOLLY IN \u2192 TRACKING \u2192 CRANE \u2192 CLOSE-UP${shotCount > 5 ? ' \u2192 PULL OUT' : ''}\n\nZONE 4 \u2014 FLOOR PLAN + CAMERA PLAN (TOP-DOWN)\n${floorPlanSection}\n\nZONE 5 \u2014 LIGHTING / MOOD / STYLE NOTES\nTitle label: "4. LIGHTING / MOOD / STYLE NOTES"\nLighting refs (NO PEOPLE) + MOOD: ${mood}\nCinematography: key light, shadows, atmosphere, material palette.\n\nVISUAL STYLE: Dark navy bg (#0a1628), white text, cyan accents. ${style}. 8K ultra-detailed, NO PEOPLE, no watermarks.${scriptExcerpt ? `\n\nSCRIPT CONTEXT: ${scriptExcerpt}${script.length > 3000 ? '...' : ''}` : ''}`;
    } else {
        prompt = `Create a professional cinematic PRODUCTION DESIGN BOARD for "${campaign.name || 'Scene'}" \u2014 a single comprehensive reference sheet image with ALL zones on a dark navy background (#0a1628) with subtle grid lines and cyan/teal accent borders.${layoutInstruction}\nZONE 1 \u2014 CHARACTER + HERO OBJECT REFERENCE\nTitle label: "1. CHARACTER + HERO OBJECT REFERENCE"\n${charAngleLayout}\n${charBlock ? `Character details:\n${charBlock}` : '  - A cinematic character appropriate to the scene'}\n${productBlock ? `HERO OBJECT:\n${productBlock}` : ''}\nBelow: SHARED PALETTE (4-5 color swatches) + REFERENCE NOTES\n\nZONE 2 \u2014 ENVIRONMENT / SET DESIGN\nTitle label: "2. ENVIRONMENT / SET DESIGN"\nMAIN ENVIRONMENT STILL: ${location} \u2014 ${time}\n${desc ? `Scene: ${desc}` : ''}\n3 SUPPLEMENTARY VIEWS: wide angle, detail/texture, character-in-environment.\nMATERIALS STRIP: key textures.\n\nZONE 3 \u2014 STORYBOARD\nTitle label: "3. STORYBOARD"\n${storyboardLayout}\nEach cut shows a different camera angle of the SAME scene.\nCamera progression: WIDE \u2192 DOLLY IN \u2192 TRACK CU \u2192 ARC/OTS \u2192 PUSH IN${shotCount > 5 ? ' \u2192 PULL OUT' : ''}\n\nZONE 4 \u2014 FLOOR PLAN + CAMERA PLAN (TOP-DOWN)\n${floorPlanSection}\n\nZONE 5 \u2014 LIGHTING / MOOD / STYLE NOTES\nTitle label: "4. LIGHTING / MOOD / STYLE NOTES"\nLighting refs + MOOD: ${mood}\nCinematography: key light (${lighting}), shadows, atmosphere, color palette.\n\nVISUAL STYLE: Dark navy bg (#0a1628), white text, cyan accents. ${style}. 8K ultra-detailed, no watermarks.${scriptExcerpt ? `\n\nSCRIPT CONTEXT: ${scriptExcerpt}${script.length > 3000 ? '...' : ''}` : ''}`;
    }

    navigator.clipboard.writeText(prompt).then(() => {
        toast('\uD83D\uDCCB Production Board prompt copied!', 'success');
    }).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = prompt;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast('\uD83D\uDCCB Production Board prompt copied!', 'success');
    });
}

// ── Generate Panorama via AI (ChatGPT browser) ────────────────
async function generatePanoramaAI() {
    if (!currentCampaign || !currentEpisode) {
        toast('Please select an episode first', 'error');
        return;
    }
    const btn = document.getElementById('btnPanoramaAIGen');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '⏳ Generating...';
    }
    toast('🎨 Starting panorama generation via ChatGPT...', 'info');
    try {
        const resp = await fetch(`${API}/campaigns/${currentCampaign.id}/episodes/${currentEpisode.id}/generate-panorama`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await resp.json();
        if (resp.ok && data.status === 'success') {
            let meta = {};
            try { meta = JSON.parse(currentEpisode.metadata || '{}'); } catch(e) {}
            meta.panorama_image_url = data.panorama_url;
            meta.panorama_image_path = data.panorama_path || '';
            meta.scene_mode = true;
            currentEpisode.metadata = JSON.stringify(meta);
            toast('✅ Panorama generated successfully!', 'success');
            renderPanoramaSection();
        } else {
            toast(`❌ Panorama generation failed: ${data.error || data.detail || 'Unknown error'}`, 'error');
        }
    } catch (e) {
        toast(`❌ Error: ${e.message}`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '🎨 AI Gen';
        }
    }
}

function openCharacterDetail(charId) {
    const char = (window.currentCampaignCharacters || []).find(c => c.id === charId);
    if (!char) { toast('Character not found', 'error'); return; }
    
    const refImgUrl = _getCharRefUrl(char);
    let refs = [];
    try { refs = JSON.parse(char.reference_images || '[]'); } catch(e) {}
    
    const modal = document.getElementById('charDetailModal');
    if (!modal) return;
    
    document.getElementById('charDetailName').value = char.name || '';
    document.getElementById('charDetailRole').value = char.role || '';
    document.getElementById('charDetailAppearance').value = char.appearance || '';
    document.getElementById('charDetailPersonality').value = char.personality || '';
    document.getElementById('charDetailDescription').value = char.description || '';
    
    const previewEl = document.getElementById('charDetailPreview');
    if (refImgUrl) {
        previewEl.innerHTML = `<img src="${refImgUrl}" alt="${esc(char.name)}" />`;
    } else {
        previewEl.innerHTML = `<div class="upload-hint"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span>Click to upload</span></div>`;
    }
    previewEl.onclick = () => triggerCharRefUpload(charId);
    
    // Ref thumbs
    const thumbsEl = document.getElementById('charDetailThumbs');
    thumbsEl.innerHTML = refs.map((path, i) => {
        const fname = path.replace(/\\/g, '/').split('/').pop();
        return `<div class="char-ref-thumb ${i === refs.length - 1 ? 'active' : ''}"><img src="/api/v1/pod_studio/references/${encodeURIComponent(fname)}" /></div>`;
    }).join('');
    
    modal.dataset.charId = charId;
    modal.style.display = 'flex';
}

async function saveCharacterDetail() {
    const modal = document.getElementById('charDetailModal');
    const charId = parseInt(modal.dataset.charId);
    
    const data = {
        name: document.getElementById('charDetailName').value,
        role: document.getElementById('charDetailRole').value,
        appearance: document.getElementById('charDetailAppearance').value,
        personality: document.getElementById('charDetailPersonality').value,
        description: document.getElementById('charDetailDescription').value,
    };
    
    try {
        await apiFetch(`/characters/${charId}`, { method: 'PUT', body: JSON.stringify(data) });
        toast('Character updated!', 'success');
        modal.style.display = 'none';
        loadExtractData();
    } catch(e) {
        toast('Failed to save: ' + e.message, 'error');
    }
}

function openSceneDetail(sceneId) {
    // Simple inline edit - can be enhanced later
    toast('Scene detail editor coming soon', 'info');
}

async function generateCharRefAI(charId) {
    const char = (window.currentCampaignCharacters || []).find(c => c.id === charId);
    if (!char) { toast('Character not found', 'error'); return; }
    if (!char.appearance || !char.appearance.trim()) {
        toast(`Please fill in the Appearance field for "${char.name}" first (click Edit)`, 'error');
        return;
    }
    // Auto-detect profile: wizard chips > campaign metadata > localStorage
    const autoProfile = _getAutoProfile();
    if (autoProfile) {
        // Skip modal — use saved profile directly
        const engine = _getVideoEngine();
        const btn = document.getElementById(`btnGenChar${charId}`);
        if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Generating...'; }
        try {
            const res = await apiFetch(`/characters/${charId}/generate-ref`, {
                method: 'POST',
                body: JSON.stringify({ profile_name: autoProfile, engine }),
            });
            if (res.task_id) {
                const engineLabel = engine === 'veo3' ? 'Veo3' : 'Grok';
                toast(`🎨 [${engineLabel}] Đang tạo ảnh nhân vật "${char.name}"...`, 'info');
                _pollCharGenStatus(res.task_id, charId, btn);
            }
        } catch(e) {
            toast('AI Generate failed: ' + e.message + ' — Hãy chọn lại profile', 'error');
            if (btn) { btn.disabled = false; btn.innerHTML = '🎨 AI Gen'; }
            // Fallback: show profile picker on error
            _charGenPendingCharId = charId;
            await _openCharGenProfileModal(charId);
        }
    } else {
        // No profile found — show profile picker modal
        await _openCharGenProfileModal(charId);
    }
}

// Auto-detect the best available browser profile
function _getAutoProfile() {
    // 1. Wizard chip selector (step 3)
    if (typeof _chipSelectedProfiles !== 'undefined' && _chipSelectedProfiles.length > 0) {
        return _chipSelectedProfiles[0];
    }
    // 2. Campaign metadata
    if (typeof currentCampaign !== 'undefined' && currentCampaign) {
        try {
            const meta = JSON.parse(currentCampaign.metadata || '{}');
            if (meta.browser_profile_name) return meta.browser_profile_name;
            if (meta.browser_profile_names_video && meta.browser_profile_names_video.length > 0) {
                return meta.browser_profile_names_video[0];
            }
        } catch(e) {}
    }
    // 3. localStorage
    const ls = localStorage.getItem('cs_last_browser_profile');
    if (ls) return ls;
    return null;
}

// ── Profile Picker Modal Helpers ───────────────────────────
let _charGenPendingCharId = null;
let _charGenSelectedProfile = null;
let _charGenAllProfiles = [];

async function _openCharGenProfileModal(charId) {
    _charGenPendingCharId = charId;
    _charGenSelectedProfile = null;

    const modal = document.getElementById('charGenProfileModal');
    const listEl = document.getElementById('charGenProfileList');
    const loadingEl = document.getElementById('charGenProfileLoading');
    const confirmBtn = document.getElementById('charGenProfileConfirmBtn');
    const selectedEl = document.getElementById('charGenProfileSelected');
    const searchEl = document.getElementById('charGenProfileSearch');

    if (!modal) return;

    // Reset UI
    listEl.innerHTML = '';
    listEl.appendChild(loadingEl || (() => {
        const d = document.createElement('div'); d.id = 'charGenProfileLoading'; d.textContent = 'Đang tải...'; return d;
    })());
    if (loadingEl) { loadingEl.style.display = ''; listEl.appendChild(loadingEl); }
    confirmBtn.disabled = true;
    if (selectedEl) selectedEl.style.display = 'none';
    if (searchEl) searchEl.value = '';

    modal.style.display = 'flex';

    try {
        const res = await fetch('/api/v1/pod_studio/browser-profiles');
        const data = await res.json();
        _charGenAllProfiles = data.profiles || [];
    } catch(e) {
        _charGenAllProfiles = [];
        toast('Không thể tải danh sách profile: ' + e.message, 'error');
    }

    _renderCharGenProfiles(_charGenAllProfiles);

    // Pre-select last used profile if it still exists
    const lastProfile = localStorage.getItem('cs_last_browser_profile') || '';
    if (lastProfile && _charGenAllProfiles.includes(lastProfile)) {
        _charGenSelectProfile(lastProfile);
    }
}

function _renderCharGenProfiles(profiles) {
    const listEl = document.getElementById('charGenProfileList');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (!profiles.length) {
        listEl.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-3); font-size:13px;">Không tìm thấy profile nào trong <code>data/browser_profiles</code></div>';
        return;
    }

    const lastProfile = localStorage.getItem('cs_last_browser_profile') || '';
    profiles.forEach(name => {
        const item = document.createElement('div');
        const isLast = name === lastProfile;
        item.dataset.profile = name;
        item.style.cssText = `padding:8px 12px; border-radius:6px; cursor:pointer; font-size:13px; display:flex; align-items:center; gap:8px; transition:background 0.15s; ${isLast ? 'background:rgba(139,92,246,0.12); border:1px solid rgba(139,92,246,0.3);' : 'border:1px solid transparent;'}`;
        item.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${isLast ? '#a78bfa' : 'var(--text-3)'}" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
            <span style="color:${isLast ? '#a78bfa' : 'var(--text-1)'}; font-weight:${isLast ? '600' : '400'};">${name}</span>
            ${isLast ? '<span style="margin-left:auto; font-size:10px; background:#7c3aed30; color:#a78bfa; padding:2px 6px; border-radius:4px;">Lần trước</span>' : ''}
        `;
        item.onmouseover = () => { if (item.dataset.profile !== _charGenSelectedProfile) item.style.background = 'var(--bg-2)'; };
        item.onmouseout = () => { if (item.dataset.profile !== _charGenSelectedProfile) item.style.background = 'transparent'; };
        item.onclick = () => _charGenSelectProfile(name);
        listEl.appendChild(item);
    });
}

function _charGenSelectProfile(name) {
    _charGenSelectedProfile = name;

    // Update list items highlight
    const listEl = document.getElementById('charGenProfileList');
    if (listEl) {
        listEl.querySelectorAll('[data-profile]').forEach(el => {
            const isSelected = el.dataset.profile === name;
            el.style.background = isSelected ? 'rgba(139,92,246,0.15)' : 'transparent';
            el.style.border = isSelected ? '1px solid rgba(139,92,246,0.4)' : '1px solid transparent';
        });
    }

    // Show selected badge
    const selEl = document.getElementById('charGenProfileSelected');
    const selName = document.getElementById('charGenProfileSelectedName');
    if (selEl && selName) {
        selName.textContent = name;
        selEl.style.display = '';
    }

    // Enable confirm
    const btn = document.getElementById('charGenProfileConfirmBtn');
    if (btn) btn.disabled = false;
}

function _filterCharGenProfiles(query) {
    const q = query.trim().toLowerCase();
    const filtered = q ? _charGenAllProfiles.filter(n => n.toLowerCase().includes(q)) : _charGenAllProfiles;
    _renderCharGenProfiles(filtered);
    // Re-apply selection highlight after re-render
    if (_charGenSelectedProfile && filtered.includes(_charGenSelectedProfile)) {
        _charGenSelectProfile(_charGenSelectedProfile);
    }
}

function _closeCharGenProfileModal() {
    const modal = document.getElementById('charGenProfileModal');
    if (modal) modal.style.display = 'none';
    _charGenPendingCharId = null;
    _charGenSelectedProfile = null;
}

// _confirmCharGenProfile is defined below — unified version handles both char and scene gen


function _pollCharGenStatus(taskId, charId, btn) {
    let polls = 0;
    const maxPolls = 50; // 50 * 3s = 150s max
    
    const interval = setInterval(async () => {
        polls++;
        if (polls > maxPolls) {
            clearInterval(interval);
            if (btn) { btn.disabled = false; btn.innerHTML = '🎨 AI Gen'; }
            toast('⏱ Quá thời gian chờ (150s)', 'error');
            return;
        }
        
        try {
            const status = await apiFetch(`/generate-status/${taskId}`);
            if (status.status === 'done') {
                clearInterval(interval);
                if (btn) { btn.disabled = false; btn.innerHTML = '🎨 AI Gen'; }
                toast('✅ Đã tạo ảnh nhân vật thành công!', 'success');
                loadExtractData();
            } else if (status.status === 'error') {
                clearInterval(interval);
                if (btn) { btn.disabled = false; btn.innerHTML = '🎨 AI Gen'; }
                const msg = status.message || '';
                if (msg.includes('Playwright load failed') || msg.includes('Crash:')) {
                    toast(`❌ Lỗi khởi động browser: ${msg}`, 'error');
                } else if (msg.includes('not logged') || msg.includes('login')) {
                    toast('❌ Profile chưa đăng nhập Grok! Thử lại và đăng nhập trong 60 giây.', 'error');
                } else if (msg.includes('Profile') && msg.includes('not found')) {
                    toast(`❌ Không tìm thấy profile browser. Kiểm tra lại cài đặt.`, 'error');
                } else if (msg.includes('Input box not found')) {
                    toast('❌ Grok đổi giao diện — không tìm thấy ô nhập. Báo lại để cập nhật.', 'error');
                } else if (msg.includes('Timeout')) {
                    toast('⏱ Grok không tạo ảnh trong thời gian chờ. Thử lại sau.', 'error');
                } else {
                    toast(`❌ Gen thất bại: ${msg || 'Lỗi không xác định'}`, 'error');
                }
            }
        } catch(e) {
            // Ignore poll errors
        }
    }, 3000);
}

// ── Scene AI Image Generation ──────────────────────────────
async function generateSceneRefAI(sceneId) {
    const scene = (window.currentCampaignScenes || []).find(s => s.id === sceneId);
    if (!scene) { toast('Scene not found', 'error'); return; }
    if (!scene.location || !scene.location.trim()) {
        toast(`Scene has no location description`, 'error');
        return;
    }
    // Auto-detect profile: wizard chips > campaign metadata > localStorage
    const autoProfile = _getAutoProfile();
    if (autoProfile) {
        // Skip modal — use saved profile directly
        const engine = _getVideoEngine();
        const btn = document.getElementById(`btnGenScene${sceneId}`);
        if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Generating...'; }
        try {
            const res = await apiFetch(`/scenes/${sceneId}/generate-ref`, {
                method: 'POST',
                body: JSON.stringify({ profile_name: autoProfile, engine }),
            });
            if (res.task_id) {
                const engineLabel = engine === 'veo3' ? 'Veo3' : 'Grok';
                toast(`🎨 [${engineLabel}] Đang tạo ảnh cảnh "${scene.location}"...`, 'info');
                _pollSceneGenStatus(res.task_id, sceneId, btn);
            }
        } catch(e) {
            toast('AI Generate failed: ' + e.message + ' — Hãy chọn lại profile', 'error');
            if (btn) { btn.disabled = false; btn.innerHTML = '🎨 AI Gen'; }
            // Fallback: show profile picker on error
            _sceneGenPendingSceneId = sceneId;
            _charGenPendingCharId = null;
            await _openCharGenProfileModal(null);
        }
    } else {
        // No profile found — show profile picker modal
        _sceneGenPendingSceneId = sceneId;
        await _openCharGenProfileModal(null);
        _charGenPendingCharId = null;
    }
}

let _sceneGenPendingSceneId = null;

// Override confirm to handle scene gen when _sceneGenPendingSceneId is set
const _origConfirmCharGen = typeof _confirmCharGenProfile === 'function' ? _confirmCharGenProfile : null;

async function _confirmCharGenProfile() {
    const profile = _charGenSelectedProfile;
    
    // Handle scene gen if pending
    if (_sceneGenPendingSceneId && profile) {
        const sceneId = _sceneGenPendingSceneId;
        _sceneGenPendingSceneId = null;
        
        const saveCheck = document.getElementById('charGenProfileSaveCheck');
        if (saveCheck && saveCheck.checked) {
            localStorage.setItem('cs_last_browser_profile', profile);
        }
        
        const modal = document.getElementById('charGenProfileModal');
        if (modal) modal.style.display = 'none';
        
        const scene = (window.currentCampaignScenes || []).find(s => s.id === sceneId);
        const btn = document.getElementById(`btnGenScene${sceneId}`);
        if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Generating...'; }
        
        try {
            const res = await apiFetch(`/scenes/${sceneId}/generate-ref`, {
                method: 'POST',
                body: JSON.stringify({ profile_name: profile, engine: _getVideoEngine() }),
            });
            
            if (res.task_id) {
                toast(`🎨 Đang tạo ảnh cảnh "${scene?.location || sceneId}"...`, 'info');
                _pollSceneGenStatus(res.task_id, sceneId, btn);
            }
        } catch(e) {
            toast('AI Generate failed: ' + e.message, 'error');
            if (btn) { btn.disabled = false; btn.innerHTML = '🎨 AI Gen'; }
        }
        return;
    }
    
    // Original char gen flow
    const charId = _charGenPendingCharId;
    if (!profile || !charId) return;
    
    const saveCheck = document.getElementById('charGenProfileSaveCheck');
    if (saveCheck && saveCheck.checked) {
        localStorage.setItem('cs_last_browser_profile', profile);
    }
    
    const modal = document.getElementById('charGenProfileModal');
    if (modal) modal.style.display = 'none';
    
    const char = (window.currentCampaignCharacters || []).find(c => c.id === charId);
    const btn = document.getElementById(`btnGenChar${charId}`);
    if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Generating...'; }
    
    try {
        const res = await apiFetch(`/characters/${charId}/generate-ref`, {
            method: 'POST',
            body: JSON.stringify({ profile_name: profile, engine: _getVideoEngine() }),
        });
        
        if (res.task_id) {
            toast(`🎨 Đang tạo ảnh nhân vật "${char?.name || charId}"...`, 'info');
            _pollCharGenStatus(res.task_id, charId, btn);
        }
    } catch(e) {
        toast('AI Generate failed: ' + e.message, 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = '🎨 AI Gen'; }
    }
}

function _pollSceneGenStatus(taskId, sceneId, btn) {
    let polls = 0;
    const maxPolls = 50;
    
    const interval = setInterval(async () => {
        polls++;
        if (polls > maxPolls) {
            clearInterval(interval);
            if (btn) { btn.disabled = false; btn.innerHTML = '🎨 AI Gen'; }
            toast('⏱ Quá thời gian chờ (150s)', 'error');
            return;
        }
        
        try {
            const status = await apiFetch(`/generate-status/${taskId}`);
            if (status.status === 'done') {
                clearInterval(interval);
                if (btn) { btn.disabled = false; btn.innerHTML = '🎨 AI Gen'; }
                toast('✅ Đã tạo ảnh cảnh thành công!', 'success');
                loadExtractData();
            } else if (status.status === 'error') {
                clearInterval(interval);
                if (btn) { btn.disabled = false; btn.innerHTML = '🎨 AI Gen'; }
                const msg = status.message || '';
                if (msg.includes('Timeout')) {
                    toast('⏱ Grok không tạo ảnh trong thời gian chờ. Thử lại sau.', 'error');
                } else {
                    toast(`❌ Gen thất bại: ${msg || 'Lỗi không xác định'}`, 'error');
                }
            }
        } catch(e) {
            // Ignore poll errors
        }
    }, 3000);
}

// ── Storyboard Breakdown ───────────────────────────────────
async function clearStoryboards() {
    if (!currentEpisode) return;
    if (!confirm('Xóa tất cả storyboard của tập này?')) return;
    try {
        const res = await apiFetch(`/episodes/${currentEpisode.id}/storyboards`, { method: 'DELETE' });
        if (res.status === 'ok') {
            toast('🗑 Storyboards cleared', 'success');
            // Reset UI
            document.getElementById('sbList').innerHTML = '';
            document.getElementById('sbList').style.display = 'none';
            document.getElementById('storyboardEmpty').style.display = '';
            document.getElementById('sbCount').textContent = '0 shots';
        }
    } catch(e) {
        toast(e.message || 'Error clearing storyboards', 'error');
    }
}

async function doBreakdown(append = false) {
    if (isStreaming) return;
    if (!currentEpisode) {
        toast('Select an episode first', 'error');
        return;
    }

    let script = currentEpisode?.script_content || currentEpisode?.content || '';
    const scriptEl = document.getElementById('scriptTextarea');
    if (scriptEl && scriptEl.value.trim().length > 0) {
        script = scriptEl.value;
    }
    const rawEl = document.getElementById('rawTextarea');
    if (!script.trim() && rawEl && rawEl.value.trim().length > 0) {
        script = rawEl.value;
    }

    if (!script.trim()) {
        toast('No script content. Complete AI Rewrite first.', 'error');
        setStep('script');
        return;
    }

    setStep('storyboard');
    isStreaming = true;
    document.getElementById('btnBreakdown').disabled = true;

    // Show loading
    document.getElementById('storyboardEmpty').style.display = 'none';
    const sbList = document.getElementById('sbList');
    if (!append) {
        sbList.style.display = 'none';
        sbList.innerHTML = '';
    }

    const stepPanel = document.getElementById('stepStoryboard');
    stepPanel.insertAdjacentHTML('beforeend',
        `<div class="step-loading" id="sbLoading">
            <div class="spinner"></div>
            <div class="loading-text">AI is breaking down the screenplay...</div>
            <div class="loading-meta" style="font-size:11px;color:var(--text-3);font-family:var(--font-mono);margin-top:4px">
                <span id="sbProgressChars">0</span> chars received · <span id="sbProgressTime">0</span>s elapsed
            </div>
        </div>`
    );
    const sbStartTime = Date.now();
    let sbCharCount = 0;
    const sbTimer = setInterval(() => {
        const el = document.getElementById('sbProgressTime');
        if (el) el.textContent = Math.floor((Date.now() - sbStartTime) / 1000);
    }, 1000);

    try {
        const response = await fetch(`${API}/episodes/${currentEpisode.id}/storyboard`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ append: append }),
            signal: typeof realtimeAbortController !== 'undefined' && realtimeAbortController ? realtimeAbortController.signal : undefined
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(err);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let storyboardData = null;
        let fullChunkText = '';
        let lastRenderedLength = 0;

        while (true) {
            if (typeof realtimeAbortController !== 'undefined' && realtimeAbortController && realtimeAbortController.signal.aborted) {
                reader.cancel();
                throw new Error("Aborted by user");
            }
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            const lines = text.split('\n');
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') break;
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.event === 'status') {
                        const loadEl = document.getElementById('sbLoading');
                        if (loadEl) {
                            const lt = loadEl.querySelector('.loading-text');
                            if (lt) lt.textContent = parsed.message;
                        }
                    }
                    if (parsed.event === 'progress_reasoning') {
                        const loadEl = document.getElementById('sbLoading');
                        if (loadEl) {
                            const lt = loadEl.querySelector('.loading-text');
                            if (lt) lt.textContent = `Thinking / Reasoning...`;
                        }
                    }
                    if (parsed.event === 'progress' && parsed.content) {
                        sbCharCount += parsed.content.length;
                        fullChunkText += parsed.content;
                        const cEl = document.getElementById('sbProgressChars');
                        if (cEl) cEl.textContent = sbCharCount;

                        // Real-time partial JSON rendering
                        if (fullChunkText.length - lastRenderedLength > 150) {
                            const chunks = fullChunkText.split('\n\n---\n\n');
                            let allShotsRendered = [];
                            
                            for (let c of chunks) {
                                let clean = c.trim();
                                if(clean.startsWith('```json')) clean = clean.substring(7);
                                else if(clean.startsWith('```')) clean = clean.substring(3);
                                clean = clean.trim();
                                
                                const idx = clean.indexOf('[');
                                if(idx !== -1) {
                                    let salvageTarget = clean.substring(idx);
                                    let parsedArr = null;
                                    for(let i = salvageTarget.length; i > 0; i--) {
                                        if(salvageTarget[i-1] === '}' || salvageTarget[i-1] === ']') {
                                            let candidate = salvageTarget.substring(0, i);
                                            if(candidate.endsWith('}')) candidate += ']';
                                            try {
                                                const arr = JSON.parse(candidate);
                                                if(Array.isArray(arr) && arr.length > 0) {
                                                    parsedArr = arr;
                                                    break;
                                                }
                                            } catch(e) {}
                                        }
                                    }
                                    if (parsedArr) {
                                        allShotsRendered = allShotsRendered.concat(parsedArr);
                                    }
                                }
                            }
                            
                            if (allShotsRendered.length > 0) {
                                renderStoryboard(allShotsRendered);
                                lastRenderedLength = fullChunkText.length;
                            }
                        }
                    }
                    if (parsed.event === 'complete') {
                        storyboardData = parsed;
                    }
                    if (parsed.event === 'error') {
                        throw new Error("BACKEND_ERR:" + parsed.message);
                    }
                } catch (e) {
                    if (e.message && e.message.startsWith("BACKEND_ERR:")) {
                        throw new Error(e.message.replace("BACKEND_ERR:", ""));
                    }
                    if (e.message && !e.message.includes('JSON')) throw e;
                }
            }
        }

        // Remove loading
        clearInterval(sbTimer);
        const loadEl = document.getElementById('sbLoading');
        if (loadEl) loadEl.remove();

        if (storyboardData && storyboardData.storyboards?.length) {
            renderStoryboard(storyboardData.storyboards);
            toast(`Created ${storyboardData.saved_count} storyboard shots!`, 'success');
        } else {
            document.getElementById('storyboardEmpty').style.display = '';
            toast('No storyboard data generated', 'error');
            throw new Error("No storyboard data generated");
        }
    } catch (e) {
        if (e.name === 'AbortError' || e.message === 'Aborted by user') {
            toast("Storyboard breakdown aborted.", "info");
            throw e;
        }
        const loadEl = document.getElementById('sbLoading');
        if (loadEl) loadEl.remove();
        document.getElementById('storyboardEmpty').style.display = '';
        toast(`Storyboard failed: ${e.message}`, 'error');
        throw e;
    } finally {
        isStreaming = false;
        document.getElementById('btnBreakdown').disabled = false;
    }
}


// ── Production Board (8 Zones) Toggle & Render ──

let currentSbView = 'board'; // 'board' or 'list'

function toggleSbView(view) {
    currentSbView = view;
    document.getElementById('btnViewBoard').className = view === 'board' ? 'btn btn-sm' : 'btn btn-sm btn-ghost';
    document.getElementById('btnViewBoard').style.background = view === 'board' ? 'var(--bg-0)' : '';
    document.getElementById('btnViewBoard').style.color = view === 'board' ? 'var(--text-1)' : 'var(--text-3)';
    
    document.getElementById('btnViewList').className = view === 'list' ? 'btn btn-sm' : 'btn btn-sm btn-ghost';
    document.getElementById('btnViewList').style.background = view === 'list' ? 'var(--bg-0)' : '';
    document.getElementById('btnViewList').style.color = view === 'list' ? 'var(--text-1)' : 'var(--text-3)';

    if (window.currentRenderedShots && window.currentRenderedShots.length > 0) {
        if (view === 'board') {
            document.getElementById('sbList').style.display = 'none';
            document.getElementById('productionBoard').style.display = 'grid';
            renderProductionBoard(window.currentRenderedShots);
        } else {
            document.getElementById('productionBoard').style.display = 'none';
            document.getElementById('sbList').style.display = '';
            // sbList is already populated by renderStoryboard
        }
    }
}

function renderProductionBoard(shots) {
    const container = document.getElementById('productionBoard');
    if (!shots || shots.length === 0) {
        container.style.display = 'none';
        return;
    }
    
    document.getElementById('sbViewToggles').style.display = 'flex';

    // Data Sources
    const chars = window.currentCampaignCharacters || [];
    const scenes = window.currentCampaignScenes || [];
    
    // Z1: Characters (find all unique characters in these shots)
    let activeCharIds = new Set();
    let activeCharNames = new Set();
    shots.forEach(s => {
        (s.character_ids || []).forEach(id => activeCharIds.add(id));
        (s.character_names || []).forEach(n => activeCharNames.add(n));
    });
    
    let boardChars = chars.filter(c => activeCharIds.has(c.id) || activeCharNames.has(c.name));
    if (boardChars.length === 0) boardChars = chars.slice(0, 4);

    // Z2: Environment
    const scene = scenes.length > 0 ? scenes[0] : null;

    // Z5-Z8: Extract from scene
    const lighting = scene && scene.lighting_style ? scene.lighting_style : 'Natural / Cinematic';
    const emotions = scene && scene.mood ? scene.mood.split(',').map(m => m.trim()).filter(Boolean) : ['Dramatic', 'Intense'];
    const props = scene && scene.material_refs ? scene.material_refs.split(',').map(m => m.trim()).filter(Boolean) : [];
    
    // Scene element tags from description
    const sceneElements = [];
    if (scene) {
        if (scene.location) sceneElements.push(scene.location);
        if (scene.description) {
            scene.description.split(',').slice(0, 6).forEach(d => {
                const t = d.trim();
                if (t && t.length < 30) sceneElements.push(t);
            });
        }
    }

    // Helper: get total duration
    const totalDur = shots.reduce((sum, s) => sum + (s.duration || 5), 0);
    let cumTime = 0;

    container.innerHTML = `
        <!-- Zone 1: Characters -->
        <div class="pb-zone pb-z1">
            <div class="pb-zone-header">
                <span class="pb-zh-cn">Characters</span>
                <span class="pb-zh-en">STYLING & REFERENCE</span>
            </div>
            <div class="pb-char-list">
                ${boardChars.map(c => {
                    const imgUrl = _getCharRefUrl(c);
                    const descLines = [];
                    if (c.appearance) descLines.push({label: 'Appearance', val: c.appearance});
                    if (c.personality) descLines.push({label: 'Personality', val: c.personality});
                    if (c.description) descLines.push({label: 'Note', val: c.description});
                    return `
                    <div class="pb-char-item" style="flex-direction:column; gap:8px; padding:10px;">
                        <div style="display:flex; gap:10px; align-items:center;">
                            ${imgUrl
                              ? `<img src="${imgUrl}" class="pb-char-img" style="width:56px;height:72px;border-radius:6px;border:1px solid rgba(0,200,220,0.3);" />`
                              : `<div class="pb-char-img" style="width:56px;height:72px;border-radius:6px;background:#1e293b;display:flex;align-items:center;justify-content:center;">
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                                 </div>`}
                            <div>
                                <div class="pb-char-name">${esc(c.name)}</div>
                                <div class="pb-char-role">${esc(c.role || 'character')}</div>
                            </div>
                        </div>
                        ${descLines.length > 0 ? `
                        <div style="display:flex;flex-direction:column;gap:4px;border-top:1px solid rgba(255,255,255,0.06);padding-top:6px;">
                            ${descLines.map(d => `
                                <div style="font-size:11px;line-height:1.4;">
                                    <span style="color:#00c8dc;font-weight:600;">${d.label}:</span>
                                    <span style="color:#94a3b8;">${esc(d.val.substring(0,80))}${d.val.length > 80 ? '…' : ''}</span>
                                </div>
                            `).join('')}
                        </div>` : ''}
                    </div>
                    `;
                }).join('') || '<div style="color:#64748b;font-size:12px;padding:12px;">No characters assigned</div>'}
            </div>
        </div>

        <!-- Zone 2: Environment -->
        <div class="pb-zone pb-z2">
            <div class="pb-zone-header">
                <span class="pb-zh-cn">Environment</span>
                <span class="pb-zh-en">SCENE DESIGN</span>
            </div>
            ${scene ? `
                <div class="pb-env-view">
                    <div class="pb-env-img-wrap">
                        ${_getSceneRefUrl(scene)
                          ? `<img src="${_getSceneRefUrl(scene)}" class="pb-env-img" onerror="this.parentElement.innerHTML='<div style=\\'width:100%;height:100%;background:#1e293b;display:flex;align-items:center;justify-content:center;color:#475569;\\'>No Image</div>'">`
                          : '<div style="width:100%;height:100%;background:#1e293b;display:flex;align-items:center;justify-content:center;color:#475569;font-size:12px;">No Scene Image</div>'}
                        <div class="pb-env-name">${esc(scene.name || scene.location || 'Scene')}</div>
                    </div>
                    <div class="pb-env-desc">${esc(scene.description || scene.location || '')}</div>
                    ${sceneElements.length > 0 ? `
                    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">
                        ${sceneElements.map(e => `<span class="pb-pill">${esc(e)}</span>`).join('')}
                    </div>` : ''}
                </div>
            ` : '<div style="color:#64748b;font-size:12px;">No scene data available</div>'}
        </div>

        <!-- Zone 3: Storyboard Panels -->
        <div class="pb-zone pb-z3">
            <div class="pb-zone-header">
                <span class="pb-zh-cn">Shots (${shots.length}) · ${totalDur}s</span>
                <span class="pb-zh-en">STORYBOARD PANELS</span>
            </div>
            <div class="pb-panels">
                ${shots.map((s, idx) => {
                    const dur = s.duration || 5;
                    const startT = cumTime;
                    cumTime += dur;
                    const timeLabel = startT + '-' + cumTime + 's';
                    const thumbUrl = s.composed_image ? '/api/v1/pod_studio/references/' + encodeURIComponent(s.composed_image.replace(/\\\\/g, '/').split('/').pop()) : null;
                    return `
                        <div class="pb-panel">
                            <div class="pb-panel-head">
                                <span class="pb-panel-num">SHOT ${s.storyboard_number || (idx+1)}</span>
                                <span class="pb-panel-time">${esc(s.shot_type || '')} · ${esc(s.angle || '')} · ${timeLabel}</span>
                            </div>
                            ${thumbUrl ? `<img src="${thumbUrl}" style="width:100%;height:80px;object-fit:cover;border-radius:4px;margin-bottom:6px;border:1px solid rgba(0,200,220,0.2);" onerror="this.style.display='none'">` : ''}
                            ${s.title ? `<div class="pb-panel-title">${esc(s.title)}</div>` : ''}
                            ${s.action ? `<div class="pb-panel-action">${esc(s.action)}</div>` : ''}
                            ${s.dialogue ? `<div class="pb-panel-dialogue">"${esc(s.dialogue)}"</div>` : ''}
                        </div>
                    `;
                }).join('')}
            </div>
        </div>

        <!-- Zone 4: Blocking & Movement (Map Style) -->
        <div class="pb-zone pb-z4" style="padding:0;overflow:hidden;">
            <div class="pb-zone-header" style="padding:16px 16px 12px;">
                <span class="pb-zh-cn">Blocking</span>
                <span class="pb-zh-en">CAMERA MOVEMENT MAP</span>
            </div>
            <div style="display:flex;gap:0;min-height:220px;">
                <!-- Left: Scene Map with Shot Markers -->
                <div style="flex:1;position:relative;min-height:220px;overflow:hidden;border-right:1px solid rgba(0,200,220,0.15);">
                    ${(() => {
                        // Priority: Panorama image > Scene image > none
                        let _epMeta = {};
                        try { _epMeta = JSON.parse(currentEpisode?.metadata || '{}'); } catch(e) {}
                        const panoramaUrl = _epMeta.panorama_image_url || null;
                        const sceneUrl = panoramaUrl || (scene ? _getSceneRefUrl(scene) : null);
                        const isPanorama = !!panoramaUrl;

                        // Generate marker positions
                        const n = shots.length;
                        const positions = [];

                        for (let i = 0; i < n; i++) {
                            const s = shots[i];
                            // Try AI spatial_position first
                            let sp = s.spatial_position || null;
                            if (!sp) {
                                try {
                                    const sMeta = JSON.parse(s.metadata || '{}');
                                    sp = sMeta.spatial_position || null;
                                } catch(e) {}
                            }

                            if (sp && sp.zone && sp.depth) {
                                // Map spatial_position to x,y coordinates
                                const zoneX = { left: 15, 'center-left': 30, center: 50, 'center-right': 70, right: 85 };
                                const depthY = { foreground: 80, midground: 50, background: 20 };
                                positions.push({
                                    x: zoneX[sp.zone] || 50,
                                    y: depthY[sp.depth] || 50,
                                    anchor: sp.anchor_element || ''
                                });
                            } else {
                                // Fallback: S-curve
                                const progress = n > 1 ? i / (n - 1) : 0.5;
                                const isLeft = i % 2 === 0;
                                const x = isLeft ? 20 + progress * 25 : 75 - progress * 25;
                                const y = 15 + progress * 70;
                                positions.push({ x, y, anchor: '' });
                            }
                        }
                        
                        // Build SVG path lines
                        let pathD = '';
                        if (positions.length > 1) {
                            pathD = 'M ' + positions[0].x + ' ' + positions[0].y;
                            for (let i = 1; i < positions.length; i++) {
                                const prev = positions[i-1];
                                const curr = positions[i];
                                const cpx = (prev.x + curr.x) / 2;
                                const cpy = prev.y + (curr.y - prev.y) * 0.3;
                                pathD += ' Q ' + cpx + ' ' + cpy + ' ' + curr.x + ' ' + curr.y;
                            }
                        }
                        
                        return `
                        <!-- Scene background (dimmed) -->
                        ${sceneUrl ? `<img src="${sceneUrl}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:brightness(${isPanorama ? '0.4' : '0.3'}) saturate(0.5);z-index:0;" onerror="this.style.display='none'">` : ''}
                        <div style="position:absolute;inset:0;background:rgba(10,22,40,${sceneUrl ? '0.4' : '0.9'});z-index:1;"></div>
                        
                        <!-- SVG Overlay: paths + markers -->
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;z-index:2;">
                            <!-- Movement path line -->
                            ${pathD ? `
                            <path d="${pathD}" fill="none" stroke="rgba(0,200,220,0.15)" stroke-width="0.8" stroke-dasharray="2,2"/>
                            <path d="${pathD}" fill="none" stroke="rgba(0,200,220,0.5)" stroke-width="0.4"/>
                            ` : ''}
                            
                            <!-- Shot markers -->
                            ${positions.map((p, i) => `
                                <circle cx="${p.x}" cy="${p.y}" r="3.5" fill="rgba(10,22,40,0.8)" stroke="${i === 0 ? '#f59e0b' : '#00c8dc'}" stroke-width="0.5"/>
                                <text x="${p.x}" y="${p.y + 1.2}" text-anchor="middle" fill="${i === 0 ? '#fbbf24' : '#fff'}" font-size="3" font-weight="700" font-family="sans-serif">${shots[i].storyboard_number || (i+1)}</text>
                            `).join('')}
                            
                            <!-- Direction arrows between markers -->
                            ${positions.length > 1 ? positions.slice(0, -1).map((p, i) => {
                                const next = positions[i+1];
                                const mx = (p.x + next.x) / 2;
                                const my = (p.y + next.y) / 2;
                                const angle = Math.atan2(next.y - p.y, next.x - p.x) * 180 / Math.PI;
                                return `<polygon points="${mx},${my-0.8} ${mx+1.5},${my} ${mx},${my+0.8}" fill="rgba(0,200,220,0.6)" transform="rotate(${angle},${mx},${my})"/>`;
                            }).join('') : ''}
                        </svg>
                        
                        <!-- Legend -->
                        <div style="position:absolute;bottom:8px;left:10px;z-index:3;display:flex;gap:12px;font-size:10px;color:#94a3b8;">
                            <span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f59e0b;margin-right:4px;"></span>Start</span>
                            <span><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#00c8dc;margin-right:4px;"></span>Shot</span>
                            <span style="color:rgba(0,200,220,0.5);">― Path</span>
                            ${isPanorama ? '<span style="color:#f59e0b;">📍 Panorama</span>' : ''}
                        </div>
                        `;
                    })()}
                </div>
                <!-- Right: Shot Movement List -->
                <div style="width:280px;padding:8px 12px;overflow-y:auto;max-height:280px;display:flex;flex-direction:column;gap:6px;font-size:11px;">
                    <div style="font-size:10px;color:rgba(0,200,220,0.7);font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">${shots.length} shots sequence</div>
                    ${shots.map((s, idx) => {
                        const move = s.movement || 'static';
                        const isTracking = move.toLowerCase().includes('track') || move.toLowerCase().includes('dolly') || move.toLowerCase().includes('pan');
                        return `
                        <div style="display:flex;gap:8px;align-items:flex-start;padding:4px 0;${idx < shots.length - 1 ? 'border-bottom:1px solid rgba(255,255,255,0.04);' : ''}">
                            <div style="width:18px;height:18px;border-radius:50%;background:${idx === 0 ? 'rgba(245,158,11,0.2)' : 'rgba(0,200,220,0.15)'};color:${idx === 0 ? '#fbbf24' : '#00c8dc'};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;">${s.storyboard_number || (idx+1)}</div>
                            <div style="min-width:0;">
                                <span style="color:#fff;font-weight:600;">${esc(move)}</span>
                                ${isTracking ? '<span style="margin-left:4px;font-size:9px;padding:1px 4px;border-radius:3px;background:rgba(0,200,220,0.15);color:#00c8dc;">↗</span>' : ''}
                                <div style="color:#94a3b8;margin-top:2px;line-height:1.3;">${esc((s.title || s.action || '').substring(0, 60))}</div>
                            </div>
                        </div>`;
                    }).join('')}
                </div>
            </div>
        </div>

        <!-- Bottom Row (Zones 5, 6, 7, 8) -->
        <div class="pb-bottom-row">
            <div class="pb-zone">
                <div class="pb-zone-header" style="margin-bottom:8px;padding-bottom:8px;">
                    <span class="pb-zh-cn" style="font-size:13px;">Lighting</span>
                    <span class="pb-zh-en" style="font-size:9px;">ATMOSPHERE</span>
                </div>
                <div style="font-size:12px; color:#cbd5e1; line-height:1.6;">${esc(lighting)}</div>
            </div>
            
            <div class="pb-zone">
                <div class="pb-zone-header" style="margin-bottom:8px;padding-bottom:8px;">
                    <span class="pb-zh-cn" style="font-size:13px;">Emotions</span>
                    <span class="pb-zh-en" style="font-size:9px;">MOOD & TONE</span>
                </div>
                <div class="pb-pill-container">
                    ${emotions.map(e => `<span class="pb-pill glow">${esc(e)}</span>`).join('')}
                </div>
            </div>

            <div class="pb-zone">
                <div class="pb-zone-header" style="margin-bottom:8px;padding-bottom:8px;">
                    <span class="pb-zh-cn" style="font-size:13px;">Sound</span>
                    <span class="pb-zh-en" style="font-size:9px;">SFX & BGM</span>
                </div>
                <div style="font-size:11px; color:#cbd5e1; display:flex; flex-direction:column; gap:6px;">
                    ${shots.filter(s => s.sound_effect).slice(0,4).map(s => `<div>🎵 ${esc(s.sound_effect)}</div>`).join('')}
                    ${shots.filter(s => s.bgm_prompt).slice(0,1).map(s => `<div style="color:#fcd34d;">🎼 ${esc(s.bgm_prompt)}</div>`).join('')}
                    ${shots.filter(s => s.sound_effect).length === 0 && shots.filter(s => s.bgm_prompt).length === 0 ? '<div style="color:#475569;">No sound data</div>' : ''}
                </div>
            </div>

            <div class="pb-zone">
                <div class="pb-zone-header" style="margin-bottom:8px;padding-bottom:8px;">
                    <span class="pb-zh-cn" style="font-size:13px;">Props</span>
                    <span class="pb-zh-en" style="font-size:9px;">DETAILS & ITEMS</span>
                </div>
                <div class="pb-pill-container">
                    ${props.length > 0
                      ? props.map(p => `<span class="pb-pill">${esc(p)}</span>`).join('')
                      : '<span style="color:#475569;font-size:11px;">No props data</span>'}
                </div>
            </div>
        </div>
    `;
}


function renderStoryboard(shots) {
    window.currentRenderedShots = shots;
    const sbList = document.getElementById('sbList');
    if (shots && shots.length > 0) { toggleSbView(currentSbView); } else { sbList.style.display = ''; document.getElementById('productionBoard').style.display = 'none'; document.getElementById('sbViewToggles').style.display = 'none'; }

    // Hide the empty-state placeholder
    document.getElementById('storyboardEmpty').style.display = 'none';

    document.getElementById('sbCount').textContent = `${shots.length} shots`;

    sbList.innerHTML = shots.map((s, i) => {
        const num = String(i + 1).padStart(2, '0');
        const shotMeta = [s.shot_type, s.angle, s.movement].filter(Boolean).join(' · ');
        const chars = (s.character_names || []).join(', ');
        const dur = s.duration || 12;

        let illustLayout = s.illustrate_layout || '';
        let assets = s.reference_asset_names || [];
        let effects = s.reference_effect_names || [];
        try {
            if (s.metadata) {
                const meta = typeof s.metadata === 'string' ? JSON.parse(s.metadata) : s.metadata;
                if (meta.illustrate_layout) illustLayout = meta.illustrate_layout;
                if (meta.reference_asset_names) assets = meta.reference_asset_names;
                if (meta.reference_effect_names) effects = meta.reference_effect_names;
            }
        } catch(e) {}
        
        const assetsStr = Array.isArray(assets) ? assets.join(', ') : assets;
        const effectsStr = Array.isArray(effects) ? effects.join(', ') : effects;

        return `
            <div class="sb-item" onclick="toggleSbDetail(this)">
                <div class="sb-num">${num}</div>
                <div class="sb-body">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start">
                        <div class="sb-title">${esc(s.title || `Shot ${num}`)}</div>
                        <div style="display:flex;gap:4px">
                            <button class="btn btn-sm btn-ghost" style="padding:2px 6px;font-size:10px;border:1px solid var(--border)" onclick="copyShotPrompt(event, ${i}, 'image')" title="Copy Image Prompt & Context">Copy IMG</button>
                            ${s.video_prompt ? `<button class="btn btn-sm btn-ghost" style="padding:2px 6px;font-size:10px;border:1px solid var(--border)" onclick="copyShotPrompt(event, ${i}, 'video')" title="Copy Video Prompt & Context">Copy VID</button>` : ''}
                        </div>
                    </div>
                    <div class="sb-desc">${esc(s.action || s.description || '')}</div>
                    <div class="sb-tags">
                        ${shotMeta ? `<span class="tag tag-outline">${esc(shotMeta)}</span>` : ''}
                        ${s.location ? `<span class="tag tag-outline">📍 ${esc(s.location)}</span>` : ''}
                        <span class="tag tag-outline">⏱ ${dur}s</span>
                        ${chars ? `<span class="tag tag-outline">👤 ${esc(chars)}</span>` : ''}
                        ${assetsStr ? `<span class="tag tag-outline" style="border-color:#34d399;color:#34d399">📊 ${esc(assetsStr)}</span>` : ''}
                        ${effectsStr ? `<span class="tag tag-outline" style="border-color:#a78bfa;color:#a78bfa">✨ ${esc(effectsStr)}</span>` : ''}
                        ${illustLayout ? `<span class="tag tag-outline" style="border-color:#fbbf24;color:#fbbf24">🎨 Layout: ${esc(illustLayout.substring(0,30) + (illustLayout.length>30?'...':''))}</span>` : ''}
                    </div>
                    <div class="sb-detail" style="display:none">
                        ${s.dialogue ? `<div class="sb-field"><span class="sb-field-label">💬 Dialogue</span><div class="sb-field-value">${esc(s.dialogue)}</div></div>` : ''}
                        ${s.description ? `<div class="sb-field"><span class="sb-field-label">📝 Description</span><div class="sb-field-value">${esc(s.description)}</div></div>` : ''}
                        ${s.result ? `<div class="sb-field"><span class="sb-field-label">🎯 Result</span><div class="sb-field-value">${esc(s.result)}</div></div>` : ''}
                        ${s.atmosphere ? `<div class="sb-field"><span class="sb-field-label">🌙 Atmosphere</span><div class="sb-field-value">${esc(s.atmosphere)}</div></div>` : ''}
                        ${illustLayout ? `<div class="sb-field"><span class="sb-field-label" style="color:#fbbf24">🎨 Illustrate Layout</span><div class="sb-field-value">${esc(illustLayout)}</div></div>` : ''}
                        ${s.image_prompt ? `<div class="sb-field"><span class="sb-field-label">🖼️ Image Prompt</span><div class="sb-field-value mono">${esc(s.image_prompt)}</div></div>` : ''}
                        ${s.video_prompt ? `<div class="sb-field"><span class="sb-field-label">🎬 Video Prompt</span><div class="sb-field-value mono">${esc(s.video_prompt)}</div></div>` : ''}
                        ${s.bgm_prompt ? `<div class="sb-field"><span class="sb-field-label">🎵 BGM</span><div class="sb-field-value">${esc(s.bgm_prompt)}</div></div>` : ''}
                        ${s.sound_effect ? `<div class="sb-field"><span class="sb-field-label">🔊 SFX</span><div class="sb-field-value">${esc(s.sound_effect)}</div></div>` : ''}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function toggleSbDetail(el) {
    const detail = el.querySelector('.sb-detail');
    if (detail) {
        const isOpen = detail.style.display !== 'none';
        detail.style.display = isOpen ? 'none' : '';
        el.classList.toggle('expanded', !isOpen);
    }
}

function copyShotPrompt(e, idx, type = 'image') {
    e.stopPropagation();
    const shots = window.currentRenderedShots || [];
    const shot = shots[idx];
    if (!shot) return;

    const basePrompt = type === 'video' ? (shot.video_prompt || shot.image_prompt || '') : (shot.image_prompt || '');
    
    // Character info
    const chars = window.currentCampaignCharacters || [];
    const shotCharNames = shot.character_names || []; 
    const shotCharIds = shot.character_ids || [];     
    
    let charsInfo = [];
    if (shotCharIds.length > 0) {
        charsInfo = chars.filter(c => shotCharIds.includes(c.id));
    } else if (shotCharNames.length > 0) {
        charsInfo = chars.filter(c => shotCharNames.includes(c.name));
    }

    const charText = charsInfo.map(c => `- ${c.name} (${c.role || 'Minor'}): ${c.description || ''}`).join('\n');
    
    // Scene info
    const scenes = window.currentCampaignScenes || [];
    let sceneInfo = null;
    if (shot.scene_id) {
        sceneInfo = scenes.find(s => s.id === shot.scene_id);
    } else if (shot.location) {
        sceneInfo = scenes.find(s => s.location === shot.location);
    }
    
    const sceneText = sceneInfo ? `${sceneInfo.location} (${sceneInfo.time || 'Day'}): ${sceneInfo.description || ''}` : `${shot.location || ''} ${shot.time || ''}`;
    
    const promptHeader = type === 'video' ? '[VIDEO PROMPT]' : '[IMAGE PROMPT]';
    const finalPrompt = `${promptHeader}\n${basePrompt}\n\n[CHARACTERS]\n${charText || 'None'}\n\n[SCENE SETTING]\n${sceneText || 'None'}`;
    
    navigator.clipboard.writeText(finalPrompt.trim()).then(() => {
        toast(`Copied ${type === 'video' ? 'Video' : 'Image'} Context!`, 'success');
    }).catch(() => {
        toast('Failed to copy', 'error');
    });
}

// ── Export ──────────────────────────────────────────────────
async function exportEpisode(format = 'md') {
    if (!currentEpisode) return;
    try {
        const result = await apiFetch(`/episodes/${currentEpisode.id}/export`, {
            method: 'POST',
            body: JSON.stringify({ format: format }),
        });
        // Create downloadable blob
        const blob = new Blob([result.content || JSON.stringify(result.data, null, 2)], {
            type: format === 'json' ? 'application/json' : 'text/plain;charset=utf-8'
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = result.filename || `export.${format}`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast('Exported!', 'success');
    } catch (e) {
        toast('Export failed', 'error');
    }
}

// ── AI Chat ────────────────────────────────────────────────
function handleChatKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChat();
    }
}

async function sendChat() {
    if (isStreaming) return;
    const input = document.getElementById('chatInput');
    const message = input.value.trim();
    if (!message) return;

    const messagesEl = document.getElementById('chatMessages');

    // Clear welcome
    const welcome = messagesEl.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    // Add user message
    appendChatMsg(message, 'user');
    input.value = '';

    // Add streaming assistant message
    const assistantEl = appendChatMsg('', 'assistant', true);

    isStreaming = true;
    document.getElementById('chatSend').disabled = true;

    try {
        const response = await fetch(`${API}/agent/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agent_type: document.getElementById('agentSelect').value,
                message,
                episode_id: currentEpisode?.id,
                campaign_id: currentCampaign?.id,
            }),
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            const lines = text.split('\n');
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') break;
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.content) {
                        fullText += parsed.content;
                        assistantEl.textContent = fullText;
                        messagesEl.scrollTop = messagesEl.scrollHeight;
                    }
                } catch (e) {}
            }
        }

        assistantEl.classList.remove('streaming');
        // Highlight AI errors visually
        if (fullText.startsWith('\u274c')) {
            assistantEl.style.color = '#ef4444';
            assistantEl.style.background = 'rgba(239,68,68,0.08)';
            assistantEl.style.borderLeft = '3px solid #ef4444';
            assistantEl.style.paddingLeft = '10px';
        }
    } catch (e) {
        assistantEl.textContent = `❌ Error: ${e.message}`;
    } finally {
        isStreaming = false;
        document.getElementById('chatSend').disabled = false;
    }
}

function appendChatMsg(text, role, streaming = false) {
    const messagesEl = document.getElementById('chatMessages');
    const el = document.createElement('div');
    el.className = `chat-msg ${role}${streaming ? ' streaming' : ''}`;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
}

// ── Char count helpers ─────────────────────────────────────
function updateRawCount() {
    const val = document.getElementById('rawTextarea').value;
    document.getElementById('rawCharCount').textContent = `${val.length} chars`;
}
function updateScriptCount() {
    const val = document.getElementById('scriptTextarea').value;
    document.getElementById('scriptCharCount').textContent = `${val.length} chars`;
}

// ── Gen Audio Integration ──────────────────────────────────
let rawAudioPollInterval = null;
let ttsVoicesCache = [];

async function generateRawAudio() {
    const text = document.getElementById('rawTextarea').value.trim();
    if (!text) {
        toast("Please provide raw content first to generate audio.", "error");
        return;
    }

    document.getElementById('audioGenModal').style.display = 'flex';
    const select = document.getElementById('audioGenVoice');
    
    if(!window.ttsVoicesCache || window.ttsVoicesCache.length === 0) {
        select.innerHTML = '<option value="">Loading voices...</option>';
        try {
            const res = await apiFetch('/../tts/voices');
            if (res.success && res.voices) window.ttsVoicesCache = res.voices;
            else window.ttsVoicesCache = [];
        } catch(e) {
            console.warn('Failed to load TTS voices', e);
            window.ttsVoicesCache = [];
        }
    }
    
    if (window.ttsVoicesCache && window.ttsVoicesCache.length > 0) {
        let edgeHtml = '<optgroup label="Edge-TTS (Online)">';
        let vibeHtml = '<optgroup label="VibeVoice (Offline)">';
        let geminiHtml = '<optgroup label="Gemini (Online via automation)">';
        
        const targetLang = (typeof currentCampaign !== 'undefined' && currentCampaign && currentCampaign.language) 
            ? currentCampaign.language.toLowerCase() 
            : null;
            
        let hasProfiles = false;
        window.ttsVoicesCache.forEach(v => {
            if (targetLang && targetLang !== 'auto' && v.engine !== 'gemini') {
                const vLang = (v.language || '').toLowerCase();
                const vLangName = (v.language_name || '').toLowerCase();
                const tLangLower = targetLang.toLowerCase();
                // Match prefix (e.g. "ja" matches "ja-JP") or contained string
                if (!vLang.includes(tLangLower) && !tLangLower.includes(vLang) && !vLangName.includes(tLangLower) && !tLangLower.includes(vLangName)) {
                    return;
                }
            }
            
            hasProfiles = true;
            const langPart = v.language_name || v.language;
            const namePart = v.name;
            const genderPart = v.gender ? ` (${v.gender})` : '';
            
            const optionHtml = `<option value="${v.id}" data-engine="${v.engine}">${langPart} - ${namePart}${genderPart}</option>`;
            if (v.engine === 'edge') edgeHtml += optionHtml;
            else if (v.engine === 'gemini') geminiHtml += optionHtml;
            else vibeHtml += optionHtml;
        });
        edgeHtml += '</optgroup>';
        vibeHtml += '</optgroup>';
        geminiHtml += '</optgroup>';
        
        if (!hasProfiles) {
            select.innerHTML = '<option value="">No voices match the project language</option>';
        } else {
            select.innerHTML = vibeHtml + edgeHtml;
            // Provide a sensible default selection
            for (let i = 0; i < select.options.length; i++) {
                if (targetLang && targetLang === 'vi' && select.options[i].value.includes('HoaiMy')) {
                    select.selectedIndex = i;
                    break;
                } else if (!targetLang && select.options[i].value.includes('HoaiMy')) {
                    select.selectedIndex = i;
                    break;
                }
            }
        }
    } else {
        select.innerHTML = '<option value="">Error loading voices</option>';
    }
}

async function confirmGenerateRawAudio() {
    const text = document.getElementById('rawTextarea').value.trim();
    const select = document.getElementById('audioGenVoice');
    const selectedOption = select.options[select.selectedIndex];
    
    if (!selectedOption || !selectedOption.value) {
        toast("Please select a valid voice.", "error");
        return;
    }
    
    const voiceId = selectedOption.value;
    const engine = selectedOption.getAttribute('data-engine') || 'edge';
    
    document.getElementById('audioGenModal').style.display = 'none';

    const btn = document.getElementById('btnGenAudio');
    const oldHtml = btn.innerHTML;
    btn.innerHTML = 'Starting TTS...';
    btn.disabled = true;

    try {
        const res = await apiFetch('/../tts/synthesize', {
            method: 'POST',
            body: JSON.stringify({
                text: text,
                voice: voiceId,
                engine: engine
            })
        });

        if (res.success && res.task_id) {
            toast("Audio generation started. It runs in the background.", "info");
            
            // Poll for status
            rawAudioPollInterval = setInterval(async () => {
                try {
                    const statusRes = await apiFetch(`/../tts/status/${res.task_id}`);
                    if (!statusRes.success) return;
                    
                    if (statusRes.status === 'processing') {
                        btn.innerHTML = 'Generating...';
                    } else if (statusRes.status === 'success') {
                        clearInterval(rawAudioPollInterval);
                        rawAudioPollInterval = null;
                        
                        btn.innerHTML = oldHtml;
                        btn.disabled = false;
                        toast("Audio generated successfully!", "success");
                        // Extract filename from absolute path
                        let outputPath = statusRes.result.output || "";
                        let filename = outputPath.split(/[\\/]/).pop();
                        
                        if (filename) {
                            const audioUrl = `/api/v1/tts/audio/${filename}`;
                            document.getElementById('rawAudioPlayerContainer').style.display = 'flex';
                            document.getElementById('rawAudioPlayer').src = audioUrl;
                            document.getElementById('rawAudioDownload').href = audioUrl;
                            document.getElementById('audioStatus').textContent = `Audio generated! (${selectedOption.text})`;

                            if (currentEpisode) {
                                currentEpisode.audio_url = audioUrl;
                                apiFetch(`/episodes/${currentEpisode.id}`, {
                                    method: 'PUT',
                                    body: JSON.stringify({ audio_url: audioUrl })
                                }).catch(e => console.error("Failed to save audio_url", e));
                            }
                        }
                    } else if (statusRes.status === 'error') {
                        clearInterval(rawAudioPollInterval);
                        rawAudioPollInterval = null;
                        btn.innerHTML = oldHtml;
                        btn.disabled = false;
                        toast("Audio generation failed.", "error");
                    }
                } catch (e) {
                    console.error("Audio polling error", e);
                }
            }, 2000);
            
        } else {
            throw new Error("Failed to start TTS task");
        }
    } catch (e) {
        toast("TTS Error: " + e.message, "error");
        btn.innerHTML = oldHtml;
        btn.disabled = false;
    }
}

// ── Toast ──────────────────────────────────────────────────
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

// ── Auto-Pilot Realtime & Background ───────────────────────────
let apPollingInterval = null;
let realtimeAbortController = null;

async function startBackgroundAutoPilot() {
    if (!pendingAutoPilotCampaignId) return;
    try {
        await apiFetch(`/campaigns/${pendingAutoPilotCampaignId}/start-autopilot`, { method: 'POST' });
        
        document.getElementById('wizStep3').style.display = 'none';
        document.getElementById('wizStepProgress').style.display = '';
        document.getElementById('wizardDesc').textContent = 'Generating in background...';
        
        // Start polling
        apPollingInterval = setInterval(pollBackgroundStatus, 3000);
        pollBackgroundStatus();
    } catch (e) {
        toast("Failed to start engine: " + e.message, "error");
    }
}

async function pollBackgroundStatus() {
    if (!pendingAutoPilotCampaignId) return;
    try {
        const res = await apiFetch(`/campaigns/${pendingAutoPilotCampaignId}/autopilot-status`);
        document.getElementById('wizStatusText').textContent = res.status;
        document.getElementById('wizProgressBar').style.width = res.progress + '%';
        
        if (res.status === 'completed' || res.status.startsWith('failed') || res.status.startsWith('error')) {
            clearInterval(apPollingInterval);
            apPollingInterval = null;
            if (res.status === 'completed') {
                toast("Auto-pilot generation completed!", "success");
            }
        }
    } catch (e) {
        // Ignore polling errors
    }
}

window.resumeAutoPilot = function() {
    if (!currentCampaign) return;
    pendingAutoPilotCampaignId = currentCampaign.id;
    window.pendingAutoPilotIsResume = true;
    
    let outline;
    try { outline = JSON.parse(currentCampaign.metadata).series_outline; } catch(e) {}
    
    if (!outline || !outline.episodes) {
        outline = { episodes: [], series_title: currentCampaign.title };
    }
    
    // Pad outline to support manually added DB episodes
    if (currentCampaign && currentCampaign.episodes) {
        let maxEpNum = currentCampaign.episodes.reduce((max, ep) => Math.max(max, ep.episode_number || 1), outline.episodes.length);
        while (outline.episodes.length < maxEpNum) {
            const nextNum = outline.episodes.length + 1;
            outline.episodes.push({
                episode_number: nextNum,
                title: `Episode ${nextNum}`,
                plot_outline: `Manual episode plot outline...`
            });
        }
    }
    
    if (outline && outline.episodes && outline.episodes.length > 0) {
        document.getElementById('wizardModal').style.display = 'flex';
        document.getElementById('wizStep1').style.display = 'none';
        document.getElementById('wizStep2').style.display = 'none';
        document.getElementById('wizStep3').style.display = '';
        document.getElementById('wizStepProgress').style.display = 'none';
        
        document.getElementById('wizInd1').className = 'wiz-step done';
        document.getElementById('wizInd2').className = 'wiz-step done';
        document.getElementById('wizInd3').className = 'wiz-step active';
        document.getElementById('wizLine1').className = 'wiz-step-line active';
        document.getElementById('wizLine2').className = 'wiz-step-line active';
        
        document.getElementById('wizOutlineTitle').textContent = outline.series_title || "Proposed Episodes (Resume)";
        
        let outlineHtml = '';
        outline.episodes.forEach((ep) => {
            outlineHtml += `
                <div style="background:var(--bg-2); border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:10px;">
                    <h4 style="margin:0 0 5px 0; color:var(--accent);">Episode ${ep.episode_number}: ${esc(ep.title)}</h4>
                    <p style="margin:0; font-size:13px; color:var(--text-2); line-height:1.4;">${esc(ep.plot_outline)}</p>
                </div>
            `;
        });
        document.getElementById('wizOutlineReview').innerHTML = outlineHtml;
        
        // Load browser profiles into chip selector, pre-select from campaign metadata
        _loadBrowserProfilesIntoSelect('wizBrowserProfileExec').then(() => {
            // Try to restore browser profiles from campaign metadata first
            let restored = false;
            if (currentCampaign) {
                try {
                    const meta = JSON.parse(currentCampaign.metadata || '{}');
                    const savedProfiles = meta.browser_profile_names_video || (meta.browser_profile_name ? [meta.browser_profile_name] : []);
                    if (savedProfiles.length > 0) {
                        _chipSelectedProfiles = savedProfiles.filter(s => s && _browserProfilesCache.some(p => p.name === s));
                        _syncChipsToSelect();
                        restored = true;
                    }
                } catch(e) {}
            }
            if (!restored) _initChipsFromSaved();
            _renderBrowserChips();
        });

        // Restore video engine dropdown from campaign metadata
        if (currentCampaign) {
            try {
                const meta = JSON.parse(currentCampaign.metadata || '{}');
                if (meta.video_engine) {
                    const wizEngEl = document.getElementById('wizVideoEngine');
                    if (wizEngEl) {
                        wizEngEl.value = meta.video_engine;
                        onVideoEngineChange();
                    }
                    localStorage.setItem('cs_video_engine', meta.video_engine);
                }
            } catch(e) {}
        }

        // Restore preset dropdown if campaign was created from a queue job
        if (currentCampaign) {
            try {
                const meta = JSON.parse(currentCampaign.metadata || '{}');
                const jobId = meta.auto_pipeline_job_id;
                if (jobId) {
                    // Fetch the original job to get preset_name
                    apiFetch(`/auto-pipeline/jobs/${jobId}`).then(res => {
                        if (res.success && res.job && res.job.preset_name) {
                            const presetSel = document.getElementById('wizPresetSelect');
                            if (presetSel) {
                                // Make sure presets are loaded
                                loadWizPresets();
                                presetSel.value = res.job.preset_name;
                            }
                        }
                    }).catch(() => {});
                }
            } catch(e) {}
        }
        
        // Voice profile loading and display logic
        const pSteps = getCurrentPipeline();
        const vWrap = document.getElementById('wizVoiceProfileWrap');
        if (vWrap) {
            if (pSteps.includes('audio') || pSteps.includes('videos')) {
                vWrap.style.display = 'flex';
                // Also update the browser profile label if videos included
                if (pSteps.includes('videos')) {
                    const bpLabel = document.querySelector('label.field span.field-label:not(#wizVoiceProfileWrap span)');
                    if (bpLabel && bpLabel.textContent.includes('Browser')) {
                        bpLabel.textContent = _getVideoEngine() === 'veo3' ? '🌐 Browser Profile (Veo3 AI Gen)' : '🌐 Browser Profile (Grok AI Gen)';
                    }
                }
                const targetLan = (typeof currentCampaign !== 'undefined' && currentCampaign && currentCampaign.language) 
                                    ? currentCampaign.language 
                                    : (document.getElementById('wizLanguage') ? document.getElementById('wizLanguage').value : null);
                // Load voices then auto-select from campaign metadata (voice_preset)
                _loadVoiceProfilesIntoSelect('wizVoiceProfileExec', targetLan).then(() => {
                    // The _loadVoiceProfilesIntoSelect already tries currentCampaign.metadata.voice_preset
                    // But voice_preset format is "voiceId|engine", need to match just voiceId
                    if (currentCampaign) {
                        try {
                            const meta = JSON.parse(currentCampaign.metadata || '{}');
                            const savedVoice = meta.voice_preset || meta.tts_voice || '';
                            if (savedVoice) {
                                const voiceId = savedVoice.split('|')[0]; // strip engine suffix
                                const sel = document.getElementById('wizVoiceProfileExec');
                                if (sel) {
                                    for (let i = 0; i < sel.options.length; i++) {
                                        if (sel.options[i].value === voiceId || sel.options[i].value === savedVoice) {
                                            sel.selectedIndex = i;
                                            break;
                                        }
                                    }
                                }
                            }
                        } catch(e) {}
                    }
                });
            } else {
                vWrap.style.display = 'none';
            }
        }

        // Restore upload targets from campaign metadata
        if (currentCampaign) {
            try {
                const meta = JSON.parse(currentCampaign.metadata || '{}');
                const savedTargets = meta.upload_targets || [];
                const savedPrivacy = meta.upload_privacy || 'private';
                // Pre-load YT/FB dropdowns and select saved values
                const ytTarget = savedTargets.find(t => t.provider === 'youtube');
                const fbTarget = savedTargets.find(t => t.provider === 'facebook');
                if (ytTarget) {
                    const sel = document.getElementById('wizYtChannel');
                    if (sel && !_wizYtLoaded) {
                        const tempName = ytTarget.channel_name || ytTarget.channel_id || '⏳ Loading...';
                        sel.innerHTML = `<option value="">None (không upload)</option><option value='${JSON.stringify(ytTarget).replace(/'/g, "&#39;")}' selected>📺 ${tempName}</option>`;
                    }
                    loadWizYtChannels().then(() => {
                        if (sel) {
                            const targetVal = JSON.stringify(ytTarget);
                            for (let i = 0; i < sel.options.length; i++) {
                                if (sel.options[i].value === targetVal) { sel.selectedIndex = i; break; }
                            }
                        }
                    });
                }
                if (fbTarget) {
                    const sel = document.getElementById('wizFbPage');
                    if (sel && !_wizFbLoaded) {
                        const tempName = fbTarget.page_name || fbTarget.channel_id || '⏳ Loading...';
                        sel.innerHTML = `<option value="">None (không upload)</option><option value='${JSON.stringify(fbTarget).replace(/'/g, "&#39;")}' selected>📘 ${tempName}</option>`;
                    }
                    loadWizFbPages().then(() => {
                        if (sel) {
                            const targetVal = JSON.stringify(fbTarget);
                            for (let i = 0; i < sel.options.length; i++) {
                                if (sel.options[i].value === targetVal) { sel.selectedIndex = i; break; }
                            }
                        }
                    });
                }
                const privSel = document.getElementById('wizUploadPrivacy');
                if (privSel) privSel.value = savedPrivacy;
            } catch(e) {}
        }
    } else {
        toast("No auto-generated outline exists for this project.", "error");
    }
}

// ── REALTIME VISUAL AUTO PILOT ─────────────────────────────
let isAutoPilotRunning = false;
async function startRealtimeAutoPilot() {
    if (!pendingAutoPilotCampaignId) return;
    if (isAutoPilotRunning) return;
    
    // Save selected profiles from wizard to localStorage + campaign metadata
    const wizProfileSel = document.getElementById('wizBrowserProfileExec');
    let selectedVideoProfiles = wizProfileSel ? Array.from(wizProfileSel.selectedOptions).map(o => o.value).filter(Boolean) : [];
    // Fallback: if chip UI has values (may not yet be synced) use those
    if (selectedVideoProfiles.length === 0 && _chipSelectedProfiles.length > 0) {
        selectedVideoProfiles = [..._chipSelectedProfiles];
        _syncChipsToSelect(); // force sync
    }
    // Last-resort fallback: use localStorage saved value
    if (selectedVideoProfiles.length === 0) {
        const lsFallback = (localStorage.getItem('cs_last_browser_profile_video') || localStorage.getItem('cs_last_browser_profile') || '').split(',').filter(Boolean);
        if (lsFallback.length > 0) selectedVideoProfiles = lsFallback;
    }
    const selectedProfile = selectedVideoProfiles.length > 0 ? selectedVideoProfiles[0] : '';
    const wizVoiceSel = document.getElementById('wizVoiceProfileExec');
    let selectedVoice = wizVoiceSel ? wizVoiceSel.value : '';
    
    if (wizVoiceSel && wizVoiceSel.selectedIndex >= 0 && selectedVoice) {
        const engineAttr = wizVoiceSel.options[wizVoiceSel.selectedIndex].getAttribute('data-engine') || 'edge';
        if (!selectedVoice.includes('|')) {
            selectedVoice = `${selectedVoice}|${engineAttr}`;
        }
    }
    
    // Always persist video_engine + profile to campaign metadata
    try {
        const campaignData = await apiFetch(`/campaigns/${pendingAutoPilotCampaignId}`);
        const meta = JSON.parse(campaignData.metadata || '{}');
        
        // Always save video engine
        meta.video_engine = _getVideoEngine();

        // Save image engine + image browser profile (separate from video)
        const wizImgEngine = document.getElementById('wizImageEngine');
        if (wizImgEngine && wizImgEngine.value) meta.image_engine = wizImgEngine.value;
        const wizImgBrowser = document.getElementById('wizImageBrowserProfile');
        if (wizImgBrowser && wizImgBrowser.value) meta.image_browser_profile = wizImgBrowser.value;
        
        if (selectedProfile) {
            meta.browser_profile_name = selectedProfile;
            localStorage.setItem('cs_last_browser_profile', selectedProfile);
        }
        if (selectedVoice) {
            localStorage.setItem('cs_last_voice_profile', selectedVoice);
        }
        if (selectedVideoProfiles.length > 0) meta.browser_profile_names_video = selectedVideoProfiles;
        
        const vWrap = document.getElementById('wizVoiceProfileWrap');
        if (selectedVoice && vWrap && vWrap.style.display !== 'none') {
            meta.voice_preset = selectedVoice;
            if (wizVoiceSel.selectedIndex >= 0) {
                const opt = wizVoiceSel.options[wizVoiceSel.selectedIndex];
                meta.tts_engine = opt.getAttribute('data-engine') || 'vibe';
            }
        }
        
        // Save upload targets from Step 3
        const wizUploadTargets = [];
        const wizYtVal = document.getElementById('wizYtChannel')?.value;
        if (wizYtVal) try { wizUploadTargets.push(JSON.parse(wizYtVal)); } catch(e) {}
        const wizFbVal = document.getElementById('wizFbPage')?.value;
        if (wizFbVal) try { wizUploadTargets.push(JSON.parse(wizFbVal)); } catch(e) {}
        if (wizUploadTargets.length > 0) {
            meta.upload_targets = wizUploadTargets;
        }
        const privVal = document.getElementById('wizUploadPrivacy')?.value;
        if (privVal) meta.upload_privacy = privVal;
        
        await apiFetch(`/campaigns/${pendingAutoPilotCampaignId}`, {
            method: 'PUT',
            body: JSON.stringify({ metadata: JSON.stringify(meta) })
        });
    } catch(e) { console.warn('Could not save metadata', e); }
    
    isAutoPilotRunning = true;
    
    hideWizard();
    
    // Save the episode the user was viewing before selectCampaign resets it
    const isResume = !!window.pendingAutoPilotIsResume;
    window.pendingAutoPilotIsResume = false;
    const savedResumeEpNumber = (isResume && currentEpisode) ? currentEpisode.episode_number : null;
    
    // Refresh sidebar data so the newly created project appears
    await loadCampaigns();
    
    // Load Campaign into the workspace
    await selectCampaign(pendingAutoPilotCampaignId);
    
    // Verify an outline exists
    if (!currentCampaign || !currentCampaign.metadata) return;
    let outline;
    try { 
        outline = JSON.parse(currentCampaign.metadata).series_outline; 
    } catch(e) {}
    
    if (!outline || !outline.episodes) {
        outline = { episodes: [] };
    }
    
    // Pad outline to support manually added DB episodes
    if (currentCampaign && currentCampaign.episodes) {
        let maxEpNum = currentCampaign.episodes.reduce((max, ep) => Math.max(max, ep.episode_number || 1), outline.episodes.length);
        while (outline.episodes.length < maxEpNum) {
            const nextNum = outline.episodes.length + 1;
            outline.episodes.push({
                episode_number: nextNum,
                title: `Episode ${nextNum}`,
                plot_outline: ``
            });
        }
    }
    
    if (outline.episodes.length === 0) {
        toast("No episodes exist to run.", "error"); return;
    }
    
    realtimeAbortController = new AbortController();
    document.getElementById('floatStopBtn').style.display = 'flex';
    
    toast("Starting Visual Auto-Pilot Sequence...", "info");

    const pipeline = getCurrentPipeline();
    
    try {
        let startIndex = 0;
        if (isResume && savedResumeEpNumber) {
            let foundIdx = outline.episodes.findIndex((epPlan, idx) => (epPlan.episode_number || idx + 1) === savedResumeEpNumber);
            if (foundIdx >= 0) {
                startIndex = foundIdx;
                toast(`🚀 Auto-Pilot resuming directly from Episode ${savedResumeEpNumber}...`, "info");
            }
        }
        
        for (let i = startIndex; i < outline.episodes.length; i++) {
            const epPlan = outline.episodes[i];
            let success = false;
            let isRetry = false;
            let retryCount = 0;
            
            while (!success) {
                if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                
                try {
                    // 1. Ensure episode exists in UI
                    let ep = currentCampaign.episodes.find(e => e.episode_number === (epPlan.episode_number || i+1));
                    if (!ep) {
                        // we technically need to add an episode
                        await addEpisode(currentCampaign.id);
                        // `addEpisode` auto-selects the newly created episode as `currentEpisode`
                        currentEpisode.title = epPlan.title || `Episode ${i+1}`;
                        await apiFetch(`/episodes/${currentEpisode.id}`, {
                            method: 'PUT',
                            body: JSON.stringify({ title: currentEpisode.title })
                        });
                    } else {
                        await selectEpisode(ep.id);
                    }
                    
                    // 2. Stream Novel (Skip if already has content)
                    if (currentEpisode.content && currentEpisode.content.trim().length > 50) {
                        toast(`Skipping Novel generation for ${currentEpisode.title}`, "info");
                        document.getElementById('rawTextarea').value = currentEpisode.content;
                    } else {
                        setStep('raw');
                        const novelPrompt = `Episode Title: ${epPlan.title}\nPlot Outline: ${epPlan.plot_outline}`;
                        await _runAgentStreamAction('novel_writer', novelPrompt, 'rawTextarea', 'rawCharCount');
                        if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                        await saveCurrentEpisode();
                    }
                    
                    // 3. Stream Script (Skip if not in pipeline or already has content)
                    if (pipeline.includes('rewrite')) {
                    if (currentEpisode.script_content && currentEpisode.script_content.trim().length > 50) {
                        toast(`Skipping Script generation for ${currentEpisode.title}`, "info");
                        document.getElementById('scriptTextarea').value = currentEpisode.script_content;
                    } else {
                        setStep('rewrite');
                        const proseContent = document.getElementById('rawTextarea').value;
                        const scriptPrompt = `Please write the formatted screenplay for this episode.\n\n${proseContent}`;
                        await _runAgentStreamAction('script_rewriter', scriptPrompt, 'scriptTextarea', 'scriptCharCount');
                        if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                        await saveCurrentEpisode();
                    }
                    }
                    
                    // Parse episode metadata (needed by extract + storyboard)
                    let epMeta = {};
                    try { epMeta = JSON.parse(currentEpisode.metadata || "{}"); } catch(e){}
                    
                    // 4. Extract (skip if not in pipeline)
                    // Uses epMeta.extract_completed flag (saved per-episode) to decide
                    if (pipeline.includes('extract')) {
                        setStep('extract');
                        
                        // Re-read episode metadata (may have been updated by a previous run)
                        try {
                            const freshEp = await apiFetch(`/episodes/${currentEpisode.id}`);
                            currentEpisode = freshEp;
                            epMeta = {};
                            try { epMeta = JSON.parse(currentEpisode.metadata || '{}'); } catch(e) {}
                        } catch(e) {}
                        
                        const extractDone = !!epMeta.extract_completed;
                        
                        if (!extractDone || isRetry) {
                            // Need to run extraction (text analysis)
                            toast(`Running full Extract for ${currentEpisode.title}...`, "info");
                            await doExtract();
                            // doExtract() now sets extract_completed=true on success
                            // Re-read epMeta after doExtract
                            try { epMeta = JSON.parse(currentEpisode.metadata || '{}'); } catch(e) {}
                        } else {
                            toast(`⏭️ Extract already completed for ${currentEpisode.title}`, "info");
                        }
                        
                        // Now check for missing reference images (regardless of whether we just extracted or skipped)
                        let allScenes = [];
                        let allChars = [];
                        try {
                            const sceneRes = await apiFetch(`/campaigns/${currentCampaign.id}/scenes`);
                            allScenes = (sceneRes && sceneRes.items) ? sceneRes.items : [];
                            const charRes = await apiFetch(`/campaigns/${currentCampaign.id}/characters`);
                            allChars = (charRes && charRes.items) ? charRes.items : [];
                        } catch(e) {
                            console.warn('[AutoPilot] Could not fetch chars/scenes:', e);
                        }
                        
                        let missingScenes = allScenes.filter(sc => !sc.image_url);
                        let missingChars = allChars.filter(ch => !ch.image_url);
                        const totalMissing = missingScenes.length + missingChars.length;
                        
                        if (totalMissing === 0) {
                            toast(`✅ All ${allChars.length} chars + ${allScenes.length} scenes have images`, "info");
                        } else {
                            toast(`🎨 Generating ${totalMissing} missing images (${missingChars.length} chars, ${missingScenes.length} scenes)...`, "info");
                            
                            // Resolve browser profile + engine
                            let imgProfile = '';
                            let imgEngine = 'grok';
                            try {
                                const campaignMeta = JSON.parse(currentCampaign.metadata || '{}');
                                imgProfile = campaignMeta.browser_profile_name || '';
                                imgEngine = campaignMeta.video_engine || 'grok';
                            } catch(e) {}
                            if (!imgProfile) imgProfile = localStorage.getItem('cs_last_browser_profile') || '';
                            
                            if (!imgProfile) {
                                toast(`⚠️ No browser profile — cannot generate images. Select a profile first.`, "warning");
                            } else {
                                // Generate missing character images sequentially
                                for (let ci = 0; ci < missingChars.length; ci++) {
                                    if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                                    const ch = missingChars[ci];
                                    toast(`🎨 [${ci+1}/${totalMissing}] Generating char image: ${(ch.name || '').substring(0, 25)}...`, "info");
                                    try {
                                        const genRes = await apiFetch(`/characters/${ch.id}/generate-ref`, {
                                            method: 'POST',
                                            body: JSON.stringify({ profile_name: imgProfile, engine: imgEngine })
                                        });
                                        if (genRes.task_id) {
                                            for (let poll = 0; poll < 60; poll++) {
                                                await new Promise(r => setTimeout(r, 3000));
                                                if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                                                try {
                                                    const st = await apiFetch(`/generate-status/${genRes.task_id}`);
                                                    if (st.status === 'done') {
                                                        toast(`✅ Char image done: ${(ch.name || '').substring(0, 25)}`, "success");
                                                        try { loadExtractData(); } catch(e) {}
                                                        break;
                                                    } else if (st.status === 'error') {
                                                        toast(`⚠️ Char image error: ${st.message || 'unknown'}`, "warning");
                                                        break;
                                                    }
                                                } catch(e) { break; }
                                            }
                                        }
                                    } catch(e) {
                                        toast(`⚠️ Failed to generate char image: ${e.message}`, "warning");
                                    }
                                }
                                
                                // Generate missing scene images sequentially
                                for (let si = 0; si < missingScenes.length; si++) {
                                    if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                                    const sc = missingScenes[si];
                                    toast(`🎨 [${missingChars.length + si + 1}/${totalMissing}] Generating scene image: ${(sc.location || '').substring(0, 25)}...`, "info");
                                    try {
                                        const genRes = await apiFetch(`/scenes/${sc.id}/generate-ref`, {
                                            method: 'POST',
                                            body: JSON.stringify({ profile_name: imgProfile, engine: imgEngine })
                                        });
                                        if (genRes.task_id) {
                                            for (let poll = 0; poll < 60; poll++) {
                                                await new Promise(r => setTimeout(r, 3000));
                                                if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                                                try {
                                                    const st = await apiFetch(`/generate-status/${genRes.task_id}`);
                                                    if (st.status === 'done') {
                                                        toast(`✅ Scene image done: ${(sc.location || '').substring(0, 25)}`, "success");
                                                        try { loadExtractData(); } catch(e) {}
                                                        break;
                                                    } else if (st.status === 'error') {
                                                        toast(`⚠️ Scene image error: ${st.message || 'unknown'}`, "warning");
                                                        break;
                                                    }
                                                } catch(e) { break; }
                                            }
                                        }
                                    } catch(e) {
                                        toast(`⚠️ Failed to generate scene image: ${e.message}`, "warning");
                                    }
                                }
                                
                                toast(`✅ Image generation complete for ${currentEpisode.title}`, "success");
                            }
                        }
                    }
                    if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                    
                    // 5. Storyboard (skip if not in pipeline)
                    if (pipeline.includes('storyboard')) {
                    await new Promise(r => setTimeout(r, 2000));
                    setStep('storyboard');
                    
                    // Re-read episode metadata
                    try { epMeta = JSON.parse(currentEpisode.metadata || '{}'); } catch(e) {}
                    
                    let existingShots = [];
                    try {
                        const sbRes = await apiFetch(`/episodes/${currentEpisode.id}/storyboards`);
                        existingShots = sbRes.items || [];
                    } catch(e) {}
                    
                    const sbDone = !!epMeta.storyboard_completed;
                    
                    if ((existingShots.length > 0 || sbDone) && !isRetry) {
                        toast(`Skipping Storyboard for ${currentEpisode.title} (${existingShots.length} shots exist)`, "info");
                        if (existingShots.length > 0) renderStoryboard(existingShots);
                    } else if (existingShots.length > 0 && isRetry) {
                        toast(`Resuming Storyboard generation from shot ${existingShots.length + 1}...`, "info");
                        await doBreakdown(true);
                    } else {
                        await doBreakdown(false);
                    }
                    
                    // Mark storyboard as completed in episode metadata
                    try {
                        let freshMeta = {};
                        try { freshMeta = JSON.parse(currentEpisode.metadata || '{}'); } catch(e) {}
                        if (!freshMeta.storyboard_completed) {
                            freshMeta.storyboard_completed = true;
                            await apiFetch(`/episodes/${currentEpisode.id}`, {
                                method: 'PUT',
                                body: JSON.stringify({ metadata: JSON.stringify(freshMeta) })
                            });
                            currentEpisode.metadata = JSON.stringify(freshMeta);
                            epMeta = freshMeta;
                        }
                    } catch(e) { console.warn('[AutoPilot] Could not save storyboard_completed flag', e); }
                    
                    if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                    }
                    
                    // 5.5 Auto Grid Generation (after storyboard, before video/image gen)
                    // Run grid gen when: storyboard is in pipeline, OR panoramic mode + images pipeline
                    const _isPanoramicMode = (() => { try { return JSON.parse(currentCampaign.metadata || '{}').scene_gen_mode === 'panoramic_grid'; } catch(e) { return false; } })();
                    if (pipeline.includes('storyboard') || (_isPanoramicMode && pipeline.includes('images'))) {
                        try {
                            let gridMeta = {};
                            try { gridMeta = JSON.parse(currentEpisode.metadata || '{}'); } catch(e) {}
                            
                            if (gridMeta.master_grid_prompt && !gridMeta.grid_image_url) {
                                toast(`🎨 Auto Grid: Generating concept grid via Veo3...`, "info");
                                
                                let browserProfile = '';
                                try {
                                    const campaignMeta = JSON.parse(currentCampaign.metadata || '{}');
                                    browserProfile = campaignMeta.browser_profile_name || campaignMeta.browser_profile || '';
                                } catch(e) {}
                                if (!browserProfile) browserProfile = localStorage.getItem('cs_last_browser_profile') || '';
                                
                                if (browserProfile) {
                                    try {
                                        const gridRes = await apiFetch(`/campaigns/${currentCampaign.id}/episodes/${currentEpisode.id}/generate-grid`, {
                                            method: 'POST',
                                            body: JSON.stringify({
                                                prompt: gridMeta.master_grid_prompt,
                                                profile_name: browserProfile,
                                                engine: 'veo3'
                                            })
                                        });
                                        
                                        if (gridRes.success && gridRes.image_url) {
                                            toast(`✅ Grid image generated! Auto-slicing...`, "success");
                                            gridMeta.grid_image_url = gridRes.image_url;
                                            currentEpisode.metadata = JSON.stringify(gridMeta);
                                            
                                            // Auto-determine grid dimensions
                                            const sbRes2 = await apiFetch(`/episodes/${currentEpisode.id}/storyboards`);
                                            const shotCount = (sbRes2.items || []).length;
                                            let cols = 3, rows = 3;
                                            if (shotCount <= 4) { cols = 2; rows = 2; }
                                            else if (shotCount <= 6) { cols = 3; rows = 2; }
                                            else if (shotCount <= 8) { cols = 4; rows = 2; }
                                            else if (shotCount <= 9) { cols = 3; rows = 3; }
                                            else if (shotCount <= 12) { cols = 4; rows = 3; }
                                            else { cols = 4; rows = 4; }
                                            
                                            // Auto-slice
                                            const sliceRes = await apiFetch(`/campaigns/${currentCampaign.id}/episodes/${currentEpisode.id}/slice-grid`, {
                                                method: 'POST',
                                                body: JSON.stringify({
                                                    image_url: gridRes.image_url,
                                                    cols: cols,
                                                    rows: rows
                                                })
                                            });
                                            
                                            if (sliceRes.success) {
                                                toast(`✅ Grid sliced into ${sliceRes.sliced_count} shot references!`, "success");
                                            }
                                        }
                                    } catch(gridErr) {
                                        console.warn('[AutoPilot] Grid generation failed, continuing pipeline:', gridErr);
                                        toast(`⚠️ Grid gen failed: ${gridErr.message}. Continuing...`, "warning");
                                    }
                                } else {
                                    toast(`⚠️ No browser profile — skipping auto grid gen`, "warning");
                                }
                            } else if (gridMeta.grid_image_url) {
                                toast(`⏭️ Grid image already exists, skipping`, "info");
                            }
                        } catch(e) { console.warn('[AutoPilot] Grid check error:', e); }
                        
                        if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                    }

                    // 6. Image Generation via Grok (skip if not in pipeline)
                    // Check scene gen mode — panoramic_grid uses grid slice, not per-shot
                    let _sceneGenMode = 'per_shot';
                    try { _sceneGenMode = JSON.parse(currentCampaign.metadata || '{}').scene_gen_mode || 'per_shot'; } catch(e) {}
                    
                    if (pipeline.includes('images') && _sceneGenMode === 'panoramic_grid') {
                        toast(`🖼️ Panoramic Grid mode: Ảnh các shot đã được tạo từ Grid slice. Bỏ qua per-shot image gen.`, "info");
                        setStep('images');
                    } else if (pipeline.includes('images')) {
                    await new Promise(r => setTimeout(r, 2000));
                    setStep('images');
                    
                    const imgSbRes = await apiFetch(`/episodes/${currentEpisode.id}/storyboards`);
                    const imgShots = imgSbRes.items || [];
                    const pendingImgShots = imgShots.filter(s => s.image_prompt && !s.composed_image);
                    
                    if (pendingImgShots.length === 0 && imgShots.length > 0) {
                        toast(`Skipping Image gen for ${currentEpisode.title} (all ${imgShots.length} images done)`, "info");
                        await loadEpisodeImages().catch(e => {});
                    } else if (pendingImgShots.length > 0) {
                        let browserProfile = '';
                        try {
                            const campaignMeta = JSON.parse(currentCampaign.metadata || '{}');
                            browserProfile = campaignMeta.browser_profile_name || campaignMeta.browser_profile_path || '';
                        } catch(e) {}
                        if (!browserProfile) browserProfile = localStorage.getItem('cs_last_browser_profile') || '';
                        
                        if (!browserProfile) {
                            toast(`⚠️ No browser profile set — skipping image gen for ${currentEpisode.title}`, "warning");
                        } else {
                            toast(`🖼 Auto Grok image gen: ${pendingImgShots.length} shots for ${currentEpisode.title}`, "info");
                            
                            const genRes = await apiFetch(`/episodes/${currentEpisode.id}/gen-images`, {
                                method: 'POST',
                                body: JSON.stringify({ profile_name: browserProfile, headless: false, overwrite: false })
                            });
                            
                            if (genRes.success) {
                                _activeGenImageTaskId = genRes.task_id;
                                document.getElementById('imagesEmpty').style.display = 'none';
                                document.getElementById('imgProgressSection').style.display = 'block';
                                document.getElementById('imgProgressSection').style.border = '';
                                document.getElementById('imgProgressBar').style.width = '0%';
                                document.getElementById('imgProgressCount').textContent = `0 / ${genRes.total || 1}`;
                                document.getElementById('imgProgressLabel').textContent = 'Generating images...';
                                
                                await _waitForImageGenCompletion(genRes.task_id, genRes.total);
                                _activeGenImageTaskId = null;
                            }
                        }
                    }
                    
                    if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                    }

                    // 6.5. Video Generation via Grok (skip if not in pipeline)
                    if (pipeline.includes('videos')) {
                    await new Promise(r => setTimeout(r, 2000));
                    setStep('videos');
                    
                    const vidSbRes = await apiFetch(`/episodes/${currentEpisode.id}/storyboards`);
                    const vidShots = vidSbRes.items || [];
                    const pendingVidShots = vidShots.filter(s => s.image_prompt && !s.video_url);
                    
                    if (pendingVidShots.length === 0 && vidShots.length > 0) {
                        toast(`Skipping Video gen for ${currentEpisode.title} (all ${vidShots.length} videos done)`, "info");
                        await loadEpisodeVideos().catch(e => {});
                    } else if (pendingVidShots.length > 0) {
                        let browserProfileNames = [];
                        let campaignMeta = {};
                        try {
                            campaignMeta = JSON.parse(currentCampaign.metadata || '{}');
                            
                            if (campaignMeta.browser_profile_names_video && campaignMeta.browser_profile_names_video.length > 0) {
                                browserProfileNames = campaignMeta.browser_profile_names_video;
                            } else {
                                const fallback = campaignMeta.browser_profile_name || campaignMeta.browser_profile_path || '';
                                if (fallback) browserProfileNames = [fallback];
                            }
                        } catch(e) {}
                        
                        if (browserProfileNames.length === 0) {
                            const fallbackStr = localStorage.getItem('cs_last_browser_profile_video');
                            if (fallbackStr) {
                                browserProfileNames = fallbackStr.split(',');
                            } else {
                                const older = localStorage.getItem('cs_last_browser_profile');
                                if (older) browserProfileNames = [older];
                            }
                        }
                        
                        if (browserProfileNames.length === 0) {
                            toast(`⚠️ No browser profile set — skipping video gen for ${currentEpisode.title}`, "warning");
                        } else {
                            const engineName = (campaignMeta.video_engine || localStorage.getItem('cs_video_engine') || 'grok') === 'veo3' ? 'Veo3' : 'Grok';
                            toast(`🎞 Auto ${engineName} video gen: ${pendingVidShots.length} shots for ${currentEpisode.title}`, "info");
                            
                            const genRes = await apiFetch(`/episodes/${currentEpisode.id}/gen-videos`, {
                                method: 'POST',
                                body: JSON.stringify({ profile_names: browserProfileNames, headless: false, overwrite: false, engine: campaignMeta.video_engine || localStorage.getItem('cs_video_engine') || 'grok' })
                            });
                            
                            if (genRes.success) {
                                _activeGenVideoTaskId = genRes.task_id;
                                document.getElementById('videosEmpty').style.display = 'none';
                                document.getElementById('vidProgressSection').style.display = 'block';
                                document.getElementById('vidProgressSection').style.border = '';
                                document.getElementById('vidProgressBar').style.width = '0%';
                                document.getElementById('vidProgressCount').textContent = `0 / ${genRes.total || 1}`;
                                document.getElementById('vidProgressLabel').textContent = 'Generating videos...';
                                
                                await _waitForVideoGenCompletion(genRes.task_id, genRes.total);
                                _activeGenVideoTaskId = null;
                            }
                        }
                    }
                    if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                    }

                    // 6+. Audio Generation (TTS) explicitly in step 6
                    if (pipeline.includes('audio')) {
                        await new Promise(r => setTimeout(r, 2000));
                        setStep('audio');
                        let audioReady = !!currentEpisode.audio_url;
                        if (!audioReady) {
                            try {
                                const sbRes = await apiFetch(`/episodes/${currentEpisode.id}/storyboards`);
                                const shots = sbRes.items || [];
                                if (shots.length > 0) {
                                    const withAudio = shots.filter(s => s.tts_audio_url && s.tts_audio_url.trim()).length;
                                    if (withAudio === shots.length) audioReady = true;
                                }
                            } catch(e) {}
                        }

                        if (audioReady && !isRetry) {
                            toast(`⏭️ Skipping Audio TTS for ${currentEpisode.title}`, "info");
                            document.getElementById('audioStatus').textContent = 'Audio ready';
                            document.getElementById('audioEmpty').style.display = 'none';
                            if (currentEpisode.audio_url) {
                                document.getElementById('audioPlayerSection').style.display = 'flex';
                                document.getElementById('audioStepPlayer').src = currentEpisode.audio_url;
                                document.getElementById('audioStepDownload').href = currentEpisode.audio_url;
                            }
                        } else {
                            toast(`🎙️ Generating TTS Audio for ${currentEpisode.title}...`, "info");
                            document.getElementById('audioStatus').textContent = 'Starting TTS...';
                            document.getElementById('audioEmpty').style.display = 'flex'; 
                            document.querySelector('#audioEmpty .empty-title').textContent = 'Generating TTS...';
                            document.querySelector('#audioEmpty .empty-desc').textContent = 'Please wait, synthesizing via external engine.';
                            
                            let voiceId = null, engine = null, voiceLabel = 'Auto Voice';
                            if (selectedVoice) {
                                const parts = selectedVoice.split('|'); 
                                voiceId = parts[0];
                                engine = parts[1] || 'edge';
                                try {
                                    const wizVoiceSel = document.getElementById('wizVoiceProfileExec');
                                    if (wizVoiceSel && wizVoiceSel.options && wizVoiceSel.selectedIndex >= 0) {
                                        voiceLabel = wizVoiceSel.options[wizVoiceSel.selectedIndex].text;
                                    }
                                } catch(e){}
                            }
                            
                            const audioResult = await _generateVideoTTS(voiceId, engine);
                            
                            if (audioResult === 'per_shot_audio') {
                                // Batch TTS generated per-shot audio (Gemini mode)
                                // Each shot's tts_audio_url is already saved in DB
                                // FFmpeg will pick them up automatically
                                toast(`✅ Per-shot audio generated for ${currentEpisode.title}`, 'success');
                                document.getElementById('audioStatus').textContent = `Audio generated! (${voiceLabel})`;
                                document.getElementById('audioEmpty').style.display = 'none';
                            } else if (audioResult === 'tts_skipped') {
                                // TTS failed but we continue gracefully
                                toast('⚠️ Audio TTS skipped, continuing...', 'warning');
                                document.getElementById('audioStatus').textContent = 'TTS Skipped';
                            } else if (audioResult) {
                                // Single audio file URL (legacy/edge mode)
                                currentEpisode.audio_url = audioResult;
                                await apiFetch(`/episodes/${currentEpisode.id}`, {
                                    method: 'PUT',
                                    body: JSON.stringify({ audio_url: audioResult })
                                }).catch(()=>{});
                                document.getElementById('audioEmpty').style.display = 'none';
                                document.getElementById('audioPlayerSection').style.display = 'flex';
                                document.getElementById('audioStepPlayer').src = audioResult;
                                document.getElementById('audioStepDownload').href = audioResult;
                                document.getElementById('audioStatus').textContent = `Audio generated! (${voiceLabel})`;
                            } else {
                                toast('⚠️ Audio TTS failed for this episode.', "error");
                                document.getElementById('audioStatus').textContent = 'TTS Failed';
                                throw new Error("Audio TTS Generation Failed");
                            }
                        }
                        if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                    }

                    // 7. Video Build (skip if not in pipeline)
                    if (pipeline.includes('video')) {
                        await new Promise(r => setTimeout(r, 2000));
                        setStep('video');
                        
                        if (pipeline.includes('videos')) {
                            toast(`🎥 Assembling Final Video via FFmpeg for ${currentEpisode.title}...`, "info");
                            await startFFmpegExport();
                        } else {
                            toast(`🎥 Building Video Preview for ${currentEpisode.title}...`, "info");
                            await _doBuildVideoPreview({ randomSlides: true, addAudio: pipeline.includes('audio'), voiceId: null, engine: 'vibe' });
                        }
                        
                        if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                    }
                    
                    // 8. Publish (skip if not in pipeline)
                    if (pipeline.includes('publish')) {
                        await new Promise(r => setTimeout(r, 2000));
                        setStep('publish');
                        toast(`🚀 Publishing Episode ${epPlan.episode_number || i+1}...`, "info");
                        
                        try {
                            // Refresh episode data
                            const epData = await apiFetch(`/episodes/${currentEpisode.id}`);
                            const epMeta = JSON.parse(epData.metadata || '{}');
                            
                            // Generate SEO for THIS episode if not exists
                            if (!epMeta.seo_publish || Object.keys(epMeta.seo_publish).length === 0) {
                                toast("Generating SEO Metadata for this episode...", "info");
                                await apiFetch(`/campaigns/${currentCampaign.id}/generate-seo`, {
                                    method: 'POST',
                                    body: JSON.stringify({ episode_id: currentEpisode.id }),
                                });
                            }
                            
                            // ═══ Pre-publish Validation ═══
                            toast(`🔍 Validating episode content before publish...`, "info");
                            const validation = await apiFetch(`/campaigns/${currentCampaign.id}/episodes/${currentEpisode.id}/validate-before-publish`, { method: 'POST' });
                            
                            if (validation.warnings && validation.warnings.length > 0) {
                                validation.warnings.forEach(w => toast(w, "warning"));
                            }
                            
                            if (!validation.valid) {
                                // Show all errors
                                validation.errors.forEach(err => toast(err, "error"));
                                const s = validation.summary || {};
                                toast(`📊 Status: ${s.with_video || 0}/${s.total_shots || 0} videos, ${s.with_audio || 0}/${s.total_shots || 0} audio, export: ${s.has_export ? s.export_size_mb + 'MB' : 'MISSING'}`, "error");
                                toast(`⛔ Publish BLOCKED — episode content is incomplete. Fix errors above first.`, "error");
                                
                                // 📲 Telegram: report validation errors
                                const errList = (validation.errors || []).join('\n');
                                const tgMsg = `⛔ <b>[Auto-Pilot] Publish BLOCKED</b>\n` +
                                    `📁 ${currentCampaign.title} — Ep ${epPlan.episode_number || i+1}\n\n` +
                                    `${errList}\n\n` +
                                    `📊 Video: ${s.with_video || 0}/${s.total_shots || 0} | Audio: ${s.with_audio || 0}/${s.total_shots || 0} | Export: ${s.has_export ? s.export_size_mb + 'MB' : '❌ MISSING'}`;
                                apiFetch('/notify-telegram', { method: 'POST', body: JSON.stringify({ text: tgMsg }) }).catch(() => {});
                            } else {
                                // Validation passed — publish to ALL platforms
                                const s = validation.summary || {};
                                toast(`✅ Validation OK: ${s.total_shots} shots, ${s.with_video}/${s.total_shots} videos, ${s.with_audio}/${s.total_shots} audio, export ${s.export_size_mb}MB`, "success");
                                
                                const campaignMeta = JSON.parse(currentCampaign.metadata || '{}');
                                const uploadTargets = campaignMeta.upload_targets || [];
                                
                                if (uploadTargets.length === 0) {
                                    toast(`⚠️ No upload targets configured. Skipping publish.`, "warning");
                                } else {
                                    const publishResults = [];
                                    for (let ti = 0; ti < uploadTargets.length; ti++) {
                                        const targetPlatform = uploadTargets[ti].provider || 'youtube';
                                        toast(`📤 Publishing to ${targetPlatform} (${ti+1}/${uploadTargets.length})...`, "info");
                                        try {
                                            const pubRes = await apiFetch(`/campaigns/${currentCampaign.id}/episodes/${currentEpisode.id}/publish`, {
                                                method: 'POST',
                                                body: JSON.stringify({ target_index: ti }),
                                            });
                                            if (pubRes.success || pubRes.task_id) {
                                                toast(`✅ Upload started for ${targetPlatform} - Episode ${epPlan.episode_number || i+1}`, "success");
                                                publishResults.push({ platform: targetPlatform, ok: true });
                                            } else {
                                                const errMsg = pubRes.error || pubRes.message || 'Unknown error';
                                                toast(`⚠️ Publish to ${targetPlatform} failed: ${errMsg}`, "error");
                                                publishResults.push({ platform: targetPlatform, ok: false, error: errMsg });
                                            }
                                        } catch (pubErr) {
                                            toast(`⚠️ Publish to ${targetPlatform} error: ${pubErr.message}`, "error");
                                            publishResults.push({ platform: targetPlatform, ok: false, error: pubErr.message });
                                        }
                                        if (ti < uploadTargets.length - 1) await new Promise(r => setTimeout(r, 2000));
                                    }
                                    
                                    // 📲 Telegram: report publish results + send video
                                    const okPlatforms = publishResults.filter(r => r.ok).map(r => r.platform);
                                    const failPlatforms = publishResults.filter(r => !r.ok);
                                    let tgText = '';
                                    if (okPlatforms.length > 0 && failPlatforms.length === 0) {
                                        tgText = `✅ <b>[Auto-Pilot] Đăng thành công!</b>\n` +
                                            `📁 ${currentCampaign.title} — Ep ${epPlan.episode_number || i+1}\n` +
                                            `📤 Platforms: ${okPlatforms.join(', ')}\n` +
                                            `📊 ${s.total_shots} shots | Export: ${s.export_size_mb}MB`;
                                    } else if (okPlatforms.length > 0 && failPlatforms.length > 0) {
                                        const failDetails = failPlatforms.map(f => `  ❌ ${f.platform}: ${f.error}`).join('\n');
                                        tgText = `⚠️ <b>[Auto-Pilot] Đăng một phần</b>\n` +
                                            `📁 ${currentCampaign.title} — Ep ${epPlan.episode_number || i+1}\n` +
                                            `✅ OK: ${okPlatforms.join(', ')}\n` +
                                            `❌ Lỗi:\n${failDetails}`;
                                    } else {
                                        const failDetails = failPlatforms.map(f => `  ❌ ${f.platform}: ${f.error}`).join('\n');
                                        tgText = `❌ <b>[Auto-Pilot] Đăng thất bại!</b>\n` +
                                            `📁 ${currentCampaign.title} — Ep ${epPlan.episode_number || i+1}\n` +
                                            `❌ Lỗi:\n${failDetails}`;
                                    }
                                    // Send with video attached if at least one succeeded
                                    apiFetch('/notify-telegram', {
                                        method: 'POST',
                                        body: JSON.stringify({
                                            text: tgText,
                                            video_path: okPlatforms.length > 0 ? (s.export_path_full || '') : '',
                                        }),
                                    }).catch(() => {});
                                }
                            }
                        } catch (e) {
                            toast(`⚠️ Publish error: ${e.message}`, "error");
                        }
                        
                        if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                    }
                    
                    toast(`✅ Finished Auto-Pilot for Episode ${epPlan.episode_number || i+1}`, "success");
                    await new Promise(r => setTimeout(r, 3000)); // wait before next episode
                    
                    success = true; // Iteration completed successfully
                    
                } catch (err) {
                    if (err.message === "Aborted by user") throw err;
                    if (err.message.includes("RATE_LIMIT_REACHED")) {
                        toast("⛔ Auto-Pilot stopped due to Grok Rate Limit.", "error");
                        throw new Error("Aborted by user");
                    }
                    
                    retryCount++;
                    const MAX_AUTO_RETRIES = 2;
                    
                    if (retryCount <= MAX_AUTO_RETRIES) {
                        // Auto-retry silently
                        toast(`⚠️ Episode ${epPlan.episode_number || i+1} lỗi: ${err.message}. Tự động thử lại lần ${retryCount}/${MAX_AUTO_RETRIES}...`, "warning");
                        isRetry = true;
                        await new Promise(r => setTimeout(r, 5000)); // Wait 5s before retry
                        // success remains false, so while loop repeats
                    } else {
                        // All retries exhausted — notify Telegram and stop
                        const tgErrMsg = `❌ <b>[Auto-Pilot] Dừng lại!</b>\n` +
                            `📁 ${currentCampaign.title} — Ep ${epPlan.episode_number || i+1}\n` +
                            `⚠️ Lỗi sau ${MAX_AUTO_RETRIES} lần thử lại:\n${err.message}\n\n` +
                            `🕐 ${new Date().toLocaleString('vi-VN')}`;
                        apiFetch('/notify-telegram', { method: 'POST', body: JSON.stringify({ text: tgErrMsg }) }).catch(() => {});
                        
                        // Show error recovery modal as last resort
                        const choice = await showErrorDialog(`Episode ${epPlan.episode_number || i+1} failed after ${MAX_AUTO_RETRIES} retries: ${err.message}`);
                        if (choice === 'cancel') {
                            throw new Error("Aborted by user");
                        } else if (choice === 'skip') {
                            toast("Skipping to next episode...", "info");
                            break;
                        } else if (choice === 'retry') {
                            toast("Retrying episode (reset counter)...", "info");
                            retryCount = 0;
                            isRetry = true;
                        }
                    }
                }
            } // end while(!success)
        } // end for loop
    } catch (e) {
        if (e.message !== "Aborted by user") {
            toast("Auto-Pilot error: " + e.message, "error");
        } else {
            toast("Visual Auto-Pilot safely stopped.", "info");
        }
    } finally {
        realtimeAbortController = null;
        isAutoPilotRunning = false;
        document.getElementById('floatStopBtn').style.display = 'none';
        await loadCampaigns();
    }
}
let _activeGenVideoTaskId = null;
let _activeGenImageTaskId = null;

function abortRealtimeStream() {
    if (realtimeAbortController) {
        realtimeAbortController.abort();
    }
    
    // Kill backend subprocess (browser) via cancel API
    if (_activeGenVideoTaskId) {
        apiFetch(`/gen-videos/cancel/${_activeGenVideoTaskId}`, { method: 'POST' }).catch(() => {});
        _activeGenVideoTaskId = null;
    }
    if (_activeGenImageTaskId) {
        apiFetch(`/gen-images/cancel/${_activeGenImageTaskId}`, { method: 'POST' }).catch(() => {});
        _activeGenImageTaskId = null;
    }
}

let errorResolvePromise = null;
function showErrorDialog(message) {
    document.getElementById('errorRecoverMsg').textContent = message;
    document.getElementById('errorRecoverModal').style.display = 'flex';
    return new Promise(resolve => {
        errorResolvePromise = resolve;
    });
}
window.resolveError = function(choice) {
    document.getElementById('errorRecoverModal').style.display = 'none';
    if (errorResolvePromise) {
        errorResolvePromise(choice);
        errorResolvePromise = null;
    }
}

async function _runAgentStreamAction(agentType, message, targetTextareaId, countId) {
    const area = document.getElementById(targetTextareaId);
    
    // Clear empty state and loading placeholders if any
    const emptyStateId = targetTextareaId.replace('Textarea', 'Empty');
    const loadingStateId = targetTextareaId.replace('Textarea', 'Loading');
    if (document.getElementById(emptyStateId)) document.getElementById(emptyStateId).style.display = 'none';
    if (document.getElementById(loadingStateId)) document.getElementById(loadingStateId).style.display = 'none';
    
    area.style.display = '';
    area.value = '';
    
    document.getElementById(countId).textContent = `Processing ${agentType}...`;

    try {
        const response = await fetch(`${API}/agent/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agent_type: agentType,
                message: message,
                episode_id: currentEpisode?.id,
                campaign_id: currentCampaign?.id,
            }),
            signal: realtimeAbortController ? realtimeAbortController.signal : null
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';

        while (true) {
            if (realtimeAbortController && realtimeAbortController.signal.aborted) {
                reader.cancel();
                throw new Error("Aborted by user");
            }
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            const lines = text.split('\n');
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') break;
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.reasoning) {
                        document.getElementById(countId).textContent = `Reasoning / Thinking...`;
                    }
                    if (parsed.content) {
                        fullText += parsed.content;
                        area.value = fullText;
                        area.scrollTop = area.scrollHeight;
                        document.getElementById(countId).textContent = `${fullText.length} chars (Typing...)`;
                    }
                } catch (e) {}
            }
        }
        // Detect AI API errors in streamed response
        if (fullText.startsWith('\u274c')) {
            const errMsg = fullText.substring(0, 300);
            document.getElementById(countId).textContent = 'AI Error!';
            toast('AI Error: ' + errMsg, 'error');
            throw new Error('AI_ERROR: ' + errMsg);
        }
        document.getElementById(countId).textContent = `${fullText.length} chars`;
    } catch (e) {
        if (e.name === 'AbortError') throw new Error("Aborted by user");
        throw e;
    }
}

// ── Utilities ──────────────────────────────────────────────
function esc(str) {
    if (!str) return '';
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
}

// ── Browser Profile Helpers ────────────────────────────────
let _browserProfilesCache = [];

async function _loadBrowserProfilesIntoSelect(selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    try {
        // Call browser extension API directly
        const resp = await fetch('/api/v1/browser/profiles');
        const res = await resp.json();
        const profiles = res.profiles || [];
        
        if (profiles.length > 0) {
            _browserProfilesCache = profiles;
            sel.innerHTML = '<option value="">— Chọn profile —</option>';
            profiles.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.name;   // TubeCLI profile name (e.g. 'browser11')
                let label = p.name;
                if (p.has_cookies) label += ' 🍪';
                if (p.google_account) label += ' ✉️';
                opt.textContent = label;
                sel.appendChild(opt);
            });
            // Auto-select if campaign already has a saved profile
            if (currentCampaign) {
                try {
                    const meta = JSON.parse(currentCampaign.metadata || '{}');
                    if (meta.browser_profile_name) {
                        for (let i = 0; i < sel.options.length; i++) {
                            if (sel.options[i].value === meta.browser_profile_name) {
                                sel.selectedIndex = i;
                                break;
                            }
                        }
                    }
                } catch(e) {}
            }
        } else {
            sel.innerHTML = '<option value="">Không tìm thấy profile nào</option>';
        }
    } catch(e) {
        sel.innerHTML = `<option value="">⚠️ ${e.message}</option>`;
    }
    // Auto-render chip UI if the chip container exists
    // For wizard profile selector: also restore last-used chips from localStorage
    if (selectId === 'wizBrowserProfileExec') {
        _initChipsFromSaved();
    }
}

// ── Chip-based Browser Profile Selector ──
// Image Browser Profile Loader (separate from video browser)
async function loadWizImageBrowserProfiles() {
    const sel = document.getElementById('wizImageBrowserProfile');
    if (!sel) return;
    if (sel.options.length > 1) return;
    try {
        let profiles = _browserProfilesCache;
        if (!profiles || profiles.length === 0) {
            const resp = await fetch('/api/v1/browser/profiles');
            const res = await resp.json();
            profiles = res.profiles || [];
            if (profiles.length > 0) _browserProfilesCache = profiles;
        }
        if (profiles.length > 0) {
            sel.innerHTML = '<option value="">-- Browser --</option>';
            profiles.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.name;
                opt.textContent = p.name;
                sel.appendChild(opt);
            });
            if (currentCampaign) {
                try {
                    const meta = JSON.parse(currentCampaign.metadata || '{}');
                    if (meta.image_browser_profile) {
                        for (let i = 0; i < sel.options.length; i++) {
                            if (sel.options[i].value === meta.image_browser_profile) { sel.selectedIndex = i; break; }
                        }
                    }
                } catch(e) {}
            }
            if (!sel.value) {
                const saved = localStorage.getItem('cs_last_image_browser_profile');
                if (saved) {
                    for (let i = 0; i < sel.options.length; i++) {
                        if (sel.options[i].value === saved) { sel.selectedIndex = i; break; }
                    }
                }
            }
        }
    } catch(e) { console.warn('loadWizImageBrowserProfiles:', e); }
}

let _chipSelectedProfiles = [];

function _renderBrowserChips() {
    const container = document.getElementById('wizBrowserChipSelect');
    const emptyLabel = document.getElementById('wizBrowserChipEmpty');
    const menu = document.getElementById('wizBrowserChipMenu');
    if (!container || !menu) return;

    // Remove old chips (keep empty label and the add-btn wrapper)
    container.querySelectorAll('.chip-item').forEach(el => el.remove());

    // Show/hide empty label
    if (emptyLabel) emptyLabel.style.display = _chipSelectedProfiles.length === 0 ? '' : 'none';

    // Insert chips before the add-btn wrapper
    const addBtnWrap = container.querySelector('[style*="position:relative"]');
    _chipSelectedProfiles.forEach(name => {
        const profile = _browserProfilesCache.find(p => p.name === name);
        const chip = document.createElement('span');
        chip.className = 'chip-item';
        chip.innerHTML = `<span class="chip-status"></span>${_escChip(name)}<span class="chip-remove" title="Remove">✕</span>`;
        chip.querySelector('.chip-remove').addEventListener('click', (e) => {
            e.stopPropagation();
            _chipSelectedProfiles = _chipSelectedProfiles.filter(n => n !== name);
            _syncChipsToSelect();
            _renderBrowserChips();
        });
        container.insertBefore(chip, addBtnWrap);
    });

    // Render dropdown menu options
    menu.innerHTML = '';
    _browserProfilesCache.forEach(p => {
        const isSelected = _chipSelectedProfiles.includes(p.name);
        const opt = document.createElement('div');
        opt.className = 'chip-dropdown-option' + (isSelected ? ' selected' : '');
        opt.innerHTML = `
            <span class="opt-icon">🌐</span>
            <span class="opt-name">${_escChip(p.name)}${p.has_cookies ? ' 🍪' : ''}${p.google_account ? ' 👤' : ''}</span>
            <span class="opt-check">✓</span>
        `;
        opt.addEventListener('click', () => {
            if (isSelected) {
                _chipSelectedProfiles = _chipSelectedProfiles.filter(n => n !== p.name);
            } else {
                _chipSelectedProfiles.push(p.name);
            }
            _syncChipsToSelect();
            _renderBrowserChips();
        });
        menu.appendChild(opt);
    });
}

function _syncChipsToSelect() {
    const sel = document.getElementById('wizBrowserProfileExec');
    if (!sel) return;
    // Sync selected state to hidden native select
    for (let i = 0; i < sel.options.length; i++) {
        sel.options[i].selected = _chipSelectedProfiles.includes(sel.options[i].value);
    }
    // Save to localStorage
    if (_chipSelectedProfiles.length > 0) {
        localStorage.setItem('cs_last_browser_profile_video', _chipSelectedProfiles.join(','));
        localStorage.setItem('cs_last_browser_profile', _chipSelectedProfiles[0]);
    }
}

function toggleBrowserChipMenu() {
    const menu = document.getElementById('wizBrowserChipMenu');
    if (!menu) return;
    menu.classList.toggle('open');

    // Close on click outside
    if (menu.classList.contains('open')) {
        setTimeout(() => {
            const handler = (e) => {
                if (!menu.contains(e.target) && e.target.id !== 'wizBrowserAddBtn') {
                    menu.classList.remove('open');
                    document.removeEventListener('click', handler);
                }
            };
            document.addEventListener('click', handler);
        }, 10);
    }
}

function _escChip(str) {
    const d = document.createElement('span');
    d.textContent = str;
    return d.innerHTML;
}

// Initialize chips from saved localStorage on profile load
function _initChipsFromSaved() {
    const savedStr = localStorage.getItem('cs_last_browser_profile_video') || localStorage.getItem('cs_last_browser_profile') || '';
    if (savedStr) {
        _chipSelectedProfiles = savedStr.split(',').filter(s => s && _browserProfilesCache.some(p => p.name === s));
        _syncChipsToSelect();
    }
    _renderBrowserChips();
}

async function _loadVoiceProfilesIntoSelect(selectId, targetLang = null) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    
    // Fetch if empty
    if (!window.ttsVoicesCache || window.ttsVoicesCache.length === 0) {
        try {
            const res = await apiFetch('/../tts/voices');
            if (res.success && res.voices) window.ttsVoicesCache = res.voices;
            else window.ttsVoicesCache = [];
        } catch(e) {
            console.warn('Failed to fetch TTS voices', e);
            window.ttsVoicesCache = [];
        }
    }
    
    if (window.ttsVoicesCache && window.ttsVoicesCache.length > 0) {
        let edgeHtml = '<optgroup label="Edge-TTS (Online)">';
        let vibeHtml = '<optgroup label="VibeVoice (Offline)">';
        let geminiHtml = '<optgroup label="Gemini (Online via automation)">';
        
        let hasProfiles = false;
        window.ttsVoicesCache.forEach(v => {
            if (targetLang && v.engine !== 'gemini') {
                const vLang = (v.language || '').toLowerCase();
                const vLangName = (v.language_name || '').toLowerCase();
                const tLangLower = targetLang.toLowerCase();
                // Filter
                if (!vLang.startsWith(tLangLower) && !vLangName.includes(tLangLower)) {
                    return;
                }
            }
            hasProfiles = true;
            
            const langPart = v.language_name || v.language;
            const optionHtml = `<option value="${v.id}" data-engine="${v.engine}">${langPart} - ${v.name}${v.gender ? ` (${v.gender})` : ''}</option>`;
            if (v.engine === 'edge') edgeHtml += optionHtml;
            else if (v.engine === 'gemini') geminiHtml += optionHtml;
            else vibeHtml += optionHtml;
        });
        
        if (!hasProfiles && targetLang) {
            sel.innerHTML = '<option value="">(Không tìm thấy giọng: ' + targetLang + ')</option>';
            return;
        }
        
        edgeHtml += '</optgroup>';
        vibeHtml += '</optgroup>';
        geminiHtml += '</optgroup>';
        sel.innerHTML = vibeHtml + edgeHtml + geminiHtml;
        
        // Auto-select if campaign already has a saved voice
        const saved = localStorage.getItem('cs_last_voice_profile') || '';
        let hasSelected = false;
        if (typeof currentCampaign !== 'undefined' && currentCampaign) {
            try {
                const meta = JSON.parse(currentCampaign.metadata || '{}');
                const savedVoice = meta.tts_voice || meta.voice_preset;
                if (savedVoice) {
                    for (let i = 0; i < sel.options.length; i++) {
                        if (sel.options[i].value === savedVoice) {
                            sel.selectedIndex = i;
                            hasSelected = true;
                            break;
                        }
                    }
                }
            } catch(e) {}
        }
        
        if (!hasSelected && saved) {
            for (let i = 0; i < sel.options.length; i++) {
                if (sel.options[i].value === saved) {
                    sel.selectedIndex = i;
                    break;
                }
            }
        }
    } else {
        // Cache is genuinely empty or failed
        sel.innerHTML = '<option value="">(Lỗi mạng/Lỗi tải AI Voice)</option>';
    }
}


// ── Gen Images (Step 5) ────────────────────────────────────
let _genImgPollTimer = null;

async function openGenImagesDialog() {
    if (!currentEpisode) { toast('No episode selected', 'error'); return; }

    // Load profiles into gen-images modal
    await _loadBrowserProfilesIntoSelect('genImgProfile');

    // Pre-select saved profile: campaign metadata first, then localStorage fallback
    const sel = document.getElementById('genImgProfile');
    let savedProfile = '';
    if (currentCampaign) {
        try { savedProfile = JSON.parse(currentCampaign.metadata || '{}').browser_profile_name || ''; } catch(e) {}
    }
    if (!savedProfile) savedProfile = localStorage.getItem('cs_last_browser_profile') || '';
    
    if (savedProfile) {
        for (let i = 0; i < sel.options.length; i++) {
            if (sel.options[i].value === savedProfile) {
                sel.selectedIndex = i;
                break;
            }
        }
    }

    // Count pending shots
    try {
        const sbRes = await apiFetch(`/episodes/${currentEpisode.id}/storyboards`);
        const shots = sbRes.items || [];
        const pending = shots.filter(s => s.image_prompt && !s.composed_image);
        document.getElementById('genImgShotCount').textContent = `${pending.length} shots pending (${shots.length} total)`;
    } catch(e) {
        document.getElementById('genImgShotCount').textContent = '?? shots';
    }

    document.getElementById('genImagesModal').style.display = 'flex';
}

async function startGrokImageGen() {
    const profilePath = document.getElementById('genImgProfile').value;
    const errEl = document.getElementById('genImgError');
    
    // Helper to show error in dialog
    function showDialogError(msg) {
        errEl.textContent = '❌ ' + msg;
        errEl.style.display = 'block';
        errEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    
    errEl.style.display = 'none';
    
    if (!profilePath) { 
        showDialogError('Vui lòng chọn một Browser Profile');
        return; 
    }

    const overwrite = document.getElementById('genImgMode').value === 'all';
    const headless = document.getElementById('genImgHeadless').checked;

    // Save profile name to campaign metadata + localStorage for global recall
    localStorage.setItem('cs_last_browser_profile', profilePath);
    if (currentCampaign) {
        try {
            const meta = JSON.parse(currentCampaign.metadata || '{}');
            meta.browser_profile_name = profilePath;
            await apiFetch(`/campaigns/${currentCampaign.id}`, {
                method: 'PUT',
                body: JSON.stringify({ metadata: JSON.stringify(meta) })
            });
            currentCampaign.metadata = JSON.stringify(meta);
        } catch(e) { console.warn('Could not save profile to campaign', e); }
    }

    // Disable button while starting
    const btn = document.getElementById('btnStartGenImg');
    if (btn) { btn.disabled = true; btn.textContent = 'Starting...'; }

    try {
        const res = await apiFetch(`/episodes/${currentEpisode.id}/gen-images`, {
            method: 'POST',
            body: JSON.stringify({ profile_name: profilePath, headless, overwrite })
        });

        if (res.success) {
            document.getElementById('genImagesModal').style.display = 'none';
            toast(`🖼 Image gen started — ${res.total} shots`, 'info');
            setStep('images');
            // Show progress section
            document.getElementById('imagesEmpty').style.display = 'none';
            document.getElementById('imgProgressSection').style.border = '';
            document.getElementById('imgProgressSection').style.display = 'block';
            document.getElementById('imgProgressBar').style.width = '0%';
            document.getElementById('imgProgressCount').textContent = `0 / ${res.total || 1}`;
            document.getElementById('imgProgressLabel').textContent = 'Khởi tạo Grok...';
            _startGenImgPolling(res.task_id, res.total);
        } else {
            showDialogError(res.detail || res.message || JSON.stringify(res));
        }
    } catch(e) {
        showDialogError(e.message || String(e));
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Gen'; }
    }
}

// Helper: wait for image gen to complete (used by Auto-Pilot)
async function _waitForImageGenCompletion(taskId, total) {
    while (true) {
        if (realtimeAbortController && realtimeAbortController.signal.aborted) {
            throw new Error("Aborted by user");
        }
        
        await new Promise(r => setTimeout(r, 3000));
        
        try {
            const res = await apiFetch(`/gen-images/status/${taskId}`);
            if (!res.success) break;
            
            const done = res.done || 0;
            const tot = res.total || total || 1;
            const pct = Math.round((done / tot) * 100);
            
            document.getElementById('imgProgressBar').style.width = `${pct}%`;
            document.getElementById('imgProgressCount').textContent = `${done} / ${tot}`;
            document.getElementById('imgProgressLabel').textContent =
                res.status === 'completed' ? '✅ Done!' :
                res.status.startsWith('error') ? `❌ ${res.status}` :
                `Generating shot ${done + 1}/${tot}...`;
            
            if (done > 0) {
                await loadEpisodeImages().catch(e => console.error(e));
            }
            
            if (res.status === 'completed' || res.status.startsWith('error')) {
                if (res.status === 'completed') {
                    document.getElementById('imgProgressSection').style.borderColor = '#10b981';
                } else {
                    document.getElementById('imgProgressSection').style.borderColor = '#ef4444';
                }
                await loadEpisodeImages().catch(e => console.error(e));
                
                setTimeout(() => {
                    const p = document.getElementById('imgProgressSection');
                    if (p) p.style.display = 'none';
                }, 5000);

                if (res.status.includes('RATE_LIMIT_REACHED')) {
                    throw new Error("RATE_LIMIT_REACHED");
                }
                break;
            }
        } catch(e) {
            if (e.message === 'RATE_LIMIT_REACHED' || e.message === 'Aborted by user') {
                throw e; // Re-throw critical errors so autopilot stops
            }
            console.error('Image gen poll error', e);
            break;
        }
    }
}

function _startGenImgPolling(taskId, total) {
    if (_genImgPollTimer) clearInterval(_genImgPollTimer);

    _genImgPollTimer = setInterval(async () => {
        try {
            const res = await apiFetch(`/gen-images/status/${taskId}`);
            
            // If task dropped or server restarted
            if (!res.success) {
                clearInterval(_genImgPollTimer);
                _genImgPollTimer = null;
                document.getElementById('imgProgressLabel').textContent = '⚠️ Lỗi: Không thể tải tiến độ (Máy chủ bị gián đoạn)';
                document.getElementById('imgProgressSection').style.borderColor = '#ef4444';
                return;
            }

            const isCurrentMatch = (currentEpisode && res.episode_id == currentEpisode.id);

            if (isCurrentMatch) {
                const done = res.done || 0;
                const tot = res.total || total || 1;
                const pct = Math.round((done / tot) * 100);

                document.getElementById('imgProgressBar').style.width = `${pct}%`;
                document.getElementById('imgProgressCount').textContent = `${done} / ${tot}`;
                document.getElementById('imgProgressLabel').textContent =
                    res.status === 'completed' ? '✅ Done!' :
                    res.status.startsWith('error') ? `❌ ${res.status}` :
                    `Generating shot ${done + 1}/${tot}...`;

                // Realtime update: refresh images as they arrive
                if (done > 0) {
                    await loadEpisodeImages().catch(e => console.error('Realtime image refresh error', e));
                }
            }

            if (res.status === 'completed' || res.status.startsWith('error')) {
                clearInterval(_genImgPollTimer);
                _genImgPollTimer = null;
                
                if (isCurrentMatch) {
                    if (res.status.startsWith('error') || (res.errors && res.errors.length > 0)) {
                        document.getElementById('imgProgressLabel').textContent = '⚠️ Hoàn thành nhưng có lỗi!';
                        document.getElementById('imgProgressSection').style.borderColor = '#ef4444';
                        
                        const failCount = res.errors ? res.errors.length : 0;
                        toast(`❌ ${failCount} ảnh bị lỗi! Hãy thử chạy lại.`, 'error');
                    } else {
                        document.getElementById('imgProgressLabel').textContent = '✅ Đã xong toàn bộ!';
                        document.getElementById('imgProgressSection').style.borderColor = '#10b981';
                        toast(`✅ Đã tạo toàn bộ ảnh!`, 'success');
                    }
                    
                    // Call loadEpisodeImages to show the final state, wrapped safely
                    await loadEpisodeImages().catch(e => console.error(e));
                    
                    setTimeout(() => {
                        const progSec = document.getElementById('imgProgressSection');
                        if (progSec) progSec.style.display = 'none';
                    }, 5000);
                }
            }
        } catch(e) { console.error('Image poll error', e); }
    }, 3000);
}

async function loadEpisodeImages() {
    if (!currentEpisode) return;

    try {
        const sbRes = await apiFetch(`/episodes/${currentEpisode.id}/storyboards`);
        const shots = sbRes.items || [];
        const withImages = shots.filter(s => s.composed_image);

        let arCss = '16/9';
        if (currentCampaign) {
            try {
                const meta = JSON.parse(currentCampaign.metadata || '{}');
                const ar = meta.aspect_ratio || '16:9';
                if (ar.includes(':')) arCss = ar.replace(':', '/');
            } catch(e) {}
        }

        const grid = document.getElementById('imageGrid');
        const empty = document.getElementById('imagesEmpty');
        const count = document.getElementById('imgCount');

        count.textContent = `${withImages.length} / ${shots.length} images`;

        if (withImages.length === 0) {
            grid.style.display = 'none';
            empty.style.display = '';
            return;
        }

        empty.style.display = 'none';
        grid.style.display = 'grid';

        grid.innerHTML = withImages.map(s => {
            // Serve image: if it's an absolute path, use grok-image endpoint with filename
            const imgPath = s.composed_image || '';
            const filename = imgPath.split(/[\\/]/).pop();
            const imgSrc = `/api/v1/pod_studio/grok-image/${filename}`;
            return `
                <div style="border-radius:8px; overflow:hidden; background:var(--bg-1); border:1px solid var(--border); position:relative;">
                    <img src="${imgSrc}" alt="Shot ${s.storyboard_number}"
                        style="width:100%; aspect-ratio:${arCss}; object-fit:cover; display:block;"
                        onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
                    />
                    <div style="display:none; width:100%; aspect-ratio:${arCss}; align-items:center; justify-content:center; color:var(--text-3); font-size:11px;">No image</div>
                    <div style="padding:6px 8px; font-size:11px; color:var(--text-2);">
                        <strong>Shot #${s.storyboard_number}</strong>${s.title ? ' — ' + esc(s.title) : ''}
                    </div>
                </div>
            `;
        }).join('');
    } catch(e) {
        console.error('loadEpisodeImages error', e);
    }
}

// ── Gen Videos (Step 5.5) ──────────────────────────────────
let _genVidPollTimer = null;

async function clearAllVideos() {
    if (!currentEpisode) { toast('No episode selected', 'error'); return; }
    
    if (!confirm('Xóa toàn bộ video đã tạo cho episode này? Thao tác này không thể hoàn tác.')) return;
    
    try {
        const res = await apiFetch(`/episodes/${currentEpisode.id}/clear-videos`, { method: 'POST' });
        if (res.success) {
            toast(`🗑 Đã xóa ${res.deleted || 0} video`, 'success');
            await loadEpisodeVideos();
        } else {
            toast('❌ ' + (res.detail || res.message || 'Lỗi xóa video'), 'error');
        }
    } catch(e) {
        toast('❌ ' + (e.message || String(e)), 'error');
    }
}

async function clearSingleVideo(shotId) {
    if (!currentEpisode) { toast('No episode selected', 'error'); return; }
    
    if (!confirm('Xóa video của shot này để tạo lại?')) return;
    
    try {
        const res = await apiFetch(`/episodes/${currentEpisode.id}/storyboards/${shotId}/video`, { method: 'DELETE' });
        if (res.success) {
            toast('🗑 Đã xóa video', 'success');
            await loadEpisodeVideos();
        } else {
            toast('❌ Lỗi xóa video', 'error');
        }
    } catch(e) {
        toast('❌ ' + (e.message || String(e)), 'error');
    }
}

async function openGenVideosDialog() {
    if (!currentEpisode) { toast('No episode selected', 'error'); return; }

    await _loadBrowserProfilesIntoSelect('genVidProfile');

    // Initialize chip UI for Gen Videos dialog
    _genVidChipSelected = [];
    let savedProfiles = [];
    if (currentCampaign) {
        try { 
            const meta = JSON.parse(currentCampaign.metadata || '{}');
            if (meta.browser_profile_names_video) savedProfiles = meta.browser_profile_names_video;
            else if (meta.browser_profile_name) savedProfiles = [meta.browser_profile_name];
        } catch(e) {}
    }
    if (savedProfiles.length === 0) {
        const fallbackStr = localStorage.getItem('cs_last_browser_profile_video');
        if (fallbackStr) savedProfiles = fallbackStr.split(',');
        else {
            const older = localStorage.getItem('cs_last_browser_profile');
            if (older) savedProfiles = [older];
        }
    }
    
    _genVidChipSelected = savedProfiles.filter(s => s && _browserProfilesCache.some(p => p.name === s));
    _syncGenVidChipsToSelect();
    _renderGenVidChips();

    try {
        const sbRes = await apiFetch(`/episodes/${currentEpisode.id}/storyboards`);
        const shots = sbRes.items || [];
        const pending = shots.filter(s => s.image_prompt && !s.video_url);
        // Count characters
        let totalChars = 0, shotsWithChars = 0;
        shots.filter(s => s.image_prompt).forEach(s => {
            let charNames = s.character_names;
            if (typeof charNames === 'string') try { charNames = JSON.parse(charNames); } catch(e) { charNames = []; }
            if (Array.isArray(charNames) && charNames.length > 0) { shotsWithChars++; totalChars += charNames.length; }
        });
        const totalVideoShots = shots.filter(s => s.image_prompt).length;
        
        // Get aspect ratio and gallery info
        let ar = '16:9';
        let hasGallery = false;
        try {
            const meta = JSON.parse(currentCampaign.metadata || '{}');
            ar = meta.aspect_ratio || '16:9';
            hasGallery = !!meta.gallery_category_id;
        } catch(e) {}
        
        const parts = [];
        if (shotsWithChars > 0) parts.push(`${shotsWithChars}/${totalVideoShots} shots có chars`);
        if (hasGallery) parts.push('Gallery ✓');
        const refStr = parts.length > 0 ? parts.join(' · ') : 'No refs';
        
        document.getElementById('genVidShotCount').innerHTML = `<strong>${pending.length} shots</strong> pending (${totalVideoShots} total) · 
            <span style="color:rgb(129,140,248);">${ar}</span> · 
            <span style="color:${(shotsWithChars > 0 || hasGallery) ? 'rgb(52,211,153)' : 'rgb(251,191,36)'};">🖼 ${refStr}</span>`;
    } catch(e) {
        document.getElementById('genVidShotCount').textContent = '?? shots';
    }

    _restoreVideoEngine();
    document.getElementById('genVideosModal').style.display = 'flex';
}

// ── Gen Videos Chip-based Profile Selector ──
let _genVidChipSelected = [];

function _renderGenVidChips() {
    const container = document.getElementById('genVidChipSelect');
    const emptyLabel = document.getElementById('genVidChipEmpty');
    const menu = document.getElementById('genVidChipMenu');
    if (!container || !menu) return;

    // Remove old chips
    container.querySelectorAll('.gv-chip-item').forEach(el => el.remove());

    // Show/hide empty label
    if (emptyLabel) emptyLabel.style.display = _genVidChipSelected.length === 0 ? '' : 'none';

    // Insert chips before the add-btn wrapper
    const addBtnWrap = container.querySelector('div[style*="position:relative"]');
    _genVidChipSelected.forEach(name => {
        const profile = _browserProfilesCache.find(p => p.name === name);
        const chip = document.createElement('span');
        chip.className = 'gv-chip-item';
        chip.style.cssText = `
            display:inline-flex; align-items:center; gap:6px;
            padding:4px 10px 4px 8px; border-radius:20px;
            background:linear-gradient(135deg, rgba(99,102,241,.15), rgba(139,92,246,.15));
            border:1px solid rgba(99,102,241,.3);
            color:var(--text-1); font-size:12px; font-weight:500;
            transition:all .2s; cursor:default; animation:chipFadeIn .2s ease;
        `;
        const statusDot = profile && profile.has_cookies ? '🟢' : '🔵';
        const googleIcon = profile && profile.google_account ? ' 👤' : '';
        chip.innerHTML = `<span style="font-size:10px;">${statusDot}</span>${_escChip(name)}${googleIcon}<span class="gv-chip-remove" style="cursor:pointer; opacity:.6; font-size:14px; margin-left:2px; transition:opacity .2s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='.6'" title="Remove">✕</span>`;
        chip.querySelector('.gv-chip-remove').addEventListener('click', (e) => {
            e.stopPropagation();
            _genVidChipSelected = _genVidChipSelected.filter(n => n !== name);
            _syncGenVidChipsToSelect();
            _renderGenVidChips();
        });
        container.insertBefore(chip, addBtnWrap);
    });

    // Render dropdown menu options
    menu.innerHTML = '';
    _browserProfilesCache.forEach(p => {
        const isSelected = _genVidChipSelected.includes(p.name);
        const opt = document.createElement('div');
        opt.style.cssText = `
            display:flex; align-items:center; gap:8px; padding:8px 12px;
            cursor:pointer; font-size:13px; transition:background .15s;
            ${isSelected ? 'background:rgba(99,102,241,.12);' : ''}
        `;
        opt.onmouseover = () => { if (!isSelected) opt.style.background = 'rgba(255,255,255,.05)'; };
        opt.onmouseout = () => { if (!isSelected) opt.style.background = 'transparent'; };
        const statusDot = p.has_cookies ? '🟢' : '⚪';
        const googleTag = p.google_account ? ' <span style="opacity:.5; font-size:11px;">👤</span>' : '';
        opt.innerHTML = `
            <span style="font-size:11px;">${statusDot}</span>
            <span style="flex:1; color:var(--text-1);">${_escChip(p.name)}${googleTag}</span>
            <span style="color:var(--primary); font-size:16px; opacity:${isSelected ? '1' : '0'}; transition:opacity .15s;">✓</span>
        `;
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isSelected) {
                _genVidChipSelected = _genVidChipSelected.filter(n => n !== p.name);
            } else {
                _genVidChipSelected.push(p.name);
            }
            _syncGenVidChipsToSelect();
            _renderGenVidChips();
        });
        menu.appendChild(opt);
    });
}

function _syncGenVidChipsToSelect() {
    const sel = document.getElementById('genVidProfile');
    if (!sel) return;
    for (let i = 0; i < sel.options.length; i++) {
        sel.options[i].selected = _genVidChipSelected.includes(sel.options[i].value);
    }
    if (_genVidChipSelected.length > 0) {
        localStorage.setItem('cs_last_browser_profile_video', _genVidChipSelected.join(','));
    }
}

function toggleGenVidChipMenu(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('genVidChipMenu');
    if (!menu) return;
    const isOpen = menu.style.display !== 'none';
    menu.style.display = isOpen ? 'none' : 'block';

    if (!isOpen) {
        setTimeout(() => {
            const handler = (e) => {
                if (!menu.contains(e.target) && e.target.id !== 'genVidAddBtn') {
                    menu.style.display = 'none';
                    document.removeEventListener('click', handler);
                }
            };
            document.addEventListener('click', handler);
        }, 10);
    }
}

// ── Video Engine Selection Functions ──

function onVideoEngineChange() {
    const engine = document.getElementById('wizVideoEngine')?.value || 'grok';
    const label = document.getElementById('wizBrowserLabel');
    if (label) {
        label.textContent = engine === 'veo3' 
            ? '\ud83c\udf10 Browser Profiles (Google login)' 
            : '\ud83c\udf10 Browser Profiles (Grok Gen)';
    }
    localStorage.setItem('cs_video_engine', engine);
}

function onVideoLengthChange() {
    const sel = document.getElementById('wizVideoLength');
    const hint = document.getElementById('wizVideoLengthHint');
    const arSel = document.getElementById('wizAspectRatio');
    const epSel = document.getElementById('wizEpisodes');
    if (!sel) return;
    const v = sel.value;
    if (v === 'short_60s') {
        if (arSel) arSel.value = '9:16';
        if (epSel) epSel.value = '1';
        if (hint) hint.textContent = '⚡ Auto: 9:16, 1 tập, < 60s, hook cực mạnh 3 giây đầu';
    } else if (v === 'short_3m') {
        if (arSel) arSel.value = '9:16';
        if (epSel) epSel.value = '1';
        if (hint) hint.textContent = '📱 Auto: 9:16, 1 tập, < 3 phút, nội dung súc tích có chiều sâu';
    } else if (v === 'long_10m') {
        if (arSel) arSel.value = '16:9';
        if (epSel) epSel.value = '0';
        if (hint) hint.textContent = '📺 Auto: 16:9, auto tập, > 10 phút, nội dung chuyên sâu chi tiết';
    } else {
        if (hint) hint.textContent = '';
    }
}

function onSceneGenModeChange() {
    const sel = document.getElementById('wizSceneGenMode');
    const hint = document.getElementById('wizSceneGenModeHint');
    const camSel = document.getElementById('wizCameraAngle');
    if (!sel) return;
    if (sel.value === 'panoramic_grid') {
        if (hint) hint.innerHTML = '🖼️ Mỗi scene tạo 1 ảnh grid 3×3 → auto crop theo góc quay. AI tự thiết kế bố cục & số lượng shot.';
        if (camSel) { camSel.value = 'Default'; camSel.closest('label').style.opacity = '0.4'; camSel.disabled = true; }
    } else {
        if (hint) hint.textContent = 'Mỗi shot tạo ảnh riêng lẻ qua AI.';
        if (camSel) { camSel.closest('label').style.opacity = '1'; camSel.disabled = false; }
    }
}

function onGenVidEngineChange() {
    const engine = document.getElementById('genVidEngine')?.value || 'grok';
    const title = document.getElementById('genVidModalTitle');
    const label = document.getElementById('genVidProfileLabel');
    if (title) {
        title.textContent = engine === 'veo3' 
            ? '\ud83c\udf9e Generate Videos with Veo3' 
            : '\ud83c\udf9e Generate Videos with Grok';
    }
    if (label) {
        label.textContent = engine === 'veo3'
            ? 'Browser Profile (Chrome \u0111\u00e3 login Google)'
            : 'Browser Profile (Chrome \u0111\u00e3 login Grok)';
    }
    // Sync to wizard dropdown and localStorage so they stay consistent
    const wizEl = document.getElementById('wizVideoEngine');
    if (wizEl) wizEl.value = engine;
    localStorage.setItem('cs_video_engine', engine);
}

function _getVideoEngine() {
    // If Gen Videos modal is open, always use its dropdown (user is actively choosing)
    const genModal = document.getElementById('genVideosModal');
    if (genModal && genModal.style.display !== 'none') {
        const genEl = document.getElementById('genVidEngine');
        if (genEl && genEl.value) return genEl.value;
    }
    // If wizard is visible (user is actively configuring), use its dropdown
    const wizStep3 = document.getElementById('wizStep3');
    if (wizStep3 && wizStep3.style.display !== 'none') {
        const wizEl = document.getElementById('wizVideoEngine');
        if (wizEl && wizEl.value) return wizEl.value;
    }
    // Otherwise: campaign metadata > localStorage > wizard dropdown > default
    if (typeof currentCampaign !== 'undefined' && currentCampaign) {
        try {
            const meta = JSON.parse(currentCampaign.metadata || '{}');
            if (meta.video_engine) return meta.video_engine;
        } catch(e) {}
    }
    const lsEngine = localStorage.getItem('cs_video_engine');
    if (lsEngine) return lsEngine;
    return 'grok';
}

function _restoreVideoEngine() {
    // Restore engine selection from campaign metadata or localStorage
    let engine = 'grok';
    if (currentCampaign) {
        try {
            const meta = JSON.parse(currentCampaign.metadata || '{}');
            if (meta.video_engine) engine = meta.video_engine;
        } catch(e) {}
    }
    if (!engine || engine === 'grok') {
        engine = localStorage.getItem('cs_video_engine') || 'grok';
    }
    const wizEl = document.getElementById('wizVideoEngine');
    const genEl = document.getElementById('genVidEngine');
    if (wizEl) wizEl.value = engine;
    if (genEl) genEl.value = engine;
    onVideoEngineChange();
}



async function startGrokVideoGen() {
    const sel = document.getElementById('genVidProfile');
    const profilePaths = Array.from(sel.selectedOptions).map(o => o.value);
    const errEl = document.getElementById('genVidError');
    
    function showDialogError(msg) {
        errEl.textContent = '❌ ' + msg;
        errEl.style.display = 'block';
        errEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    
    errEl.style.display = 'none';
    
    if (profilePaths.length === 0 || !profilePaths[0]) { 
        showDialogError('Vui lòng chọn ít nhất một Browser Profile');
        return; 
    }

    const overwrite = document.getElementById('genVidMode').value === 'all';
    const headless = document.getElementById('genVidHeadless').checked;

    localStorage.setItem('cs_last_browser_profile_video', profilePaths.join(','));
    if (currentCampaign) {
        try {
            const meta = JSON.parse(currentCampaign.metadata || '{}');
            meta.browser_profile_names_video = profilePaths;
            await apiFetch(`/campaigns/${currentCampaign.id}`, {
                method: 'PUT',
                body: JSON.stringify({ metadata: JSON.stringify(meta) })
            });
            currentCampaign.metadata = JSON.stringify(meta);
        } catch(e) {}
    }

    const btn = document.getElementById('btnStartGenVid');
    if (btn) { btn.disabled = true; btn.textContent = 'Starting...'; }

    try {
        const res = await apiFetch(`/episodes/${currentEpisode.id}/gen-videos`, {
            method: 'POST',
            body: JSON.stringify({ profile_names: profilePaths, headless, overwrite, engine: _getVideoEngine() })
        });

        if (res.success) {
            document.getElementById('genVideosModal').style.display = 'none';
            toast(`🎞 Video gen started — ${res.total} shots`, 'info');
            setStep('videos');
            
            document.getElementById('videosEmpty').style.display = 'none';
            document.getElementById('vidProgressSection').style.border = '';
            document.getElementById('vidProgressSection').style.display = 'block';
            document.getElementById('vidProgressBar').style.width = '0%';
            document.getElementById('vidProgressCount').textContent = `0 / ${res.total || 1}`;
            document.getElementById('vidProgressLabel').textContent = (_getVideoEngine() === 'veo3' ? 'Khởi tạo Veo3 Video...' : 'Khởi tạo Grok Video...');
            // Refresh grid to show cleared state (all skeleton cards in overwrite mode)
            if (overwrite) await loadEpisodeVideos().catch(e => {});
            _startGenVidPolling(res.task_id, res.total);
        } else {
            showDialogError(res.detail || res.message || JSON.stringify(res));
        }
    } catch(e) {
        showDialogError(e.message || String(e));
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Gen Video'; }
    }
}

async function _waitForVideoGenCompletion(taskId, total) {
    while (true) {
        if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
        await new Promise(r => setTimeout(r, 5000));
        
        try {
            const res = await apiFetch(`/gen-videos/status/${taskId}`);
            if (!res.success) break;
            
            const done = res.done || 0;
            const tot = res.total || total || 1;
            const pct = Math.round((done / tot) * 100);
            
            document.getElementById('vidProgressBar').style.width = `${pct}%`;
            document.getElementById('vidProgressCount').textContent = `${done} / ${tot}`;
            document.getElementById('vidProgressLabel').textContent =
                res.status === 'completed' ? '✅ Done!' :
                res.status.startsWith('error') ? `❌ ${res.status}` :
                `Generating shot ${done + 1}/${tot}...`;
            
            // Show real-time skeleton cards with progress map
            await loadEpisodeVideos(res.shot_progress).catch(e => {});
            
            if (res.status === 'completed' || res.status.startsWith('error')) {
                if (res.status === 'completed') document.getElementById('vidProgressSection').style.borderColor = '#10b981';
                else document.getElementById('vidProgressSection').style.borderColor = '#ef4444';
                
                await loadEpisodeVideos().catch(e => {});
                setTimeout(() => {
                    const p = document.getElementById('vidProgressSection');
                    if (p) p.style.display = 'none';
                }, 5000);

                if (res.status.includes('RATE_LIMIT_REACHED')) {
                    throw new Error("RATE_LIMIT_REACHED");
                }
                break;
            }
        } catch(e) {
            if (e.message === 'RATE_LIMIT_REACHED' || e.message === 'Aborted by user') {
                throw e; // Re-throw critical errors so autopilot stops
            }
            console.error('Video gen poll error', e);
            break;
        }
    }
}

function _startGenVidPolling(taskId, total) {
    if (_genVidPollTimer) clearInterval(_genVidPollTimer);

    _genVidPollTimer = setInterval(async () => {
        try {
            const res = await apiFetch(`/gen-videos/status/${taskId}`);
            if (!res.success) {
                clearInterval(_genVidPollTimer);
                _genVidPollTimer = null;
                document.getElementById('vidProgressLabel').textContent = '⚠️ Lỗi: Không thể tải tiến độ';
                document.getElementById('vidProgressSection').style.borderColor = '#ef4444';
                return;
            }

            const isCurrentMatch = (currentEpisode && res.episode_id == currentEpisode.id);
            if (isCurrentMatch) {
                const done = res.done || 0;
                const tot = res.total || total || 1;
                const pct = Math.round((done / tot) * 100);

                document.getElementById('vidProgressBar').style.width = `${pct}%`;
                document.getElementById('vidProgressCount').textContent = `${done} / ${tot}`;
                document.getElementById('vidProgressLabel').textContent =
                    res.status === 'completed' ? '✅ Done!' :
                    res.status.startsWith('error') ? `❌ ${res.status}` :
                    `Generating shot ${done + 1}/${tot}...`;

                // Show real-time skeleton cards with progress map
                await loadEpisodeVideos(res.shot_progress).catch(e => {});
            }

            if (res.status === 'completed' || res.status.startsWith('error')) {
                clearInterval(_genVidPollTimer);
                _genVidPollTimer = null;
                
                if (isCurrentMatch) {
                    if (res.status.startsWith('error') || (res.errors && res.errors.length > 0)) {
                        document.getElementById('vidProgressLabel').textContent = '⚠️ Hoàn thành nhưng có lỗi!';
                        document.getElementById('vidProgressSection').style.borderColor = '#ef4444';
                        toast(`❌ Video gen errors detected!`, 'error');
                    } else {
                        document.getElementById('vidProgressLabel').textContent = '✅ Đã xong toàn bộ video!';
                        document.getElementById('vidProgressSection').style.borderColor = '#10b981';
                        toast(`✅ Đã tạo xong toàn bộ video!`, 'success');
                    }
                    
                    await loadEpisodeVideos().catch(e => {});
                    setTimeout(() => {
                        const progSec = document.getElementById('vidProgressSection');
                        if (progSec) progSec.style.display = 'none';
                    }, 5000);
                }
            }
        } catch(e) {}
    }, 5000);
}

async function loadEpisodeVideos(progressMap = null) {
    if (!currentEpisode) return;

    try {
        const sbRes = await apiFetch(`/episodes/${currentEpisode.id}/storyboards`);
        const shots = sbRes.items || [];
        
        // Target shots are ones with an image_prompt
        const videoShots = shots.filter(s => s.image_prompt);
        
        let arCss = '16/9';
        if (currentCampaign) {
            try {
                const meta = JSON.parse(currentCampaign.metadata || '{}');
                const ar = meta.aspect_ratio || '16:9';
                if (ar.includes(':')) arCss = ar.replace(':', '/');
            } catch(e) {}
        }
        
        const grid = document.getElementById('videoGrid');
        const empty = document.getElementById('videosEmpty');
        const count = document.getElementById('vidCount');

        let completedVideosCount = 0;
        
        if (videoShots.length === 0) {
            grid.style.display = 'none';
            empty.style.display = '';
        } else {
            empty.style.display = 'none';
            grid.style.display = 'grid';

            videoShots.forEach(s => {
                let card = document.getElementById(`video-card-${s.id}`);
                if (!card) {
                    card = document.createElement('div');
                    card.id = `video-card-${s.id}`;
                    grid.appendChild(card);
                }

                const prog = progressMap && progressMap[s.id] ? progressMap[s.id] : null;
                const vidPath = s.video_url || (prog && prog.path ? prog.path : '');
                
                if (vidPath) {
                    completedVideosCount++;
                    const filename = vidPath.split(/[\\/]/).pop();
                    const vidSrc = `/api/v1/pod_studio/grok-video/${filename}`;
                    
                    if (card.dataset.state !== 'video' || card.dataset.src !== vidSrc) {
                        card.dataset.state = 'video';
                        card.dataset.src = vidSrc;
                        card.innerHTML = `
                            <div style="border-radius:8px; overflow:hidden; background:var(--bg-1); border:1px solid var(--border); position:relative;">
                                <video src="${vidSrc}" controls loop muted preload="metadata"
                                    style="width:100%; aspect-ratio:${arCss}; object-fit:cover; display:block;"
                                    onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
                                ></video>
                                <div style="display:none; width:100%; aspect-ratio:${arCss}; align-items:center; justify-content:center; color:var(--text-3); font-size:11px;">No video</div>
                                <div style="padding:6px 8px; font-size:11px; color:var(--text-2); display:flex; justify-content:space-between; align-items:center; gap:8px;">
                                    <div style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"><strong>Shot #${s.storyboard_number}</strong>${s.title ? ' — ' + esc(s.title) : ''}</div>
                                    <button class="btn btn-sm btn-danger" onclick="clearSingleVideo(${s.id})" title="Clear this video" style="padding:2px 6px; min-height:0; flex-shrink:0;">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                    </button>
                                </div>
                            </div>
                        `;
                    }
                } else {
                    let indicatorHTML = `<div style="color:var(--text-3);">Pending...</div>`;
                    if (prog) {
                        if (prog.status === 'generating') {
                            indicatorHTML = `
                                <div style="color:var(--primary); font-weight:600; font-size:18px;">${prog.percent || 0}%</div>
                                <div style="font-size:11px; color:var(--text-3); margin-top:4px;">Generating...</div>
                            `;
                        } else if (prog.status === 'error') {
                            indicatorHTML = `<div style="color:var(--danger);">Error</div>`;
                        } else if (prog.status === 'done') {
                            indicatorHTML = `<div style="color:var(--success);">✅ Trích xuất...</div>`;
                        } else {
                            indicatorHTML = `<div style="color:var(--text-3);">Waiting...</div>`;
                        }
                    }
                    
                    // We update the skeleton every time since it's just text
                    card.dataset.state = 'skeleton';
                    card.dataset.src = '';
                    card.innerHTML = `
                        <div style="border-radius:8px; overflow:hidden; background:var(--bg-1); border:1px dashed var(--border); position:relative; display:flex; flex-direction:column;">
                            <div style="width:100%; aspect-ratio:${arCss}; display:flex; flex-direction:column; align-items:center; justify-content:center; background:var(--bg-2);">
                                ${indicatorHTML}
                            </div>
                            <div style="padding:6px 8px; font-size:11px; color:var(--text-2); border-top:1px solid var(--border);">
                                <strong>Shot #${s.storyboard_number}</strong>${s.title ? ' — ' + esc(s.title) : ''}
                            </div>
                        </div>
                    `;
                }
            });

            // Cleanup removed shots if any
            Array.from(grid.children).forEach(child => {
                if (!videoShots.find(s => `video-card-${s.id}` === child.id)) {
                    grid.removeChild(child);
                }
            });
        }

        count.textContent = `${completedVideosCount} / ${videoShots.length} videos`;

        // Update aspect ratio badge
        const arBadge = document.getElementById('vidAspectBadge');
        if (arBadge && currentCampaign) {
            try {
                const meta = JSON.parse(currentCampaign.metadata || '{}');
                const ar = meta.aspect_ratio || '16:9';
                arBadge.textContent = ar;
                arBadge.style.display = videoShots.length > 0 ? '' : 'none';
            } catch(e) { arBadge.style.display = 'none'; }
        }

        // Update ref images badge — compute from character_names (ref_images are computed at gen-time)
        const refBadge = document.getElementById('vidRefBadge');
        if (refBadge) {
            let shotsWithChars = 0;
            let totalChars = 0;
            videoShots.forEach(s => {
                let charNames = s.character_names;
                if (typeof charNames === 'string') try { charNames = JSON.parse(charNames); } catch(e) { charNames = []; }
                if (Array.isArray(charNames) && charNames.length > 0) {
                    shotsWithChars++;
                    totalChars += charNames.length;
                }
            });
            // Also check if gallery is configured
            let hasGallery = false;
            if (currentCampaign) {
                try {
                    const meta = JSON.parse(currentCampaign.metadata || '{}');
                    hasGallery = !!meta.gallery_category_id;
                } catch(e) {}
            }
            
            if (shotsWithChars > 0 || hasGallery) {
                const parts = [];
                if (shotsWithChars > 0) parts.push(`${shotsWithChars} shots có chars`);
                if (hasGallery) parts.push('Gallery ✓');
                refBadge.textContent = `🖼 ${parts.join(' · ')}`;
                refBadge.style.display = '';
                refBadge.style.background = 'rgba(245,158,11,0.12)';
                refBadge.style.color = 'rgb(251,191,36)';
                refBadge.style.borderColor = 'rgba(245,158,11,0.25)';
            } else {
                refBadge.textContent = '🖼 No refs';
                refBadge.style.display = videoShots.length > 0 ? '' : 'none';
                refBadge.style.background = 'rgba(239,68,68,0.1)';
                refBadge.style.color = 'rgb(252,165,165)';
                refBadge.style.borderColor = 'rgba(239,68,68,0.2)';
            }
            // Store for detail dialog
            window._videoShotsRefData = videoShots.map(s => {
                let charNames = s.character_names;
                if (typeof charNames === 'string') try { charNames = JSON.parse(charNames); } catch(e) { charNames = []; }
                return { id: s.id, num: s.storyboard_number, title: s.title || '', chars: Array.isArray(charNames) ? charNames : [] };
            });
        }
    } catch(e) { console.error('loadEpisodeVideos error', e); }
}

// ── Show Ref Images Detail Dialog ──
function showRefImagesDetail() {
    const data = window._videoShotsRefData || [];
    if (data.length === 0) { toast('Chưa có shot data', 'warning'); return; }

    // Create or reuse modal
    let modal = document.getElementById('refImagesDetailModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'refImagesDetailModal';
        modal.className = 'modal-overlay';
        modal.style.cssText = 'display:none; z-index:10001; align-items:center; justify-content:center; padding:20px;';
        modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
        document.body.appendChild(modal);
    }

    let hasGallery = false;
    if (currentCampaign) {
        try {
            const meta = JSON.parse(currentCampaign.metadata || '{}');
            hasGallery = !!meta.gallery_category_id;
        } catch(e) {}
    }

    const shotsWithChars = data.filter(s => s.chars.length > 0);
    const shotsNoChars = data.filter(s => s.chars.length === 0);
    const totalChars = data.reduce((sum, s) => sum + s.chars.length, 0);

    let content = `
        <div class="modal" style="width:600px; max-height:80vh; display:flex; flex-direction:column;">
            <div class="modal-header">
                <h2 class="modal-title">🖼 Tham Chiếu Nhân Vật (Reference Data)</h2>
            </div>
            <div style="padding:16px 20px; overflow-y:auto; flex:1;">
                <div style="margin-bottom:16px; padding:10px; border-radius:6px; background:var(--bg-2); border:1px solid var(--border); display:flex; gap:10px; align-items:center;">
                    <div style="padding:4px 8px; border-radius:4px; font-size:11px; font-weight:600; 
                        background:${hasGallery ? 'rgba(52,211,153,0.12)' : 'rgba(239,68,68,0.1)'}; 
                        color:${hasGallery ? 'rgb(52,211,153)' : 'rgb(252,165,165)'}; border:1px solid ${hasGallery ? 'rgba(52,211,153,0.3)' : 'rgba(239,68,68,0.3)'};">
                        ${hasGallery ? '✅ Đã cài đặt Gallery' : '❌ Chưa có Gallery Fallback'}
                    </div>
                    <div style="font-size:11px; color:var(--text-2);">Nếu shot không có nhân vật, ảnh từ Gallery sẽ được dùng làm backup (nếu có).</div>
                </div>
                <div style="display:flex; gap:12px; margin-bottom:16px;">
                    <div style="flex:1; padding:12px; background:var(--bg-2); border-radius:8px; border:1px solid var(--border); text-align:center;">
                        <div style="font-size:24px; font-weight:700; color:var(--primary);">${totalChars}</div>
                        <div style="font-size:11px; color:var(--text-3);">Tổng số nhân vật</div>
                    </div>
                    <div style="flex:1; padding:12px; background:var(--bg-2); border-radius:8px; border:1px solid var(--border); text-align:center;">
                        <div style="font-size:24px; font-weight:700; color:rgb(52,211,153);">${shotsWithChars.length}</div>
                        <div style="font-size:11px; color:var(--text-3);">Shots có nhân vật</div>
                    </div>
                    <div style="flex:1; padding:12px; background:var(--bg-2); border-radius:8px; border:1px solid var(--border); text-align:center;">
                        <div style="font-size:24px; font-weight:700; color:${shotsNoChars.length > 0 ? 'rgb(251,191,36)' : 'var(--text-3)'};">${shotsNoChars.length}</div>
                        <div style="font-size:11px; color:var(--text-3);">Shots trống nhân vật</div>
                    </div>
                </div>`;

    if (shotsNoChars.length > 0) {
        content += `<div style="margin-bottom:12px; padding:10px; background:rgba(245,158,11,0.08); border:1px solid rgba(245,158,11,0.2); border-radius:6px; font-size:11px; color:rgb(251,191,36);">
            ⚠️ ${shotsNoChars.length} shots không có nhân vật: ${shotsNoChars.map(s => `#${s.num}`).join(', ')}
        </div>`;
    }

    content += `<div style="display:flex; flex-direction:column; gap:8px;">`;
    data.forEach(s => {
        const hasChars = s.chars.length > 0;
        let charListHtml = '';
        if (hasChars) {
            charListHtml = `<div style="margin-top:6px; display:flex; flex-wrap:wrap; gap:4px;">` + 
                s.chars.map(c => `<span style="padding:2px 6px; background:var(--bg-2); border:1px solid var(--border); border-radius:4px; font-size:10px; color:var(--text-2);">${esc(c)}</span>`).join('') + 
                `</div>`;
        }

        content += `
            <div style="display:flex; flex-direction:column; padding:8px 12px; background:var(--bg-1); border:1px solid var(--border); border-radius:6px; font-size:12px;">
                <div style="display:flex; align-items:center; gap:10px;">
                    <span style="font-weight:600; min-width:60px; color:var(--text-1);">Shot #${s.num}</span>
                    <span style="flex:1; color:var(--text-2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(s.title)}</span>
                    <span style="padding:2px 8px; border-radius:4px; font-size:10px; font-weight:600; 
                        background:${hasChars ? 'rgba(52,211,153,0.12)' : (hasGallery ? 'rgba(129,140,248,0.15)' : 'rgba(239,68,68,0.1)')}; 
                        color:${hasChars ? 'rgb(52,211,153)' : (hasGallery ? 'rgb(129,140,248)' : 'rgb(252,165,165)')};">
                        ${hasChars ? `👤 ${s.chars.length} nhân vật` : (hasGallery ? '🖼 Dùng Gallery' : '❌ Không có ref')}
                    </span>
                </div>
                ${charListHtml}
            </div>`;
    });
    content += `</div></div>
            <div class="modal-actions" style="padding:12px 20px; border-top:1px solid var(--border);">
                <button class="btn" onclick="document.getElementById('refImagesDetailModal').style.display='none'">Close</button>
            </div>
        </div>`;

    modal.innerHTML = content;
    modal.style.display = 'flex';
}

// ── Copy All Narration Text ─────────────────────────────────
async function copyAllAudioText() {
    if (!currentEpisode) { toast('Chưa chọn episode', 'error'); return; }
    try {
        const sbRes = await apiFetch(`/episodes/${currentEpisode.id}/storyboards`);
        const shots = sbRes.items || [];
        if (!shots.length) { toast('Chưa có storyboard', 'warning'); return; }
        
        const lines = shots.map((s, i) => {
            const text = (s.narration_text || s.dialogue || s.description || '').trim();
            return text;
        }).filter(t => t);
        
        if (!lines.length) { toast('Không có narration text', 'warning'); return; }
        
        const allText = lines.join(' ');
        await navigator.clipboard.writeText(allText);
        toast(`📋 Đã copy ${lines.length} đoạn narration (${allText.length} chars)`, 'success');
    } catch (e) {
        console.error('copyAllAudioText error:', e);
        toast('❌ Copy thất bại: ' + e.message, 'error');
    }
}

// ── Audio Upload (Manual) ───────────────────────────────────
async function handleAudioUpload(input) {
    if (!input.files || !input.files[0]) return;
    if (!currentEpisode) { toast('Chưa chọn episode', 'error'); return; }
    
    const file = input.files[0];
    const maxMB = 200;
    if (file.size > maxMB * 1024 * 1024) {
        toast(`File quá lớn (tối đa ${maxMB}MB)`, 'error');
        input.value = '';
        return;
    }
    
    // Show progress in status bar
    const statusEl = document.getElementById('audioStatus');
    const btnUpload = document.getElementById('btnUploadAudio');
    const btnGen = document.getElementById('btnGenAllAudio');
    if (statusEl) statusEl.textContent = `⏳ Đang upload & phân tích Whisper...`;
    if (btnUpload) btnUpload.disabled = true;
    if (btnGen) btnGen.disabled = true;
    
    toast(`📤 Đang upload "${file.name}"... Whisper sẽ tự tách từng shot`, 'info');
    
    try {
        const formData = new FormData();
        formData.append('audio', file);
        
        const resp = await fetch(`/api/v1/pod_studio/episodes/${currentEpisode.id}/upload-audio`, {
            method: 'POST',
            body: formData
        });
        
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({ detail: resp.statusText }));
            throw new Error(err.detail || `HTTP ${resp.status}`);
        }
        
        const data = await resp.json();
        const { total, success_count } = data;
        
        if (statusEl) statusEl.textContent = `✅ ${success_count}/${total} audio ready`;
        toast(`✅ Upload xong! ${success_count}/${total} shots đã có audio`, 'success');
        
        // Reload cards to show new audio
        await loadEpisodeAudio();
        
    } catch (e) {
        console.error('Upload audio error:', e);
        if (statusEl) statusEl.textContent = 'No audio';
        toast(`❌ Upload thất bại: ${e.message}`, 'error');
    } finally {
        if (btnUpload) btnUpload.disabled = false;
        if (btnGen) btnGen.disabled = false;
        input.value = ''; // Reset file input for re-upload
    }
}

// ── Audio Step ─────────────────────────────────────────────
async function loadEpisodeAudio() {
    const cardsEl = document.getElementById('audioShotCards');
    const empty = document.getElementById('audioEmpty');
    const player = document.getElementById('audioPlayerSection');
    const statusEl = document.getElementById('audioStatus');
    
    if (!currentEpisode) { console.warn('loadEpisodeAudio: no currentEpisode'); return; }
    if (!cardsEl) { console.error('loadEpisodeAudio: audioShotCards element not found'); return; }
    
    // Fetch storyboard shots
    let shots = [];
    try {
        const sbRes = await apiFetch(`/episodes/${currentEpisode.id}/storyboards`);
        shots = sbRes.items || [];
        console.log(`loadEpisodeAudio: ${shots.length} shots loaded`);
    } catch(e) { console.error('loadEpisodeAudio fetch error:', e); }
    
    if (shots.length === 0) {
        cardsEl.innerHTML = '';
        if (empty) empty.style.display = '';
        if (player) player.style.display = 'none';
        if (statusEl) statusEl.textContent = 'No storyboard shots — create storyboard first';
        return;
    }
    
    if (empty) empty.style.display = 'none';
    if (player) player.style.display = 'none';
    
    const withAudio = shots.filter(s => s.tts_audio_url && s.tts_audio_url.trim()).length;
    if (statusEl) statusEl.textContent = `${withAudio}/${shots.length} audio ready`;
    
    // Render cards - show only narration text (strip prompt metadata)
    cardsEl.innerHTML = shots.map((shot, idx) => {
        const rawNarration = shot.narration_text || shot.dialogue || shot.description || '';
        const narration = _cleanNarration(rawNarration);
        const hasAudio = shot.tts_audio_url && shot.tts_audio_url.trim();
        const cardClass = hasAudio ? 'audio-shot-card has-audio' : 'audio-shot-card';
        const charCount = narration.length;
        
        // Whisper content check: flag if narration is suspiciously short or empty
        let whisperWarning = '';
        if (hasAudio && charCount < 10) {
            whisperWarning = '<span style="color:#ef4444;font-size:10px;font-weight:600;" title="Nội dung quá ngắn hoặc thiếu — kiểm tra lại Whisper">⚠️ Thiếu nội dung</span>';
        } else if (hasAudio && charCount < 30) {
            whisperWarning = '<span style="color:#f59e0b;font-size:10px;font-weight:600;" title="Nội dung ngắn — có thể Whisper tách thiếu">⚠️ Nội dung ngắn</span>';
        }
        
        return `
            <div class="${cardClass}" id="audioCard_${shot.id}">
                <div class="audio-shot-num">${shot.storyboard_number || idx + 1}</div>
                <div class="audio-shot-body">
                    <div class="audio-shot-title">
                        ${esc(shot.title || 'Shot ' + (idx + 1))}
                        ${hasAudio ? '<span style="color:#22c55e;font-size:11px;">\u2705</span>' : '<span style="color:var(--text-3);font-size:11px;">\u23f3</span>'}
                        <span style="font-size:10px;color:var(--text-3);font-weight:400">${charCount} chars</span>
                        ${hasAudio ? `<span class="audio-duration-badge" id="durBadge_${shot.id}" style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:var(--bg-3);color:var(--text-3);">0:00</span>` : ''}
                        ${whisperWarning}
                        <button onclick="toggleAudioText(this)" style="font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bg-3);border:1px solid var(--border);color:var(--text-2);cursor:pointer;margin-left:auto;">▼ Xem</button>
                    </div>
                    <div class="audio-shot-text" id="audioText_${shot.id}" onclick="toggleAudioTextByClick(this)">${esc(narration) || '<i style="color:var(--text-3)">No narration text</i>'}</div>
                    <div id="audioEdit_${shot.id}" style="display:none;margin-top:8px;">
                        <textarea id="audioEditTA_${shot.id}" class="input" style="width:100%;min-height:80px;font-size:12px;line-height:1.6;resize:vertical;">${esc(narration)}</textarea>
                        <div style="display:flex;gap:6px;margin-top:6px;justify-content:flex-end;">
                            <button class="btn btn-outline" style="font-size:11px;padding:4px 10px;" onclick="cancelEditNarration(${shot.id})">Cancel</button>
                            <button class="btn btn-primary" style="font-size:11px;padding:4px 10px;" onclick="saveNarration(${shot.id})">Save</button>
                            <button class="btn btn-primary" style="font-size:11px;padding:4px 10px;background:linear-gradient(135deg,#7c3aed,#6d28d9);border:none;" onclick="saveAndRegenerateTTS(${shot.id}, ${idx})">Save + TTS</button>
                        </div>
                    </div>
                    ${hasAudio ? `
                    <div class="mini-player" id="mp_${shot.id}">
                        <button class="mp-play" onclick="toggleMiniPlayer(${shot.id})">\u25b6</button>
                        <div class="mp-bar" onclick="seekMiniPlayer(event, ${shot.id})">
                            <div class="mp-progress" id="mpProg_${shot.id}"></div>
                        </div>
                        <span class="mp-time" id="mpTime_${shot.id}">0:00</span>
                        <audio id="mpAudio_${shot.id}" preload="metadata" src="${shot.tts_audio_url}" 
                            ontimeupdate="updateMiniPlayer(${shot.id})" 
                            onended="endMiniPlayer(${shot.id})"
                            onloadedmetadata="initMiniPlayer(${shot.id})"></audio>
                    </div>` : ''}
                </div>
                <div class="audio-shot-actions">
                    <button class="btn btn-sm btn-ghost" onclick="toggleEditNarration(${shot.id})" title="Edit text" style="font-size:13px;">\u270f\ufe0f</button>
                    ${hasAudio ? `<button class="btn btn-sm btn-ghost" style="color:var(--red);" onclick="deleteShotAudio(${shot.id})" title="Xóa audio"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>` : ''}
                    <button class="btn btn-sm ${hasAudio ? 'btn-ghost' : 'btn-primary'}" onclick="generateShotAudio(${shot.id}, ${idx})" id="btnGenShot_${shot.id}" title="${hasAudio ? 'Regenerate' : 'Generate TTS'}">
                        ${hasAudio ? '\ud83d\udd04' : '\ud83c\udf99'}
                    </button>
                </div>
            </div>
        `;
    }).join('');
    
    if (currentEpisode.audio_url) {
        if (player) player.style.display = 'flex';
        document.getElementById('audioStepPlayer').src = currentEpisode.audio_url;
        document.getElementById('audioStepDownload').href = currentEpisode.audio_url;
    }
    
    // Add total duration summary after all audio metadata loads
    if (withAudio > 0) {
        setTimeout(() => _updateAudioDurationSummary(shots), 2000);
    }
}

// Clean narration text: strip prompt metadata, keep only story content
function _cleanNarration(text) {
    if (!text) return '';
    let clean = text
        .replace(/\[IMAGE PROMPT\][\s\S]*?(?=\[|$)/gi, '')
        .replace(/\[CHARACTERS\][\s\S]*?(?=\[|$)/gi, '')
        .replace(/\[SCENE SETTING\][\s\S]*?(?=\[|$)/gi, '')
        .replace(/\[Camera Angle\][^\n]*/gi, '')
        .replace(/\[NARRATION\]:?/gi, '')
        .replace(/\[DIALOGUE\]:?/gi, '')
        // Strip visual/cinematic descriptions that shouldn't be in narration
        .replace(/^Hình ảnh chuyển cảnh[.:]\s*/gim, '')
        .replace(/^Cảnh quay (cắt|chuyển|mở)[^.]*\.\s*/gim, '')
        .replace(/^(Camera|Fade|Cut|Pan|Zoom|Tracking)[^.]*\.\s*/gim, '')
        .replace(/^Hình ảnh [^.]*\.\s*/gim, '')
        .trim();
    return clean || text.trim();
}


// ── Audio Duration Summary ──
function _updateAudioDurationSummary(shots) {
    const statusEl = document.getElementById('audioStatus');
    if (!statusEl) return;
    
    let totalSplitDuration = 0;
    let zeroCount = 0;
    let shortCount = 0;
    let zeroWithTextShots = [];
    const withAudio = shots.filter(s => s.tts_audio_url && s.tts_audio_url.trim());
    
    for (const shot of withAudio) {
        const audioEl = document.getElementById(`mpAudio_${shot.id}`);
        const dur = (audioEl && audioEl.duration && !isNaN(audioEl.duration)) ? audioEl.duration : 0;
        totalSplitDuration += dur;
        
        if (dur < 0.5) {
            zeroCount++;
            // Check if this shot has narration text but 0s audio
            const narration = (shot.narration_text || shot.dialogue || shot.description || '').trim();
            if (narration.length > 10) {
                zeroWithTextShots.push(shot.storyboard_number || shot.id);
            }
        } else if (dur < 5) {
            shortCount++;
        }
    }
    
    const totalFmt = _fmtTime(totalSplitDuration);
    
    // Try to get original audio duration
    const _showSummary = (originalDuration) => {
        let summaryParts = [`${withAudio.length}/${shots.length} audio ready`, `Tổng cắt: ${totalFmt}`];
        
        if (originalDuration > 0) {
            const origFmt = _fmtTime(originalDuration);
            const diff = Math.abs(totalSplitDuration - originalDuration);
            const diffPct = originalDuration > 0 ? (diff / originalDuration * 100).toFixed(1) : 0;
            
            summaryParts.push(`Gốc: ${origFmt}`);
            if (diff < 2) {
                summaryParts.push(`<span style="color:#22c55e;">✅ Khớp</span>`);
            } else {
                summaryParts.push(`<span style="color:#f59e0b;">⚠️ Lệch ${_fmtTime(diff)} (${diffPct}%)</span>`);
            }
        }
        
        if (zeroCount > 0) {
            let zeroMsg = `<span style="color:#ef4444;">🔴 ${zeroCount} lỗi 0s</span>`;
            if (zeroWithTextShots.length > 0) {
                zeroMsg += ` <span style="color:#ef4444;font-size:10px;">(Shot ${zeroWithTextShots.slice(0, 5).join(', ')}${zeroWithTextShots.length > 5 ? '...' : ''})</span>`;
            }
            summaryParts.push(zeroMsg);
        }
        if (shortCount > 0) summaryParts.push(`<span style="color:#f59e0b;">🟠 ${shortCount} ngắn &lt;5s</span>`);
        
        // Add Fix button if there are 0-duration or mismatch issues
        if (zeroCount > 0 || (originalDuration > 0 && Math.abs(totalSplitDuration - originalDuration) >= 2)) {
            summaryParts.push(`<button onclick="resplitAudio()" style="font-size:10px;padding:2px 8px;border-radius:4px;background:linear-gradient(135deg,#7c3aed,#6d28d9);border:none;color:#fff;cursor:pointer;font-weight:600;" id="btnResplit">🔧 Fix Audio</button>`);
        }
        
        statusEl.innerHTML = summaryParts.map((p, i) => {
            if (i === 0) return p;
            return `<span style="margin-left:8px;padding-left:8px;border-left:1px solid var(--border);">${p}</span>`;
        }).join('');
    };
    
    // Load original episode audio to get its duration
    if (currentEpisode && currentEpisode.audio_url) {
        const probeAudio = new Audio();
        probeAudio.preload = 'metadata';
        probeAudio.onloadedmetadata = () => {
            _showSummary(probeAudio.duration || 0);
            probeAudio.src = ''; // cleanup
        };
        probeAudio.onerror = () => {
            _showSummary(0);
        };
        // Timeout fallback
        setTimeout(() => {
            if (!probeAudio.duration) _showSummary(0);
        }, 5000);
        probeAudio.src = currentEpisode.audio_url;
    } else {
        _showSummary(0);
    }
}

// ── Resplit Audio Fix ──
async function resplitAudio() {
    if (!currentEpisode) { toast('No episode selected', 'error'); return; }
    
    const btn = document.getElementById('btnResplit');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Đang xử lý...';
    }
    
    try {
        toast('🔧 Đang re-split audio với thuật toán mới...', 'info');
        const res = await apiFetch(`/episodes/${currentEpisode.id}/resplit-audio`, {
            method: 'POST'
        });
        
        if (res.success) {
            const okCount = res.results.filter(r => r.status === 'ok').length;
            const errCount = res.results.filter(r => r.status === 'error').length;
            toast(`✅ Re-split xong: ${okCount} thành công${errCount > 0 ? `, ${errCount} lỗi` : ''}`, 'success');
            
            // Reload audio panel
            await loadEpisodeAudio();
        } else {
            toast(`❌ Re-split thất bại: ${res.message || 'unknown'}`, 'error');
        }
    } catch (e) {
        toast(`❌ Lỗi: ${e.message}`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '🔧 Fix Audio';
        }
    }
}

// ── Audio Card Expand/Edit Functions ──

function toggleAudioText(btn) {
    if (!btn) return;
    const body = btn.closest('.audio-shot-body');
    if (!body) return;
    const textEl = body.querySelector('.audio-shot-text');
    if (!textEl) return;
    textEl.classList.toggle('expanded');
    btn.textContent = textEl.classList.contains('expanded') ? '\u25b2 Thu' : '\u25bc Xem';
}

function toggleAudioTextByClick(textEl) {
    if (!textEl) return;
    textEl.classList.toggle('expanded');
    // Also update the button text if it exists
    const body = textEl.closest('.audio-shot-body');
    if (body) {
        const btn = body.querySelector('.audio-shot-title button');
        if (btn) btn.textContent = textEl.classList.contains('expanded') ? '\u25b2 Thu' : '\u25bc Xem';
    }
}

function toggleEditNarration(shotId) {
    const editDiv = document.getElementById('audioEdit_' + shotId);
    const textDiv = document.getElementById('audioText_' + shotId);
    if (!editDiv) return;
    const isHidden = editDiv.style.display === 'none';
    editDiv.style.display = isHidden ? 'block' : 'none';
    if (textDiv) textDiv.style.display = isHidden ? 'none' : '';
    if (isHidden) {
        const ta = document.getElementById('audioEditTA_' + shotId);
        if (ta) ta.focus();
    }
}

function cancelEditNarration(shotId) {
    const editDiv = document.getElementById('audioEdit_' + shotId);
    const textDiv = document.getElementById('audioText_' + shotId);
    if (editDiv) editDiv.style.display = 'none';
    if (textDiv) textDiv.style.display = '';
}

async function saveNarration(shotId) {
    const ta = document.getElementById('audioEditTA_' + shotId);
    if (!ta) return;
    const newText = ta.value.trim();
    try {
        await apiFetch('/storyboards/' + shotId, {
            method: 'PUT',
            body: JSON.stringify({ narration_text: newText })
        });
        toast('Narration updated', 'success');
        cancelEditNarration(shotId);
        await loadEpisodeAudio();
    } catch (e) {
        toast('Save failed: ' + e.message, 'error');
    }
}

async function saveAndRegenerateTTS(shotId, idx) {
    const ta = document.getElementById('audioEditTA_' + shotId);
    if (!ta) return;
    const newText = ta.value.trim();
    try {
        await apiFetch('/storyboards/' + shotId, {
            method: 'PUT',
            body: JSON.stringify({ narration_text: newText })
        });
        toast('Narration saved, generating TTS...', 'info');
        cancelEditNarration(shotId);
        await generateShotAudio(shotId, idx);
    } catch (e) {
        toast('Error: ' + e.message, 'error');
    }
}


// ── Mini Player Controls ──
let _activeMiniPlayer = null;

function toggleMiniPlayer(shotId) {
    const audio = document.getElementById(`mpAudio_${shotId}`);
    const btn = document.querySelector(`#mp_${shotId} .mp-play`);
    if (!audio || !btn) return;
    
    // Stop any other playing audio
    if (_activeMiniPlayer && _activeMiniPlayer !== shotId) {
        const prevAudio = document.getElementById(`mpAudio_${_activeMiniPlayer}`);
        const prevBtn = document.querySelector(`#mp_${_activeMiniPlayer} .mp-play`);
        if (prevAudio) { prevAudio.pause(); }
        if (prevBtn) prevBtn.textContent = '▶';
    }
    
    if (audio.paused) {
        audio.play().catch(e => console.warn('Play failed:', e));
        btn.textContent = '⏸';
        _activeMiniPlayer = shotId;
    } else {
        audio.pause();
        btn.textContent = '▶';
        _activeMiniPlayer = null;
    }
}

function updateMiniPlayer(shotId) {
    const audio = document.getElementById(`mpAudio_${shotId}`);
    const prog = document.getElementById(`mpProg_${shotId}`);
    const timeEl = document.getElementById(`mpTime_${shotId}`);
    if (!audio || !prog) return;
    
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    prog.style.width = pct + '%';
    
    if (timeEl) {
        const cur = _fmtTime(audio.currentTime);
        const dur = _fmtTime(audio.duration || 0);
        timeEl.textContent = `${cur}/${dur}`;
    }
}

function initMiniPlayer(shotId) {
    const audio = document.getElementById(`mpAudio_${shotId}`);
    const timeEl = document.getElementById(`mpTime_${shotId}`);
    const badge = document.getElementById(`durBadge_${shotId}`);
    
    if (audio && timeEl) {
        const dur = audio.duration || 0;
        timeEl.textContent = `0:00/${_fmtTime(dur)}`;
        
        // Update duration badge with color coding
        if (badge) {
            badge.textContent = _fmtTime(dur);
            if (dur === 0 || isNaN(dur)) {
                badge.style.background = 'rgba(239,68,68,0.2)';
                badge.style.color = '#ef4444';
                badge.title = 'Thời lượng 0s — audio có thể bị lỗi';
            } else if (dur < 5) {
                badge.style.background = 'rgba(245,158,11,0.2)';
                badge.style.color = '#f59e0b';
                badge.title = `Thời lượng ngắn (${dur.toFixed(1)}s) — kiểm tra lại`;
            } else {
                badge.style.background = 'rgba(34,197,94,0.2)';
                badge.style.color = '#22c55e';
                badge.title = `${dur.toFixed(1)}s`;
            }
        }
    }
}

function endMiniPlayer(shotId) {
    const btn = document.querySelector(`#mp_${shotId} .mp-play`);
    const prog = document.getElementById(`mpProg_${shotId}`);
    if (btn) btn.textContent = '▶';
    if (prog) prog.style.width = '0%';
    _activeMiniPlayer = null;
}

function seekMiniPlayer(e, shotId) {
    const audio = document.getElementById(`mpAudio_${shotId}`);
    const bar = e.currentTarget;
    if (!audio || !bar || !audio.duration) return;
    const rect = bar.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pct * audio.duration;
}

function _fmtTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
}

async function generateShotAudio(shotId, idx) {
    const btn = document.getElementById(`btnGenShot_${shotId}`);
    const card = document.getElementById(`audioCard_${shotId}`);
    if (!btn || !card) return;
    
    btn.disabled = true;
    btn.textContent = '⏳';
    card.classList.add('generating');
    card.classList.remove('has-audio');
    
    try {
        const res = await apiFetch(`/storyboards/${shotId}/generate-tts`, { method: 'POST' });
        if (res.success && res.audio_url) {
            // Refresh card
            await loadEpisodeAudio();
            toast(`✅ Shot ${idx + 1} audio ready`, 'success');
        } else {
            throw new Error(res.detail || res.message || 'TTS failed');
        }
    } catch(e) {
        toast(`❌ Shot ${idx + 1}: ${e.message}`, 'error');
        btn.disabled = false;
        btn.textContent = '🎙';
        card.classList.remove('generating');
    }
}

async function generateAllShotAudio() {
    if (!currentEpisode) return;
    
    // Load voices if not loaded
    if (document.getElementById('batchAudioVoice').options.length <= 1) {
        populateVoicesDropdown('batchAudioVoice');
    }
    document.getElementById('batchAudioGenModal').style.display = 'flex';
}

async function confirmBatchAudioGen() {
    if (!currentEpisode) return;
    
    const select = document.getElementById('batchAudioVoice');
    const selectedOption = select.options[select.selectedIndex];
    
    if (!selectedOption || !selectedOption.value) {
        toast("Please select a valid voice.", "error");
        return;
    }
    
    const voiceId = selectedOption.value;
    const engine = selectedOption.getAttribute('data-engine') || 'edge';
    
    document.getElementById('batchAudioGenModal').style.display = 'none';

    const btn = document.getElementById('btnGenAllAudio');
    const statusEl = document.getElementById('audioStatus');
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = '🎙 Starting batch TTS...';
    
    // Immediately mark all pending cards as "generating" with pulse animation
    document.querySelectorAll('.audio-shot-card:not(.has-audio)').forEach(card => {
        card.classList.add('generating');
        const titleEl = card.querySelector('.audio-shot-title span:first-of-type');
        if (titleEl) { titleEl.style.color = '#f59e0b'; titleEl.textContent = '⏳'; }
    });

    // Show progress bar in the toolbar area
    let progressContainer = document.getElementById('ttsProgressContainer');
    if (!progressContainer) {
        const toolbar = document.querySelector('#stepAudio .step-toolbar .toolbar-left');
        if (toolbar) {
            toolbar.insertAdjacentHTML('afterend', `
                <div id="ttsProgressContainer" style="display:flex; align-items:center; gap:8px; flex:1; padding:0 12px;">
                    <div style="flex:1; height:6px; background:var(--bg-3); border-radius:3px; overflow:hidden;">
                        <div id="ttsProgressBar" style="width:0%; height:100%; background:var(--accent-gradient); transition:width 0.4s ease; border-radius:3px;"></div>
                    </div>
                    <span id="ttsProgressText" style="font-size:11px; color:var(--text-2); font-family:var(--font-mono); white-space:nowrap;">0%</span>
                </div>
            `);
            progressContainer = document.getElementById('ttsProgressContainer');
        }
    } else {
        progressContainer.style.display = 'flex';
        document.getElementById('ttsProgressBar').style.width = '0%';
        document.getElementById('ttsProgressText').textContent = '0%';
    }
    
    try {
        // Fire background batch TTS
        const res = await apiFetch(`/episodes/${currentEpisode.id}/batch-tts`, { 
            method: 'POST',
            body: JSON.stringify({
                voice_id: voiceId,
                engine: engine
            })
        });
        if (!res.success || !res.task_id) throw new Error('Failed to start batch TTS');
        
        const taskId = res.task_id;
        const total = res.total || 0;
        toast(`🎙 TTS started for ${total} shots`, 'info');
        
        // Poll for progress
        const pollId = setInterval(async () => {
            try {
                const st = await apiFetch(`/batch-tts/${taskId}`);
                const done = st.done || 0;
                const success = st.success || 0;
                const failed = st.failed || 0;
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                
                if (statusEl) statusEl.textContent = `🎙 ${done}/${total} (✅${success} ❌${failed})`;
                
                // Update progress bar
                const bar = document.getElementById('ttsProgressBar');
                const txt = document.getElementById('ttsProgressText');
                if (bar) bar.style.width = pct + '%';
                if (txt) txt.textContent = `${done}/${total}`;
                
                // Update individual cards if visible
                if (st.results) {
                    for (const r of st.results) {
                        const card = document.getElementById(`audioCard_${r.shot_id}`);
                        const cardBtn = document.getElementById(`btnGenShot_${r.shot_id}`);
                        if (r.status === 'ok') {
                            if (card) { card.classList.remove('generating'); card.classList.add('has-audio'); }
                            if (cardBtn) { cardBtn.innerHTML = '🔄'; cardBtn.disabled = false; }
                            // Add mini player if missing
                            const body = card?.querySelector('.audio-shot-body');
                            if (body && !body.querySelector('.mini-player') && r.audio_url) {
                                body.insertAdjacentHTML('beforeend', `
                                <div class="mini-player" id="mp_${r.shot_id}">
                                    <button class="mp-play" onclick="toggleMiniPlayer(${r.shot_id})">▶</button>
                                    <div class="mp-bar" onclick="seekMiniPlayer(event, ${r.shot_id})">
                                        <div class="mp-progress" id="mpProg_${r.shot_id}"></div>
                                    </div>
                                    <span class="mp-time" id="mpTime_${r.shot_id}">0:00</span>
                                    <audio id="mpAudio_${r.shot_id}" preload="none" src="${r.audio_url}" 
                                        ontimeupdate="updateMiniPlayer(${r.shot_id})" 
                                        onended="endMiniPlayer(${r.shot_id})"
                                        onloadedmetadata="initMiniPlayer(${r.shot_id})"></audio>
                                </div>`);
                            }
                            const statusIcon = card?.querySelector('.audio-shot-title span:first-of-type');
                            if (statusIcon) { statusIcon.style.color = '#22c55e'; statusIcon.textContent = '✅'; }
                        } else if (r.status === 'error' || r.status === 'timeout') {
                            if (card) card.classList.remove('generating');
                            if (cardBtn) { cardBtn.innerHTML = '❌'; cardBtn.disabled = false; }
                            const statusIcon = card?.querySelector('.audio-shot-title span:first-of-type');
                            if (statusIcon) { statusIcon.style.color = '#ef4444'; statusIcon.textContent = '❌'; }
                        }
                    }
                }
                
                if (st.status === 'done' || st.status === 'error') {
                    clearInterval(pollId);
                    if (btn) btn.disabled = false;
                    if (statusEl) statusEl.textContent = `✅ ${success}/${total} audio ready`;
                    // Hide progress bar
                    const pc = document.getElementById('ttsProgressContainer');
                    if (pc) pc.style.display = 'none';
                    toast(`🎙 Batch TTS done: ${success}/${total} success`, st.status === 'done' ? 'success' : 'error');
                    // Refresh audio cards
                    loadEpisodeAudio();
                }
            } catch(e) {
                console.warn('TTS poll error', e);
            }
        }, 2000);
        
    } catch(e) {
        toast('TTS Error: ' + e.message, 'error');
        if (btn) btn.disabled = false;
        if (statusEl) statusEl.textContent = '❌ TTS failed';
        const pc = document.getElementById('ttsProgressContainer');
        if (pc) pc.style.display = 'none';
    }
}

async function deleteShotAudio(shotId) {
    if (!confirm("Bạn có chắc muốn xoá audio của shot này không?")) return;
    
    const btn = document.getElementById(`btnGenShot_${shotId}`);
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    
    try {
        const res = await apiFetch(`/storyboards/${shotId}`, {
            method: 'PUT',
            body: JSON.stringify({ tts_audio_url: "" })
        });
        if (res.success || res.id) {
            toast('Đã xoá audio thành công', 'success');
            await loadEpisodeAudio();
        } else {
            toast('Lỗi khi xoá audio', 'error');
            if (btn) { btn.disabled = false; btn.textContent = '🗑️'; }
        }
    } catch(e) {
        toast('Lỗi: ' + e.message, 'error');
        if (btn) { btn.disabled = false; btn.textContent = '🗑️'; }
    }
}

function openAudioGenStep() {
    generateAllShotAudio();
}

async function deleteCurrentAudio() {
    if(!currentEpisode || !currentEpisode.audio_url) return;
    if(!confirm("Are you sure you want to delete the synthesized audio for this episode?")) return;
    
    currentEpisode.audio_url = "";
    try {
        await apiFetch(`/episodes/${currentEpisode.id}`, {
            method: 'PUT',
            body: JSON.stringify({ audio_url: "" })
        });
        toast("Audio deleted successfully.", "success");
        document.getElementById('audioPlayerSection').style.display = 'none';
        document.getElementById('audioStepPlayer').pause();
        document.getElementById('audioStepPlayer').src = '';
    } catch(e) {
        toast("Failed to delete audio: " + e.message, "error");
    }
}

// ── Video Step (Slideshow Player) ──────────────────────────
let videoSlides = [];
let videoPlaying = false;
let videoAnimFrame = null;
let videoStartTime = 0;       // when play started (performance.now)
let videoElapsed = 0;          // accumulated time before last pause
let videoCurrentSlideIdx = 0;
let videoSecsPerSlide = 5;     // default
let videoSyncAudio = false;

function loadEpisodeVideo() {
    const empty = document.getElementById('videoEmpty');
    const container = document.getElementById('videoPlayerContainer');
    const progress = document.getElementById('videoBuildProgress');
    const statusEl = document.getElementById('videoStatus');
    const exportedContainer = document.getElementById('videoExportedContainer');
    const exportedPlayer = document.getElementById('videoExportedPlayer');
    const exportedDownload = document.getElementById('videoExportedDownload');
    
    // 1. If episode has an exported MP4 video, show native <video> player
    if (currentEpisode && currentEpisode.video_url) {
        _stopVideo();
        empty.style.display = 'none';
        progress.style.display = 'none';
        container.style.display = 'none';
        
        // Determine the URL: if it's an absolute path, serve via API; otherwise use as-is
        let videoSrc = currentEpisode.video_url;
        if (videoSrc.includes(':\\') || videoSrc.includes(':/')) {
            // Absolute Windows/Unix path -> serve via a file API
            const fname = videoSrc.replace(/\\/g, '/').split('/').pop();
            videoSrc = `/api/v1/pod_studio/export-video/${encodeURIComponent(fname)}`;
        }
        
        exportedPlayer.src = videoSrc;
        exportedDownload.href = videoSrc;
        exportedContainer.style.display = 'flex';
        return;
    }
    
    // 2. Hide exported player if no exported video
    if (exportedContainer) exportedContainer.style.display = 'none';
    
    if (window.currentVideoEpisodeId === currentEpisode?.id && typeof videoSlides !== 'undefined' && videoSlides.length > 0) {
        // Video is already built for this episode. Just show container and return.
        empty.style.display = 'none';
        progress.style.display = 'none';
        container.style.display = 'flex';
        return;
    }
    
    // Stop any playing video and reset state
    _stopVideo();
    videoSlides = [];
    
    // Hide player and progress, show empty initially
    container.style.display = 'none';
    progress.style.display = 'none';
    empty.style.display = '';
    statusEl.textContent = 'No video';
    
    // Auto-build if episode has storyboard images
    if (currentEpisode && currentEpisode.id) {
        _tryAutoBuildVideo();
    }
}

async function _tryAutoBuildVideo() {
    try {
        const sbRes = await apiFetch(`/episodes/${currentEpisode.id}/storyboards`);
        const shots = (sbRes.items || []).filter(s => s.composed_image);
        if (shots.length > 0) {
            // Has images, auto-build with defaults
            _doBuildVideoPreview({ randomSlides: true, addAudio: !!currentEpisode.audio_url });
        }
    } catch(e) {
        // Silently fail, user can still manually build
        console.warn('Auto-build video check failed:', e);
    }
}

function setVideoSpeed(val) {
    if (val === 'audio') {
        videoSyncAudio = true;
    } else {
        videoSyncAudio = false;
        videoSecsPerSlide = parseInt(val) || 5;
    }
}

async function showVideoBuildOptions() {
    if (!currentEpisode) { toast('No episode selected', 'error'); return; }
    
    // Check if audio exists
    const hasAudio = !!currentEpisode.audio_url;
    const wrap = document.getElementById('voVoiceWrap');
    const select = document.getElementById('voVoiceSelect');
    
    if (hasAudio) {
        wrap.style.display = 'none';
    } else {
        wrap.style.display = 'block';
        if (ttsVoicesCache.length === 0) {
            select.innerHTML = '<option value="">Loading voices...</option>';
            try {
                const res = await apiFetch('/../tts/voices');
                if (res.success && res.voices) {
                    ttsVoicesCache = res.voices;
                    let edgeHtml = '<optgroup label="Edge-TTS (Online)">';
                    let vibeHtml = '<optgroup label="VibeVoice (Offline)">';
                    let geminiHtml = '<optgroup label="Gemini (Online via automation)">';
                    ttsVoicesCache.forEach(v => {
                        const langPart = v.language_name || v.language;
                        const namePart = v.name;
                        const genderPart = v.gender ? ` (${v.gender})` : '';
                        const optionHtml = `<option value="${v.id}" data-engine="${v.engine}">${langPart} - ${namePart}${genderPart}</option>`;
                        if (v.engine === 'edge') edgeHtml += optionHtml;
                        else if (v.engine === 'gemini') geminiHtml += optionHtml;
                        else vibeHtml += optionHtml;
                    });
                    edgeHtml += '</optgroup>';
                    vibeHtml += '</optgroup>';
                    geminiHtml += '</optgroup>';
                    select.innerHTML = vibeHtml + edgeHtml + geminiHtml;
                    
                    for (let i = 0; i < select.options.length; i++) {
                        if (select.options[i].value.includes('HoaiMy')) {
                            select.selectedIndex = i;
                            break;
                        }
                    }
                } else {
                    select.innerHTML = '<option value="">Failed to load voices</option>';
                }
            } catch(e) {
                select.innerHTML = '<option value="">Error loading voices</option>';
            }
        }
    }
    
    document.getElementById('videoBuildOptionsModal').style.display = 'flex';
}

let _ffmpegPollTimer = null;
let _ffmpegResolve = null;
let _ffmpegReject = null;

async function startFFmpegExport() {
    if (!currentEpisode) { toast('No episode selected', 'error'); return; }

    const buildBar = document.getElementById('videoBuildBar');
    const buildLabel = document.getElementById('videoBuildLabel');
    const buildCount = document.getElementById('videoBuildCount');
    const progress = document.getElementById('videoBuildProgress');
    const empty = document.getElementById('videoEmpty');
    const container = document.getElementById('videoPlayerContainer');

    empty.style.display = 'none';
    container.style.display = 'none';
    const exportedContainer = document.getElementById('videoExportedContainer');
    if (exportedContainer) exportedContainer.style.display = 'none';
    progress.style.display = 'flex';
    buildBar.style.width = '0%';
    buildLabel.textContent = 'Starting FFmpeg export...';
    buildCount.textContent = '';

    try {
        const res = await apiFetch(`/episodes/${currentEpisode.id}/export-ffmpeg`, { method: 'POST' });
        if (!res.success) {
            toast(res.detail || res.message || 'Error starting export', 'error');
            progress.style.display = 'none';
            empty.style.display = 'flex';
            return;
        }
        
        toast('FFmpeg assembly started', 'info');
        
        // Return a Promise that resolves only when FFmpeg finishes
        return new Promise((resolve, reject) => {
            _ffmpegResolve = resolve;
            _ffmpegReject = reject;
            
            _ffmpegPollTimer = setInterval(async () => {
                try {
                    // Check abort
                    if (realtimeAbortController && realtimeAbortController.signal.aborted) {
                        clearInterval(_ffmpegPollTimer);
                        _ffmpegPollTimer = null;
                        _ffmpegReject = null;
                        reject(new Error("Aborted by user"));
                        return;
                    }
                    
                    const statusRes = await apiFetch(`/export-ffmpeg/status/${res.task_id}`);
                    if (!statusRes.success) {
                        clearInterval(_ffmpegPollTimer);
                        _ffmpegPollTimer = null;
                        buildLabel.textContent = '⚠️ Lỗi: Không thể check tiến độ FFmpeg';
                        resolve(); // don't block auto-pilot
                        return;
                    }
                    
                    const pct = statusRes.done || 0;
                    buildBar.style.width = `${pct}%`;
                    buildLabel.textContent = statusRes.current_shot || `Assembling... ${pct}%`;
                    buildCount.textContent = `${pct}%`;
                    
                    if (statusRes.status === 'completed' || statusRes.status.startsWith('error')) {
                        clearInterval(_ffmpegPollTimer);
                        _ffmpegPollTimer = null;
                        
                        if (statusRes.status.startsWith('error')) {
                            buildLabel.textContent = `❌ ${statusRes.status}`;
                            toast(`FFmpeg Error: ${statusRes.status}`, 'error');
                        } else {
                            buildLabel.textContent = '✅ FFmpeg export complete!';
                            buildBar.style.width = '100%';
                            buildCount.textContent = '100%';
                            toast('Video Assembly Complete!', 'success');
                            
                            // Load the episode to update the UI with new video_url
                            await selectEpisode(currentEpisode.id);
                            setStep('video');
                        }
                        resolve();
                    }
                } catch(e) { 
                    console.warn('poll error', e); 
                }
            }, 2000);
        });

    } catch(e) {
        toast('Exception: ' + e.message, 'error');
        progress.style.display = 'none';
        empty.style.display = 'flex';
    }
}

function confirmBuildVideoPreview() {
    document.getElementById('videoBuildOptionsModal').style.display = 'none';
    const randomSlides = document.getElementById('voRandomSlides').checked;
    const addAudio = document.getElementById('voAddAudio').checked;
    
    let voiceId = null;
    let engine = null;
    const select = document.getElementById('voVoiceSelect');
    if (select && select.selectedIndex >= 0) {
        const opt = select.options[select.selectedIndex];
        voiceId = opt.value;
        engine = opt.getAttribute('data-engine') || 'vibe';
    }
    
    _doBuildVideoPreview({ randomSlides, addAudio, voiceId, engine });
}

async function _doBuildVideoPreview(options = { randomSlides: true, addAudio: true }) {
    const empty = document.getElementById('videoEmpty');
    const container = document.getElementById('videoPlayerContainer');
    const canvas = document.getElementById('videoCanvas');
    if (typeof currentCampaign !== 'undefined' && currentCampaign && canvas) {
        try {
            const meta = JSON.parse(currentCampaign.metadata || '{}');
            const ar = meta.aspect_ratio || '16:9';
            canvas.style.aspectRatio = ar.replace(':', '/');
        } catch(e) {}
    }
    const progress = document.getElementById('videoBuildProgress');
    const statusEl = document.getElementById('videoStatus');
    const audioPlayer = document.getElementById('videoAudioPlayer');
    const buildBar = document.getElementById('videoBuildBar');
    const buildLabel = document.getElementById('videoBuildLabel');
    const buildCount = document.getElementById('videoBuildCount');
    
    // Stop if playing
    _stopVideo();
    
    // --- Phase 1: Show progress, hide others ---
    empty.style.display = 'none';
    container.style.display = 'none';
    progress.style.display = 'flex';
    buildBar.style.width = '0%';
    buildLabel.textContent = 'Loading storyboard data...';
    buildCount.textContent = '';
    
    // --- Phase 2: Fetch storyboard ---
    try {
        const sbRes = await apiFetch(`/episodes/${currentEpisode.id}/storyboards`);
        const shots = (sbRes.items || []).filter(s => s.composed_image);
        
        videoSlides = shots.map(s => {
            const filename = s.composed_image.split(/[\\/]/).pop();
            return {
                src: `/api/v1/pod_studio/grok-image/${filename}`,
                label: `Shot #${s.storyboard_number}${s.title ? ' — ' + s.title : ''}`,
                dialogue: s.dialogue || s.description || '',
            };
        });
    } catch(e) {
        videoSlides = [];
    }
    
    if (videoSlides.length === 0) {
        progress.style.display = 'none';
        empty.style.display = '';
        toast('Cần có ảnh (Images) trước khi build preview', 'warning');
        return;
    }
    
    // --- Phase 3: Pre-load all images with progress ---
    buildLabel.textContent = 'Pre-loading slide images...';
    buildCount.textContent = `0 / ${videoSlides.length}`;
    
    let loaded = 0;
    const totalSteps = videoSlides.length + (options.addAudio ? 1 : 0);
    
    // Assign random VFX to each slide upfront if selected
    for (let i = 0; i < videoSlides.length; i++) {
        if (options.randomSlides) {
            let vfx = VFX_CLASSES[Math.floor(Math.random() * VFX_CLASSES.length)];
            // avoid same VFX as previous
            if (i > 0 && vfx === videoSlides[i - 1].vfx) {
                vfx = VFX_CLASSES[(VFX_CLASSES.indexOf(vfx) + 1) % VFX_CLASSES.length];
            }
            videoSlides[i].vfx = vfx;
        } else {
            videoSlides[i].vfx = null; // No VFX
        }
    }
    
    await Promise.all(videoSlides.map((slide, i) => {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = img.onerror = () => {
                loaded++;
                const pct = Math.round((loaded / totalSteps) * 100);
                buildBar.style.width = pct + '%';
                buildCount.textContent = `${loaded} / ${totalSteps}`;
                buildLabel.textContent = `Loading image ${loaded} / ${videoSlides.length}...`;
                resolve();
            };
            img.src = slide.src;
        });
    }));
    
    // --- Phase 4: Load audio if enabled ---
    let audioUrl = currentEpisode.audio_url;
    
    if (options.addAudio && !audioUrl) {
        buildLabel.textContent = 'Generating full TTS audio...';
        buildCount.textContent = 'VibeVoice/Edge TTS...';
        audioUrl = await _generateVideoTTS(options.voiceId, options.engine);
        if (audioUrl) {
            currentEpisode.audio_url = audioUrl;
            // Silent save
            apiFetch(`/episodes/${currentEpisode.id}`, {
                method: 'PUT',
                body: JSON.stringify({ audio_url: audioUrl })
            }).catch(e => console.error(e));
        }
    }
    
    if (options.addAudio && audioUrl) {
        buildLabel.textContent = 'Loading audio...';
        audioPlayer.src = audioUrl;
        audioPlayer.style.display = '';
        // Wait for audio metadata to load
        await new Promise(resolve => {
            const onReady = () => { audioPlayer.removeEventListener('loadedmetadata', onReady); resolve(); };
            if (audioPlayer.readyState >= 1) { resolve(); }
            else { audioPlayer.addEventListener('loadedmetadata', onReady); }
            // Timeout fallback
            setTimeout(resolve, 5000);
        });
        
        // Auto-switch to sync audio mode
        videoSyncAudio = true;
        document.getElementById('videoSpeedSel').value = 'audio';
    } else {
        audioPlayer.src = '';
        audioPlayer.style.display = 'none';
        
        // If audio was previously synced, switch back to fixed seconds
        if (videoSyncAudio) {
            videoSyncAudio = false;
            document.getElementById('videoSpeedSel').value = '5';
            videoSecsPerSlide = 5;
        }
    }
    
    // Final step
    buildBar.style.width = '100%';
    buildLabel.textContent = 'Done! Starting player...';
    buildCount.textContent = `${totalSteps} / ${totalSteps}`;
    
    await new Promise(r => setTimeout(r, 500));
    
    // --- Phase 5: Show player ---
    progress.style.display = 'none';
    container.style.display = 'flex';
    
    // Record that the video for this episode is successfully built
    window.currentVideoEpisodeId = currentEpisode.id;
    
    const totalDuration = _getVideoDuration();
    statusEl.textContent = `${videoSlides.length} slides · ${_fmtTime(totalDuration)}`;
    
    // Reset state
    videoCurrentSlideIdx = 0;
    videoElapsed = 0;
    _showSlide(0);
    _updateVideoUI(0);
    
    // Show play overlay
    document.getElementById('videoPlayOverlay').style.display = 'flex';
    
    // Show download button
    const dlBtn = document.getElementById('btnDownloadVideo');
    if (dlBtn) dlBtn.style.display = '';
    
    toast(`Video preview: ${videoSlides.length} slides${audioUrl ? ' + audio' : ''} (${_fmtTime(totalDuration)})`, 'success');
}

async function downloadVideoMP4() {
    if (videoSlides.length === 0) { toast('Build preview first', 'warning'); return; }
    
    const btn = document.getElementById('btnDownloadVideo');
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '⏳ Rendering...';
    
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d');
        
        const fps = 30;
        const secsPerSlide = videoSyncAudio ? (_getVideoDuration() / videoSlides.length) : videoSecsPerSlide;
        const totalFrames = Math.ceil(videoSlides.length * secsPerSlide * fps);
        
        // Use MediaRecorder with canvas stream
        const stream = canvas.captureStream(fps);
        
        // Mix audio if available
        let audioCtx, audioSource, audioDest;
        const audioPlayer = document.getElementById('videoAudioPlayer');
        if (audioPlayer && audioPlayer.src && currentEpisode.audio_url) {
            audioCtx = new AudioContext();
            audioSource = audioCtx.createMediaElementSource(audioPlayer);
            audioDest = audioCtx.createMediaStreamDestination();
            audioSource.connect(audioDest);
            audioSource.connect(audioCtx.destination);
            audioDest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
        }
        
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp9' });
        const chunks = [];
        recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
        
        const done = new Promise(resolve => { recorder.onstop = resolve; });
        recorder.start();
        
        // Start audio
        if (audioPlayer && audioPlayer.src && currentEpisode.audio_url) {
            audioPlayer.currentTime = 0;
            audioPlayer.play().catch(() => {});
        }
        
        // Render frames - use proportional timing
        const dlTiming = _getSlideTiming();
        for (let frame = 0; frame < totalFrames; frame++) {
            const t = frame / fps;
            let slideIdx = 0;
            for (let si = 0; si < dlTiming.length; si++) {
                if (t >= dlTiming[si].start) slideIdx = si;
                else break;
            }
            if (slideIdx >= videoSlides.length) slideIdx = videoSlides.length - 1;
            const slide = videoSlides[slideIdx];
            const slideStart = dlTiming[slideIdx].start;
            const slideDur = dlTiming[slideIdx].duration;
            const slideProgress = Math.min((t - slideStart) / slideDur, 1);
            
            // Draw black bg
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, 1280, 720);
            
            // Load image (use cached)
            if (!slide._imgEl) {
                slide._imgEl = new Image();
                slide._imgEl.crossOrigin = 'anonymous';
                slide._imgEl.src = slide.src;
                await new Promise(r => { slide._imgEl.onload = r; slide._imgEl.onerror = r; });
            }
            
            const img = slide._imgEl;
            if (img.naturalWidth > 0) {
                ctx.save();
                // Ken Burns effect: slow zoom during slide
                const scale = 1 + slideProgress * 0.15;
                const tx = -slideProgress * 20;
                const ty = -slideProgress * 10;
                ctx.translate(640 + tx, 360 + ty);
                ctx.scale(scale, scale);
                ctx.translate(-640, -360);
                
                // Fit image to canvas
                const ratio = Math.max(1280 / img.naturalWidth, 720 / img.naturalHeight);
                const w = img.naturalWidth * ratio;
                const h = img.naturalHeight * ratio;
                ctx.drawImage(img, (1280 - w) / 2, (720 - h) / 2, w, h);
                ctx.restore();
                
                // Fade in first 0.5s of each slide
                if (slideProgress < 0.08) {
                    ctx.fillStyle = `rgba(0,0,0,${1 - slideProgress / 0.08})`;
                    ctx.fillRect(0, 0, 1280, 720);
                }
            }
            
            // Update progress
            const pct = Math.round((frame / totalFrames) * 100);
            btn.innerHTML = `⏳ ${pct}%`;
            
            // Wait for next frame
            await new Promise(r => setTimeout(r, 1000 / fps));
        }
        
        // Stop
        if (audioPlayer) audioPlayer.pause();
        recorder.stop();
        await done;
        
        // Disconnect audio
        if (audioSource) {
            audioSource.disconnect();
            audioSource.connect(new AudioContext().destination);
        }
        
        // Download
        const blob = new Blob(chunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${currentEpisode.title || 'episode'}_video.webm`;
        a.click();
        URL.revokeObjectURL(url);
        
        toast('Video downloaded!', 'success');
    } catch(e) {
        console.error('Download video error:', e);
        toast('Failed to render video: ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = origHtml;
    }
}

async function _generateVideoTTS() {
    // Show loading state
    const _btnGen = document.getElementById('btnAudioGenerate');
    const _btnGenTop = document.getElementById('btnGenAudioStep');
    const _spinner = document.getElementById('audioSpinner');
    const _emptyVisual = document.getElementById('audioEmptyVisual');
    const _emptyTitle = document.getElementById('audioEmptyTitle');
    
    if (_btnGen) _btnGen.style.display = 'none';
    if (_btnGenTop) _btnGenTop.disabled = true;
    if (_spinner) _spinner.style.display = 'block';
    if (_emptyVisual) _emptyVisual.style.display = 'none';
    if (_emptyTitle) _emptyTitle.textContent = '🔊 Generating Audio for all shots...';
    
    try {
        if (!currentEpisode) throw new Error('No episode selected');
        
        // Start batch TTS in background (with retry)
        let res = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                res = await apiFetch(`/episodes/${currentEpisode.id}/batch-tts`, { method: 'POST' });
                if (res.success && res.task_id) break;
            } catch(retryErr) {
                console.warn(`Batch TTS attempt ${attempt} failed:`, retryErr.message);
                if (attempt < 3) await new Promise(r => setTimeout(r, 5000));
            }
        }
        if (!res || !res.success || !res.task_id) throw new Error('Failed to start batch TTS after 3 attempts');
        
        const taskId = res.task_id;
        const total = res.total || 0;
        
        // Wait for completion via polling (Auto-Pilot needs to block here)
        // Timeout after 10 minutes to prevent infinite wait
        const TTS_TIMEOUT = 10 * 60 * 1000;
        const result = await Promise.race([
            new Promise((resolve) => {
                const pollId = setInterval(async () => {
                    try {
                        const st = await apiFetch(`/batch-tts/${taskId}`);
                        const done = st.done || 0;
                        const success = st.success || 0;
                        if (_emptyTitle) _emptyTitle.textContent = `🔊 TTS: ${done}/${total} (✅${success})`;
                        
                        if (st.status === 'done' || st.status === 'error') {
                            clearInterval(pollId);
                            resolve(st);
                        }
                    } catch(e) {
                        // Ignore poll errors, keep trying
                    }
                }, 3000);
            }),
            new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout', success: 0, failed: total }), TTS_TIMEOUT))
        ]);
        
        const successCount = result.success || 0;
        const failedCount = result.failed || 0;
        
        if (failedCount > 0 && total > 0) {
            console.warn(`TTS: ${failedCount}/${total} shots failed audio generation`);
            toast(`⚠️ Audio: ${successCount}/${total} thành công, ${failedCount} thất bại`, 'warning');
        }
        
        if (_emptyTitle) _emptyTitle.textContent = successCount > 0 ? `✅ Audio: ${successCount}/${total}` : '⚠️ Audio Failed';
        if (_spinner) _spinner.style.display = 'none';
        if (_btnGenTop) _btnGenTop.disabled = false;
        
        // Reload audio cards to show the new audio URLs from DB
        if (successCount > 0) {
            try { await loadEpisodeAudio(); } catch(e) { console.warn('loadEpisodeAudio refresh failed:', e); }
        }
        
        return "per_shot_audio";
    } catch(e) {
        console.error("TTS Exception:", e);
        if (_btnGen) _btnGen.style.display = '';
        if (_btnGenTop) _btnGenTop.disabled = false;
        if (_spinner) _spinner.style.display = 'none';
        if (_emptyVisual) _emptyVisual.style.display = '';
        if (_emptyTitle) _emptyTitle.textContent = 'Generate Audio (TTS)';
        // DON'T throw - log and continue for autopilot resilience
        console.warn(`TTS step failed: ${e.message}, continuing pipeline...`);
        toast(`⚠️ TTS failed: ${e.message}`, 'warning');
        return "tts_skipped";
    }
}

function _getVideoDuration() {
    if (videoSyncAudio) {
        const audioPlayer = document.getElementById('videoAudioPlayer');
        const dur = audioPlayer.duration;
        if (dur && !isNaN(dur) && dur > 0) return dur;
    }
    return videoSlides.length * videoSecsPerSlide;
}

// Calculate per-slide start times based on dialogue proportions
function _getSlideTiming() {
    const totalDuration = _getVideoDuration();
    const minSlideTime = 2; // minimum 2 seconds per slide
    
    // Check if any slide has dialogue text
    const hasDialogue = videoSlides.some(s => s.dialogue && s.dialogue.length > 0);
    
    if (!hasDialogue || !videoSyncAudio) {
        // Equal distribution
        const perSlide = totalDuration / videoSlides.length;
        return videoSlides.map((_, i) => ({
            start: i * perSlide,
            duration: perSlide
        }));
    }
    
    // Proportional distribution based on dialogue character count
    const charCounts = videoSlides.map(s => Math.max((s.dialogue || '').length, 10)); // min 10 chars
    const totalChars = charCounts.reduce((a, b) => a + b, 0);
    
    // First pass: proportional durations
    let durations = charCounts.map(c => (c / totalChars) * totalDuration);
    
    // Second pass: enforce minimum slide time
    let deficit = 0;
    let freeSlides = 0;
    durations = durations.map(d => {
        if (d < minSlideTime) {
            deficit += minSlideTime - d;
            return minSlideTime;
        }
        freeSlides++;
        return d;
    });
    
    // Redistribute deficit from longer slides
    if (deficit > 0 && freeSlides > 0) {
        durations = durations.map(d => {
            if (d > minSlideTime) {
                return d - (deficit / freeSlides);
            }
            return d;
        });
    }
    
    // Build start times
    let cumulative = 0;
    return durations.map(d => {
        const obj = { start: cumulative, duration: d };
        cumulative += d;
        return obj;
    });
}

const VFX_CLASSES = [
    'vfx-fade-in', 'vfx-slide-left', 'vfx-slide-right', 'vfx-slide-up',
    'vfx-zoom-in', 'vfx-zoom-out', 'vfx-kenburns', 'vfx-blur-reveal',
    'vfx-flip', 'vfx-rotate-in',
    'vfx-pan-left', 'vfx-pan-right', 'vfx-zoom-pan-tl', 'vfx-zoom-pan-br'
];
let _lastVfx = '';

function _showSlide(idx) {
    if (idx < 0) idx = 0;
    if (idx >= videoSlides.length) idx = videoSlides.length - 1;
    videoCurrentSlideIdx = idx;
    
    const slide = videoSlides[idx];
    const img = document.getElementById('videoSlideImg');
    const label = document.getElementById('videoShotLabel');
    const counter = document.getElementById('videoSlideCounter');
    
    if (img.getAttribute('data-idx') !== String(idx)) {
        // Use pre-assigned VFX from build, or pick random fallback
        let vfx = slide.vfx;
        if (!vfx) {
            vfx = VFX_CLASSES[Math.floor(Math.random() * VFX_CLASSES.length)];
            if (vfx === _lastVfx) vfx = VFX_CLASSES[(VFX_CLASSES.indexOf(vfx) + 1) % VFX_CLASSES.length];
        }
        _lastVfx = vfx;
        
        // Strip old VFX classes
        VFX_CLASSES.forEach(c => img.classList.remove(c));
        
        // Load new image with VFX
        img.src = slide.src;
        img.setAttribute('data-idx', String(idx));
        
        // Force reflow to restart animation
        void img.offsetWidth;
        img.classList.add(vfx);
    }
    label.textContent = slide.label;
    counter.textContent = `${idx + 1} / ${videoSlides.length}`;
}

function _updateVideoUI(currentTime) {
    const duration = _getVideoDuration();
    const seekBar = document.getElementById('videoSeekBar');
    const timeDisplay = document.getElementById('videoTimeDisplay');
    
    seekBar.value = duration > 0 ? (currentTime / duration) * 1000 : 0;
    timeDisplay.textContent = `${_fmtTime(currentTime)} / ${_fmtTime(duration)}`;
}

function toggleVideoPlay() {
    if (videoSlides.length === 0) return;
    
    if (videoPlaying) {
        _pauseVideo();
    } else {
        _playVideo();
    }
}

function _playVideo() {
    videoPlaying = true;
    document.getElementById('btnVideoPlay').textContent = '⏸ Pause';
    document.getElementById('videoPlayOverlay').style.display = 'none';
    
    const audioPlayer = document.getElementById('videoAudioPlayer');
    if (videoSyncAudio && audioPlayer.src) {
        audioPlayer.currentTime = videoElapsed;
        audioPlayer.play().catch(() => {});
    }
    
    videoStartTime = performance.now();
    _runVideoLoop();
}

function _pauseVideo() {
    videoPlaying = false;
    videoElapsed += (performance.now() - videoStartTime) / 1000;
    document.getElementById('btnVideoPlay').textContent = '▶️ Play';
    document.getElementById('videoPlayOverlay').style.display = 'flex';
    
    const audioPlayer = document.getElementById('videoAudioPlayer');
    audioPlayer.pause();
    
    if (videoAnimFrame) { cancelAnimationFrame(videoAnimFrame); videoAnimFrame = null; }
}

function _stopVideo() {
    videoPlaying = false;
    videoElapsed = 0;
    videoCurrentSlideIdx = 0;
    document.getElementById('btnVideoPlay').textContent = '▶️ Play';
    document.getElementById('videoPlayOverlay').style.display = 'flex';
    
    const audioPlayer = document.getElementById('videoAudioPlayer');
    audioPlayer.pause();
    if (audioPlayer.duration) audioPlayer.currentTime = 0;
    
    if (videoAnimFrame) { cancelAnimationFrame(videoAnimFrame); videoAnimFrame = null; }
}

function _runVideoLoop() {
    if (!videoPlaying) return;
    
    const now = performance.now();
    let currentTime;
    
    if (videoSyncAudio) {
        const audioPlayer = document.getElementById('videoAudioPlayer');
        currentTime = audioPlayer.currentTime || 0;
    } else {
        currentTime = videoElapsed + (now - videoStartTime) / 1000;
    }
    
    const duration = _getVideoDuration();
    
    // Update UI
    _updateVideoUI(Math.min(currentTime, duration));
    
    // Calculate which slide using proportional timing
    if (videoSlides.length > 0) {
        const timing = _getSlideTiming();
        let slideIdx = 0;
        for (let i = 0; i < timing.length; i++) {
            if (currentTime >= timing[i].start) {
                slideIdx = i;
            } else break;
        }
        if (slideIdx >= videoSlides.length) slideIdx = videoSlides.length - 1;
        if (slideIdx < 0) slideIdx = 0;
        
        if (slideIdx !== videoCurrentSlideIdx) {
            _showSlide(slideIdx);
        }
    }
    
    // Check ended
    const ended = videoSyncAudio 
        ? document.getElementById('videoAudioPlayer').ended 
        : currentTime >= duration;
    
    if (ended) {
        videoPlaying = false;
        videoElapsed = 0;
        document.getElementById('btnVideoPlay').textContent = '▶️ Play';
        document.getElementById('videoPlayOverlay').style.display = 'flex';
        _showSlide(0);
        _updateVideoUI(0);
        return;
    }
    
    videoAnimFrame = requestAnimationFrame(_runVideoLoop);
}

function videoJumpSlide(delta) {
    if (videoSlides.length === 0) return;
    
    const wasPlaying = videoPlaying;
    if (wasPlaying) _pauseVideo();
    
    let newIdx = videoCurrentSlideIdx + delta;
    if (newIdx < 0) newIdx = 0;
    if (newIdx >= videoSlides.length) newIdx = videoSlides.length - 1;
    
    _showSlide(newIdx);
    
    // Update elapsed time to match new slide position using proportional timing
    const timing = _getSlideTiming();
    videoElapsed = timing[newIdx] ? timing[newIdx].start : 0;
    
    if (videoSyncAudio) {
        const audioPlayer = document.getElementById('videoAudioPlayer');
        if (audioPlayer.duration) audioPlayer.currentTime = videoElapsed;
    }
    
    _updateVideoUI(videoElapsed);
    
    if (wasPlaying) _playVideo();
}

function seekVideo(val) {
    const duration = _getVideoDuration();
    const t = (val / 1000) * duration;
    
    videoElapsed = t;
    videoStartTime = performance.now();
    
    if (videoSyncAudio) {
        const audioPlayer = document.getElementById('videoAudioPlayer');
        if (audioPlayer.duration) audioPlayer.currentTime = t;
    }
    
    // Show correct slide
    if (videoSlides.length > 0) {
        const timing = _getSlideTiming();
        let slideIdx = 0;
        for (let i = 0; i < timing.length; i++) {
            if (t >= timing[i].start) slideIdx = i;
            else break;
        }
        if (slideIdx >= videoSlides.length) slideIdx = videoSlides.length - 1;
        if (slideIdx < 0) slideIdx = 0;
        _showSlide(slideIdx);
    }
    
    _updateVideoUI(t);
}

function _fmtTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
}


// ═══════════════════════════════════════════════════════════════
// ── Auto Pipeline Module ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

let _apJobPollInterval = null;
let _apChipSelectedProfiles = [];

function togglePipelineView() {
    const mainContent = document.getElementById('mainPanel');
    const pipelineView = document.getElementById('pipelineView');
    const galleryView = document.getElementById('galleryView');
    
    if (pipelineView.style.display === 'none') {
        mainContent.style.display = 'none';
        if (galleryView) galleryView.style.display = 'none';
        pipelineView.style.display = 'flex';
        _initAutoPipelineModal();
    } else {
        _closePipelineView();
    }
}

/** Close Pipeline Queue view and restore main content panel. */
function _closePipelineView() {
    const mainContent = document.getElementById('mainPanel');
    const pipelineView = document.getElementById('pipelineView');
    const galleryView = document.getElementById('galleryView');
    
    if (pipelineView && pipelineView.style.display !== 'none') {
        pipelineView.style.display = 'none';
        if (galleryView && galleryView.style.display !== 'none') {
            // If gallery is open, let it be. But usually they are mutually exclusive.
        } else {
            mainContent.style.display = 'flex';
        }
        if (_apJobPollInterval) { clearInterval(_apJobPollInterval); _apJobPollInterval = null; }
    }
}

async function _initAutoPipelineModal() {
    // Load presets from wizard system
    _loadApPresets();

    // Load browser profiles into cache
    await _loadBrowserProfilesIntoSelect('apBrowserProfiles');

    // Initialize chip UI from cache
    const savedStr = localStorage.getItem('cs_last_browser_profile_video') || localStorage.getItem('cs_last_browser_profile') || '';
    if (savedStr && _apChipSelectedProfiles.length === 0) {
        _apChipSelectedProfiles = savedStr.split(',').filter(s => s && _browserProfilesCache.some(p => p.name === s));
    }
    _renderApBrowserChips();

    // Load voice profiles
    await _loadVoiceProfilesIntoSelect('apVoice');

    // Load gallery categories
    if (typeof _loadGalleryCategoriesIntoSelect === 'function') {
        await _loadGalleryCategoriesIntoSelect('apGalleryCategory');
    }

    // Load jobs
    await loadApJobs();

    // Load watchers
    await loadApWatchers();

    // URL count watcher
    const urlInput = document.getElementById('apUrlList');
    urlInput.removeEventListener('input', _apCountUrls);
    urlInput.addEventListener('input', _apCountUrls);

    // Check pipeline & watcher status
    _refreshApStatus();
}

// ── Preset System ──
function _loadApPresets() {
    const sel = document.getElementById('apPresetSelect');
    if (!sel) return;
    const presets = _getPresets(); // reuse wizard presets
    sel.innerHTML = '<option value="">-- Chọn preset --</option>';
    for (const name of Object.keys(presets).sort()) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
    }
}

function applyApPreset() {
    const sel = document.getElementById('apPresetSelect');
    if (!sel || !sel.value) {
        document.getElementById('apPresetInfo').textContent = '';
        return;
    }
    const presets = _getPresets();
    const data = presets[sel.value];
    if (!data) return;

    // Map wizard fields → auto pipeline hidden fields
    const pipelineMap = {
        wizPipelineTemplate: 'apPipeline',
        wizLanguage: 'apLanguage',
        wizContentFormat: 'apContentFormat',
        wizEpisodes: 'apMaxEpisodes',
        wizGalleryCategory: 'apGalleryCategory',
    };
    for (const [wizId, apId] of Object.entries(pipelineMap)) {
        const val = data[wizId];
        if (val !== undefined) {
            const el = document.getElementById(apId);
            if (el) el.value = val;
        }
    }

    // Build info display
    const infoParts = [];
    const pipelineLabels = {
        campaign_scene: '🎞 Cinematic', campaign_full: '📺 Slideshow',
        audio_story: '🎧 Audio', content_only: '📝 Content'
    };
    const langLabels = { vi: '🇻🇳', en: '🇬🇧', zh: '🇨🇳', ja: '🇯🇵', ko: '🇰🇷' };

    const pl = data.wizPipelineTemplate || '';
    if (pipelineLabels[pl]) infoParts.push(pipelineLabels[pl]);
    const lg = data.wizLanguage || '';
    if (langLabels[lg]) infoParts.push(langLabels[lg]);
    const ep = data.wizEpisodes || '1';
    infoParts.push(`${ep} ep`);
    const cf = data.wizContentFormat || '';
    if (cf) infoParts.push(cf.split('/')[0].trim());

    const infoEl = document.getElementById('apPresetInfo');
    if (infoEl) {
        infoEl.textContent = infoParts.join(' • ');
    }
    toast(`⚡ Preset "${sel.value}" đã áp dụng`, 'success');
}

function _apCountUrls() {
    const text = document.getElementById('apUrlList').value;
    const urls = text.split('\n').map(l => l.trim()).filter(l => l.length > 5);
    document.getElementById('apUrlCount').textContent = `${urls.length} links`;
}

// ── Tab Switching ──
function switchApTab(tab) {
    document.querySelectorAll('.apTabContent').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.apTab').forEach(el => el.classList.remove('active'));
    const tabEl = document.getElementById('apTab' + tab.charAt(0).toUpperCase() + tab.slice(1));
    if (tabEl) tabEl.style.display = '';
    document.querySelector(`.apTab[data-tab="${tab}"]`)?.classList.add('active');

    // Show/hide submit button based on tab
    const submitBtn = document.getElementById('apSubmitBtn');
    if (submitBtn) submitBtn.style.display = (tab === 'batch') ? '' : 'none';

    if (tab === 'jobs') loadApJobs();
    if (tab === 'watchers') loadApWatchers();
}

// ── Upload Target Toggle ──
function toggleApUploadTarget(platform) {
    if (platform === 'fb') {
        const checked = document.getElementById('apUploadFb').checked;
        const sel = document.getElementById('apFbPage');
        sel.style.display = checked ? '' : 'none';
        sel.disabled = !checked;
        if (checked && sel.options.length <= 1) _loadFbPages();
    } else if (platform === 'yt') {
        const checked = document.getElementById('apUploadYt').checked;
        const sel = document.getElementById('apYtChannel');
        sel.style.display = checked ? '' : 'none';
        sel.disabled = !checked;
        if (checked && sel.options.length <= 1) _loadYtChannels();
    }
}

async function _loadFbPages() {
    const sel = document.getElementById('apFbPage');
    sel.innerHTML = '<option value="" disabled selected>⏳ Đang tải...</option>';
    try {
        const res = await fetch('/api/v1/video_manager/accounts?provider=facebook');
        const data = await res.json();
        sel.innerHTML = '<option value="">-- Chọn --</option>'; // Reset
        if (data.accounts && data.accounts.length > 0) {
            for (const acc of data.accounts) {
                try {
                    const chRes = await fetch(`/api/v1/video_manager/channels?provider=facebook&cred_id=${acc.cred_id || acc.id || ''}`);
                    const chData = await chRes.json();
                    (chData.channels || []).forEach(ch => {
                        const opt = document.createElement('option');
                        opt.value = JSON.stringify({ provider: 'facebook', cred_id: acc.cred_id || acc.id, channel_id: ch.id });
                        opt.textContent = `${ch.name || ch.id}`;
                        sel.appendChild(opt);
                    });
                } catch(e) {}
            }
        }
        if (sel.options.length <= 1) sel.innerHTML += '<option value="" disabled>Không tìm thấy page nào</option>';
    } catch(e) {
        sel.innerHTML = `<option value="" disabled>⚠️ ${e.message}</option>`;
    }
}

async function _loadYtChannels() {
    const sel = document.getElementById('apYtChannel');
    sel.innerHTML = '<option value="" disabled selected>⏳ Đang tải...</option>';
    try {
        const res = await fetch('/api/v1/video_manager/accounts?provider=youtube');
        const data = await res.json();
        sel.innerHTML = '<option value="">-- Chọn --</option>'; // Reset
        if (data.accounts && data.accounts.length > 0) {
            for (const acc of data.accounts) {
                try {
                    const chRes = await fetch(`/api/v1/video_manager/channels?provider=youtube&email=${acc.email || ''}&cred_id=${acc.cred_id || acc.id || ''}`);
                    const chData = await chRes.json();
                    (chData.channels || []).forEach(ch => {
                        const opt = document.createElement('option');
                        opt.value = JSON.stringify({ provider: 'youtube', email: acc.email, cred_id: acc.cred_id || acc.id, channel_id: ch.id });
                        opt.textContent = `${ch.name || ch.id} (${acc.email || ''})`;
                        sel.appendChild(opt);
                    });
                } catch(e) {}
            }
        }
        if (sel.options.length <= 1) sel.innerHTML += '<option value="" disabled>Không tìm thấy channel nào</option>';
    } catch(e) {
        sel.innerHTML = `<option value="" disabled>⚠️ ${e.message}</option>`;
    }
}

// ── Submit Batch Queue ──
async function submitBatchQueue() {
    const urlText = document.getElementById('apUrlList').value;
    const urls = urlText.split('\n').map(l => l.trim()).filter(l => l.length > 5);
    if (urls.length === 0) {
        toast('Vui lòng nhập ít nhất 1 link YouTube', 'error');
        return;
    }

    // Gather config
    const selectedBrowsers = [..._apChipSelectedProfiles];

    const voiceSel = document.getElementById('apVoice');
    let voicePreset = voiceSel ? voiceSel.value : '';
    if (voiceSel && voiceSel.selectedIndex >= 0 && voicePreset) {
        const engine = voiceSel.options[voiceSel.selectedIndex].getAttribute('data-engine') || 'edge';
        if (!voicePreset.includes('|')) voicePreset = `${voicePreset}|${engine}`;
    }

    const galleryCatId = document.getElementById('apGalleryCategory')?.value;

    const seoMode = document.querySelector('input[name="apSeoMode"]:checked')?.value || 'ai_generate';
    const seoTagsStr = document.getElementById('apSeoTags')?.value || '';
    const seoTags = seoTagsStr ? seoTagsStr.split(',').map(t => t.trim()).filter(t => t) : [];

    // Upload targets
    const uploadTargets = [];
    if (document.getElementById('apUploadFb')?.checked) {
        const fbVal = document.getElementById('apFbPage')?.value;
        if (fbVal) {
            try { uploadTargets.push(JSON.parse(fbVal)); } catch(e) {}
        }
    }
    if (document.getElementById('apUploadYt')?.checked) {
        const ytVal = document.getElementById('apYtChannel')?.value;
        if (ytVal) {
            try { uploadTargets.push(JSON.parse(ytVal)); } catch(e) {}
        }
    }

    // Get full preset data for project creation
    const presetName = document.getElementById('apPresetSelect')?.value || '';
    let presetData = null;
    if (presetName) {
        const allPresets = _getPresets();
        presetData = allPresets[presetName] || null;
    }

    let finalVisualStyle = 'Default';
    if (presetData) {
        const vStyle = presetData.wizStyle === '__custom__' ? (presetData.wizStyleCustom || 'Default') : (presetData.wizStyle || 'Default');
        const cStyle = presetData.wizCharacterStyle === '__custom__' ? (presetData.wizCharStyleCustom || 'Default') : (presetData.wizCharacterStyle || 'Default');
        if (vStyle !== 'Default' || cStyle !== 'Default') {
            finalVisualStyle = `Visual Style: ${vStyle} | Model/Product Style: ${cStyle}`;
        }
    }

    const payload = {
        urls: urls,
        pipeline_template: document.getElementById('apPipeline')?.value || presetData?.wizPipelineTemplate || 'campaign_scene',
        language: document.getElementById('apLanguage')?.value || presetData?.wizLanguage || 'vi',
        voice_preset: voicePreset,
        browser_profiles: selectedBrowsers,
        content_format: document.getElementById('apContentFormat')?.value || presetData?.wizContentFormat || 'Educational / Learning',
        visual_style: finalVisualStyle,
        max_episodes: parseInt(document.getElementById('apMaxEpisodes')?.value || presetData?.wizEpisodes) || 1,
        aspect_ratio: presetData?.wizAspectRatio || '16:9',
        narration_source: presetData?.wizNarrationSource || 'prose',
        video_length: presetData?.wizVideoLength || 'standard',
        seo_mode: seoMode,
        seo_tags: seoTags,
        upload_targets: uploadTargets,
        upload_privacy: document.getElementById('apUploadPrivacy')?.value || 'private',
        gallery_category_id: galleryCatId ? parseInt(galleryCatId) : null,
        preset_name: presetName,
        preset_data: presetData,
    };


    try {
        document.getElementById('apSubmitBtn').disabled = true;
        document.getElementById('apSubmitBtn').textContent = '⏳ Đang tạo...';

        const res = await apiFetch('/auto-pipeline/jobs', {
            method: 'POST',
            body: JSON.stringify(payload),
        });

        toast(`✅ Đã tạo ${res.count} jobs thành công!`, 'success');
        document.getElementById('apUrlList').value = '';
        _apCountUrls();

        // Auto-start the pipeline
        await apiFetch('/auto-pipeline/start', { method: 'POST' });

        await loadApJobs();
        _startApJobPolling();

    } catch(e) {
        toast('❌ Lỗi tạo jobs: ' + e.message, 'error');
    } finally {
        document.getElementById('apSubmitBtn').disabled = false;
        document.getElementById('apSubmitBtn').innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> ⚡ Thêm vào hàng đợi';
    }
}

// ── Job List ──
async function loadApJobs() {
    try {
        const res = await apiFetch('/auto-pipeline/jobs');
        const jobs = res.jobs || [];
        const container = document.getElementById('apJobList');
        if (jobs.length === 0) {
            container.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:40px; color:var(--text-3);">Chưa có job nào trong hàng đợi.</td></tr>';
            return;
        }
        
        // Update global variable for edit reference
        window._apJobsCache = jobs;
        
        container.innerHTML = jobs.map(j => _renderApJobRow(j)).join('');
    } catch(e) {
        console.warn('Load AP jobs failed:', e);
    }
}

function _renderApJobRow(job) {
    const statusIcons = {
        pending: '⏳ Pending', extracting: '📥 Extracting', processing: '⚙️ Processing',
        uploading: '📤 Uploading', done: '✅ Done', error: '❌ Error'
    };
    
    const title = job.source_title || job.source_url.split('v=')[1] || job.source_url;
    const voiceParts = (job.voice_preset || '').split('|');
    const voice = voiceParts.length > 0 && voiceParts[0] ? voiceParts[0] : 'Mặc định';
    
    let browser = 'Mặc định';
    try {
        const profiles = typeof job.browser_profiles === 'string' ? JSON.parse(job.browser_profiles) : job.browser_profiles;
        if (profiles && profiles.length > 0) browser = profiles[0] + (profiles.length > 1 ? ` (+${profiles.length-1})` : '');
    } catch(e) {}
    
    let upload = 'Private';
    try {
        const targets = typeof job.upload_targets === 'string' ? JSON.parse(job.upload_targets) : job.upload_targets;
        if (targets && targets.length > 0) upload = targets.length + ' targets';
    } catch(e) {}

    // Parse visual & character style into separate badges
    let vStyleBadge = '';
    let cStyleBadge = '';
    let vs = job.visual_style || '';
    
    // Fallback: read from preset localStorage if visual_style is Default/empty
    if ((!vs || vs === 'Default') && job.preset_name) {
        try {
            const presets = JSON.parse(localStorage.getItem('studio_wiz_presets') || '{}');
            const pd = presets[job.preset_name];
            if (pd) {
                const pvs = pd.wizStyle === '__custom__' ? (pd.wizStyleCustom || '') : (pd.wizStyle || '');
                const pcs = pd.wizCharacterStyle === '__custom__' ? (pd.wizCharStyleCustom || '') : (pd.wizCharacterStyle || '');
                if (pvs && pvs !== 'Default') vs = `Visual Style: ${pvs} | Model/Product Style: ${pcs || 'Default'}`;
            }
        } catch(e) {}
    }
    
    if (vs && vs !== 'Default') {
        const vsMatch = vs.match(/Visual Style:\s*([^|]+)/);
        const csMatch = vs.match(/Model\/Product Style:\s*(.+)/);
        const vName = vsMatch ? vsMatch[1].trim() : vs;
        const cName = csMatch ? csMatch[1].trim() : '';
        if (vName && vName !== 'Default') vStyleBadge = `<span style="background:rgba(168,85,247,0.15); color:#c084fc; padding:2px 6px; border-radius:4px; border:1px solid rgba(168,85,247,0.3);" title="Visual Style: ${vName}">🎨 ${vName}</span>`;
        if (cName && cName !== 'Default') cStyleBadge = `<span style="background:rgba(59,130,246,0.15); color:#93c5fd; padding:2px 6px; border-radius:4px; border:1px solid rgba(59,130,246,0.3);" title="Model/Product Style: ${cName}">👤 ${cName}</span>`;
    }

    // Aspect ratio badge
    let arBadge = '';
    let arVal = job.aspect_ratio || '';
    if (!arVal && job.preset_name) {
        try {
            const presets = JSON.parse(localStorage.getItem('studio_wiz_presets') || '{}');
            const pd = presets[job.preset_name];
            if (pd && pd.wizAspectRatio) arVal = pd.wizAspectRatio;
        } catch(e) {}
    }
    if (arVal && arVal !== '16:9') {
        arBadge = `<span style="background:rgba(251,146,60,0.15); color:#fb923c; padding:2px 6px; border-radius:4px; border:1px solid rgba(251,146,60,0.3);" title="Tỉ lệ màn hình">📐 ${arVal}</span>`;
    }
    
    // Narration source badge
    let nsBadge = '';
    let nsVal = job.narration_source || '';
    if (!nsVal && job.preset_name) {
        try {
            const presets = JSON.parse(localStorage.getItem('studio_wiz_presets') || '{}');
            const pd = presets[job.preset_name];
            if (pd && pd.wizNarrationSource) nsVal = pd.wizNarrationSource;
        } catch(e) {}
    }
    if (nsVal && nsVal !== 'prose') {
        const nsLabels = { 'dialogue': 'Hội thoại', 'poem': 'Thơ', 'prose': 'Văn xuôi', 'verse': 'Verse' };
        const nsLabel = nsLabels[nsVal] || nsVal;
        nsBadge = `<span style="background:rgba(20,184,166,0.15); color:#5eead4; padding:2px 6px; border-radius:4px; border:1px solid rgba(20,184,166,0.3);" title="Narration Source">🗣️ ${nsLabel}</span>`;
    }

    let galleryBadge = '';
    let galCatId = job.gallery_category_id;
    
    // Fallback to preset if not saved in job
    if (!galCatId && job.preset_name) {
        try {
            const presets = JSON.parse(localStorage.getItem('studio_wiz_presets') || '{}');
            const pd = presets[job.preset_name];
            if (pd && pd.wizGalleryCategory) galCatId = pd.wizGalleryCategory;
        } catch(e) {}
    }

    if (galCatId) {
        const catName = window._galleryCategoryMap ? window._galleryCategoryMap[galCatId] : `Cat ${galCatId}`;
        const displayName = catName || `Cat ${galCatId}`;
        galleryBadge = `<span style="background:rgba(236,72,153,0.15); color:#f472b6; padding:2px 6px; border-radius:4px; border:1px solid rgba(236,72,153,0.3);" title="Gallery Category">🎨 ${displayName}</span>`;
    }

    const canEdit = job.status === 'pending' || job.status === 'error';

    return `<tr class="pq-row">
        <td class="pq-col-id">#${job.id}</td>
        <td class="pq-col-source">
            <div class="pq-truncate pq-title" title="${title}">${title}</div>
            <div class="pq-truncate pq-url" title="${job.source_url}"><a href="${job.source_url}" target="_blank" style="color:inherit; text-decoration:none;">${job.source_url}</a></div>
            ${job.error_message ? `<div style="color:var(--error); font-size:10px; margin-top:4px;" title="${job.error_message.replace(/"/g,'&quot;')}">⚠️ Lỗi: ${job.error_message.substring(0,50)}...</div>` : ''}
        </td>
        <td class="pq-col-preset">
            <div class="pq-truncate" style="font-weight:600; margin-bottom:4px; color:var(--text-0);" title="${job.preset_name || 'Manual'}">${job.preset_name || 'Manual'}</div>
            <div style="display:flex; flex-wrap:wrap; gap:4px; font-size:10px; color:var(--text-2);">
                ${job.language ? `<span style="background:var(--bg-2); padding:2px 6px; border-radius:4px; border:1px solid var(--border);" title="Ngôn ngữ">🌐 ${job.language.toUpperCase()}</span>` : ''}
                ${job.max_episodes ? `<span style="background:var(--bg-2); padding:2px 6px; border-radius:4px; border:1px solid var(--border);" title="Số tập tối đa">🎬 ${job.max_episodes} ep</span>` : ''}
                ${job.content_format ? `<span style="background:var(--bg-2); padding:2px 6px; border-radius:4px; border:1px solid var(--border);" title="Định dạng nội dung">📝 ${job.content_format.split('/')[0].trim()}</span>` : ''}
                ${vStyleBadge}
                ${cStyleBadge}
                ${galleryBadge}
                ${arBadge}
                ${nsBadge}
            </div>
        </td>
        <td class="pq-col-voice"><div class="pq-truncate" title="${voice}">${voice}</div></td>
        <td class="pq-col-browser"><div class="pq-truncate" title="${browser}">${browser}</div></td>
        <td class="pq-col-upload"><div class="pq-truncate">${upload}</div></td>
        <td class="pq-col-status">
            <span class="pq-badge ${job.status}">${statusIcons[job.status] || job.status}</span>
        </td>
        <td class="pq-col-actions">
            <div style="display:flex; justify-content:flex-end; gap:8px;">
                ${job.campaign_id ? `<button class="pq-edit-btn" onclick="openQueueCampaign(${job.campaign_id})" title="Mở Project & Resume">📂</button>` : ''}
                ${job.status === 'error' ? `<button class="pq-edit-btn" onclick="retryApJob(${job.id})" title="Thử lại" style="color:var(--accent);">🔄</button>` : ''}
                ${canEdit ? `<button class="pq-edit-btn" onclick="editApJob(${job.id})" title="Chỉnh sửa">✏️</button>` : ''}
                <button class="pq-delete-btn" onclick="deleteApJob(${job.id})" title="Xóa">🗑️</button>
            </div>
        </td>
    </tr>`;
}

async function retryApJob(jobId) {
    if (!confirm('Bạn có muốn đưa job này vào lại hàng đợi để xử lý không?')) return;
    try {
        const payload = { status: 'pending', error_message: null };
        await apiFetch('/auto-pipeline/jobs/' + jobId, {
            method: 'PUT',
            body: JSON.stringify(payload)
        });
        toast('Đã chuyển job về trạng thái pending', 'success');
        await loadApJobs();
        await apiFetch('/auto-pipeline/start', { method: 'POST' });
    } catch(e) {
        toast('Lỗi: ' + e.message, 'error');
    }
}

// ── Open Queue Project with Resume ──
async function openQueueCampaign(campaignId) {
    togglePipelineView();
    await selectCampaign(campaignId);
    // Small delay to ensure currentCampaign is loaded, then trigger resume
    setTimeout(() => {
        if (currentCampaign && currentCampaign.id === campaignId) {
            resumeAutoPilot();
        }
    }, 300);
}

// ── Inline Edit ──
let _editJobBrowserChips = [];

async function editApJob(jobId) {
    const job = window._apJobsCache?.find(j => j.id === jobId);
    if (!job) return;
    
    document.getElementById('editJobId').value = job.id;
    document.getElementById('editJobIdText').textContent = job.id;
    
    // Preset
    const presetSel = document.getElementById('editJobPreset');
    presetSel.innerHTML = '<option value="">-- Chọn preset --</option>';
    const presets = _getPresets();
    for (const name of Object.keys(presets).sort()) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        presetSel.appendChild(opt);
    }
    presetSel.value = job.preset_name || '';
    
    // Voice
    const voiceSel = document.getElementById('editJobVoice');
    await _loadVoiceProfilesIntoSelect('editJobVoice');
    const voiceParts = (job.voice_preset || '').split('|');
    voiceSel.value = voiceParts[0] || '';
    
    // Gallery
    await _loadGalleryCategoriesIntoSelect('editJobGallery');
    document.getElementById('editJobGallery').value = job.gallery_category_id || '';
    
    // Browser profiles
    let profiles = [];
    try { profiles = typeof job.browser_profiles === 'string' ? JSON.parse(job.browser_profiles) : job.browser_profiles; } catch(e) {}
    _editJobBrowserChips = Array.isArray(profiles) ? profiles : [];
    
    // Upload Targets
    let targets = [];
    try { targets = typeof job.upload_targets === 'string' ? JSON.parse(job.upload_targets) : job.upload_targets; } catch(e) {}
    document.getElementById('editJobUpload').value = JSON.stringify(targets || [], null, 2);
    
    _renderEditJobBrowserChips();
    document.getElementById('apJobEditModal').style.display = 'flex';
}

function _renderEditJobBrowserChips() {
    const container = document.getElementById('editJobBrowserChipSelect');
    const emptySpan = document.getElementById('editJobBrowserChipEmpty');
    container.querySelectorAll('.chip-item').forEach(el => el.remove());
    
    if (_editJobBrowserChips.length > 0) {
        emptySpan.style.display = 'none';
        _editJobBrowserChips.forEach((name, idx) => {
            const chip = document.createElement('div');
            chip.className = 'chip-item';
            chip.innerHTML = `<span>${name}</span><button onclick="event.stopPropagation(); _editJobBrowserChips.splice(${idx},1); _renderEditJobBrowserChips();">✕</button>`;
            container.insertBefore(chip, container.querySelector('div[style]'));
        });
    } else {
        emptySpan.style.display = '';
    }
}

function toggleEditJobBrowserChipMenu() {
    const menu = document.getElementById('editJobBrowserChipMenu');
    if (menu.style.display === 'block') {
        menu.style.display = 'none';
        return;
    }
    menu.innerHTML = '';
    _browserProfilesCache.forEach(p => {
        if (!_editJobBrowserChips.includes(p.name)) {
            const div = document.createElement('div');
            div.className = 'chip-dropdown-item';
            div.textContent = p.name;
            div.onclick = (e) => {
                e.stopPropagation();
                _editJobBrowserChips.push(p.name);
                menu.style.display = 'none';
                _renderEditJobBrowserChips();
            };
            menu.appendChild(div);
        }
    });
    if (menu.innerHTML === '') menu.innerHTML = '<div style="padding:8px 12px; font-size:11px; color:var(--text-3);">Không còn profile nào</div>';
    menu.style.display = 'block';
    
    document.addEventListener('click', function closeMenu(e) {
        if (!e.target.closest('#editJobBrowserChipMenu') && !e.target.closest('#editJobBrowserAddBtn')) {
            menu.style.display = 'none';
            document.removeEventListener('click', closeMenu);
        }
    });
}

async function saveApJobEdit() {
    const jobId = document.getElementById('editJobId').value;
    const preset_name = document.getElementById('editJobPreset').value;
    
    const voiceSel = document.getElementById('editJobVoice');
    let voicePreset = voiceSel.value;
    if (voiceSel.selectedIndex >= 0 && voicePreset) {
        const engine = voiceSel.options[voiceSel.selectedIndex].getAttribute('data-engine') || 'edge';
        if (!voicePreset.includes('|')) voicePreset = `${voicePreset}|${engine}`;
    }
    
    let upload_targets = [];
    try {
        const val = document.getElementById('editJobUpload').value.trim();
        if (val) upload_targets = JSON.parse(val);
    } catch(e) {
        toast('Định dạng JSON Upload Targets không hợp lệ', 'error');
        return;
    }
    
    const galleryCatId = document.getElementById('editJobGallery').value;
    
    const payload = {
        preset_name,
        voice_preset: voicePreset,
        browser_profiles: _editJobBrowserChips,
        upload_targets,
        gallery_category_id: galleryCatId ? parseInt(galleryCatId) : null
    };
    
    // Automatically extract hidden fields from preset if a preset was chosen
    if (preset_name) {
        const presets = _getPresets();
        const data = presets[preset_name];
        if (data) {
            if (data.wizPipelineTemplate) payload.pipeline_template = data.wizPipelineTemplate;
            if (data.wizLanguage) payload.language = data.wizLanguage;
            if (data.wizContentFormat) payload.content_format = data.wizContentFormat;
            if (data.wizEpisodes) payload.max_episodes = data.wizEpisodes;
            if (data.wizGalleryCategory && !galleryCatId) payload.gallery_category_id = parseInt(data.wizGalleryCategory);
        }
    }
    
    try {
        await apiFetch(`/auto-pipeline/jobs/${jobId}`, {
            method: 'PUT',
            body: JSON.stringify(payload)
        });
        toast('Đã lưu thay đổi', 'success');
        document.getElementById('apJobEditModal').style.display = 'none';
        await loadApJobs();
    } catch(e) {
        toast('Lỗi khi lưu: ' + e.message, 'error');
    }
}

async function deleteApJob(jobId) {
    if (!confirm('Bạn có chắc chắn muốn xóa job này khỏi hàng đợi?\n(Project đã tạo sẽ không bị xóa)')) return;
    try {
        await apiFetch(`/auto-pipeline/jobs/${jobId}`, { method: 'DELETE' });
        toast('Đã xóa job khỏi hàng đợi', 'info');
        await loadApJobs();
    } catch(e) {
        toast('Lỗi xóa job: ' + e.message, 'error');
    }
}

// ── Pipeline Start/Stop ──
async function toggleAutoPipelineRun() {
    try {
        const statusRes = await apiFetch('/auto-pipeline/status');
        if (statusRes.running) {
            await apiFetch('/auto-pipeline/stop', { method: 'POST' });
            toast('⏸ Pipeline đã dừng', 'info');
        } else {
            await apiFetch('/auto-pipeline/start', { method: 'POST' });
            toast('▶ Pipeline đã bắt đầu', 'success');
            _startApJobPolling();
        }
        setTimeout(_refreshApStatus, 500);
    } catch(e) {
        toast('Lỗi: ' + e.message, 'error');
    }
}

function _startApJobPolling() {
    if (_apJobPollInterval) clearInterval(_apJobPollInterval);
    _apJobPollInterval = setInterval(async () => {
        await loadApJobs();
        await _refreshApStatus();
    }, 5000);
}

async function _refreshApStatus() {
    try {
        // Refresh sidebar project list if any job is processing to show newly created projects
        const pRes = await apiFetch('/auto-pipeline/status');
        if (pRes.running) {
            loadCampaigns();
        }
        
        // Pipeline status
        const pText = document.getElementById('apJobStatusText');
        const pBtn = document.getElementById('apPipelineToggleBtn');
        if (pRes.running) {
            pText.textContent = `⚙️ Đang chạy (job #${pRes.current_job_id || '?'}) | ${pRes.pending_count} pending`;
            pBtn.textContent = '⏸ Stop';
            pBtn.style.color = '#ef4444';
        } else {
            pText.textContent = `⏸ Idle | ${pRes.pending_count} pending`;
            pBtn.textContent = '▶ Start Queue';
            pBtn.style.color = '';
            if (_apJobPollInterval && pRes.pending_count === 0) {
                clearInterval(_apJobPollInterval);
                _apJobPollInterval = null;
            }
        }

        // Watcher status
        const wRes = await apiFetch('/channel-watchers/status');
        const wText = document.getElementById('apWatcherStatusText');
        const wBtn = document.getElementById('apWatcherToggleBtn');
        if (wRes.running) {
            wText.textContent = '🟢 Đang theo dõi';
            wBtn.textContent = '⏸ Tạm dừng';
            wBtn.style.color = '#ef4444';
        } else {
            wText.textContent = '⏸ Chưa chạy';
            wBtn.textContent = '▶ Bật theo dõi';
            wBtn.style.color = '';
        }
    } catch(e) {}
}

// ── Channel Watchers ──
async function loadApWatchers() {
    try {
        const res = await apiFetch('/channel-watchers');
        const watchers = res.watchers || [];
        const container = document.getElementById('apWatcherList');
        if (watchers.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-3); font-size:13px;">Chưa có kênh nào. Thêm kênh YouTube để bắt đầu theo dõi.</div>';
            return;
        }
        container.innerHTML = watchers.map(w => _renderWatcherCard(w)).join('');
    } catch(e) {
        console.warn('Load watchers failed:', e);
    }
}

function _renderWatcherCard(w) {
    const active = w.is_active;
    const lastChecked = w.last_checked_at ? new Date(w.last_checked_at).toLocaleString() : 'Chưa check';
    const interval = w.check_interval_minutes || 30;
    const name = w.channel_name || w.channel_url;
    const platform = w.platform === 'youtube' ? '🔴' : w.platform === 'facebook' ? '🔵' : '⬛';

    return `<div style="display:flex; align-items:center; gap:10px; padding:10px 12px; background:var(--bg-1); border:1px solid var(--border); border-radius:8px;">
        <span style="font-size:18px;">${platform}</span>
        <div style="flex:1; min-width:0;">
            <div style="font-size:12px; font-weight:500; color:var(--text-0); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${name}</div>
            <div style="font-size:10px; color:var(--text-3);">Mỗi ${interval} phút | Last: ${lastChecked}</div>
        </div>
        <span style="font-size:10px; padding:2px 8px; border-radius:4px; background:${active ? '#10b98122' : '#6b728022'}; color:${active ? '#10b981' : '#6b7280'}; font-weight:600;">
            ${active ? 'Active' : 'Paused'}
        </span>
        <button class="btn btn-sm" onclick="toggleWatcherActive(${w.id}, ${active ? 0 : 1})" style="padding:2px 6px; font-size:10px;">
            ${active ? '⏸' : '▶'}
        </button>
        <button class="btn btn-sm" onclick="deleteWatcher(${w.id})" style="padding:2px 6px; font-size:10px; color:#ef4444;">✕</button>
    </div>`;
}

async function addChannelWatcher() {
    const url = document.getElementById('apNewChannelUrl').value.trim();
    if (!url) {
        toast('Vui lòng nhập URL kênh', 'error');
        return;
    }

    // Gather current batch config as defaults for watcher
    const selectedBrowsers = [..._apChipSelectedProfiles];
    const voiceSel = document.getElementById('apVoice');
    let voicePreset = voiceSel ? voiceSel.value : '';
    if (voiceSel && voiceSel.selectedIndex >= 0 && voicePreset) {
        const engine = voiceSel.options[voiceSel.selectedIndex].getAttribute('data-engine') || 'edge';
        if (!voicePreset.includes('|')) voicePreset = `${voicePreset}|${engine}`;
    }

    const uploadTargets = [];
    if (document.getElementById('apUploadFb').checked) {
        const fbVal = document.getElementById('apFbPage').value;
        if (fbVal) try { uploadTargets.push(JSON.parse(fbVal)); } catch(e) {}
    }
    if (document.getElementById('apUploadYt').checked) {
        const ytVal = document.getElementById('apYtChannel').value;
        if (ytVal) try { uploadTargets.push(JSON.parse(ytVal)); } catch(e) {}
    }

    try {
        await apiFetch('/channel-watchers', {
            method: 'POST',
            body: JSON.stringify({
                channel_url: url,
                platform: url.includes('facebook') ? 'facebook' : url.includes('tiktok') ? 'tiktok' : 'youtube',
                pipeline_template: document.getElementById('apPipeline').value,
                language: document.getElementById('apLanguage').value,
                voice_preset: voicePreset,
                browser_profiles: selectedBrowsers,
                content_format: document.getElementById('apContentFormat').value,
                max_episodes: parseInt(document.getElementById('apMaxEpisodes').value) || 1,
                seo_mode: document.querySelector('input[name="apSeoMode"]:checked')?.value || 'ai_generate',
                upload_targets: uploadTargets,
                upload_privacy: document.getElementById('apUploadPrivacy').value,
                check_interval_minutes: 30,
            }),
        });
        toast('✅ Đã thêm kênh theo dõi', 'success');
        document.getElementById('apNewChannelUrl').value = '';
        await loadApWatchers();
    } catch(e) {
        toast('❌ Lỗi: ' + e.message, 'error');
    }
}

async function toggleWatcherActive(watcherId, newState) {
    try {
        await apiFetch(`/channel-watchers/${watcherId}`, {
            method: 'PUT',
            body: JSON.stringify({ is_active: newState }),
        });
        await loadApWatchers();
    } catch(e) {
        toast('Lỗi: ' + e.message, 'error');
    }
}

async function deleteWatcher(watcherId) {
    if (!confirm('Xóa kênh theo dõi này?')) return;
    try {
        await apiFetch(`/channel-watchers/${watcherId}`, { method: 'DELETE' });
        toast('Đã xóa', 'info');
        await loadApWatchers();
    } catch(e) {
        toast('Lỗi: ' + e.message, 'error');
    }
}

async function toggleChannelWatcher() {
    try {
        const res = await apiFetch('/channel-watchers/status');
        if (res.running) {
            await apiFetch('/channel-watchers/stop', { method: 'POST' });
            toast('⏸ Channel watcher đã dừng', 'info');
        } else {
            await apiFetch('/channel-watchers/start', { method: 'POST' });
            toast('🟢 Channel watcher đã bật', 'success');
        }
        setTimeout(_refreshApStatus, 500);
    } catch(e) {
        toast('Lỗi: ' + e.message, 'error');
    }
}

// ── Auto Pipeline Chip Browser Selector ──

function _renderApBrowserChips() {
    const container = document.getElementById('apBrowserChipSelect');
    const emptyLabel = document.getElementById('apBrowserChipEmpty');
    const menu = document.getElementById('apBrowserChipMenu');
    if (!container || !menu) return;

    // Remove old chips
    container.querySelectorAll('.chip-item').forEach(el => el.remove());

    // Show/hide empty label
    if (emptyLabel) emptyLabel.style.display = _apChipSelectedProfiles.length === 0 ? '' : 'none';

    // Insert chips before the add-btn wrapper
    const addBtnWrap = container.querySelector('[style*="position:relative"]');
    _apChipSelectedProfiles.forEach(name => {
        const chip = document.createElement('span');
        chip.className = 'chip-item';
        chip.innerHTML = `<span class="chip-status"></span>${_escChip(name)}<span class="chip-remove" title="Remove">✕</span>`;
        chip.querySelector('.chip-remove').addEventListener('click', (e) => {
            e.stopPropagation();
            _apChipSelectedProfiles = _apChipSelectedProfiles.filter(n => n !== name);
            _renderApBrowserChips();
        });
        container.insertBefore(chip, addBtnWrap);
    });

    // Render dropdown menu options
    menu.innerHTML = '';
    (_browserProfilesCache || []).forEach(p => {
        const isSelected = _apChipSelectedProfiles.includes(p.name);
        const opt = document.createElement('div');
        opt.className = 'chip-dropdown-option' + (isSelected ? ' selected' : '');
        opt.innerHTML = `
            <span class="opt-icon">🌐</span>
            <span class="opt-name">${_escChip(p.name)}${p.has_cookies ? ' 🍪' : ''}${p.google_account ? ' 👤' : ''}</span>
            <span class="opt-check">✓</span>
        `;
        opt.addEventListener('click', () => {
            if (isSelected) {
                _apChipSelectedProfiles = _apChipSelectedProfiles.filter(n => n !== p.name);
            } else {
                _apChipSelectedProfiles.push(p.name);
            }
            _renderApBrowserChips();
        });
        menu.appendChild(opt);
    });
}

function toggleApBrowserChipMenu() {
    const menu = document.getElementById('apBrowserChipMenu');
    if (!menu) return;
    menu.classList.toggle('open');

    if (menu.classList.contains('open')) {
        setTimeout(() => {
            const handler = (e) => {
                if (!menu.contains(e.target) && e.target.id !== 'apBrowserAddBtn') {
                    menu.classList.remove('open');
                    document.removeEventListener('click', handler);
                }
            };
            document.addEventListener('click', handler);
        }, 10);
    }
}

// ── CHARACTER GALLERY IMPLEMENTATION ────────────────────────────────────

let currentGalleryCategory = null;
let allGalleryCategories = [];
let _galItemSelectedCategories = [];

function toggleGalleryView() {
    const mainContent = document.getElementById('mainPanel');
    const pipelineView = document.getElementById('pipelineView');
    const galleryView = document.getElementById('galleryView');
    
    const isCurrentlyOpen = galleryView.style.display !== 'none';
    
    if (isCurrentlyOpen) {
        // Close gallery, restore main content
        galleryView.style.display = 'none';
        mainContent.style.display = 'flex';
    } else {
        // Open gallery, hide others
        mainContent.style.display = 'none';
        if (pipelineView) pipelineView.style.display = 'none';
        galleryView.style.display = 'flex';
        
        // Remove active class from sidebar
        document.querySelectorAll('.project-item').forEach(el => el.classList.remove('active'));
        
        loadGalleryCategories();
        loadGalleryItems(null);
    }
}

async function _loadGalleryCategoriesIntoSelect(selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    
    try {
        const res = await apiFetch('/gallery/categories');
        const categories = res.categories || [];
        
        if (!window._galleryCategoryMap) window._galleryCategoryMap = {};
        
        sel.innerHTML = '<option value="">None (AI generates new)</option>';
        categories.forEach(cat => {
            window._galleryCategoryMap[cat.id] = cat.name;
            const opt = document.createElement('option');
            opt.value = cat.id;
            opt.textContent = cat.name + (cat.visual_style ? ` (${cat.visual_style})` : '');
            sel.appendChild(opt);
        });
    } catch (e) {
        console.warn(`Failed to load gallery categories for ${selectId}`, e);
    }
}

async function loadWizGalleryCategories() {
    await _loadGalleryCategoriesIntoSelect('wizGalleryCategory');
}

let _allGalleryItemsCache = []; // for client-side search

async function loadGalleryCategories() {
    try {
        const res = await apiFetch('/gallery/categories');
        allGalleryCategories = res.categories || [];
        
        const listEl = document.getElementById('galleryCategoriesList');
        if (!listEl) return;
        
        listEl.innerHTML = '';
        
        // "All Models & Products" sidebar item
        const allItem = document.createElement('div');
        allItem.className = 'gallery-cat-item' + (currentGalleryCategory === null ? ' active' : '');
        allItem.innerHTML = `
            <div class="gallery-cat-icon">👥</div>
            <span class="gallery-cat-name">All Models & Products</span>
        `;
        allItem.onclick = () => {
            currentGalleryCategory = null;
            document.getElementById('galleryCurrentCategoryName').textContent = 'All Models & Products';
            loadGalleryCategories();
            loadGalleryItems(null);
        };
        listEl.appendChild(allItem);
        
        allGalleryCategories.forEach(cat => {
            const item = document.createElement('div');
            item.className = 'gallery-cat-item' + (currentGalleryCategory === cat.id ? ' active' : '');
            item.innerHTML = `
                <div class="gallery-cat-icon">🎭</div>
                <span class="gallery-cat-name">${esc(cat.name)}</span>
                <span class="gallery-cat-count">${cat.item_count || 0}</span>
                <div class="gallery-cat-actions">
                    <button class="cat-action-btn" title="Edit category" onclick="event.stopPropagation(); editGalleryCategory(${cat.id})">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="cat-action-btn cat-delete-btn" title="Delete category" onclick="event.stopPropagation(); deleteGalleryCategory(${cat.id}, '${esc(cat.name)}')">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </div>
            `;
            item.onclick = () => {
                currentGalleryCategory = cat.id;
                document.getElementById('galleryCurrentCategoryName').textContent = cat.name;
                loadGalleryCategories();
                loadGalleryItems(cat.id);
            };
            
            listEl.appendChild(item);
        });
    } catch (e) {
        toast('Failed to load gallery categories', 'error');
    }
}

function editGalleryCategory(catId) {
    const cat = allGalleryCategories.find(c => c.id === catId);
    if (!cat) return;
    document.getElementById('galCatId').value = cat.id;
    document.getElementById('galCatName').value = cat.name || '';
    document.getElementById('galCatStyle').value = cat.visual_style || '';
    document.getElementById('galCatModalTitle').textContent = 'Edit Category';
    // Show delete button in modal
    const delBtn = document.getElementById('btnDeleteGalCat');
    if (delBtn) delBtn.style.display = 'inline-flex';
    document.getElementById('galleryCategoryModal').style.display = 'flex';
}

async function deleteGalleryCategory(catId, catName) {
    if (!confirm(`Xóa category "${catName}"?\n\nCác character trong category này sẽ không bị xóa, chỉ bỏ liên kết.`)) return;
    
    try {
        await apiFetch(`/gallery/categories/${catId}`, { method: 'DELETE' });
        toast(`Đã xóa category "${catName}"`, 'success');
        
        // Reset view if we were viewing the deleted category
        if (currentGalleryCategory === catId) {
            currentGalleryCategory = null;
            document.getElementById('galleryCurrentCategoryName').textContent = 'All Models & Products';
            loadGalleryItems(null);
        }
        loadGalleryCategories();
    } catch (e) {
        toast('Lỗi xóa category: ' + e.message, 'error');
    }
}

async function loadGalleryItems(categoryId = null) {
    try {
        let url = '/gallery/items';
        if (categoryId) url += `?category_id=${categoryId}`;
        
        const res = await apiFetch(url);
        const items = res.items || [];
        _allGalleryItemsCache = items;
        
        const countEl = document.getElementById('galleryItemCount');
        if (countEl) countEl.textContent = `${items.length} character${items.length !== 1 ? 's' : ''}`;
        
        _renderGalleryCards(items);
        
    } catch (e) {
        toast('Failed to load gallery items', 'error');
    }
}

function filterGalleryItems(query) {
    const q = (query || '').toLowerCase().trim();
    if (!q) {
        _renderGalleryCards(_allGalleryItemsCache);
        return;
    }
    const filtered = _allGalleryItemsCache.filter(item => {
        return (item.name || '').toLowerCase().includes(q) ||
               (item.tags || '').toLowerCase().includes(q) ||
               (item.role_type || '').toLowerCase().includes(q);
    });
    _renderGalleryCards(filtered);
}

function _resolveGalleryImageUrl(url) {
    if (!url) return '';
    // Already a web URL
    if (url.startsWith('/') || url.startsWith('http')) return url;
    // Old absolute path like C:\...\gallery\filename.ext — extract filename
    const parts = url.replace(/\\/g, '/').split('/');
    const fname = parts[parts.length - 1];
    if (fname) return `/api/v1/pod_studio/gallery/image/${fname}`;
    return url;
}

function _renderGalleryCards(items) {
    const grid = document.getElementById('galleryItemsGrid');
    if (!grid) return;
    
    grid.innerHTML = '';
    
    if (items.length === 0) {
        grid.innerHTML = `
            <div class="gallery-empty-state">
                <div class="gallery-empty-icon">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
                        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                        <circle cx="9" cy="7" r="4"></circle>
                        <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                        <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                    </svg>
                </div>
                <div class="gallery-empty-title">No Models & Products Yet</div>
                <div class="gallery-empty-desc">Upload reference images and add character details to build your gallery. Models & Products will be used as visual references in campaign projects.</div>
                <button class="btn btn-primary" onclick="showGalleryItemModal()" style="margin-top:16px;">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                    Add First Character
                </button>
            </div>`;
        return;
    }
    
    const _charTypeLabels = {
        individual: '👤', duo: '👥', friend_group: '🤝',
        crowd: '👨‍👩‍👧‍👦', creature: '🐾', object: '📦',
        costume_full: '👗', fabric_swatch: '🧵', pattern_design: '🎨',
        hair_accessory: '💇', earring: '💎', necklace: '📿', bracelet: '⌚', other_accessory: '🎀',
        location: '🏛️', architecture: '🏠', interior_design: '🛋️', exterior: '🏢', nature: '🌿',
        lighting_ref: '💡', color_palette: '🎨', mood_board: '🌫️',
        chart: '📊', diagram: '🔀', infographic: '📈', table: '📋', screenshot: '🖥️', screen: '📺',
        holographic: '🌈', thought_bubble: '💭', overlay: '🎭', transition: '🔄', particle: '✨', data_panel: '📟'
    };
    items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'gallery-char-card';
        card.onclick = () => showGalleryItemModal(item);
        
        const imgUrl = _resolveGalleryImageUrl(item.image_url);
        const hasImage = !!imgUrl;
        const charType = item.char_type || 'individual';
        const typeIcon = _charTypeLabels[charType] || '👤';
        const showTypeBadge = charType && charType !== 'individual';
        
        card.innerHTML = `
            <div class="gallery-char-card-image">
                ${hasImage 
                    ? `<img src="${imgUrl}" alt="${esc(item.name)}" loading="lazy">` 
                    : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:48px;">👤</div>`
                }
                ${showTypeBadge ? `<span class="gallery-char-type-badge">${typeIcon} ${esc(charType.replace('_', ' '))}</span>` : ''}
            </div>
            <div class="gallery-char-card-body">
                <h4 class="gallery-char-card-name">${esc(item.name)}</h4>
                <div class="gallery-char-card-tags">
                    ${item.gender ? `<span class="gallery-char-tag gender">${esc(item.gender)}</span>` : ''}
                    ${item.age_range ? `<span class="gallery-char-tag age">${esc(item.age_range)}</span>` : ''}
                    ${item.role_type ? `<span class="gallery-char-tag role">${esc(item.role_type)}</span>` : ''}
                </div>
            </div>
        `;
        grid.appendChild(card);
    });
}

function showGalleryCategoryModal() {
    document.getElementById('galCatId').value = '';
    document.getElementById('galCatName').value = '';
    document.getElementById('galCatStyle').value = '';
    document.getElementById('galCatModalTitle').textContent = 'New Category';
    // Hide delete button for new category
    const delBtn = document.getElementById('btnDeleteGalCat');
    if (delBtn) delBtn.style.display = 'none';
    document.getElementById('galleryCategoryModal').style.display = 'flex';
}

async function saveGalleryCategory() {
    const id = document.getElementById('galCatId').value;
    const name = document.getElementById('galCatName').value.trim();
    const style = document.getElementById('galCatStyle').value.trim();
    
    if (!name) { toast('Please enter a category name', 'error'); return; }
    
    const payload = { name, visual_style: style };
    
    try {
        if (id) {
            await apiFetch(`/gallery/categories/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
            toast('Category updated', 'success');
        } else {
            await apiFetch('/gallery/categories', { method: 'POST', body: JSON.stringify(payload) });
            toast('Category created', 'success');
        }
        document.getElementById('galleryCategoryModal').style.display = 'none';
        loadGalleryCategories();
    } catch (e) {
        toast('Failed to save category: ' + e.message, 'error');
    }
}

function togglePrimaryProduct() {
    const input = document.getElementById('galItemIsPrimary');
    const star = document.getElementById('galItemPrimaryStar');
    const toggle = document.getElementById('galItemPrimaryToggle');
    const label = document.getElementById('galItemPrimaryLabel');
    const isPrimary = input.value === '1';
    if (isPrimary) {
        input.value = '0';
        star.textContent = '☆';
        toggle.style.border = '1px solid var(--border)';
        toggle.style.background = 'var(--bg-2)';
        label.textContent = 'Mark as Primary Product';
    } else {
        input.value = '1';
        star.textContent = '⭐';
        toggle.style.border = '1px solid #f59e0b';
        toggle.style.background = 'rgba(245,158,11,0.08)';
        label.textContent = '⭐ Primary Product — AI Focus Lock';
    }
}

function _setPrimaryState(isPrimary) {
    const input = document.getElementById('galItemIsPrimary');
    const star = document.getElementById('galItemPrimaryStar');
    const toggle = document.getElementById('galItemPrimaryToggle');
    const label = document.getElementById('galItemPrimaryLabel');
    if (isPrimary) {
        input.value = '1';
        star.textContent = '⭐';
        toggle.style.border = '1px solid #f59e0b';
        toggle.style.background = 'rgba(245,158,11,0.08)';
        label.textContent = '⭐ Primary Product — AI Focus Lock';
    } else {
        input.value = '0';
        star.textContent = '☆';
        toggle.style.border = '1px solid var(--border)';
        toggle.style.background = 'var(--bg-2)';
        label.textContent = 'Mark as Primary Product';
    }
}

function showGalleryItemModal(item = null) {
    document.getElementById('galleryItemModal').style.display = 'flex';
    document.getElementById('galItemAnalyzeStatus').style.display = 'none';
    
    if (item) {
        document.getElementById('galItemModalTitle').textContent = 'Edit Model/Product';
        document.getElementById('galItemId').value = item.id;
        document.getElementById('galItemName').value = item.name || '';
        document.getElementById('galItemCharType').value = item.char_type || 'individual';
        document.getElementById('galItemGender').value = item.gender || '';
        document.getElementById('galItemAge').value = item.age_range || '';
        document.getElementById('galItemRole').value = item.role_type || '';
        document.getElementById('galItemAppearance').value = item.appearance || '';
        document.getElementById('galItemTags').value = item.tags || '';
        document.getElementById('galItemFabric').value = item.fabric_material || '';
        document.getElementById('galItemAccessoryMaterial').value = item.accessory_material || '';
        _setPrimaryState(item.is_primary === 1 || item.is_primary === true);
        document.getElementById('galItemImageUrl').value = _resolveGalleryImageUrl(item.image_url) || '';
        
        document.getElementById('btnDeleteGalItem').style.display = 'block';
        
        // Image
        const resolvedUrl = _resolveGalleryImageUrl(item.image_url);
        if (resolvedUrl) {
            document.getElementById('galItemImagePreview').src = resolvedUrl;
            document.getElementById('galItemImagePreview').style.display = 'block';
            document.getElementById('galItemImagePlaceholder').style.display = 'none';
        } else {
            document.getElementById('galItemImagePreview').style.display = 'none';
            document.getElementById('galItemImagePlaceholder').style.display = 'block';
        }
        
        // Categories
        _galItemSelectedCategories = item.category_ids || [];
        
    } else {
        document.getElementById('galItemModalTitle').textContent = 'Add Model/Product';
        document.getElementById('galItemId').value = '';
        document.getElementById('galItemName').value = '';
        document.getElementById('galItemCharType').value = 'individual';
        document.getElementById('galItemGender').value = '';
        document.getElementById('galItemAge').value = '';
        document.getElementById('galItemRole').value = '';
        document.getElementById('galItemAppearance').value = '';
        document.getElementById('galItemTags').value = '';
        document.getElementById('galItemFabric').value = '';
        document.getElementById('galItemAccessoryMaterial').value = '';
        _setPrimaryState(false);
        document.getElementById('galItemImageUrl').value = '';
        
        document.getElementById('btnDeleteGalItem').style.display = 'none';
        
        document.getElementById('galItemImagePreview').style.display = 'none';
        document.getElementById('galItemImagePlaceholder').style.display = 'block';
        
        // Pre-select current category if viewing one
        _galItemSelectedCategories = currentGalleryCategory ? [currentGalleryCategory] : [];
    }
    
    _renderGalItemCategoryChips();
}

function _renderGalItemCategoryChips() {
    const container = document.getElementById('galItemCategorySelect');
    const emptyLabel = document.getElementById('galItemCatEmpty');
    const menu = document.getElementById('galItemCatMenu');
    if (!container || !menu) return;

    container.querySelectorAll('.chip-item').forEach(el => el.remove());
    if (emptyLabel) emptyLabel.style.display = _galItemSelectedCategories.length === 0 ? '' : 'none';

    const addBtnWrap = container.querySelector('[style*="position:relative"]');
    
    _galItemSelectedCategories.forEach(catId => {
        const cat = allGalleryCategories.find(c => c.id === catId);
        if (!cat) return;
        
        const chip = document.createElement('span');
        chip.className = 'chip-item';
        chip.innerHTML = `${esc(cat.name)}<span class="chip-remove" title="Remove">✕</span>`;
        chip.querySelector('.chip-remove').onclick = (e) => {
            e.stopPropagation();
            _galItemSelectedCategories = _galItemSelectedCategories.filter(id => id !== catId);
            _renderGalItemCategoryChips();
        };
        container.insertBefore(chip, addBtnWrap);
    });

    menu.innerHTML = '';
    allGalleryCategories.forEach(cat => {
        const isSelected = _galItemSelectedCategories.includes(cat.id);
        const opt = document.createElement('div');
        opt.className = 'chip-dropdown-option' + (isSelected ? ' selected' : '');
        opt.innerHTML = `<span class="opt-name">${esc(cat.name)}</span><span class="opt-check">✓</span>`;
        opt.onclick = () => {
            if (isSelected) {
                _galItemSelectedCategories = _galItemSelectedCategories.filter(id => id !== cat.id);
            } else {
                _galItemSelectedCategories.push(cat.id);
            }
            _renderGalItemCategoryChips();
        };
        menu.appendChild(opt);
    });
}

function toggleGalItemCatMenu() {
    const menu = document.getElementById('galItemCatMenu');
    if (!menu) return;
    menu.classList.toggle('open');
    if (menu.classList.contains('open')) {
        setTimeout(() => {
            const handler = (e) => {
                if (!menu.contains(e.target) && e.target.id !== 'galItemCatAddBtn') {
                    menu.classList.remove('open');
                    document.removeEventListener('click', handler);
                }
            };
            document.addEventListener('click', handler);
        }, 10);
    }
}

async function handleGalleryImageUpload(input) {
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    
    // Preview local image immediately
    const reader = new FileReader();
    reader.onload = (e) => {
        document.getElementById('galItemImagePreview').src = e.target.result;
        document.getElementById('galItemImagePreview').style.display = 'block';
        document.getElementById('galItemImagePlaceholder').style.display = 'none';
    };
    reader.readAsDataURL(file);
    
    // Upload
    const formData = new FormData();
    formData.append('file', file);
    
    try {
        const resp = await fetch('/api/v1/pod_studio/gallery/upload-image', {
            method: 'POST',
            body: formData
        });
        const res = await resp.json();
        if (resp.ok && res.success && res.url) {
            document.getElementById('galItemImageUrl').value = res.url;
            toast('Image uploaded successfully', 'success');
        } else {
            let errMsg = res.error || res.message || (res.detail ? JSON.stringify(res.detail) : 'Unknown error');
            throw new Error(errMsg);
        }
    } catch(e) {
        toast('Upload Error: ' + e.message, 'error');
    }
}

async function analyzeGalleryImage(manualKey = null) {
    const imageUrl = document.getElementById('galItemImageUrl').value;
    if (!imageUrl) {
        toast('Please upload an image first', 'warning');
        return;
    }
    
    const statusEl = document.getElementById('galItemAnalyzeStatus');
    statusEl.style.display = 'block';
    statusEl.textContent = 'Analyzing image...';
    
    try {
        const reqBody = { image_path: imageUrl };
        if (manualKey) reqBody.api_key = manualKey;

        const res = await apiFetch('/gallery/analyze-image', {
            method: 'POST',
            body: JSON.stringify(reqBody)
        });
        
        if (res.success && res.analysis) {
            const a = res.analysis;
            console.log('Gallery Auto-Fill analysis:', a);
            
            // Character Type
            const validTypes = ['individual', 'duo', 'friend_group', 'crowd', 'creature', 'object',
                'costume_full', 'fabric_swatch', 'pattern_design',
                'hair_accessory', 'earring', 'necklace', 'bracelet', 'other_accessory',
                'location', 'architecture', 'interior_design', 'exterior', 'nature',
                'lighting_ref', 'color_palette', 'mood_board',
                'chart', 'diagram', 'infographic', 'table', 'screenshot', 'screen',
                'holographic', 'thought_bubble', 'overlay', 'transition', 'particle', 'data_panel'];
            let detectedType = 'individual';
            if (a.char_type) {
                const ct = a.char_type.toLowerCase().replace(/\s+/g, '_');
                if (validTypes.includes(ct)) {
                    detectedType = ct;
                    document.getElementById('galItemCharType').value = ct;
                }
            }
            
            // Name suggestion (only if empty)
            if (!document.getElementById('galItemName').value && a.name_suggestion) {
                document.getElementById('galItemName').value = a.name_suggestion;
            }
            
            // Gender & Age: only fill for person-type entries
            const isPersonType = ['individual', 'duo', 'friend_group', 'crowd'].includes(detectedType);
            if (isPersonType) {
                if (a.gender) document.getElementById('galItemGender').value = a.gender.toLowerCase();
                if (a.age_range) document.getElementById('galItemAge').value = a.age_range.toLowerCase().replace(/\s+/g, '_');
            } else {
                // For objects/creatures, clear gender & age since they're not applicable
                document.getElementById('galItemGender').value = '';
                document.getElementById('galItemAge').value = '';
            }
            
            // Appearance: ensure plain text, not JSON
            let appearanceText = a.appearance || a.appearance_desc || a.description || a.physical_description || '';
            if (typeof appearanceText === 'object') {
                appearanceText = JSON.stringify(appearanceText);
            }
            if (appearanceText) document.getElementById('galItemAppearance').value = appearanceText;
            
            // Role: always fill from AI
            if (a.role_type && typeof a.role_type === 'string') {
                document.getElementById('galItemRole').value = a.role_type;
            } else if (a.role_suggestions && Array.isArray(a.role_suggestions) && a.role_suggestions.length > 0) {
                document.getElementById('galItemRole').value = a.role_suggestions[0];
            }
            
            if (a.tags) {
                const tagsStr = Array.isArray(a.tags) ? a.tags.join(', ') : a.tags;
                document.getElementById('galItemTags').value = tagsStr;
            }
            toast('Auto-Fill complete!', 'success');
        }
    } catch (e) {
        statusEl.style.display = 'none';
        // Show professional API key modal instead of ugly prompt()
        const errMsg = e.message ? e.message.toLowerCase() : '';
        if (errMsg.includes('503') || errMsg.includes('429') || errMsg.includes('high demand') || errMsg.includes('too many requests')) {
            toast('Google AI đang quá tải (High Demand). Vui lòng thử lại sau vài giây.', 'warning');
        } else {
            showGeminiKeyModal(e.message);
        }
    } finally {
        statusEl.style.display = 'none';
    }
}

// ── Gemini API Key Modal Functions ──

let _geminiKeyResolve = null;

function showGeminiKeyModal(errorMsg = '') {
    const modal = document.getElementById('geminiKeyModal');
    const errorBox = document.getElementById('geminiKeyErrorBox');
    const errorText = document.getElementById('geminiKeyErrorText');
    const input = document.getElementById('geminiKeyInput');
    
    // Show error if provided
    if (errorMsg) {
        // Extract clean error message
        let cleanMsg = errorMsg;
        try {
            // Try to extract the core message from API error JSON
            const match = errorMsg.match(/"message"\s*:\s*"([^"]+)"/);
            if (match) {
                cleanMsg = match[1];
            } else if (errorMsg.includes('API key')) {
                cleanMsg = 'API Key không hợp lệ hoặc đã hết hạn. Vui lòng kiểm tra lại.';
            }
        } catch(_) {}
        errorText.textContent = cleanMsg;
        errorBox.style.display = 'block';
    } else {
        errorBox.style.display = 'none';
    }
    
    input.value = '';
    input.type = 'password';
    modal.style.display = 'flex';
    
    // Focus input after animation
    setTimeout(() => input.focus(), 100);
}

function closeGeminiKeyModal() {
    document.getElementById('geminiKeyModal').style.display = 'none';
    toast('Phân tích đã bị hủy', 'warning');
}

function toggleGeminiKeyVisibility() {
    const input = document.getElementById('geminiKeyInput');
    input.type = input.type === 'password' ? 'text' : 'password';
}

async function submitGeminiKey() {
    const key = document.getElementById('geminiKeyInput').value.trim();
    if (!key) {
        toast('Vui lòng nhập API Key', 'error');
        document.getElementById('geminiKeyInput').focus();
        return;
    }
    
    const shouldSave = document.getElementById('geminiKeySaveCheck').checked;
    const submitBtn = document.getElementById('geminiKeySubmitBtn');
    
    // Disable button during processing
    submitBtn.disabled = true;
    submitBtn.innerHTML = `
        <div style="width:14px;height:14px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;animation:spin 0.6s linear infinite;"></div>
        Đang xử lý...
    `;
    
    try {
        // Save key if checkbox checked
        if (shouldSave) {
            try {
                await apiFetch('/gallery/save-api-key', {
                    method: 'POST',
                    body: JSON.stringify({ api_key: key })
                });
                toast('🔑 API Key đã được lưu vào Cloud Config', 'success');
                // Refresh key panel if it's open
                if (document.getElementById('geminiKeyPanel') && document.getElementById('geminiKeyPanel').style.display !== 'none') {
                    loadGeminiKeyList();
                }
            } catch (saveErr) {
                console.warn('Failed to save API key:', saveErr);
                // Don't block analysis if save fails
            }
        }
        
        // Close modal and retry analysis with the key
        document.getElementById('geminiKeyModal').style.display = 'none';
        await analyzeGalleryImage(key);
        
    } catch (e) {
        toast('Lỗi: ' + e.message, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <polyline points="20 6 9 17 4 12"/>
            </svg>
            Xác nhận & Phân tích
        `;
    }
}

// ── Gemini Key Panel Functions ──

function toggleGeminiKeyPanel() {
    const panel = document.getElementById('geminiKeyPanel');
    if (panel.style.display === 'none') {
        panel.style.display = 'block';
        loadGeminiKeyList();
    } else {
        panel.style.display = 'none';
    }
}

async function loadGeminiKeyList() {
    const listEl = document.getElementById('geminiKeyList');
    const emptyEl = document.getElementById('geminiKeyEmpty');
    listEl.innerHTML = '<div style="padding:10px; text-align:center; color:var(--text-3); font-size:12px;">Loading...</div>';
    emptyEl.style.display = 'none';

    try {
        const res = await apiFetch('/gallery/list-gemini-keys');
        const keys = res.keys || [];

        if (keys.length === 0) {
            listEl.innerHTML = '';
            emptyEl.style.display = 'block';
            return;
        }

        emptyEl.style.display = 'none';
        let html = '';
        for (const k of keys) {
            const lbl = k.label.replace(/'/g, "\\'");
            const isActive = k.active;
            const bg = isActive ? 'rgba(34,197,94,0.06)' : 'var(--bg-0)';
            const bdr = isActive ? 'rgba(34,197,94,0.2)' : 'var(--border)';
            let badge = '';
            if (isActive) {
                badge = '<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:#22c55e22;color:#22c55e;font-weight:600;">Active</span>';
            } else {
                badge = '<button onclick="setActiveGeminiKey(\'' + lbl + '\')" style="font-size:10px;padding:2px 6px;border-radius:4px;background:var(--bg-2);color:var(--accent);border:1px solid var(--border);cursor:pointer;">Dùng</button>';
            }
            const del = '<button onclick="deleteGeminiKey(\'' + lbl + '\')" title="Xóa" style="background:none;border:none;cursor:pointer;color:var(--text-3);padding:2px;font-size:14px;line-height:1;">x</button>';
            html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:8px;background:' + bg + ';border:1px solid ' + bdr + ';margin-bottom:4px;">';
            html += '<div style="flex:1;min-width:0;"><div style="font-size:12px;font-weight:600;color:var(--text-1);">' + k.label + '</div>';
            html += '<div style="font-size:11px;color:var(--text-3);font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + k.masked_key + '</div></div>';
            html += '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">' + badge + del + '</div></div>';
        }
        listEl.innerHTML = html;
    } catch (e) {
        listEl.innerHTML = '<div style="padding:10px;text-align:center;color:#ef4444;font-size:12px;">Error loading keys</div>';
    }
}

async function setActiveGeminiKey(label) {
    try {
        await apiFetch('/gallery/set-active-gemini-key', {
            method: 'POST',
            body: JSON.stringify({ label: label })
        });
        toast('Switched to key: ' + label, 'success');
        loadGeminiKeyList();
    } catch (e) {
        toast('Error: ' + e.message, 'error');
    }
}

async function deleteGeminiKey(label) {
    if (!confirm('Delete key "' + label + '"?')) return;
    try {
        await apiFetch('/gallery/delete-gemini-key', {
            method: 'POST',
            body: JSON.stringify({ label: label })
        });
        toast('Deleted key: ' + label, 'success');
        loadGeminiKeyList();
    } catch (e) {
        toast('Error: ' + e.message, 'error');
    }
}

async function saveGalleryItem() {
    const id = document.getElementById('galItemId').value;
    const name = document.getElementById('galItemName').value.trim();
    const imageUrl = document.getElementById('galItemImageUrl').value;
    
    if (!name) { toast('Please enter a character name', 'error'); return; }
    if (!imageUrl) { toast('Please upload a character reference image', 'error'); return; }
    
    const payload = {
        name,
        char_type: document.getElementById('galItemCharType').value,
        gender: document.getElementById('galItemGender').value,
        age_range: document.getElementById('galItemAge').value,
        role_type: document.getElementById('galItemRole').value,
        appearance: document.getElementById('galItemAppearance').value,
        tags: document.getElementById('galItemTags').value,
        fabric_material: document.getElementById('galItemFabric').value,
        accessory_material: document.getElementById('galItemAccessoryMaterial').value,
        is_primary: document.getElementById('galItemIsPrimary').value === '1' ? 1 : 0,
        image_url: imageUrl,
        category_ids: _galItemSelectedCategories
    };
    
    try {
        if (id) {
            await apiFetch(`/gallery/items/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
            toast('Character updated', 'success');
        } else {
            await apiFetch('/gallery/items', { method: 'POST', body: JSON.stringify(payload) });
            toast('Character added', 'success');
        }
        document.getElementById('galleryItemModal').style.display = 'none';
        loadGalleryItems(currentGalleryCategory);
    } catch (e) {
        toast('Failed to save character: ' + e.message, 'error');
    }
}

async function deleteGalleryItem() {
    const id = document.getElementById('galItemId').value;
    if (!id) return;
    
    if (!confirm('Are you sure you want to delete this character?')) return;
    
    try {
        await apiFetch(`/gallery/items/${id}`, { method: 'DELETE' });
        toast('Character deleted', 'info');
        document.getElementById('galleryItemModal').style.display = 'none';
        loadGalleryItems(currentGalleryCategory);
    } catch (e) {
        toast('Delete failed: ' + e.message, 'error');
    }
}


// ═══════════════════════════════════════════════════════════════
// ── Step 08: Publish to Platforms ─────────────────────────────
// ═══════════════════════════════════════════════════════════════

// ── Wizard: Load YT Channels & FB Pages for upload target selection ──

let _wizYtLoaded = false, _wizFbLoaded = false;

async function loadWizYtChannels() {
    if (_wizYtLoaded) return;
    _wizYtLoaded = true;
    const sel = document.getElementById('wizYtChannel');
    if (!sel) return;
    sel.innerHTML = '<option value="">None (không upload)</option><option value="" disabled>⏳ Loading...</option>';
    try {
        const res = await fetch('/api/v1/video_manager/accounts?provider=youtube');
        const data = await res.json();
        sel.innerHTML = '<option value="">None (không upload)</option>';
        if (data.accounts && data.accounts.length > 0) {
            for (const acc of data.accounts) {
                try {
                    const chRes = await fetch(`/api/v1/video_manager/channels?provider=youtube&email=${acc.email || ''}&cred_id=${acc.cred_id || acc.id || ''}`);
                    const chData = await chRes.json();
                    (chData.channels || []).forEach(ch => {
                        const opt = document.createElement('option');
                        const chName = ch.title || ch.name || ch.id;
                        opt.value = JSON.stringify({ provider: 'youtube', email: acc.email, cred_id: acc.cred_id || acc.id, channel_id: ch.id, channel_name: chName });
                        opt.textContent = `📺 ${chName} (${acc.email || ''})`;
                        sel.appendChild(opt);
                    });
                } catch(e) {}
            }
        }
        // Remove the temporary loading option if it exists
        for (let i = 0; i < sel.options.length; i++) {
            if (sel.options[i].text.includes('Loading...')) {
                sel.remove(i);
                break;
            }
        }
        if (sel.options.length <= 1) sel.innerHTML += '<option value="" disabled>Không tìm thấy channel</option>';
    } catch(e) {
        sel.innerHTML = '<option value="">None</option><option value="" disabled>⚠️ Lỗi tải channels</option>';
    }
}

async function loadWizFbPages() {
    if (_wizFbLoaded) return;
    _wizFbLoaded = true;
    const sel = document.getElementById('wizFbPage');
    if (!sel) return;
    sel.innerHTML = '<option value="">None (không upload)</option><option value="" disabled>⏳ Loading...</option>';
    try {
        const res = await fetch('/api/v1/video_manager/accounts?provider=facebook');
        const data = await res.json();
        sel.innerHTML = '<option value="">None (không upload)</option>';
        if (data.accounts && data.accounts.length > 0) {
            for (const acc of data.accounts) {
                try {
                    const chRes = await fetch(`/api/v1/video_manager/channels?provider=facebook&cred_id=${acc.cred_id || acc.id || ''}`);
                    const chData = await chRes.json();
                    (chData.channels || []).forEach(ch => {
                        const opt = document.createElement('option');
                        const chName = ch.title || ch.name || ch.id;
                        opt.value = JSON.stringify({ provider: 'facebook', cred_id: acc.cred_id || acc.id, channel_id: ch.id, page_name: chName });
                        opt.textContent = `📘 ${chName}`;
                        sel.appendChild(opt);
                    });
                } catch(e) {}
            }
        }
        // Remove the temporary loading option if it exists
        for (let i = 0; i < sel.options.length; i++) {
            if (sel.options[i].text.includes('Loading...')) {
                sel.remove(i);
                break;
            }
        }
        if (sel.options.length <= 1) sel.innerHTML += '<option value="" disabled>Không tìm thấy page</option>';
    } catch(e) {
        sel.innerHTML = '<option value="">None</option><option value="" disabled>⚠️ Lỗi tải pages</option>';
    }
}

// ── Publish Panel: Data Loading ──

let _publishSEOData = {}; // { youtube: {title, description, tags}, facebook: {...} }

async function loadPublishData() {
    if (!currentCampaign || !currentEpisode) return;
    try {
        const meta = JSON.parse(currentCampaign.metadata || '{}');
        const targets = meta.upload_targets || [];
        
        // Load SEO from EPISODE metadata (per-episode), fallback to campaign-level
        const epMeta = JSON.parse(currentEpisode.metadata || '{}');
        const seoPublish = epMeta.seo_publish || meta.seo_publish || {};
        _publishSEOData = seoPublish;

        const grid = document.getElementById('publishPlatformGrid');
        const emptyEl = document.getElementById('publishEmpty');
        const seoPreview = document.getElementById('publishSEOPreview');
        const statusEl = document.getElementById('publishStatus');

        if (targets.length === 0 && Object.keys(seoPublish).length === 0) {
            emptyEl.style.display = '';
            grid.innerHTML = '';
            seoPreview.style.display = 'none';
            statusEl.textContent = 'No publish targets configured';
            return;
        }

        emptyEl.style.display = 'none';
        seoPreview.style.display = '';
        statusEl.textContent = `${targets.length} platform(s) configured`;

        // Load publish status
        let publishStatus = {};
        try {
            const psRes = await apiFetch(`/campaigns/${currentCampaign.id}/episodes/${currentEpisode.id}/publish-status`);
            publishStatus = psRes.platforms || {};
        } catch(e) {}

        // Show SEO fields for first platform
        const firstPlatform = targets[0]?.provider || 'youtube';
        switchPublishSEOPlatform(firstPlatform);

        // Render platform cards
        grid.innerHTML = '';
        targets.forEach((target, idx) => {
            const platform = target.provider || 'youtube';
            const pStatus = publishStatus[platform] || {};
            const card = document.createElement('div');
            card.className = 'card';
            card.style.cssText = 'padding:16px; border:1px solid var(--border);';
            card.id = `publishCard_${idx}`;

            const icon = platform === 'youtube' ? '📺' : platform === 'facebook' ? '📘' : '🎵';
            const pName = platform.charAt(0).toUpperCase() + platform.slice(1);
            const channelId = target.channel_name || target.page_name || target.channel_id || '—';
            const privacy = meta.upload_privacy || 'private';

            let statusBadge = '';
            if (pStatus.status === 'done') {
                statusBadge = `<span style="color:#10b981; font-weight:600;">✅ Published</span>`;
                if (pStatus.video_url) statusBadge += `<br><a href="${pStatus.video_url}" target="_blank" style="font-size:11px; color:var(--accent);">${pStatus.video_url}</a>`;
            } else if (pStatus.status === 'uploading') {
                statusBadge = `<span style="color:#f59e0b;">⏳ Uploading... ${pStatus.progress || 0}%</span>`;
            } else if (pStatus.status === 'error') {
                statusBadge = `<span style="color:#ef4444;">❌ Error: ${pStatus.error || 'Unknown'}</span>`;
            } else {
                statusBadge = `<span style="color:var(--text-3);">⏸ Ready to publish</span>`;
            }

            card.innerHTML = `
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px;">
                    <span style="font-size:20px;">${icon}</span>
                    <div>
                        <div style="font-weight:600; font-size:14px; color:var(--text-0);">${pName}</div>
                        <div style="font-size:11px; color:var(--text-3);">Channel: ${channelId} · ${privacy}</div>
                    </div>
                </div>
                <div style="padding:8px 0; border-top:1px solid var(--border); font-size:12px;">
                    ${statusBadge}
                </div>
                <div style="display:flex; gap:6px; margin-top:10px;">
                    <button class="btn btn-sm btn-primary" onclick="publishToTarget(${idx})" ${pStatus.status === 'done' ? 'disabled' : ''}>
                        🚀 Publish
                    </button>
                    ${pStatus.status === 'done' ? `<button class="btn btn-sm btn-outline" onclick="publishToTarget(${idx})" >🔄 Re-publish</button>` : ''}
                </div>
            `;
            grid.appendChild(card);
        });

    } catch(e) {
        console.warn('loadPublishData error:', e);
    }
}

function switchPublishSEOPlatform(platform) {
    const seo = _publishSEOData[platform] || {};
    document.getElementById('publishSEOTitle').value = seo.title || '';
    document.getElementById('publishSEODesc').value = seo.description || '';
    const tags = seo.tags || [];
    document.getElementById('publishSEOTags').value = Array.isArray(tags) ? tags.join(', ') : tags;
    document.getElementById('publishSEOPlatform').value = platform;
}

async function savePublishSEO() {
    if (!currentCampaign || !currentEpisode) return;
    const platform = document.getElementById('publishSEOPlatform').value;
    const title = document.getElementById('publishSEOTitle').value.trim();
    const desc = document.getElementById('publishSEODesc').value.trim();
    const tagsStr = document.getElementById('publishSEOTags').value.trim();
    const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [];

    _publishSEOData[platform] = { title, description: desc, tags };

    try {
        // Save to EPISODE metadata (per-episode SEO)
        const epMeta = JSON.parse(currentEpisode.metadata || '{}');
        epMeta.seo_publish = _publishSEOData;
        await apiFetch(`/episodes/${currentEpisode.id}`, {
            method: 'PUT',
            body: JSON.stringify({ metadata: epMeta }),
        });
        // Update local cache
        currentEpisode.metadata = JSON.stringify(epMeta);
        toast('SEO saved!', 'success');
    } catch(e) {
        toast('Save SEO failed: ' + e.message, 'error');
    }
}

async function generatePublishSEO() {
    if (!currentCampaign || !currentEpisode) {
        toast('Chọn episode trước', 'error');
        return;
    }
    const btn = document.getElementById('btnGenSEO');
    const old = btn.innerHTML;
    btn.innerHTML = '⏳ Generating...';
    btn.disabled = true;
    try {
        const res = await apiFetch(`/campaigns/${currentCampaign.id}/generate-seo`, {
            method: 'POST',
            body: JSON.stringify({ episode_id: currentEpisode.id }),
        });
        if (res.seo_publish) {
            _publishSEOData = res.seo_publish;
            // Refresh episode metadata (SEO is now per-episode)
            const epRes = await apiFetch(`/episodes/${currentEpisode.id}`);
            currentEpisode = epRes;
            switchPublishSEOPlatform(document.getElementById('publishSEOPlatform').value);
            document.getElementById('publishSEOPreview').style.display = '';
            toast('SEO generated!', 'success');
        }
    } catch(e) {
        toast('SEO generation failed: ' + e.message, 'error');
    } finally {
        btn.innerHTML = old;
        btn.disabled = false;
    }
}

async function publishToTarget(targetIdx) {
    if (!currentCampaign || !currentEpisode) return;
    const meta = JSON.parse(currentCampaign.metadata || '{}');
    const targets = meta.upload_targets || [];
    const target = targets[targetIdx];
    if (!target) { toast('Invalid target', 'error'); return; }

    const card = document.getElementById(`publishCard_${targetIdx}`);
    const btn = card?.querySelector('.btn-primary');
    if (btn) { btn.innerHTML = '⏳ Publishing...'; btn.disabled = true; }

    try {
        const res = await apiFetch(`/campaigns/${currentCampaign.id}/episodes/${currentEpisode.id}/publish`, {
            method: 'POST',
            body: JSON.stringify({ target_index: targetIdx }),
        });
        if (res.task_id) {
            toast(`Upload started for ${target.provider}`, 'info');
            _pollPublishStatus(res.task_id, targetIdx);
        } else if (res.error) {
            toast(res.error, 'error');
            if (btn) { btn.innerHTML = '🚀 Publish'; btn.disabled = false; }
        }
    } catch(e) {
        toast('Publish failed: ' + e.message, 'error');
        if (btn) { btn.innerHTML = '🚀 Publish'; btn.disabled = false; }
    }
}

async function publishAllTargets() {
    if (!currentCampaign) return;
    const meta = JSON.parse(currentCampaign.metadata || '{}');
    const targets = meta.upload_targets || [];
    for (let i = 0; i < targets.length; i++) {
        await publishToTarget(i);
        if (i < targets.length - 1) await new Promise(r => setTimeout(r, 2000));
    }
}

function _pollPublishStatus(taskId, targetIdx) {
    const card = document.getElementById(`publishCard_${targetIdx}`);
    const interval = setInterval(async () => {
        try {
            const res = await fetch(`/api/v1/video_manager/upload/tasks/${taskId}`);
            const data = await res.json();
            const task = data.task || {};
            const statusDiv = card?.querySelector('div[style*="border-top"]');
            if (statusDiv) {
                if (task.status === 'done') {
                    statusDiv.innerHTML = `<span style="color:#10b981; font-weight:600;">✅ Published</span>` +
                        (task.video_url ? `<br><a href="${task.video_url}" target="_blank" style="font-size:11px; color:var(--accent);">${task.video_url}</a>` : '');
                    clearInterval(interval);
                    toast('Published!', 'success');
                } else if (task.status === 'error' || task.status === 'cancelled') {
                    statusDiv.innerHTML = `<span style="color:#ef4444;">❌ ${task.error_message || 'Failed'}</span>`;
                    clearInterval(interval);
                    const btn = card?.querySelector('.btn-primary');
                    if (btn) { btn.innerHTML = '🚀 Retry'; btn.disabled = false; }
                } else {
                    statusDiv.innerHTML = `<span style="color:#f59e0b;">⏳ Uploading... ${task.progress_pct || 0}%</span>`;
                }
            }
        } catch(e) {
            clearInterval(interval);
        }
    }, 3000);
}


// ── Storyboard Grid Concept ──

function copyGridPrompt() {
    if (!currentEpisode) return;
    try {
        const meta = typeof currentEpisode.metadata === 'string' ? JSON.parse(currentEpisode.metadata) : currentEpisode.metadata;
        if (meta && meta.master_grid_prompt) {
            navigator.clipboard.writeText(meta.master_grid_prompt);
            toast("Prompt copied to clipboard!", "success");
        } else {
            toast("No grid prompt available. Please generate storyboard first.", "error");
        }
    } catch(e) {
        toast("Error reading prompt.", "error");
    }
}

async function uploadGridManual(event) {
    if (!currentCampaign || !currentEpisode) return;
    const file = event.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    const btn = document.getElementById('btnGenGrid');
    const oldText = btn.innerHTML;
    btn.innerHTML = "Uploading...";
    btn.disabled = true;

    try {
        // We will hit a new endpoint: POST /campaigns/{id}/episodes/{id}/upload-grid
        // We use fetch directly to avoid apiFetch setting application/json
        const resp = await fetch(`${API}/campaigns/${currentCampaign.id}/episodes/${currentEpisode.id}/upload-grid`, {
            method: 'POST',
            body: formData
        });
        const res = await resp.json();
        
        if (resp.ok && res.success && res.image_url) {
            toast("Grid Image uploaded manually!", "success");
            let meta = typeof currentEpisode.metadata === 'string' ? JSON.parse(currentEpisode.metadata) : currentEpisode.metadata;
            meta.grid_image_url = res.image_url;
            currentEpisode.metadata = JSON.stringify(meta);
            loadStoryboardData(); // re-render panel
        } else {
            toast(res.error || "Failed to upload grid image", "error");
        }
    } catch (e) {
        toast("Upload error", "error");
    } finally {
        btn.innerHTML = oldText;
        btn.disabled = false;
        event.target.value = ''; // reset file input
    }
}

async function generateGridConcept() {
    if (!currentCampaign || !currentEpisode) return;
    
    let meta = {};
    try {
        if (currentEpisode.metadata) {
            meta = typeof currentEpisode.metadata === 'string' ? JSON.parse(currentEpisode.metadata) : currentEpisode.metadata;
        }
    } catch(e) {}
    
    if (!meta.master_grid_prompt) {
        toast("Master Grid Prompt not found. Please regenerate storyboard.", "error");
        return;
    }
    
    let profileName = "default";
    let engineName = "veo3";
    try {
        if (currentCampaign.metadata) {
            const cmeta = typeof currentCampaign.metadata === 'string' ? JSON.parse(currentCampaign.metadata) : currentCampaign.metadata;
            profileName = cmeta.browser_profile_name || cmeta.browser_profile || "default";
            engineName = cmeta.video_engine || "veo3";
        }
    } catch(e) {}
    
    const btn = document.getElementById('btnGenGrid');
    const oldText = btn.innerHTML;
    btn.innerHTML = `Generating via ${engineName === 'veo3' ? 'Veo3 4K' : 'Grok'}... (~2 min)`;
    btn.disabled = true;
    
    try {
        const res = await apiFetch(`/campaigns/${currentCampaign.id}/episodes/${currentEpisode.id}/generate-grid`, {
            method: 'POST',
            body: JSON.stringify({
                prompt: meta.master_grid_prompt,
                profile_name: profileName,
                engine: engineName
            })
        });
        
        if (res.success && res.image_url) {
            toast("Grid Image generated successfully!", "success");
            meta.grid_image_url = res.image_url;
            currentEpisode.metadata = JSON.stringify(meta);
            loadStoryboardData(); // re-render panel
        } else {
            toast(res.error || "Failed to generate grid", "error");
        }
    } catch (e) {
        toast("Error generating grid", "error");
    } finally {
        btn.innerHTML = oldText;
        btn.disabled = false;
    }
}

async function sliceGridConcept() {
    if (!currentCampaign || !currentEpisode) return;
    
    let meta = {};
    try {
        if (currentEpisode.metadata) {
            meta = typeof currentEpisode.metadata === 'string' ? JSON.parse(currentEpisode.metadata) : currentEpisode.metadata;
        }
    } catch(e) {}
    
    if (!meta.grid_image_url) {
        toast("No grid image found to slice.", "error");
        return;
    }
    
    const shotsCount = (window.currentRenderedShots || []).length;
    let cols = 3, rows = 4;
    
    if (shotsCount <= 4) { cols = 2; rows = 2; }
    else if (shotsCount <= 6) { cols = 3; rows = 2; }
    else if (shotsCount <= 8) { cols = 4; rows = 2; }
    else if (shotsCount <= 9) { cols = 3; rows = 3; }
    else if (shotsCount <= 12) { cols = 4; rows = 3; }
    else if (shotsCount <= 16) { cols = 4; rows = 4; }
    
    const input = window.prompt("Nhập tỷ lệ lưới để cắt ảnh (Cột x Dòng). Ví dụ: 3x4 hoặc 4x3", `${cols}x${rows}`);
    if (!input) return;
    
    const parts = input.split('x');
    if (parts.length === 2) {
        cols = parseInt(parts[0].trim());
        rows = parseInt(parts[1].trim());
    }
    
    const btn = document.getElementById('btnSliceGrid');
    const oldText = btn.innerHTML;
    btn.innerHTML = 'Slicing...';
    btn.disabled = true;
    
    try {
        const res = await apiFetch(`/campaigns/${currentCampaign.id}/episodes/${currentEpisode.id}/slice-grid`, {
            method: 'POST',
            body: JSON.stringify({
                image_url: meta.grid_image_url,
                cols: cols,
                rows: rows
            })
        });
        
        if (res.success) {
            toast(`Sliced into ${res.sliced_count} images successfully!`, "success");
            loadStoryboardData(); // re-render to show sliced images
        } else {
            toast(res.error || "Failed to slice grid", "error");
        }
    } catch (e) {
        toast("Error slicing grid", "error");
    } finally {
        btn.innerHTML = oldText;
        btn.disabled = false;
    }
}


