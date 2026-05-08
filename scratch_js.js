
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
    if (boardChars.length === 0) boardChars = chars.slice(0, 3); // Fallback to main chars

    // Z2: Environment (use the first scene for now, or match by scene_heading)
    const scene = scenes.length > 0 ? scenes[0] : null;

    // Z5, Z6, Z8: Extract from scene
    const lighting = scene && scene.lighting_style ? scene.lighting_style : 'Natural / Cinematic';
    const emotions = scene && scene.mood ? scene.mood.split(',').map(m => m.trim()) : ['Dramatic', 'Intense'];
    const props = scene && scene.material_refs ? scene.material_refs.split(',').map(m => m.trim()) : [];

    container.innerHTML = `
        <!-- Zone 1: Characters -->
        <div class="pb-zone pb-z1">
            <div class="pb-zone-header">
                <span class="pb-zh-cn">角色+造型设定</span>
                <span class="pb-zh-en">CHARACTER + STYLING</span>
            </div>
            <div class="pb-char-list">
                ${boardChars.map(c => `
                    <div class="pb-char-item">
                        <img src="${c.image_url ? '/gallery/image/' + encodeURIComponent(c.image_url) : ''}" class="pb-char-img" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'48\\' height=\\'64\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'%23666\\' stroke-width=\\'2\\'%3E%3Ccircle cx=\\'12\\' cy=\\'8\\' r=\\'5\\'/%3E%3Cpath d=\\'M20 21a8 8 0 0 0-16 0\\'/%3E%3C/svg%3E'">
                        <div class="pb-char-info">
                            <div class="pb-char-name">${esc(c.name)}</div>
                            <div class="pb-char-role">${esc(c.role || 'Model')}</div>
                        </div>
                    </div>
                `).join('') || '<div style="color:#64748b;font-size:12px;">No characters assigned</div>'}
            </div>
        </div>

        <!-- Zone 2: Environment -->
        <div class="pb-zone pb-z2">
            <div class="pb-zone-header">
                <span class="pb-zh-cn">环境与场景设计</span>
                <span class="pb-zh-en">ENVIRONMENT & SCENE</span>
            </div>
            ${scene ? `
                <div class="pb-env-view">
                    <div class="pb-env-img-wrap">
                        ${scene.image_url ? `<img src="/gallery/image/${encodeURIComponent(scene.image_url)}" class="pb-env-img">` : '<div style="width:100%;height:100%;background:#1e293b;display:flex;align-items:center;justify-content:center;color:#475569;">No Image</div>'}
                        <div class="pb-env-name">${esc(scene.name)}</div>
                    </div>
                    <div class="pb-env-desc">${esc(scene.description || scene.location)}</div>
                </div>
            ` : '<div style="color:#64748b;font-size:12px;">No scene data available</div>'}
        </div>

        <!-- Zone 3: Storyboard Panels -->
        <div class="pb-zone pb-z3">
            <div class="pb-zone-header">
                <span class="pb-zh-cn">分镜板 (${shots.length}镜)</span>
                <span class="pb-zh-en">STORYBOARD PANELS</span>
            </div>
            <div class="pb-panels">
                ${shots.map(s => {
                    return `
                        <div class="pb-panel">
                            <div class="pb-panel-head">
                                <span class="pb-panel-num">SHOT ${s.storyboard_number || s.id}</span>
                                <span class="pb-panel-time">${esc(s.shot_type)} • ${esc(s.angle)}</span>
                            </div>
                            ${s.title ? `<div class="pb-panel-title">${esc(s.title)}</div>` : ''}
                            ${s.action ? `<div class="pb-panel-action">${esc(s.action)}</div>` : ''}
                            ${s.dialogue ? `<div class="pb-panel-dialogue">"${esc(s.dialogue)}"</div>` : ''}
                        </div>
                    `;
                }).join('')}
            </div>
        </div>

        <!-- Zone 4: Blocking & Movement -->
        <div class="pb-zone pb-z4">
            <div class="pb-zone-header">
                <span class="pb-zh-cn">情绪调度/走位示意</span>
                <span class="pb-zh-en">BLOCKING & CAMERA MOVEMENT</span>
            </div>
            <div class="pb-block-list">
                ${shots.map(s => {
                    if(!s.movement || s.movement.toLowerCase() === 'static') return '';
                    return `
                        <div class="pb-block-item">
                            <div class="pb-block-dot">${s.storyboard_number || s.id}</div>
                            <div>
                                <span style="color:#fff;font-weight:600;">${esc(s.movement)}</span>
                                <span style="color:#94a3b8;margin-left:4px;">→ ${esc(s.action || s.description || '').substring(0,60)}...</span>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>

        <!-- Bottom Row (Zones 5, 6, 7, 8) -->
        <div class="pb-bottom-row">
            <div class="pb-zone">
                <div class="pb-zone-header" style="margin-bottom:8px;padding-bottom:8px;">
                    <span class="pb-zh-cn" style="font-size:13px;">光影/氛围</span>
                    <span class="pb-zh-en" style="font-size:9px;">LIGHTING</span>
                </div>
                <div style="font-size:12px; color:#cbd5e1; line-height:1.5;">${esc(lighting)}</div>
            </div>
            
            <div class="pb-zone">
                <div class="pb-zone-header" style="margin-bottom:8px;padding-bottom:8px;">
                    <span class="pb-zh-cn" style="font-size:13px;">情绪关键词</span>
                    <span class="pb-zh-en" style="font-size:9px;">EMOTIONS</span>
                </div>
                <div class="pb-pill-container">
                    ${emotions.map(e => `<span class="pb-pill glow">${esc(e)}</span>`).join('')}
                </div>
            </div>

            <div class="pb-zone">
                <div class="pb-zone-header" style="margin-bottom:8px;padding-bottom:8px;">
                    <span class="pb-zh-cn" style="font-size:13px;">音效/节奏</span>
                    <span class="pb-zh-en" style="font-size:9px;">SOUND & BGM</span>
                </div>
                <div style="font-size:11px; color:#cbd5e1; display:flex; flex-direction:column; gap:6px;">
                    ${shots.filter(s => s.sound_effect).slice(0,3).map(s => `<div>🎵 ${esc(s.sound_effect)}</div>`).join('')}
                    ${shots.filter(s => s.bgm_prompt).slice(0,1).map(s => `<div style="color:#fcd34d;">🎼 ${esc(s.bgm_prompt)}</div>`).join('')}
                </div>
            </div>

            <div class="pb-zone">
                <div class="pb-zone-header" style="margin-bottom:8px;padding-bottom:8px;">
                    <span class="pb-zh-cn" style="font-size:13px;">道具/细节</span>
                    <span class="pb-zh-en" style="font-size:9px;">PROPS</span>
                </div>
                <div class="pb-pill-container">
                    ${props.map(p => `<span class="pb-pill">${esc(p)}</span>`).join('')}
                </div>
            </div>
        </div>
    `;
}

