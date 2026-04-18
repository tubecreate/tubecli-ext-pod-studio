/**
 * Content Studio — Frontend Logic
 * Handles CRUD, SSE streaming, pipeline steps, and sidebar navigation.
 */

const API = '/api/v1/studio';

// ── State ──────────────────────────────────────────────────
let dramas = [];
let currentDrama = null;
let currentEpisode = null;
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
};

const PIPELINE_TEMPLATES = {
    drama_scene:  { label: '🎞 Drama Cinematic (Raw → Rewrite → Extract → Storyboard → Grok Video → Audio → Video)', steps: ['raw', 'rewrite', 'extract', 'storyboard', 'videos', 'audio', 'video'] },
    drama_full:   { label: '📺 Drama Slideshow',  steps: ['raw', 'rewrite', 'extract', 'storyboard', 'images', 'audio', 'video'] },
    audio_story:  { label: '🎧 Audio Story',      steps: ['raw', 'rewrite', 'audio', 'video'] },
    content_only: { label: '📝 Content Only',     steps: ['raw', 'rewrite'] },
    custom:       { label: '🎬 Custom',           steps: [] },
};

function getCurrentPipeline() {
    if (currentDrama) {
        try {
            const meta = JSON.parse(currentDrama.metadata || '{}');
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
    loadDramas();
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

// ── Drama CRUD ─────────────────────────────────────────────
async function loadDramas() {
    try {
        const data = await apiFetch('/dramas');
        dramas = data.items || [];
        renderSidebar();
        document.getElementById('projectCount').textContent = `${dramas.length} projects`;
        if (!dramas.length) {
            showWelcome();
        }
    } catch (e) {
        toast('Failed to load projects', 'error');
    }
}

window.showCreateDrama = function() {
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

async function wizSkipToManual() {
    const drama = await _createDramaFromWiz();
    if (drama) {
        hideWizard();
        toast('Project created! Welcome to manual mode.', 'success');
        await loadDramas();
        await selectDrama(drama.id);
    }
}

async function _createDramaFromWiz() {
    const title = document.getElementById('wizTitle').value.trim();
    const vStyle = document.getElementById('wizStyle').value;
    const cStyle = document.getElementById('wizCharacterStyle').value;
    const finalStyle = `Visual Style: ${vStyle} | Character Style: ${cStyle}`;
    
    const metadata = {};
    
    // Save pipeline config
    const pipeline = getWizPipeline();
    metadata.pipeline = pipeline;
    metadata.pipeline_template = document.getElementById('wizPipelineTemplate').value;
    metadata.camera_angle = document.getElementById('wizCameraAngle').value;
    metadata.ethnicity = document.getElementById('wizEthnicity').value;
    metadata.prompt_focus = document.getElementById('wizPromptFocus').value;

    try {
        return await apiFetch('/dramas', {
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
let pendingAutoPilotDramaId = null;

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
            languages: [document.getElementById('wizLanguage').value || "vi"]
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
            toast("Fetched YouTube subtitles successfully!", "success");
        } else {
            toast(data.message || "Failed to fetch YouTube subtitles", "error");
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
    const premise = document.getElementById('wizPremise').value.trim();
    if (!premise) { toast("Premise is required", "error"); return; }

    // Clear any previous error
    let errBox = document.getElementById('wizOutlineError');
    if (errBox) errBox.remove();

    toast("Creating project and generating outline...", "info");
    
    // Create drama first so we have an ID
    const drama = await _createDramaFromWiz();
    if (!drama) return;
    pendingAutoPilotDramaId = drama.id;
    
    const rawCount = parseInt(document.getElementById('wizEpisodes').value);
    const count = isNaN(rawCount) ? 1 : rawCount;
    
    const btn = document.querySelector('#wizStep2 .btn-primary');
    const oldHtml = btn.innerHTML;
    btn.innerHTML = 'Generating...';
    btn.disabled = true;

    try {
        const res = await apiFetch(`/dramas/${drama.id}/generate-outline`, {
            method: 'POST',
            body: JSON.stringify({ premise, episode_count: count })
        });
        
        document.getElementById('wizStep2').style.display = 'none';
        document.getElementById('wizStep3').style.display = '';
        
        // Load browser profiles into execution dropdown for new project
        _loadBrowserProfilesIntoSelect('wizBrowserProfileExec').then(() => {
            const sel = document.getElementById('wizBrowserProfileExec');
            const saved = localStorage.getItem('cs_last_browser_profile') || '';
            if (saved && sel) {
                for (let i = 0; i < sel.options.length; i++) {
                    if (sel.options[i].value === saved) {
                        sel.selectedIndex = i;
                        break;
                    }
                }
            }
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
                        bpLabel.textContent = '🌐 Browser Profile (Grok AI Gen)';
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

async function deleteDrama(dramaId, event) {
    if (event) event.stopPropagation();
    
    const confirmed = await customConfirm('⚠️ Xác nhận xoá', 'Delete this project? This cannot be undone.');
    if (!confirmed) return;
    
    try {
        await apiFetch(`/dramas/${dramaId}`, { method: 'DELETE' });
        toast('Project deleted', 'success');
        if (currentDrama && currentDrama.id === dramaId) {
            currentDrama = null;
            currentEpisode = null;
            showWelcome();
        }
        await loadDramas();
    } catch (e) {
        toast('Failed to delete: ' + e.message, 'error');
    }
}

async function selectDrama(dramaId) {
    try {
        currentDrama = await apiFetch(`/dramas/${dramaId}`);
        renderSidebar();
        // Auto-select first episode or create one
        if (currentDrama.episodes && currentDrama.episodes.length) {
            await selectEpisode(currentDrama.episodes[0].id);
        } else {
            await addEpisode(dramaId);
        }
    } catch (e) {
        toast('Failed to load project', 'error');
    }
}

// ── Episode CRUD ───────────────────────────────────────────
async function addEpisode(dramaId) {
    try {
        const ep = await apiFetch(`/dramas/${dramaId}/episodes`, {
            method: 'POST',
            body: JSON.stringify({}),
        });
        if (currentDrama) {
            currentDrama.episodes = currentDrama.episodes || [];
            currentDrama.episodes.push(ep);
        }
        // Also update the global dramas array so renderSidebar shows the new episode
        const dramaInList = dramas.find(d => d.id == dramaId);
        if (dramaInList) {
            dramaInList.episodes = dramaInList.episodes || [];
            dramaInList.episodes.push(ep);
        }
        await selectEpisode(ep.id);
        renderSidebar();
    } catch (e) {
        toast('Failed to create episode', 'error');
    }
}

async function selectEpisode(episodeId) {
    try {
        currentEpisode = await apiFetch(`/episodes/${episodeId}`);
        showEditor();
        renderSidebar();

        // Background fetch characters, scenes, and storyboards for this episode's project to persist the view
        if (currentDrama) {
            Promise.all([
                apiFetch(`/dramas/${currentDrama.id}/characters`),
                apiFetch(`/dramas/${currentDrama.id}/scenes`),
                apiFetch(`/episodes/${episodeId}/storyboards`)
            ]).then(([charRes, sceneRes, sbRes]) => {
                const characters = window.currentDramaCharacters = charRes.items || [];
                const scenes = window.currentDramaScenes = sceneRes.items || [];
                const storyboards = sbRes.items || [];

                // Render extract section using existing data
                if (characters.length > 0 || scenes.length > 0) {
                    document.getElementById('extractEmpty').style.display = 'none';
                    renderExtractResults({ characters, scenes });
                } else {
                    document.getElementById('extractEmpty').style.display = '';
                    document.getElementById('charsSection').style.display = 'none';
                    document.getElementById('scenesSection').style.display = 'none';
                }

                // Render storyboard section using existing data
                if (storyboards.length > 0) {
                    document.getElementById('storyboardEmpty').style.display = 'none';
                    renderStoryboard(storyboards);
                    document.getElementById('sbList').style.display = '';
                } else {
                    document.getElementById('storyboardEmpty').style.display = '';
                    document.getElementById('sbList').style.display = 'none';
                    document.getElementById('sbCount').textContent = '0 shots';
                }
            }).catch(e => {
                console.error("Failed to load project assets", e);
            });
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
    if (!dramas.length) {
        list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-3);font-size:12px">No projects yet</div>';
        return;
    }
    list.innerHTML = dramas.map(d => {
        const isActive = currentDrama && currentDrama.id === d.id;
        const eps = d.episodes || [];
        return `
            <div class="sidebar-project">
                <div class="sidebar-project-head ${isActive ? 'active' : ''}" onclick="selectDrama(${d.id})">
                    <span class="project-icon">🎬</span>
                    <span class="project-name">${esc(d.title)}</span>
                    <span class="project-ep-count">${eps.length}</span>
                    <button class="sidebar-delete-btn" onclick="deleteDrama(${d.id}, event)" title="Delete">
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
}

function showEditor() {
    document.getElementById('welcomeState').style.display = 'none';
    document.getElementById('editorState').style.display = '';

    // Populate header
    document.getElementById('editorTitle').textContent = currentDrama?.title || 'Untitled';
    document.getElementById('editorChip').textContent = `Episode ${currentEpisode?.episode_number || '?'}`;
    document.getElementById('metaChars').textContent = `${(currentDrama?.characters || []).length} characters`;
    document.getElementById('metaScenes').textContent = `${(currentDrama?.scenes || []).length} scenes`;

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

    // Render dynamic pipeline tabs for this drama
    renderPipelineNav();
    setStep('raw');
}

function goBack() {
    currentEpisode = null;
    currentDrama = null;
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

    // Step-specific triggers
    if (step === 'images') loadEpisodeImages();
    if (step === 'videos') loadEpisodeVideos();
    if (step === 'audio') loadEpisodeAudio();
    if (step === 'video') loadEpisodeVideo();
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
                drama_id: currentDrama?.id,
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
        toast('Rewrite complete!', 'success');
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

// ── Extract (Characters & Scenes) ──────────────────────────
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
                    }
                    if (parsed.event === 'progress' && parsed.content) {
                        exCharCount += parsed.content.length;
                        const cEl = document.getElementById('exProgressChars');
                        if (cEl) cEl.textContent = exCharCount;
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

            // Refresh drama data for header counters and global list
            if (currentDrama) {
                const [d, charRes, sceneRes] = await Promise.all([
                    apiFetch(`/dramas/${currentDrama.id}`),
                    apiFetch(`/dramas/${currentDrama.id}/characters`),
                    apiFetch(`/dramas/${currentDrama.id}/scenes`)
                ]);
                currentDrama = d;
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
            throw new Error("No data extracted");
        }
    } catch (e) {
        if (e.name === 'AbortError' || e.message === 'Aborted by user') {
            toast("Extraction aborted by user.", "info");
            throw e;
        }
        const loadEl = document.getElementById('extractLoading');
        if (loadEl) loadEl.remove();
        document.getElementById('extractEmpty').style.display = '';
        toast(`Extraction failed: ${e.message}`, 'error');
        throw e;
    } finally {
        isStreaming = false;
        document.getElementById('btnExtract').disabled = false;
    }
}

function renderExtractResults(data) {
    const characters = data.characters || [];
    const scenes = data.scenes || [];

    // Characters section
    const charsSection = document.getElementById('charsSection');
    const charsGrid = document.getElementById('charsGrid');
    const charsCount = document.getElementById('charsCount');

    if (characters.length > 0) {
        charsSection.style.display = '';
        charsCount.textContent = characters.length;
        charsGrid.innerHTML = characters.map(c => {
            const roleColors = {
                protagonist: 'var(--accent)',
                deuteragonist: '#10b981',
                supporting: '#f59e0b',
                minor: 'var(--text-2)',
                extra: 'var(--text-3)',
            };
            const roleColor = roleColors[c.role] || 'var(--text-2)';
            return `
                <div class="extract-card">
                    <div class="extract-card-head">
                        <div class="extract-card-avatar">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                        </div>
                        <div>
                            <div class="extract-card-name">${esc(c.name)}</div>
                            <span class="tag" style="background:${roleColor};color:#fff;font-size:10px;padding:1px 6px">${esc(c.role)}</span>
                        </div>
                    </div>
                    ${c.appearance ? `<div class="extract-card-field"><span class="field-icon">👤</span><span>${esc(c.appearance)}</span></div>` : ''}
                    ${c.personality ? `<div class="extract-card-field"><span class="field-icon">💡</span><span>${esc(c.personality)}</span></div>` : ''}
                    ${c.description ? `<div class="extract-card-field"><span class="field-icon">📝</span><span>${esc(c.description)}</span></div>` : ''}
                </div>
            `;
        }).join('');
    }

    // Scenes section
    const scenesSection = document.getElementById('scenesSection');
    const scenesGrid = document.getElementById('scenesGrid');
    const scenesCount = document.getElementById('scenesCount');

    if (scenes.length > 0) {
        scenesSection.style.display = '';
        scenesCount.textContent = scenes.length;
        scenesGrid.innerHTML = scenes.map(s => `
            <div class="extract-card">
                <div class="extract-card-head">
                    <div class="extract-card-avatar" style="background:rgba(16,185,129,.15);color:#10b981">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                    </div>
                    <div>
                        <div class="extract-card-name">${esc(s.location)}</div>
                        ${s.time ? `<span class="extract-card-time">${esc(s.time)}</span>` : ''}
                    </div>
                </div>
                ${s.description ? `<div class="extract-card-field"><span class="field-icon">🎭</span><span>${esc(s.description)}</span></div>` : ''}
                ${s.prompt ? `<div class="extract-card-field" style="font-family:var(--font-mono);font-size:11px;color:var(--text-3)"><span class="field-icon">🖼️</span><span>${esc(s.prompt)}</span></div>` : ''}
            </div>
        `).join('');
    }

    // Update extract count
    document.getElementById('extractCount').textContent = `${characters.length} characters · ${scenes.length} scenes`;
}

// ── Storyboard Breakdown ───────────────────────────────────
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

function renderStoryboard(shots) {
    window.currentRenderedShots = shots;
    const sbList = document.getElementById('sbList');
    sbList.style.display = '';

    document.getElementById('sbCount').textContent = `${shots.length} shots`;

    sbList.innerHTML = shots.map((s, i) => {
        const num = String(i + 1).padStart(2, '0');
        const shotMeta = [s.shot_type, s.angle, s.movement].filter(Boolean).join(' · ');
        const chars = (s.character_names || []).join(', ');
        const dur = s.duration || 12;

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
                    </div>
                    <div class="sb-detail" style="display:none">
                        ${s.dialogue ? `<div class="sb-field"><span class="sb-field-label">💬 Dialogue</span><div class="sb-field-value">${esc(s.dialogue)}</div></div>` : ''}
                        ${s.description ? `<div class="sb-field"><span class="sb-field-label">📝 Description</span><div class="sb-field-value">${esc(s.description)}</div></div>` : ''}
                        ${s.result ? `<div class="sb-field"><span class="sb-field-label">🎯 Result</span><div class="sb-field-value">${esc(s.result)}</div></div>` : ''}
                        ${s.atmosphere ? `<div class="sb-field"><span class="sb-field-label">🌙 Atmosphere</span><div class="sb-field-value">${esc(s.atmosphere)}</div></div>` : ''}
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
    const chars = window.currentDramaCharacters || [];
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
    const scenes = window.currentDramaScenes || [];
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
                drama_id: currentDrama?.id,
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
        
        const targetLang = (typeof currentDrama !== 'undefined' && currentDrama && currentDrama.language) 
            ? currentDrama.language.toLowerCase() 
            : null;
            
        let hasProfiles = false;
        window.ttsVoicesCache.forEach(v => {
            if (targetLang && targetLang !== 'auto') {
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
            else vibeHtml += optionHtml;
        });
        edgeHtml += '</optgroup>';
        vibeHtml += '</optgroup>';
        
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
    if (!pendingAutoPilotDramaId) return;
    try {
        await apiFetch(`/dramas/${pendingAutoPilotDramaId}/start-autopilot`, { method: 'POST' });
        
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
    if (!pendingAutoPilotDramaId) return;
    try {
        const res = await apiFetch(`/dramas/${pendingAutoPilotDramaId}/autopilot-status`);
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
    if (!currentDrama) return;
    pendingAutoPilotDramaId = currentDrama.id;
    window.pendingAutoPilotIsResume = true;
    
    let outline;
    try { outline = JSON.parse(currentDrama.metadata).series_outline; } catch(e) {}
    
    if (outline && outline.episodes) {
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
        
        // Load browser profiles into execution dropdown
        _loadBrowserProfilesIntoSelect('wizBrowserProfileExec').then(() => {
            const sel = document.getElementById('wizBrowserProfileExec');
            const saved = localStorage.getItem('cs_last_browser_profile') || '';
            if (saved && sel) {
                for (let i = 0; i < sel.options.length; i++) {
                    if (sel.options[i].value === saved) {
                        sel.selectedIndex = i;
                        break;
                    }
                }
            }
        });
        
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
                        bpLabel.textContent = '🌐 Browser Profile (Grok AI Gen)';
                    }
                }
                const targetLan = (typeof currentDrama !== 'undefined' && currentDrama && currentDrama.language) 
                                    ? currentDrama.language 
                                    : (document.getElementById('wizLanguage') ? document.getElementById('wizLanguage').value : null);
                _loadVoiceProfilesIntoSelect('wizVoiceProfileExec', targetLan);
            } else {
                vWrap.style.display = 'none';
            }
        }
    } else {
        toast("No auto-generated outline exists for this project.", "error");
    }
}

// ── REALTIME VISUAL AUTO PILOT ─────────────────────────────
let isAutoPilotRunning = false;
async function startRealtimeAutoPilot() {
    if (!pendingAutoPilotDramaId) return;
    if (isAutoPilotRunning) return;
    
    // Save selected profiles from wizard to localStorage + drama metadata
    const wizProfileSel = document.getElementById('wizBrowserProfileExec');
    const selectedProfile = wizProfileSel ? wizProfileSel.value : '';
    const wizVoiceSel = document.getElementById('wizVoiceProfileExec');
    let selectedVoice = wizVoiceSel ? wizVoiceSel.value : '';
    
    if (wizVoiceSel && wizVoiceSel.selectedIndex >= 0 && selectedVoice) {
        const engineAttr = wizVoiceSel.options[wizVoiceSel.selectedIndex].getAttribute('data-engine') || 'edge';
        if (!selectedVoice.includes('|')) {
            selectedVoice = `${selectedVoice}|${engineAttr}`;
        }
    }
    
    if (selectedProfile || selectedVoice) {
        if (selectedProfile) localStorage.setItem('cs_last_browser_profile', selectedProfile);
        if (selectedVoice) localStorage.setItem('cs_last_voice_profile', selectedVoice);
        
        // Persist to drama metadata so auto-pilot execution functions find them
        try {
            const dramaData = await apiFetch(`/dramas/${pendingAutoPilotDramaId}`);
            const meta = JSON.parse(dramaData.metadata || '{}');
            if (selectedProfile) meta.browser_profile_name = selectedProfile;
            
            const vWrap = document.getElementById('wizVoiceProfileWrap');
            if (selectedVoice && vWrap && vWrap.style.display !== 'none') {
                meta.voice_preset = selectedVoice;
                if (wizVoiceSel.selectedIndex >= 0) {
                    const opt = wizVoiceSel.options[wizVoiceSel.selectedIndex];
                    meta.tts_engine = opt.getAttribute('data-engine') || 'vibe';
                }
            }
            
            await apiFetch(`/dramas/${pendingAutoPilotDramaId}`, {
                method: 'PUT',
                body: JSON.stringify({ metadata: JSON.stringify(meta) })
            });
        } catch(e) { console.warn('Could not save profile to drama metadata', e); }
    }
    
    isAutoPilotRunning = true;
    
    hideWizard();
    
    // Refresh sidebar data so the newly created project appears
    await loadDramas();
    
    // Load Drama into the workspace
    await selectDrama(pendingAutoPilotDramaId);
    
    // Verify an outline exists
    if (!currentDrama || !currentDrama.metadata) return;
    let outline;
    try { 
        outline = JSON.parse(currentDrama.metadata).series_outline; 
    } catch(e) {}
    if (!outline || !outline.episodes) {
        toast("No outline found to run.", "error"); return;
    }
    
    realtimeAbortController = new AbortController();
    document.getElementById('floatStopBtn').style.display = 'flex';
    
    toast("Starting Visual Auto-Pilot Sequence...", "info");

    const pipeline = getCurrentPipeline();
    
    try {
        let startIndex = 0;
        const isResume = !!window.pendingAutoPilotIsResume;
        window.pendingAutoPilotIsResume = false;
        if (isResume && typeof currentEpisode !== 'undefined' && currentEpisode) {
            let foundIdx = outline.episodes.findIndex((epPlan, idx) => (epPlan.episode_number || idx + 1) === currentEpisode.episode_number);
            if (foundIdx >= 0) {
                startIndex = foundIdx;
                toast(`🚀 Auto-Pilot resuming directly from Episode ${currentEpisode.episode_number}...`, "info");
            }
        }
        
        for (let i = startIndex; i < outline.episodes.length; i++) {
            const epPlan = outline.episodes[i];
            let success = false;
            let isRetry = false;
            
            while (!success) {
                if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                
                try {
                    // 1. Ensure episode exists in UI
                    let ep = currentDrama.episodes.find(e => e.episode_number === (epPlan.episode_number || i+1));
                    if (!ep) {
                        // we technically need to add an episode
                        await addEpisode(currentDrama.id);
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
                    if (pipeline.includes('extract')) {
                    setStep('extract');
                    
                    // Check if extract data already exists
                    let hasExtractData = epMeta.extract_completed;
                    if (!hasExtractData && currentDrama) {
                        try {
                            const [charRes, sceneRes] = await Promise.all([
                                apiFetch(`/dramas/${currentDrama.id}/characters`),
                                apiFetch(`/dramas/${currentDrama.id}/scenes`)
                            ]);
                            hasExtractData = (charRes.items || []).length > 0 || (sceneRes.items || []).length > 0;
                        } catch(e) {}
                    }
                    
                    if (hasExtractData && !isRetry) {
                        toast(`Skipping Extract for ${currentEpisode.title} (data already exists)`, "info");
                    } else {
                        await doExtract();
                    }
                    }
                    if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                    
                    // 5. Storyboard (skip if not in pipeline)
                    if (pipeline.includes('storyboard')) {
                    await new Promise(r => setTimeout(r, 2000));
                    setStep('storyboard');
                    
                    let existingShots = [];
                    try {
                        const sbRes = await apiFetch(`/episodes/${currentEpisode.id}/storyboards`);
                        existingShots = sbRes.items || [];
                    } catch(e) {}
                    
                    if ((existingShots.length > 0 || epMeta.storyboard_completed) && !isRetry) {
                        toast(`Skipping Storyboard for ${currentEpisode.title} (${existingShots.length} shots exist)`, "info");
                        if (existingShots.length > 0) renderStoryboard(existingShots);
                    } else if (existingShots.length > 0 && isRetry) {
                        toast(`Resuming Storyboard generation from shot ${existingShots.length + 1}...`, "info");
                        await doBreakdown(true);
                    } else {
                        await doBreakdown(false);
                    }
                    
                    if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                    }
                    
                    // 6. Image Generation via Grok (skip if not in pipeline)
                    if (pipeline.includes('images')) {
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
                            const dramaMeta = JSON.parse(currentDrama.metadata || '{}');
                            browserProfile = dramaMeta.browser_profile_name || dramaMeta.browser_profile_path || '';
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
                                document.getElementById('imagesEmpty').style.display = 'none';
                                document.getElementById('imgProgressSection').style.display = 'block';
                                document.getElementById('imgProgressSection').style.border = '';
                                document.getElementById('imgProgressBar').style.width = '0%';
                                document.getElementById('imgProgressCount').textContent = `0 / ${genRes.total || 1}`;
                                document.getElementById('imgProgressLabel').textContent = 'Generating images...';
                                
                                await _waitForImageGenCompletion(genRes.task_id, genRes.total);
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
                        let browserProfile = '';
                        try {
                            const dramaMeta = JSON.parse(currentDrama.metadata || '{}');
                            browserProfile = dramaMeta.browser_profile_name || dramaMeta.browser_profile_path || '';
                        } catch(e) {}
                        if (!browserProfile) browserProfile = localStorage.getItem('cs_last_browser_profile') || '';
                        
                        if (!browserProfile) {
                            toast(`⚠️ No browser profile set — skipping video gen for ${currentEpisode.title}`, "warning");
                        } else {
                            toast(`🎞 Auto Grok video gen: ${pendingVidShots.length} shots for ${currentEpisode.title}`, "info");
                            
                            const genRes = await apiFetch(`/episodes/${currentEpisode.id}/gen-videos`, {
                                method: 'POST',
                                body: JSON.stringify({ profile_name: browserProfile, headless: false, overwrite: false })
                            });
                            
                            if (genRes.success) {
                                document.getElementById('videosEmpty').style.display = 'none';
                                document.getElementById('vidProgressSection').style.display = 'block';
                                document.getElementById('vidProgressSection').style.border = '';
                                document.getElementById('vidProgressBar').style.width = '0%';
                                document.getElementById('vidProgressCount').textContent = `0 / ${genRes.total || 1}`;
                                document.getElementById('vidProgressLabel').textContent = 'Generating videos...';
                                
                                await _waitForVideoGenCompletion(genRes.task_id, genRes.total);
                            }
                        }
                    }
                    if (realtimeAbortController && realtimeAbortController.signal.aborted) throw new Error("Aborted by user");
                    }

                    // 6+. Audio Generation (TTS) explicitly in step 6
                    if (pipeline.includes('audio')) {
                        await new Promise(r => setTimeout(r, 2000));
                        setStep('audio');
                        if (currentEpisode.audio_url && !isRetry) {
                            toast(`⏭️ Skipping Audio TTS for ${currentEpisode.title}`, "info");
                            document.getElementById('audioStatus').textContent = 'Audio ready';
                            document.getElementById('audioEmpty').style.display = 'none';
                            document.getElementById('audioPlayerSection').style.display = 'flex';
                            document.getElementById('audioStepPlayer').src = currentEpisode.audio_url;
                            document.getElementById('audioStepDownload').href = currentEpisode.audio_url;
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
                            
                            const audioUrl = await _generateVideoTTS(voiceId, engine);
                            
                            if (audioUrl) {
                                currentEpisode.audio_url = audioUrl;
                                await apiFetch(`/episodes/${currentEpisode.id}`, {
                                    method: 'PUT',
                                    body: JSON.stringify({ audio_url: audioUrl })
                                }).catch(()=>{});
                                document.getElementById('audioEmpty').style.display = 'none';
                                document.getElementById('audioPlayerSection').style.display = 'flex';
                                document.getElementById('audioStepPlayer').src = audioUrl;
                                document.getElementById('audioStepDownload').href = audioUrl;
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
                    
                    toast(`✅ Finished Auto-Pilot for Episode ${epPlan.episode_number || i+1}`, "success");
                    await new Promise(r => setTimeout(r, 3000)); // wait before next episode
                    
                    success = true; // Iteration completed successfully
                    
                } catch (err) {
                    if (err.message === "Aborted by user") throw err;
                    
                    // Show error recovery modal
                    const choice = await showErrorDialog(`Failed on Episode ${epPlan.episode_number || i+1}: ${err.message}`);
                    if (choice === 'cancel') {
                        throw new Error("Aborted by user");
                    } else if (choice === 'skip') {
                        toast("Skipping to next episode...", "info");
                        break; // Exit the while loop and proceed to next episode (i++)
                    } else if (choice === 'retry') {
                        toast("Retrying episode...", "info");
                        isRetry = true;
                        // success remains false, so while loop repeats
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
        await loadDramas();
    }
}

function abortRealtimeStream() {
    if (realtimeAbortController) {
        realtimeAbortController.abort();
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
                drama_id: currentDrama?.id,
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
                    if (parsed.content) {
                        fullText += parsed.content;
                        area.value = fullText;
                        area.scrollTop = area.scrollHeight;
                        document.getElementById(countId).textContent = `${fullText.length} chars (Typing...)`;
                    }
                } catch (e) {}
            }
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
            // Auto-select if drama already has a saved profile
            if (currentDrama) {
                try {
                    const meta = JSON.parse(currentDrama.metadata || '{}');
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
        
        let hasProfiles = false;
        window.ttsVoicesCache.forEach(v => {
            if (targetLang) {
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
            else vibeHtml += optionHtml;
        });
        
        if (!hasProfiles && targetLang) {
            sel.innerHTML = '<option value="">(Không tìm thấy giọng: ' + targetLang + ')</option>';
            return;
        }
        
        edgeHtml += '</optgroup>';
        vibeHtml += '</optgroup>';
        sel.innerHTML = vibeHtml + edgeHtml;
        
        // Auto-select if drama already has a saved voice
        const saved = localStorage.getItem('cs_last_voice_profile') || '';
        let hasSelected = false;
        if (typeof currentDrama !== 'undefined' && currentDrama) {
            try {
                const meta = JSON.parse(currentDrama.metadata || '{}');
                if (meta.voice_preset) {
                    for (let i = 0; i < sel.options.length; i++) {
                        if (sel.options[i].value === meta.voice_preset) {
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

    // Pre-select saved profile: drama metadata first, then localStorage fallback
    const sel = document.getElementById('genImgProfile');
    let savedProfile = '';
    if (currentDrama) {
        try { savedProfile = JSON.parse(currentDrama.metadata || '{}').browser_profile_name || ''; } catch(e) {}
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

    // Save profile name to drama metadata + localStorage for global recall
    localStorage.setItem('cs_last_browser_profile', profilePath);
    if (currentDrama) {
        try {
            const meta = JSON.parse(currentDrama.metadata || '{}');
            meta.browser_profile_name = profilePath;
            await apiFetch(`/dramas/${currentDrama.id}`, {
                method: 'PUT',
                body: JSON.stringify({ metadata: JSON.stringify(meta) })
            });
            currentDrama.metadata = JSON.stringify(meta);
        } catch(e) { console.warn('Could not save profile to drama', e); }
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
                break;
            }
        } catch(e) {
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
            const imgSrc = `/api/v1/studio/grok-image/${filename}`;
            return `
                <div style="border-radius:8px; overflow:hidden; background:var(--bg-1); border:1px solid var(--border); position:relative;">
                    <img src="${imgSrc}" alt="Shot ${s.storyboard_number}"
                        style="width:100%; aspect-ratio:16/9; object-fit:cover; display:block;"
                        onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
                    />
                    <div style="display:none; width:100%; aspect-ratio:16/9; align-items:center; justify-content:center; color:var(--text-3); font-size:11px;">No image</div>
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

async function openGenVideosDialog() {
    if (!currentEpisode) { toast('No episode selected', 'error'); return; }

    await _loadBrowserProfilesIntoSelect('genVidProfile');

    const sel = document.getElementById('genVidProfile');
    let savedProfile = '';
    if (currentDrama) {
        try { savedProfile = JSON.parse(currentDrama.metadata || '{}').browser_profile_name || ''; } catch(e) {}
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

    try {
        const sbRes = await apiFetch(`/episodes/${currentEpisode.id}/storyboards`);
        const shots = sbRes.items || [];
        const pending = shots.filter(s => s.image_prompt && !s.video_url);
        document.getElementById('genVidShotCount').textContent = `${pending.length} shots pending (${shots.length} total)`;
    } catch(e) {
        document.getElementById('genVidShotCount').textContent = '?? shots';
    }

    document.getElementById('genVideosModal').style.display = 'flex';
}

async function startGrokVideoGen() {
    const profilePath = document.getElementById('genVidProfile').value;
    const errEl = document.getElementById('genVidError');
    
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

    const overwrite = document.getElementById('genVidMode').value === 'all';
    const headless = document.getElementById('genVidHeadless').checked;

    localStorage.setItem('cs_last_browser_profile', profilePath);
    if (currentDrama) {
        try {
            const meta = JSON.parse(currentDrama.metadata || '{}');
            meta.browser_profile_name = profilePath;
            await apiFetch(`/dramas/${currentDrama.id}`, {
                method: 'PUT',
                body: JSON.stringify({ metadata: JSON.stringify(meta) })
            });
            currentDrama.metadata = JSON.stringify(meta);
        } catch(e) {}
    }

    const btn = document.getElementById('btnStartGenVid');
    if (btn) { btn.disabled = true; btn.textContent = 'Starting...'; }

    try {
        const res = await apiFetch(`/episodes/${currentEpisode.id}/gen-videos`, {
            method: 'POST',
            body: JSON.stringify({ profile_name: profilePath, headless, overwrite })
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
            document.getElementById('vidProgressLabel').textContent = 'Khởi tạo Grok Video...';
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
                break;
            }
        } catch(e) {
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
                    const vidSrc = `/api/v1/studio/grok-video/${filename}`;
                    
                    if (card.dataset.state !== 'video' || card.dataset.src !== vidSrc) {
                        card.dataset.state = 'video';
                        card.dataset.src = vidSrc;
                        card.innerHTML = `
                            <div style="border-radius:8px; overflow:hidden; background:var(--bg-1); border:1px solid var(--border); position:relative;">
                                <video src="${vidSrc}" controls loop muted preload="metadata"
                                    style="width:100%; aspect-ratio:16/9; object-fit:cover; display:block;"
                                    onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
                                ></video>
                                <div style="display:none; width:100%; aspect-ratio:16/9; align-items:center; justify-content:center; color:var(--text-3); font-size:11px;">No video</div>
                                <div style="padding:6px 8px; font-size:11px; color:var(--text-2);">
                                    <strong>Shot #${s.storyboard_number}</strong>${s.title ? ' — ' + esc(s.title) : ''}
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
                            <div style="width:100%; aspect-ratio:16/9; display:flex; flex-direction:column; align-items:center; justify-content:center; background:var(--bg-2);">
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
    } catch(e) { console.error('loadEpisodeVideos error', e); }
}

// ── Audio Step ─────────────────────────────────────────────
function loadEpisodeAudio() {
    const empty = document.getElementById('audioEmpty');
    const player = document.getElementById('audioPlayerSection');
    const statusEl = document.getElementById('audioStatus');
    
    if (currentEpisode && currentEpisode.audio_url) {
        empty.style.display = 'none';
        player.style.display = 'flex';
        document.getElementById('audioStepPlayer').src = currentEpisode.audio_url;
        document.getElementById('audioStepDownload').href = currentEpisode.audio_url;
        statusEl.textContent = '✅ Audio ready';
    } else {
        empty.style.display = '';
        player.style.display = 'none';
        statusEl.textContent = 'No audio';
    }
}

function openAudioGenStep() {
    // Reuse existing audio gen modal
    generateRawAudio();
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
        toast("Audio deleted successfully. You can now regenerate.", "success");
        // Refresh UI
        document.getElementById('audioPlayerSection').style.display = 'none';
        document.getElementById('audioEmpty').style.display = 'flex';
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
                    ttsVoicesCache.forEach(v => {
                        const langPart = v.language_name || v.language;
                        const namePart = v.name;
                        const genderPart = v.gender ? ` (${v.gender})` : '';
                        const optionHtml = `<option value="${v.id}" data-engine="${v.engine}">${langPart} - ${namePart}${genderPart}</option>`;
                        if (v.engine === 'edge') edgeHtml += optionHtml;
                        else vibeHtml += optionHtml;
                    });
                    edgeHtml += '</optgroup>';
                    vibeHtml += '</optgroup>';
                    select.innerHTML = vibeHtml + edgeHtml;
                    
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
    progress.style.display = 'flex';
    buildBar.style.width = '0%';
    buildLabel.textContent = 'Starting FFmpeg export...';
    buildCount.textContent = '';

    try {
        const res = await apiFetch(`/episodes/${currentEpisode.id}/export-ffmpeg`, { method: 'POST' });
        if (res.success) {
            toast('FFmpeg assembly started', 'info');
            
            _ffmpegPollTimer = setInterval(async () => {
                try {
                    const statusRes = await apiFetch(`/export-ffmpeg/status/${res.task_id}`);
                    if (!statusRes.success) {
                        clearInterval(_ffmpegPollTimer);
                        buildLabel.textContent = '⚠️ Lỗi: Không thể check tiến độ FFmpeg';
                        return;
                    }
                    
                    const pct = statusRes.done || 0;
                    buildBar.style.width = `${pct}%`;
                    buildLabel.textContent = statusRes.current_shot || `Assembling... ${pct}%`;
                    
                    if (statusRes.status === 'completed' || statusRes.status.startsWith('error')) {
                        clearInterval(_ffmpegPollTimer);
                        if (statusRes.status.startsWith('error')) {
                            buildLabel.textContent = `❌ ${statusRes.status}`;
                            toast(`FFmpeg Error: ${statusRes.status}`, 'error');
                        } else {
                            buildLabel.textContent = '✅ FFmpeg export complete!';
                            toast('Video Assembly Complete!', 'success');
                            
                            // Load the episode to update the UI with new video_url
                            await selectEpisode(currentEpisode.id);
                        }
                    }
                } catch(e) { console.warn('poll error', e); }
            }, 3000);
            
            // Auto-pilot wait loop hook
            if (isAutoPilotRunning) {
                return new Promise((resolve, reject) => {
                    const checkInterval = setInterval(() => {
                        if (realtimeAbortController && realtimeAbortController.signal.aborted) {
                            clearInterval(checkInterval);
                            clearInterval(_ffmpegPollTimer);
                            reject(new Error("Aborted by user"));
                        }
                        if (!_ffmpegPollTimer) {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 3000);
                });
            }

        } else {
            toast(res.detail || res.message || 'Error starting export', 'error');
            progress.style.display = 'none';
            empty.style.display = 'flex';
        }
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
                src: `/api/v1/studio/grok-image/${filename}`,
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

async function _generateVideoTTS(voiceId, engine) {
    // Generate intelligent script from storyboard instead of reading Raw Markdown
    let text = "";
    
    if (currentEpisode) {
        try {
            const sbRes = await apiFetch(`/episodes/${currentEpisode.id}/storyboards`);
            const shots = sbRes.items || [];
            if (shots.length > 0) {
                text = shots.map(s => s.dialogue || s.description || "").filter(t => t.trim().length > 0).join('. ');
            }
        } catch(e) {
            console.warn("Failed to fetch storyboards for TTS, falling back.", e);
        }
    }
    
    if (!text && window.videoSlides && window.videoSlides.length > 0) {
        text = window.videoSlides.map(s => s.dialogue || s.description || "").filter(t => t.trim().length > 0).join('. ');
    }
    if (!text) text = document.getElementById('rawTextarea').value.trim();
    if (!text && currentEpisode) text = currentEpisode.raw_content;
    
    if (!text) { toast("Không có nội dung kịch bản để tạo audio.", "warning"); return null; }
    
    if (!voiceId) {
        voiceId = 'hmy';
        engine = 'vibe';
    }
    
    
    // Show loading state: hide button, show spinner
    const _btnGen = document.getElementById('btnAudioGenerate');
    const _btnGenTop = document.getElementById('btnGenAudioStep');
    const _spinner = document.getElementById('audioSpinner');
    const _emptyVisual = document.getElementById('audioEmptyVisual');
    const _emptyTitle = document.getElementById('audioEmptyTitle');
    if (_btnGen) _btnGen.style.display = 'none';
    if (_btnGenTop) _btnGenTop.disabled = true;
    if (_spinner) _spinner.style.display = 'block';
    if (_emptyVisual) _emptyVisual.style.display = 'none';
    if (_emptyTitle) _emptyTitle.textContent = '🔊 Generating Audio...';
    
    try {
        const res = await apiFetch('/../tts/synthesize', {
            method: 'POST',
            body: JSON.stringify({ text: text, voice: voiceId, engine: engine })
        });
        if (!res.success || !res.task_id) return null;
        
        while(true) {
            await new Promise(r => setTimeout(r, 2000));
            const st = await apiFetch(`/../tts/status/${res.task_id}`);
            if(!st.success) throw new Error("Status check failed or returned unsuccessful.");
            
            // Provide UI feedback since VibeVoice takes a long time
            const countEl = document.getElementById('videoBuildCount');
            const audioStatusEl = document.getElementById('audioStatus');
            const progContainer = document.getElementById('audioProgressContainer');
            const progBar = document.getElementById('audioProgressBar');
            const progText = document.getElementById('audioProgressText');
            
            let txt = '';
            if (st.status === 'loading_model') {
                txt = 'Loading AI Voice Model (may take 30-60s)...';
                if (progContainer) progContainer.style.display = 'flex';
            }
            else if (st.status === 'processing') {
                txt = `Synthesizing Speech (${st.progress || 0}%)...`;
                if (progContainer) progContainer.style.display = 'flex';
                if (progBar) progBar.style.width = (st.progress || 0) + '%';
                if (progText) progText.textContent = (st.progress || 0) + '%';
            }
            else if (st.status === 'stitching') {
                txt = 'Stitching Audio Tracks...';
                if (progBar) progBar.style.width = '95%';
                if (progText) progText.textContent = 'Stitching...';
            }
            else if (st.status === 'error') {
                throw new Error(`Backend TTS generation failed: ${st.result?.message || 'Unknown'}`);
            }
            
            if (txt) {
                if (countEl) countEl.textContent = txt;
                if (audioStatusEl) audioStatusEl.textContent = txt;
                if (_emptyTitle) _emptyTitle.textContent = txt;
                const descEl = document.getElementById('audioEmptyDesc');
                if (descEl) descEl.textContent = txt;
            }

            if(st.status === 'success') {
                if (progBar) progBar.style.width = '100%';
                if (progText) progText.textContent = '100% (Complete)';
                if (_emptyTitle) _emptyTitle.textContent = '✅ Audio Complete!';
                
                // Restore UI
                if (_spinner) _spinner.style.display = 'none';
                if (_btnGenTop) _btnGenTop.disabled = false;
                
                let filename = (st.result.output || "").split(/[\\/]/).pop();
                if(filename) return `/api/v1/tts/audio/${filename}`;
                throw new Error("Success status but no output filename found.");
            }
        }
    } catch(e) {
        console.error("TTS Generation Exception:", e);
        // Restore UI on error
        const _btnGenErr = document.getElementById('btnAudioGenerate');
        const _btnGenTopErr = document.getElementById('btnGenAudioStep');
        const _spinnerErr = document.getElementById('audioSpinner');
        const _emptyVisualErr = document.getElementById('audioEmptyVisual');
        const _emptyTitleErr = document.getElementById('audioEmptyTitle');
        if (_btnGenErr) _btnGenErr.style.display = '';
        if (_btnGenTopErr) _btnGenTopErr.disabled = false;
        if (_spinnerErr) _spinnerErr.style.display = 'none';
        if (_emptyVisualErr) _emptyVisualErr.style.display = '';
        if (_emptyTitleErr) _emptyTitleErr.textContent = 'Generate Audio (TTS)';
        throw new Error(`TTS Generation Exception: ${e.message}`);
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

