"""Patch studio2.js to add video engine selection (Grok/Veo3) support"""
import re

filepath = r'c:\tubecreate-vue\tubecli\data\extensions_external\pod_studio\static\studio2.js'

with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

changes_made = 0

# ── 1. Add engine helper functions after openGenVideosDialog ──
# Find the closing of openGenVideosDialog function
marker = "document.getElementById('genVideosModal').style.display = 'flex';\r\n}"
pos = content.find(marker)
if pos == -1:
    marker = "document.getElementById('genVideosModal').style.display = 'flex';\n}"
    pos = content.find(marker)

if pos != -1:
    insert_pos = pos + len(marker)
    engine_funcs = '''

// ── Video Engine Selection Functions ──

function onVideoEngineChange() {
    const engine = document.getElementById('wizVideoEngine')?.value || 'grok';
    const label = document.getElementById('wizBrowserLabel');
    if (label) {
        label.textContent = engine === 'veo3' 
            ? '\\ud83c\\udf10 Browser Profiles (Google login)' 
            : '\\ud83c\\udf10 Browser Profiles (Grok Gen)';
    }
    localStorage.setItem('cs_video_engine', engine);
}

function onGenVidEngineChange() {
    const engine = document.getElementById('genVidEngine')?.value || 'grok';
    const title = document.getElementById('genVidModalTitle');
    const label = document.getElementById('genVidProfileLabel');
    if (title) {
        title.textContent = engine === 'veo3' 
            ? '\\ud83c\\udf9e Generate Videos with Veo3' 
            : '\\ud83c\\udf9e Generate Videos with Grok';
    }
    if (label) {
        label.textContent = engine === 'veo3'
            ? 'Browser Profile (Chrome \\u0111\\u00e3 login Google)'
            : 'Browser Profile (Chrome \\u0111\\u00e3 login Grok)';
    }
}

function _getVideoEngine() {
    // Priority: wizard dropdown > modal dropdown > campaign metadata > localStorage > default
    const wizEl = document.getElementById('wizVideoEngine');
    if (wizEl && wizEl.value) return wizEl.value;
    const genEl = document.getElementById('genVidEngine');
    if (genEl && genEl.value) return genEl.value;
    return localStorage.getItem('cs_video_engine') || 'grok';
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

'''
    content = content[:insert_pos] + engine_funcs + content[insert_pos:]
    changes_made += 1
    print(f"DONE: Inserted engine helper functions")
else:
    print("ERROR: Could not find openGenVideosDialog closing marker")

# ── 2. Modify startGrokVideoGen to send engine parameter ──
old_body = "body: JSON.stringify({ profile_names: profilePaths, headless, overwrite })\r\n"
if old_body not in content:
    old_body = "body: JSON.stringify({ profile_names: profilePaths, headless, overwrite })\n"

new_body = "body: JSON.stringify({ profile_names: profilePaths, headless, overwrite, engine: _getVideoEngine() })\n"

if old_body in content:
    # Only replace the one inside startGrokVideoGen (first occurrence)
    content = content.replace(old_body, new_body, 1)
    changes_made += 1
    print("DONE: Updated startGrokVideoGen to send engine")
else:
    print("WARNING: Could not find startGrokVideoGen body to update")

# ── 3. Update progress label "Grok Video" to be dynamic ──
old_label = "'Khởi tạo Grok Video...'"
new_label = "(_getVideoEngine() === 'veo3' ? 'Khởi tạo Veo3 Video...' : 'Khởi tạo Grok Video...')"
if old_label in content:
    content = content.replace(old_label, new_label, 1)
    changes_made += 1
    print("DONE: Updated progress label")

# ── 4. Update auto-pilot gen-videos API call to send engine ──
old_autopilot = "body: JSON.stringify({ profile_names: browserProfileNames, headless: false, overwrite: false })"
new_autopilot = "body: JSON.stringify({ profile_names: browserProfileNames, headless: false, overwrite: false, engine: campaignMeta.video_engine || localStorage.getItem('cs_video_engine') || 'grok' })"
if old_autopilot in content:
    content = content.replace(old_autopilot, new_autopilot, 1)
    changes_made += 1
    print("DONE: Updated auto-pilot gen-videos call")
else:
    print("WARNING: Could not find auto-pilot gen-videos body")

# ── 5. Save video_engine to campaign metadata in startRealtimeAutoPilot ──
# Find where browser_profile_names_video is saved and add video_engine
old_meta_save = "if (selectedProfile) meta.browser_profile_name = selectedProfile;"
new_meta_save = "if (selectedProfile) meta.browser_profile_name = selectedProfile;\n            meta.video_engine = _getVideoEngine();"
if old_meta_save in content:
    content = content.replace(old_meta_save, new_meta_save, 1)
    changes_made += 1
    print("DONE: Added video_engine to campaign metadata save")

# ── 6. Update auto-pilot toast to show engine name ──
old_toast = "toast(`\\ud83c\\udf9e Auto Grok video gen: ${pendingVidShots.length} shots for ${currentEpisode.title}`, \"info\");"
if old_toast in content:
    new_toast = "toast(`\\ud83c\\udf9e Auto ${(campaignMeta.video_engine || 'grok') === 'veo3' ? 'Veo3' : 'Grok'} video gen: ${pendingVidShots.length} shots for ${currentEpisode.title}`, \"info\");"
    content = content.replace(old_toast, new_toast, 1)
    changes_made += 1
    print("DONE: Updated auto-pilot toast")
else:
    print("WARNING: Could not find auto-pilot toast")

# ── 7. Restore engine selection when opening gen dialog ──
old_open_dialog = "document.getElementById('genVideosModal').style.display = 'flex';"
new_open_dialog = "_restoreVideoEngine();\n    document.getElementById('genVideosModal').style.display = 'flex';"
if old_open_dialog in content:
    content = content.replace(old_open_dialog, new_open_dialog, 1)
    changes_made += 1
    print("DONE: Added engine restore on dialog open")

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

print(f"\nTotal changes: {changes_made}")
