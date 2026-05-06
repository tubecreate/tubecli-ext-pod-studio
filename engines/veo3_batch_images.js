#!/usr/bin/env node
/**
 * veo3_batch_images.js — Batch generate images via Google VideoFX (Image mode).
 * Opens ONE browser, creates ONE project, sets aspect ratio ONCE,
 * then generates all images sequentially.
 * 
 * Usage: node veo3_batch_images.js --profile <name> --jobs <path_to_jobs.json> --profiles-dir <dir> [--aspect-ratio 1:1] [--timeout 120]
 * 
 * jobs.json format:
 * [
 *   { "id": "char_1", "prompt": "...", "output": "/path/to/output.png" },
 *   { "id": "scene_2", "prompt": "...", "output": "/path/to/output.png" }
 * ]
 * 
 * Output: JSON lines on stdout for each job:
 *   { "status": "success", "id": "char_1", "path": "<output_path>" }
 *   { "status": "error", "id": "char_1", "message": "<reason>" }
 *   Final line: { "status": "batch_done", "total": N, "success": M, "failed": K }
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const result = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith('--')) {
            const key = argv[i].slice(2);
            const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
            result[key] = val;
        }
    }
    return result;
}
const args = parseArgs(process.argv.slice(2));

const profileName = args.profile || args.p;
const jobsFile = args.jobs;
const profilesDir = args['profiles-dir'] || path.join(__dirname, '..', '..', '..', '..', 'data', 'browser_profiles');
const aspectRatio = args['aspect-ratio'] || '1:1';
const headless = args.headless === 'true';
const perJobTimeout = parseInt(args.timeout || '120') * 1000;

const VEO3_FLOW_URL = 'https://labs.google/fx/vi/tools/flow';
const BROWSER_EXT_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'tubecli', 'extensions', 'browser');

process.on('uncaughtException', (err) => {
    process.stdout.write(JSON.stringify({ status: 'error', message: 'Crash: ' + (err.message || String(err)) }) + '\n');
    process.exit(1);
});
process.on('unhandledRejection', (err) => {
    process.stdout.write(JSON.stringify({ status: 'error', message: 'Rejection: ' + (err && err.message ? err.message : String(err)) }) + '\n');
    process.exit(1);
});

if (!profileName || !jobsFile) {
    console.log(JSON.stringify({ status: 'error', message: 'Required: --profile, --jobs' }));
    process.exit(1);
}

let jobs;
try {
    jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));
    if (!Array.isArray(jobs) || jobs.length === 0) throw new Error('Empty jobs array');
} catch(e) {
    console.log(JSON.stringify({ status: 'error', message: 'Invalid jobs file: ' + e.message }));
    process.exit(1);
}

const profileDir = path.join(profilesDir, profileName);
const cookiesPath = path.join(profileDir, 'cookies.json');

if (!fs.existsSync(profileDir)) {
    console.log(JSON.stringify({ status: 'error', message: `Profile "${profileName}" not found at: ${profileDir}` }));
    process.exit(1);
}

function log(msg) { process.stderr.write('[Veo3Batch] ' + msg + '\n'); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
    log(`Profile: ${profileName}, Batch: ${jobs.length} images, Aspect: ${aspectRatio}`);

    let chromium;
    try {
        chromium = require(path.join(BROWSER_EXT_DIR, 'node_modules', 'playwright')).chromium;
    } catch(e) {
        console.log(JSON.stringify({ status: 'error', message: 'Playwright load failed: ' + e.message }));
        process.exit(1);
    }

    // Clean stale locks
    for (const lf of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        const lfPath = path.join(profileDir, lf);
        if (fs.existsSync(lfPath)) { try { fs.unlinkSync(lfPath); } catch(e) {} }
    }
    const defaultLock = path.join(profileDir, 'Default', 'LOCK');
    if (fs.existsSync(defaultLock)) { try { fs.unlinkSync(defaultLock); } catch(e) {} }

    let context = null;
    let successCount = 0;
    let failCount = 0;

    try {
        context = await chromium.launchPersistentContext(profileDir, {
            channel: 'chrome',
            headless,
            args: ['--no-sandbox', '--test-type', '--disable-blink-features=AutomationControlled', '--start-maximized'],
            ignoreDefaultArgs: ['--enable-automation'],
            viewport: { width: 1280, height: 800 },
        });

        if (fs.existsSync(cookiesPath)) {
            try {
                const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
                if (Array.isArray(cookies) && cookies.length > 0) await context.addCookies(cookies);
            } catch (e) {}
        }

        const page = context.pages()[0] || await context.newPage();

        // Setup global download listener
        let currentOutput = null;
        let currentSaved = false;
        page.on('download', async (download) => {
            if (!currentOutput || currentSaved) return;
            log('Download event!');
            try {
                fs.mkdirSync(path.dirname(currentOutput), { recursive: true });
                await download.saveAs(currentOutput);
                if (fs.existsSync(currentOutput) && fs.statSync(currentOutput).size > 50000) {
                    currentSaved = true;
                    log(`Saved via download: ${currentOutput}`);
                }
            } catch(e) { log('Download save error: ' + e.message); }
        });

        // ── Navigate to VideoFX Flow ──
        log('Navigating to VideoFX Flow...');
        await page.goto(VEO3_FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(4000);

        // Handle landing page
        try {
            const landingBtn = page.locator('button:has-text("Create with Flow"), button:has-text("Tạo bằng Flow")').first();
            if (await landingBtn.isVisible({ timeout: 3000 })) {
                await landingBtn.click();
                await sleep(5000);
            }
        } catch(e) {}

        // Handle login
        if (page.url().includes('accounts.google.com') || page.url().includes('signin')) {
            log('Not logged in — attempting auto-login...');
            const configPath = path.join(profileDir, 'config.json');
            let googleCreds = null;
            try {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                googleCreds = config.google_account;
            } catch(e) {}

            if (googleCreds && googleCreds.email && googleCreds.password) {
                try {
                    const loginModule = await import('file:///' + path.join(BROWSER_EXT_DIR, 'actions', 'login.js').replace(/\\/g, '/'));
                    await loginModule.login(page, {
                        email: googleCreds.email, password: googleCreds.password,
                        recoveryEmail: googleCreds.recoveryEmail || '', twoFactorCodes: googleCreds.twoFactorCodes || '',
                        platform: 'google'
                    });
                } catch(e) { log('Auto-login error: ' + e.message); }
            }

            let lw = 0;
            while (page.url().includes('accounts.google.com') || page.url().includes('signin')) {
                await sleep(2000); lw++;
                if (lw > 30) { console.log(JSON.stringify({ status: 'error', message: 'Login timeout' })); await context.close(); process.exit(1); }
            }
            log('Login OK');
            if (!page.url().includes('tools/flow')) {
                await page.goto(VEO3_FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await sleep(4000);
            }
            try {
                const lb = page.locator('button:has-text("Create with Flow"), button:has-text("Tạo bằng Flow")').first();
                if (await lb.isVisible({ timeout: 2000 })) { await lb.click(); await sleep(5000); }
            } catch(e) {}
        }

        // ── Create new project ──
        log('Creating new project...');
        try {
            const npBtn = page.locator('button:has-text("Dự án mới"), button:has-text("New project")').first();
            if (await npBtn.isVisible({ timeout: 5000 })) {
                await npBtn.click(); await sleep(3000);
                log('New project created');
            } else {
                const addBtn = page.locator('button:has(i:text("add_2"))').first();
                if (await addBtn.isVisible({ timeout: 2000 })) { await addBtn.click(); await sleep(3000); }
            }
        } catch(e) { log('Project creation: ' + e.message); }

        // ── Switch to Image mode + Set aspect ratio (ONCE) ──
        // Uses settings chip approach (same as veo3_video.js) for robustness
        log('Setting Image mode + aspect ratio (once for all jobs)...');
        
        // Wait for prompt area to load first
        try {
            const taLocator = page.locator('textarea, div[contenteditable="true"]').last();
            await taLocator.waitFor({ state: 'visible', timeout: 8000 });
        } catch(e) { log('Wait for textarea timeout'); }
        await sleep(1000);

        // ── Step 1: Find the settings chip button ──
        // The chip shows current mode info like "🍌 Nano Banana 2 □ 1x" (image mode)
        // or "Veo 2 crop_9_16 5s" (video mode)
        let settingsChip = null;
        
        // Method A: Find button with aria-haspopup="menu" containing model info
        try {
            const chips = page.locator('button[aria-haspopup="menu"]');
            const count = await chips.count();
            log(`Found ${count} buttons with aria-haspopup="menu"`);
            
            for (let i = count - 1; i >= 0; i--) {
                const chip = chips.nth(i);
                try {
                    const text = await chip.textContent({ timeout: 1000 });
                    const lower = (text || '').toLowerCase();
                    if (lower.includes('banana') || lower.includes('imagen') || 
                        lower.includes('veo') || lower.includes('1x') || 
                        lower.includes('5s') || lower.includes('crop_')) {
                        settingsChip = chip;
                        log(`Found settings chip (Method A): "${text.trim().substring(0, 60)}"`);
                        break;
                    }
                } catch(e) {}
            }
        } catch(e) {}
        
        // Method B: Walk up from textarea to find the chip
        if (!settingsChip) {
            try {
                const found = await page.evaluate(() => {
                    const ta = document.querySelector('textarea, div[contenteditable="true"]');
                    if (!ta) return null;
                    let container = ta.parentElement;
                    for (let i = 0; i < 5 && container; i++) {
                        const buttons = Array.from(container.querySelectorAll('button[aria-haspopup="menu"]'));
                        if (buttons.length > 0) {
                            return buttons[buttons.length - 1].textContent.trim().substring(0, 80);
                        }
                        container = container.parentElement;
                    }
                    return null;
                });
                if (found) {
                    settingsChip = page.locator('button[aria-haspopup="menu"]').last();
                    log(`Found settings chip (Method B): "${found}"`);
                }
            } catch(e) {}
        }
        
        if (!settingsChip) {
            log('⚠️ Could not find settings chip — will try legacy mode switching');
        } else {
            // ── Step 2: Check current mode ──
            let currentText = '';
            try { currentText = (await settingsChip.textContent({ timeout: 2000 })).toLowerCase(); } catch(e) {}
            
            const isCurrentlyImage = currentText.includes('banana') || currentText.includes('imagen') || currentText.includes('1x');
            const isCurrentlyVideo = currentText.includes('veo') || currentText.includes('5s') || currentText.includes('8s');
            log(`Current mode: ${isCurrentlyImage ? 'IMAGE' : isCurrentlyVideo ? 'VIDEO' : 'UNKNOWN'} (text: "${currentText.trim().substring(0, 50)}")`);
            
            // ── Step 3: Open popup ──
            await settingsChip.click();
            await sleep(2000);
            
            // ── Step 4: Switch to Image tab ──
            log('Selecting Image mode...');
            let imageClicked = false;
            
            // Method 1: Radix ID selector (most reliable)
            try {
                const imageTab = page.locator('button[role="tab"][id*="trigger-IMAGE"], button[role="tab"][id*="IMAGE"]').first();
                if (await imageTab.isVisible({ timeout: 2000 })) {
                    const state = await imageTab.getAttribute('data-state');
                    log(`Image tab found, state: ${state}`);
                    if (state !== 'active') {
                        await imageTab.click();
                        imageClicked = true;
                        log('✅ Clicked Image tab via Radix ID');
                    } else {
                        imageClicked = true;
                        log('✅ Image tab already active');
                    }
                }
            } catch(e) { log('Image tab Method 1: ' + e.message); }
            
            // Method 2: Find tab with "image" or "photo" icon
            if (!imageClicked) {
                try {
                    const imageTab = page.locator('button[role="tab"]:has(i:text("image")), button[role="tab"]:has(i:text("photo"))').first();
                    if (await imageTab.isVisible({ timeout: 1500 })) {
                        await imageTab.click();
                        imageClicked = true;
                        log('✅ Clicked Image tab via icon');
                    }
                } catch(e) {}
            }
            
            // Method 3: Text-based (Vietnamese + English)
            if (!imageClicked) {
                try {
                    const imageTab = page.locator('button[role="tab"]:has-text("Hình ảnh"), button[role="tab"]:has-text("Image")').first();
                    if (await imageTab.isVisible({ timeout: 1500 })) {
                        await imageTab.click();
                        imageClicked = true;
                        log('✅ Clicked Image tab via text match');
                    }
                } catch(e) {}
            }
            
            log(imageClicked ? '✅ Image mode selected' : '⚠️ Could not select Image mode');
            await sleep(1500);
            
            // ── Step 5: Set Aspect Ratio ──
            const arMap = { '4:3': '16:9', '3:4': '9:16' };
            const ar = arMap[aspectRatio] || aspectRatio || '1:1';
            let arClicked = false;
            
            // Method 1: Radix ID for aspect ratio
            const arId = ar.replace(':', '_'); // "9:16" → "9_16"
            try {
                const arTab = page.locator(`button[role="tab"][id*="${arId}"], button[role="tab"][id*="${ar}"]`).first();
                if (await arTab.isVisible({ timeout: 1500 })) {
                    const state = await arTab.getAttribute('data-state');
                    if (state !== 'active') {
                        await arTab.click();
                        arClicked = true;
                        log(`✅ Set AR to ${ar} via Radix ID`);
                    } else {
                        arClicked = true;
                        log(`✅ AR ${ar} already active`);
                    }
                }
            } catch(e) {}
            
            // Method 2: Find by crop icon
            if (!arClicked) {
                const cropIcon = ar === '9:16' ? 'crop_9_16' : ar === '16:9' ? 'crop_16_9' : ar === '1:1' ? 'crop_square' : `crop_${arId}`;
                try {
                    const arTab = page.locator(`button[role="tab"]:has(i:text("${cropIcon}"))`).first();
                    if (await arTab.isVisible({ timeout: 1500 })) {
                        await arTab.click();
                        arClicked = true;
                        log(`✅ Set AR to ${ar} via crop icon`);
                    }
                } catch(e) {}
            }
            
            // Method 3: Text-based
            if (!arClicked) {
                try {
                    const arTab = page.locator(`button[role="tab"]:has-text("${ar}")`).first();
                    if (await arTab.isVisible({ timeout: 1500 })) {
                        await arTab.click();
                        arClicked = true;
                        log(`✅ Set AR to ${ar} via text`);
                    }
                } catch(e) {}
            }
            
            log(arClicked ? `✅ Aspect ratio ${ar} set` : `⚠️ Could not set AR ${ar}`);
            await sleep(500);
            
            // Close the settings popup
            await page.keyboard.press('Escape'); await sleep(500);
        }
        
        // ── VERIFICATION: Confirm correct mode is active ──
        try {
            await sleep(1000);
            const verifyChips = page.locator('button[aria-haspopup="menu"]');
            const vCount = await verifyChips.count();
            for (let vi = vCount - 1; vi >= 0; vi--) {
                try {
                    const vText = await verifyChips.nth(vi).textContent({ timeout: 1000 });
                    const lower = (vText || '').toLowerCase();
                    if (lower.includes('banana') || lower.includes('imagen') || lower.includes('1x')) {
                        log(`✅ VERIFIED: Image mode active — "${vText.trim().substring(0, 50)}"`);
                        break;
                    }
                    if (lower.includes('veo') || lower.includes('5s')) {
                        log(`⚠️ VERIFY FAILED: Still in VIDEO mode! "${vText.trim().substring(0, 50)}". Retrying...`);
                        // One more attempt
                        await verifyChips.nth(vi).click(); await sleep(2000);
                        try {
                            const imgTab = page.locator('button[role="tab"][id*="IMAGE"], button[role="tab"]:has-text("Hình ảnh"), button[role="tab"]:has-text("Image")').first();
                            if (await imgTab.isVisible({ timeout: 2000 })) {
                                await imgTab.click(); await sleep(1000);
                                log('✅ Retry: Image tab clicked');
                            }
                        } catch(e2) {}
                        await page.keyboard.press('Escape'); await sleep(500);
                        break;
                    }
                } catch(e) {}
            }
        } catch(e) { log('Verification: ' + e.message); }

        // ── Process each job ──
        for (let ji = 0; ji < jobs.length; ji++) {
            const job = jobs[ji];
            log(`\n--- Job ${ji+1}/${jobs.length}: ${job.id} ---`);
            currentOutput = job.output;
            currentSaved = false;
            let newTileFirstSeen = 0; // Timestamp when new tile was first detected

            try {
                // Find prompt input
                let inputEl = null;
                const inputSelectors = ['textarea[placeholder*="tạo"]', 'textarea[placeholder*="create"]', 'textarea[placeholder*="muốn"]', 'textarea', 'div[contenteditable="true"]'];
                for (let a = 0; a < 5; a++) {
                    for (const sel of inputSelectors) {
                        try {
                            const el = page.locator(sel).last();
                            if (await el.isVisible({ timeout: 1500 })) { inputEl = el; break; }
                        } catch(e) {}
                    }
                    if (inputEl) break;
                    await sleep(2000);
                }

                if (!inputEl) {
                    console.log(JSON.stringify({ status: 'error', id: job.id, message: 'Prompt input not found' }));
                    failCount++; continue;
                }

                // Count existing tiles BEFORE submitting
                let prevTileCount = 0;
                let prevTileIds = [];
                try {
                    const tileInfo = await page.evaluate(() => {
                        const tiles = document.querySelectorAll('[data-tile-id]');
                        return {
                            count: tiles.length,
                            ids: Array.from(tiles).map(t => t.getAttribute('data-tile-id'))
                        };
                    });
                    prevTileCount = tileInfo.count;
                    prevTileIds = tileInfo.ids;
                } catch(e) {}

                // Type prompt
                await inputEl.click(); await sleep(300);
                await inputEl.fill(''); await sleep(200);
                try { await inputEl.fill(job.prompt.replace(/\n+/g, ' ').trim()); }
                catch(e) { await page.keyboard.type(job.prompt.replace(/\n+/g, ' ').trim(), { delay: 5 }); }
                await sleep(500);

                // Submit
                let submitted = false;
                // Method 1: arrow_forward submit button (same as veo3_video.js)
                try {
                    const submitBtn = page.locator('button:has(i:text("arrow_forward"))').last();
                    if (await submitBtn.isVisible({ timeout: 2000 })) {
                        await submitBtn.click();
                        submitted = true;
                        log('Submitted via arrow_forward button');
                    }
                } catch(e) {}
                // Method 2: Tạo (Create) button
                if (!submitted) {
                    try {
                        const createBtn = page.locator('button[aria-label*="Tạo"], button[aria-label*="Create"], button[aria-label*="Generate"]').last();
                        if (await createBtn.isVisible({ timeout: 1500 })) {
                            await createBtn.click();
                            submitted = true;
                            log('Submitted via Create button');
                        }
                    } catch(e) {}
                }
                // Method 3: Enter key
                if (!submitted) {
                    await page.keyboard.press('Enter');
                    log('Submitted via Enter key');
                }

                log('Prompt submitted. Waiting for generation...');
                await sleep(5000); // Give UI time to spawn the new loading tile

                // Wait for generation + download
                const jobDeadline = Date.now() + perJobTimeout;
                while (Date.now() < jobDeadline && !currentSaved) {
                    await sleep(4000);

                    // Check rate limit
                    try {
                        const rl = await page.evaluate(() => document.body.innerText.toLowerCase().includes('rate limit') || document.body.innerText.toLowerCase().includes('giới hạn'));
                        if (rl) {
                            console.log(JSON.stringify({ status: 'error', id: job.id, message: 'RATE_LIMIT' }));
                            try { fs.writeFileSync(cookiesPath, JSON.stringify(await context.cookies(), null, 2)); } catch(e) {}
                            console.log(JSON.stringify({ status: 'batch_done', total: jobs.length, success: successCount, failed: failCount + (jobs.length - ji) }));
                            await context.close(); process.exit(1);
                        }
                    } catch(e) {}

                    // Check if NEW tile has appeared (tile count increased)
                    let currentTileCount = 0;
                    let currentTileIds = [];
                    let newTileId = null;
                    try {
                        const tileInfo = await page.evaluate(() => {
                            const tiles = document.querySelectorAll('[data-tile-id]');
                            return {
                                count: tiles.length,
                                ids: Array.from(tiles).map(t => t.getAttribute('data-tile-id'))
                            };
                        });
                        currentTileCount = tileInfo.count;
                        currentTileIds = tileInfo.ids;
                        // Find the new tile ID (one that wasn't in prevTileIds)
                        for (const tid of currentTileIds) {
                            if (!prevTileIds.includes(tid)) { newTileId = tid; break; }
                        }
                    } catch(e) {}

                    if (currentTileCount <= prevTileCount && !newTileId) {
                        log('New tile has not appeared yet. Still waiting...');
                        continue;
                    }

                    // Track when new tile first appeared
                    if (newTileId && !newTileFirstSeen) {
                        newTileFirstSeen = Date.now();
                        log(`New tile first detected at ${new Date().toISOString()}`);
                    }

                    // ── Check for generation error (Không thành công) ──
                    let tileHasError = false;
                    try {
                        tileHasError = await page.evaluate((targetTileId) => {
                            const body = document.body.innerText;
                            if (body.includes('Không thành công') || body.includes('could not be generated') || body.includes('không thể tạo')) {
                                return true;
                            }
                            if (targetTileId) {
                                const tile = document.querySelector(`[data-tile-id="${targetTileId}"]`);
                                if (tile) {
                                    const tileText = tile.innerText || '';
                                    if (tileText.includes('Không thành công') || tileText.includes('error')) return true;
                                }
                            }
                            return false;
                        }, newTileId);
                    } catch(e) {}

                    if (tileHasError) {
                        log('⚠️ Generation error detected! Clicking retry...');
                        // Find and click the refresh button (same pattern as veo3_video.js)
                        let retryClicked = false;
                        try {
                            retryClicked = await page.evaluate(() => {
                                const allDivs = document.querySelectorAll('div');
                                for (const div of allDivs) {
                                    const buttons = div.querySelectorAll(':scope > button');
                                    if (buttons.length !== 3) continue;
                                    const iconTexts = [];
                                    let refreshBtn = null;
                                    for (const btn of buttons) {
                                        const icon = btn.querySelector('i');
                                        const iconText = icon ? icon.textContent.trim() : '';
                                        iconTexts.push(iconText);
                                        if (iconText === 'refresh') refreshBtn = btn;
                                    }
                                    if (iconTexts.includes('refresh') && iconTexts.includes('undo') && iconTexts.includes('delete_forever') && refreshBtn) {
                                        refreshBtn.click();
                                        return true;
                                    }
                                }
                                return false;
                            });
                        } catch(e) {}
                        
                        if (retryClicked) {
                            log('✅ Clicked retry button. Waiting for regeneration...');
                            prevTileCount = currentTileCount; // Reset tile tracking
                            prevTileIds = currentTileIds;
                            await sleep(5000);
                        } else {
                            log('❌ Could not find retry button — skipping this job');
                            break;
                        }
                        continue;
                    }

                    // New tile detected! Now check if it's still generating (percentage overlay)
                    let stillGenerating = false;
                    try {
                        stillGenerating = await page.evaluate((targetTileId) => {
                            // Check for percentage text on tiles (e.g. "30%", "99%")
                            const allText = document.body.innerText;
                            const percentMatch = allText.match(/(\d{1,3})%/);
                            if (percentMatch) {
                                const pct = parseInt(percentMatch[1]);
                                if (pct > 0 && pct < 100) return true;
                            }
                            
                            // Check specific tile if we found it
                            if (targetTileId) {
                                const tile = document.querySelector(`[data-tile-id="${targetTileId}"]`);
                                if (tile) {
                                    const tileText = tile.innerText || '';
                                    if (tileText.match(/\d{1,3}%/)) return true;
                                    // Check for loading indicators within the tile
                                    const hasSpinner = tile.querySelector('[class*="spinner"], [class*="loading"], [class*="progress"], [role="progressbar"]');
                                    if (hasSpinner) return true;
                                    // Check if tile has a real finished image (not just a placeholder)
                                    const img = tile.querySelector('img');
                                    if (!img || !img.src || img.naturalWidth < 500) return true;
                                }
                            }
                            
                            // Global checks
                            const spinners = document.querySelectorAll('[class*="spinner"], [class*="loading"], [role="progressbar"]');
                            if (spinners.length > 0) return true;
                            if (allText.includes('Đang tạo') || allText.includes('Generating') || allText.includes('Processing')) return true;
                            
                            return false;
                        }, newTileId);
                    } catch(e) {}

                    // Enforce minimum wait time: at least 15s after new tile appears
                    // This prevents downloading a low-res preview before the full image is ready
                    const elapsedSinceNewTile = newTileFirstSeen ? (Date.now() - newTileFirstSeen) / 1000 : 0;
                    if (newTileFirstSeen && elapsedSinceNewTile < 15) {
                        log(`New tile appeared ${Math.round(elapsedSinceNewTile)}s ago — waiting at least 15s before download...`);
                        stillGenerating = true;
                    }

                    if (stillGenerating) {
                        log('New tile found but still generating...');
                        continue;
                    }

                    log(`New tile ready! ID: ${newTileId || 'unknown'}, Count: ${prevTileCount} → ${currentTileCount}`);

                    // Strategy 1: Right-click the NEW tile → Tải xuống → 1K
                    if (!currentSaved) {
                        try {
                            // Target the specific new tile, or the first tile (newest)
                            let tile = null;
                            if (newTileId) {
                                tile = page.locator(`[data-tile-id="${newTileId}"]`).first();
                                try { if (!(await tile.isVisible({ timeout: 2000 }))) tile = null; } catch(e) { tile = null; }
                            }
                            if (!tile) {
                                tile = page.locator('[data-tile-id]').first();
                                try { if (!(await tile.isVisible({ timeout: 1000 }))) tile = null; } catch(e) { tile = null; }
                            }
                            
                            if (tile) {
                                let dlUrl = null;
                                const dlHandler = async (r) => {
                                    const u = r.url(), ct = r.headers()['content-type'] || '';
                                    if (ct.startsWith('image/') && !u.includes('_next/') && !u.includes('favicon') && u.length > 50) { dlUrl = u; }
                                };
                                page.on('response', dlHandler);

                                await tile.click({ button: 'right' }); await sleep(2000);
                                let dlItem = page.locator('text="Tải xuống"').first();
                                let menuOk = false;
                                try { menuOk = await dlItem.isVisible({ timeout: 2000 }); } catch(e) {}

                                if (!menuOk) {
                                    await page.keyboard.press('Escape'); await sleep(500);
                                    await tile.hover(); await sleep(1000);
                                    const mb = tile.locator('button:has(i:text("more_vert")), button[aria-label*="menu"]').first();
                                    try { if (await mb.isVisible({ timeout: 2000 })) { await mb.click(); await sleep(2000); try { menuOk = await dlItem.isVisible({ timeout: 2000 }); } catch(e) {} } } catch(e) {}
                                }

                                if (menuOk) {
                                    await dlItem.hover(); await sleep(2000);
                                    const r1k = page.locator('text="1K"').first();
                                    try {
                                        if (await r1k.isVisible({ timeout: 3000 })) {
                                            await r1k.hover(); await sleep(500); await r1k.click();
                                            log('Clicked 1K download');
                                        } else { await dlItem.click(); }
                                    } catch(e) { await dlItem.click(); }

                                    for (let w = 0; w < 45 && !currentSaved && !dlUrl; w++) await sleep(1000);

                                    if (!currentSaved && dlUrl) {
                                        try {
                                            fs.mkdirSync(path.dirname(currentOutput), { recursive: true });
                                            const resp = await page.request.get(dlUrl);
                                            if (resp.ok()) {
                                                fs.writeFileSync(currentOutput, await resp.body());
                                                if (fs.statSync(currentOutput).size > 50000) { currentSaved = true; log('Downloaded from network!'); }
                                            }
                                        } catch(e) {}
                                    }
                                }
                                page.removeListener('response', dlHandler);
                                try { await page.keyboard.press('Escape'); } catch(x) {}
                            }
                        } catch(e) {
                            log('Strategy 1: ' + e.message);
                            try { await page.keyboard.press('Escape'); } catch(x) {}
                        }
                    }

                    // Strategy 2: Direct DOM img src download from the NEW tile
                    if (!currentSaved) {
                        try {
                            const imgUrl = await page.evaluate((targetTileId) => {
                                // Try to get image from the specific new tile first
                                if (targetTileId) {
                                    const tile = document.querySelector(`[data-tile-id="${targetTileId}"]`);
                                    if (tile) {
                                        const img = tile.querySelector('img');
                                        if (img && img.src && img.naturalWidth > 500) return img.src;
                                    }
                                }
                                // Fallback: first tile
                                const tiles = document.querySelectorAll('[data-tile-id]');
                                for (const t of tiles) {
                                    const img = t.querySelector('img');
                                    if (img && img.src && img.naturalWidth > 500) return img.src;
                                }
                                return null;
                            }, newTileId);
                            if (imgUrl) {
                                const resp = await page.request.get(imgUrl);
                                if (resp.ok()) {
                                    fs.mkdirSync(path.dirname(currentOutput), { recursive: true });
                                    fs.writeFileSync(currentOutput, await resp.body());
                                    if (fs.statSync(currentOutput).size > 50000) { currentSaved = true; log('Strategy 2: DOM download OK!'); }
                                }
                            }
                        } catch(e) {}
                    }

                    if (currentSaved) break;
                    const el = Math.round((Date.now() - (jobDeadline - perJobTimeout)) / 1000);
                    log(`Waiting... ${el}s`);
                }

                if (currentSaved) {
                    successCount++;
                    console.log(JSON.stringify({ status: 'success', id: job.id, path: currentOutput }));
                    log(`✅ Job ${job.id} done!`);
                } else {
                    failCount++;
                    console.log(JSON.stringify({ status: 'error', id: job.id, message: 'Timeout' }));
                    log(`❌ Job ${job.id} failed`);
                }

                await sleep(2000); // Brief pause between jobs
            } catch(e) {
                failCount++;
                console.log(JSON.stringify({ status: 'error', id: job.id, message: e.message }));
            }
        }

        // Save cookies
        try { fs.writeFileSync(cookiesPath, JSON.stringify(await context.cookies(), null, 2)); } catch(e) {}
        console.log(JSON.stringify({ status: 'batch_done', total: jobs.length, success: successCount, failed: failCount }));

    } catch(e) {
        console.log(JSON.stringify({ status: 'error', message: e.message }));
    } finally {
        if (context) { try { await context.close(); } catch(e) {} }
    }
})();
