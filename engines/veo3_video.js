#!/usr/bin/env node
/**
 * veo3_video.js — Generate videos from Google Veo3 (VideoFX Flow) using TubeCLI browser profile.
 * Processes multiple shots using labs.google/fx/vi/tools/flow with Playwright automation.
 * 
 * Usage: node veo3_video.js --profile <name> --shots-file <path> [--profiles-dir <path>] [--headless] [--timeout <seconds>]
 * 
 * Output: JSON lines on stdout for each shot result:
 *   { "status": "generating", "shot_id": <id>, "percent": <0-100> }
 *   { "status": "success", "shot_id": <id>, "path": "<output_path>" }
 *   { "status": "error", "shot_id": <id>, "message": "<reason>" }
 */

const minimist = require('minimist');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const args = minimist(process.argv.slice(2));
const profileName = args.profile || args.p;
const shotsFile = args['shots-file'];
const profilesDir = args['profiles-dir'] || path.join(__dirname, '..', '..', '..', '..', 'data', 'browser_profiles');
const headless = args.headless === true || args.headless === 'true';
const timeout = parseInt(args.timeout || '300') * 1000; // 5 minutes default (Veo3 is slower)

// Configure antidetect browser engine path
const browserExtDir = path.join(__dirname, '..', '..', '..', '..', 'tubecli', 'extensions', 'browser');

const VEO3_FLOW_URL = 'https://labs.google/fx/vi/tools/flow';

if (!profileName || !shotsFile) {
    console.error(JSON.stringify({ status: 'error', message: 'Required: --profile, --shots-file' }));
    process.exit(1);
}

let shots = [];
try {
    shots = JSON.parse(fs.readFileSync(shotsFile, 'utf-8'));
} catch (e) {
    console.error(JSON.stringify({ status: 'error', message: 'Could not read shots-file' }));
    process.exit(1);
}

const profileDir = path.join(profilesDir, profileName);
const cookiesPath = path.join(profileDir, 'cookies.json');
const storageDir = profileDir;

if (!fs.existsSync(profileDir)) {
    console.error(JSON.stringify({ status: 'error', message: `Profile "${profileName}" not found at ${profileDir}` }));
    process.exit(1);
}

function log(msg) {
    process.stderr.write('[Veo3Video] ' + msg + '\n');
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

(async () => {
    log(`Profile: ${profileName}, Processing ${shots.length} shots for Veo3 video.`);

    // Cleanup stale lock files
    const lockFiles = [
        path.join(storageDir, 'SingletonLock'),
        path.join(storageDir, 'SingletonSocket'),
        path.join(storageDir, 'SingletonCookie'),
        path.join(storageDir, 'Default', 'LOCK'),
    ];
    for (const lf of lockFiles) {
        try {
            if (fs.existsSync(lf)) {
                fs.unlinkSync(lf);
                log(`Removed stale lock: ${path.basename(lf)}`);
            }
        } catch (e) {}
    }

    log('Launching browser...');
    const context = await chromium.launchPersistentContext(storageDir, {
        channel: 'chrome',
        headless,
        args: ['--no-sandbox', '--test-type', '--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
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
    
    // Intercept video responses from Veo3 CDN
    let capturedVideoUrl = null;
    page.on('response', async (response) => {
        const url = response.url();
        const ct = response.headers()['content-type'] || '';
        
        // Veo3 videos come from the media API
        // Pattern: /fx/api/trpc/media.getMediaUrlRedirect?name=<uuid>
        // Or direct video content
        const isVideoContent = ct.startsWith('video/') || (url.includes('.mp4') && !url.includes('_next/'));
        const isVeoMedia = url.includes('media.getMediaUrlRedirect') || url.includes('media.getMedia');
        
        if (isVideoContent || isVeoMedia) {
            if (ct.startsWith('video/') || url.includes('.mp4')) {
                capturedVideoUrl = url;
                log('*** CAPTURED VIDEO URL: ' + url.substring(0, 150));
            }
        }
    });

    try {
        // Navigate to Flow and create new project for this batch
        log('Navigating to Veo3 Flow...');
        await page.goto(VEO3_FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(4000);

        // Check for landing page "Create with Flow" button
        try {
            const landingBtn = page.locator('button:has-text("Create with Flow"), button:has-text("Tạo bằng Flow"), a:has-text("Create with Flow")').first();
            if (await landingBtn.isVisible({ timeout: 2000 })) {
                log('Landing page detected, clicking Create with Flow...');
                await landingBtn.click();
                await sleep(5000);
            }
        } catch (e) {}

        // Check if logged in
        if (page.url().includes('accounts.google.com') || page.url().includes('signin')) {
            log('Not logged into Google. Attempting auto-login...');
            
            // Read credentials from profile config.json
            const configPath = path.join(profileDir, 'config.json');
            let googleCreds = null;
            try {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                googleCreds = config.google_account;
            } catch (e) {
                log('Could not read config.json: ' + e.message);
            }
            
            if (googleCreds && googleCreds.email && googleCreds.password) {
                log(`Auto-login with account: ${googleCreds.email}`);
                try {
                    // Use the shared login module from browser extension
                    const loginModule = await import(
                        'file:///' + path.join(browserExtDir, 'actions', 'login.js').replace(/\\/g, '/')
                    );
                    await loginModule.login(page, {
                        email: googleCreds.email,
                        password: googleCreds.password,
                        recoveryEmail: googleCreds.recoveryEmail || '',
                        twoFactorCodes: googleCreds.twoFactorCodes || '',
                        platform: 'google'
                    });
                    log('Login completed via shared login module.');
                } catch (loginErr) {
                    log('Auto-login error: ' + loginErr.message);
                }
                
                // Wait for login to complete (redirect away from accounts.google.com)
                let loginWaitAttempts = 0;
                while (page.url().includes('accounts.google.com') || page.url().includes('signin')) {
                    await sleep(2000);
                    loginWaitAttempts++;
                    if (loginWaitAttempts > 30) {
                        log('Auto-login may have stalled. Waiting for manual intervention...');
                        break;
                    }
                }
            } else {
                log('No Google credentials found in profile config.');
                
                // Attempt to click an existing account on the 'Choose an account' screen
                try {
                    const accountLink = page.locator('div[data-email], li div[role="link"]:has-text("@")').first();
                    if (await accountLink.isVisible({ timeout: 2000 })) {
                        log('Found an existing account on screen, clicking it...');
                        await accountLink.click();
                        await sleep(3000);
                        
                        // Check if it asks for a password
                        const passInput = page.locator('input[type="password"]');
                        if (await passInput.isVisible({ timeout: 2000 })) {
                            log('Password required. Waiting for manual intervention...');
                        } else {
                            log('No password required, proceeding...');
                        }
                    }
                } catch (e) {}

                let loginWaitAttempts = 0;
                while (page.url().includes('accounts.google.com') || page.url().includes('signin')) {
                    await sleep(2000);
                    loginWaitAttempts++;
                    if (loginWaitAttempts > 150) {
                        throw new Error('Timeout waiting for manual login (5 minutes).');
                    }
                }
            }
            
            // Ensure we land on the right page after login
            log('Login complete! Ensuring we are on Flow...');
            if (!page.url().includes('tools/flow')) {
                await page.goto(VEO3_FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
            }
            await sleep(4000);
            
            // Try clicking the landing button again if we just logged in
            try {
                const landingBtn = page.locator('button:has-text("Create with Flow"), button:has-text("Tạo bằng Flow"), a:has-text("Create with Flow")').first();
                if (await landingBtn.isVisible({ timeout: 2000 })) {
                    log('Landing page detected again, clicking Create with Flow...');
                    await landingBtn.click();
                    await sleep(5000);
                }
            } catch (e) {}
        }

        // Create new project
        log('Creating new project...');
        try {
            const newProjectBtn = page.locator('button:has-text("Dự án mới"), button:has-text("New project")').first();
            if (await newProjectBtn.isVisible({ timeout: 5000 })) {
                await newProjectBtn.click();
                await sleep(3000);
                log('New project created');
            } else {
                // Maybe already in a project, check for prompt input
                const promptInput = page.locator('textarea, div[contenteditable="true"], input[placeholder*="tạo"], input[placeholder*="create"]').first();
                if (await promptInput.isVisible({ timeout: 3000 })) {
                    log('Already in a project view');
                } else {
                    log('Creating project via alternative method...');
                    // Click the "+" button in the top bar
                    const addBtn = page.locator('button:has(i:text("add_2"))').first();
                    if (await addBtn.isVisible({ timeout: 2000 })) {
                        await addBtn.click();
                        await sleep(3000);
                    }
                }
            }
        } catch (e) {
            log('Project creation: ' + e.message);
        }

        // Setup global download listener to catch both automated and manual downloads
        let currentShotOutput = null;
        let videoSaved = false;
        
        page.on('download', async (download) => {
            if (!currentShotOutput) return;
            log('Download event captured (Automated or Manual)!');
            try {
                fs.mkdirSync(path.dirname(currentShotOutput), { recursive: true });
                await download.saveAs(currentShotOutput);
                if (fs.existsSync(currentShotOutput) && fs.statSync(currentShotOutput).size > 10000) {
                    videoSaved = true;
                    log(`Video successfully saved to ${currentShotOutput}`);
                }
            } catch(e) {
                log('Error saving intercepted download: ' + e.message);
            }
        });

        // Process each shot
        for (let idx = 0; idx < shots.length; idx++) {
            const shot = shots[idx];
            log(`--- Shot ${shot.id} [${idx + 1}/${shots.length}] ---`);
            capturedVideoUrl = null;
            currentShotOutput = shot.output;
            videoSaved = false;

            // Configure settings ONLY on first shot (settings persist for the batch)
            if (idx === 0) {
                try {
                    await _configureSettings(page, shot.aspect_ratio || '9:16');
                } catch (e) {
                    log('Could not configure settings: ' + e.message);
                }
            }

            // Upload reference images (if any)
            const refImages = shot.ref_images || [];
            log(`Ref images: ${refImages.length} file(s)${refImages.length > 0 ? ' → ' + refImages.map(p => path.basename(p)).join(', ') : ''}`);
            if (refImages.length > 0) {
                await _uploadRefImages(page, refImages);
            }

            // Find and fill the prompt input
            let inputEl = null;
            try {
                await sleep(1000);
                
                // Try multiple selectors for the prompt input
                const inputSelectors = [
                    'textarea[placeholder*="tạo"]',
                    'textarea[placeholder*="create"]',
                    'textarea[placeholder*="muốn"]',
                    'textarea',
                    'div[contenteditable="true"]',
                ];
                
                for (let attempt = 0; attempt < 3; attempt++) {
                    for (const sel of inputSelectors) {
                        try {
                            const el = page.locator(sel).last();
                            if (await el.isVisible({ timeout: 1500 })) {
                                inputEl = el;
                                break;
                            }
                        } catch (e) {}
                    }
                    if (inputEl) break;
                    log('Waiting for input box...');
                    await sleep(2000);
                }

                if (!inputEl) throw new Error('Input box not found');

                await inputEl.click();
                await sleep(500);

                // Clear existing text
                await inputEl.fill('');
                await sleep(200);

                // Build prompt with aspect ratio hint
                let promptClean = shot.prompt.replace(/\n+/g, ' ').trim();
                const aspectRatio = shot.aspect_ratio || '9:16';
                if (!promptClean.includes('aspect ratio') && !promptClean.includes('16:9') && !promptClean.includes('9:16')) {
                    const arLabel = aspectRatio === '9:16' ? 'portrait' : aspectRatio === '1:1' ? 'square' : 'widescreen';
                    promptClean += ` Output in ${aspectRatio} ${arLabel} aspect ratio.`;
                }

                try {
                    await inputEl.fill(promptClean);
                } catch (e) {
                    await page.keyboard.type(promptClean, { delay: 5 });
                }
                await sleep(1000);

                // Submit the prompt
                log('Submitting prompt...');
                let submitted = false;

                // Method 1: Click the arrow submit button (the → icon button)
                try {
                    const submitBtn = page.locator('button:has(i:text("arrow_forward"))').last();
                    if (await submitBtn.isVisible({ timeout: 2000 })) {
                        await submitBtn.click();
                        submitted = true;
                        log('Submitted via arrow_forward button');
                    }
                } catch (e) {}

                // Method 2: Try the Tạo (Create) button
                if (!submitted) {
                    try {
                        const createBtn = page.locator('button[aria-label*="Tạo"], button[aria-label*="Create"], button:has-text("Tạo")').last();
                        if (await createBtn.isVisible({ timeout: 1000 })) {
                            await createBtn.click();
                            submitted = true;
                            log('Submitted via Create button');
                        }
                    } catch (e) {}
                }

                // Method 3: Enter key
                if (!submitted) {
                    try {
                        await inputEl.press('Enter');
                        log('Submitted via Enter key');
                    } catch (e) {
                        await page.keyboard.press('Enter');
                    }
                }

                log('Prompt submitted. Waiting for video generation...');
                capturedVideoUrl = null; // Reset after submit

            } catch (e) {
                console.log(JSON.stringify({ status: 'error', shot_id: shot.id, message: 'Could not submit prompt: ' + e.message }));
                continue;
            }

            // Wait for video generation (with retry on failure)
            let deadline = Date.now() + timeout;
            let lastPercent = 0;
            let retryAttempts = 0;
            const MAX_RETRY_CLICKS = 2;
            let promptModified = false;
            
            while (Date.now() < deadline) {
                await sleep(5000);


                // Check for errors / rate limits
                try {
                    const errorText = await page.evaluate(() => {
                        const text = document.body.innerText.toLowerCase();
                        if (text.includes('rate limit') || text.includes('giới hạn')) return 'RATE_LIMIT';
                        if (text.includes('error') && text.includes('generation')) return 'GEN_ERROR';
                        if (text.includes('lỗi') && text.includes('tạo')) return 'GEN_ERROR';
                        return null;
                    });
                    
                    if (errorText === 'RATE_LIMIT') {
                        console.log(JSON.stringify({ status: 'error', shot_id: shot.id, message: 'RATE_LIMIT_REACHED' }));
                        log('Rate limit detected. Aborting.');
                        await context.close();
                        process.exit(1);
                    }
                } catch (e) {}

                // Check if video is being generated (loading/progress indicators)
                let isGenerating = false;
                let actualPercent = null;
                try {
                    const progressInfo = await page.evaluate(() => {
                        // Check for the new Veo 3 progress element: videocam icon + percentage text
                        const videoIcons = document.querySelectorAll('i.google-symbols');
                        for (const icon of videoIcons) {
                            if (icon.textContent.trim() === 'videocam') {
                                const parent = icon.parentElement;
                                if (parent) {
                                    // The percentage is usually in the parent or sibling
                                    const textContent = parent.textContent || '';
                                    const match = textContent.match(/(\d+)%/);
                                    if (match) {
                                        return { generating: true, percent: parseInt(match[1], 10) };
                                    }
                                }
                            }
                        }
                        
                        // Check for spinning/loading indicators
                        const spinners = document.querySelectorAll('[class*="spinner"], [class*="loading"], [class*="progress"]');
                        if (spinners.length > 0) return { generating: true, percent: null };
                        
                        // Check for generation status text
                        const text = document.body.innerText;
                        if (text.includes('Đang tạo') || text.includes('Generating') || text.includes('Processing')) return { generating: true, percent: null };
                        
                        return { generating: false, percent: null };
                    });
                    
                    isGenerating = progressInfo.generating;
                    actualPercent = progressInfo.percent;
                } catch (e) {}

                if (isGenerating) {
                    if (actualPercent !== null) {
                        lastPercent = actualPercent;
                    } else {
                        lastPercent = Math.min(lastPercent + 5, 90);
                    }
                    console.log(JSON.stringify({ status: 'generating', shot_id: shot.id, percent: lastPercent }));
                    log(`Still generating... ${actualPercent !== null ? actualPercent + '%' : '~' + lastPercent + '%'}`);
                    continue;
                }
                // ── Check for generation error ("Không thành công" / "unusual activity") ──
                let tileHasError = false;
                let isHighTraffic = false;
                try {
                    const errState = await page.evaluate(() => {
                        let hasErr = false;
                        let highTraf = false;
                        const body = document.body.innerText;
                        if (body.includes('Không thành công') || body.includes('unusual activity') ||
                            body.includes('could not be generated') || body.includes('không thể tạo')) {
                            hasErr = true;
                        }
                        if (body.includes('lượng truy cập cao') || body.includes('high traffic') || body.includes('thử lại sau vài phút')) {
                            highTraf = true;
                        }
                        // Check for error icon on the latest tile
                        const tiles = document.querySelectorAll('[data-tile-id]');
                        for (const tile of tiles) {
                            const tileText = tile.innerText || '';
                            if (tileText.includes('Không thành công') || tileText.includes('error') ||
                                tile.querySelector('i[class*="error"], i[class*="warning"]')) {
                                hasErr = true;
                            }
                            if (tileText.includes('lượng truy cập cao') || tileText.includes('high traffic')) {
                                highTraf = true;
                            }
                        }
                        return { hasErr, highTraf };
                    });
                    tileHasError = errState.hasErr;
                    isHighTraffic = errState.highTraf;
                } catch (e) {}

                if (tileHasError && retryAttempts < MAX_RETRY_CLICKS) {
                    retryAttempts++;
                    log(`⚠️ Generation error detected! (High Traffic: ${isHighTraffic}). Clicking retry (attempt ${retryAttempts}/${MAX_RETRY_CLICKS})...`);
                    console.log(JSON.stringify({ status: 'generating', shot_id: shot.id, percent: 0, message: `Retry ${retryAttempts}/${MAX_RETRY_CLICKS}${isHighTraffic ? ' (Waiting for traffic)' : ''}` }));
                    
                    if (isHighTraffic) {
                        log('High traffic detected. Waiting 30 seconds before retrying...');
                        await sleep(30000);
                    }
                    
                    await sleep(3000);
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
                                
                                if (iconTexts.includes('refresh') && 
                                    iconTexts.includes('undo') && 
                                    iconTexts.includes('delete_forever') &&
                                    refreshBtn) {
                                    refreshBtn.click();
                                    return true;
                                }
                            }
                            return false;
                        });
                        if (retryClicked) log('✅ Clicked "refresh" button in error action group (refresh+undo+delete_forever)');
                    } catch (e) { log('Method 1 failed: ' + e.message); }
                    
                    if (!retryClicked) {
                        try {
                            const refreshBtns = page.locator('button:has(i:text-is("refresh"))');
                            const count = await refreshBtns.count();
                            for (let b = 0; b < count; b++) {
                                const btn = refreshBtns.nth(b);
                                const parentDiv = btn.locator('xpath=..');
                                const siblingUndo = parentDiv.locator('button:has(i:text-is("undo"))');
                                const siblingDelete = parentDiv.locator('button:has(i:text-is("delete_forever"))');
                                if (await siblingUndo.count() > 0 && await siblingDelete.count() > 0) {
                                    await btn.click();
                                    retryClicked = true;
                                    log('✅ Clicked "refresh" button via Playwright sibling check');
                                    break;
                                }
                            }
                        } catch (e) { log('Method 2 failed: ' + e.message); }
                    }
                    
                    if (retryClicked) {
                        lastPercent = 0;
                        await sleep(10000);
                        deadline = Date.now() + timeout;
                        continue;
                    } else {
                        log('Could not find retry button - all methods failed');
                    }
                }
                
                // ── If all retries exhausted and still error → modify prompt and regenerate ──
                if (tileHasError && retryAttempts >= MAX_RETRY_CLICKS && !promptModified) {
                    if (isHighTraffic) {
                        log(`❌ High traffic persists after ${MAX_RETRY_CLICKS} retries. Aborting shot to save time.`);
                        console.log(JSON.stringify({ status: 'error', shot_id: shot.id, message: 'High traffic. Please try again later.' }));
                        break;
                    }
                    
                    log(`❌ All ${MAX_RETRY_CLICKS} retries failed. Modifying prompt and regenerating...`);
                    console.log(JSON.stringify({ status: 'generating', shot_id: shot.id, percent: 0, message: 'Modifying prompt and retrying...' }));
                    promptModified = true;
                    
                    try { await page.keyboard.press('Escape'); } catch(e) {}
                    await sleep(1000);
                    
                    try {
                        const inputSelectors = [
                            'textarea[placeholder*="tạo"]',
                            'textarea[placeholder*="create"]',
                            'textarea[placeholder*="muốn"]',
                            'textarea',
                            'div[contenteditable="true"]',
                        ];
                        let retryInput = null;
                        for (const sel of inputSelectors) {
                            try {
                                const el = page.locator(sel).last();
                                if (await el.isVisible({ timeout: 1500 })) {
                                    retryInput = el;
                                    break;
                                }
                            } catch (e) {}
                        }
                        
                        if (retryInput) {
                            await retryInput.click();
                            await sleep(500);
                            
                            let newPrompt = shot.prompt.replace(/\n+/g, ' ').trim();
                            newPrompt = newPrompt
                                .replace(/blood|gore|violence|weapon|gun|knife|死|殺|暴力/gi, '')
                                .replace(/\s{2,}/g, ' ')
                                .trim();
                            newPrompt = `A cinematic scene: ${newPrompt}`;
                            const aspectRatio = shot.aspect_ratio || '9:16';
                            if (!newPrompt.includes('aspect ratio')) {
                                const arLabel = aspectRatio === '9:16' ? 'portrait' : aspectRatio === '1:1' ? 'square' : 'widescreen';
                                newPrompt += ` Output in ${aspectRatio} ${arLabel} aspect ratio.`;
                            }
                            
                            await retryInput.fill('');
                            await sleep(200);
                            try {
                                await retryInput.fill(newPrompt);
                            } catch(e) {
                                await page.keyboard.type(newPrompt, { delay: 5 });
                            }
                            await sleep(1000);
                            
                            let submitted = false;
                            try {
                                const submitBtn = page.locator('button:has(i:text("arrow_forward"))').last();
                                if (await submitBtn.isVisible({ timeout: 2000 })) {
                                    await submitBtn.click();
                                    submitted = true;
                                }
                            } catch (e) {}
                            if (!submitted) {
                                try {
                                    const createBtn = page.locator('button[aria-label*="Tạo"], button[aria-label*="Create"], button:has-text("Tạo")').last();
                                    if (await createBtn.isVisible({ timeout: 1000 })) {
                                        await createBtn.click();
                                        submitted = true;
                                    }
                                } catch (e) {}
                            }
                            if (!submitted) {
                                await page.keyboard.press('Enter');
                            }
                            
                            log('Modified prompt submitted! Waiting for regeneration...');
                            capturedVideoUrl = null;
                            videoSaved = false;
                            lastPercent = 0;
                            retryAttempts = 0;
                            deadline = Date.now() + timeout;
                            await sleep(10000);
                            continue;
                        }
                    } catch (e) {
                        log('Prompt modification failed: ' + e.message);
                    }
                }
                
                if (tileHasError) {
                    if (retryAttempts >= MAX_RETRY_CLICKS && promptModified) {
                        log('❌ All retries and prompt modifications failed. Giving up on this shot.');
                        break;
                    }
                    continue;
                }

                // Strategy 1: UI Download via Context Menu + Network Interception
                if (!videoSaved) {
                    try {
                        const latestTile = page.locator('[data-tile-id]').first();
                        if (await latestTile.isVisible({ timeout: 1000 })) {
                            log('Strategy 1: Opening context menu on latest tile...');
                            
                            // Setup network interceptor to catch the download URL
                            let downloadUrl = null;
                            const downloadHandler = async (response) => {
                                const url = response.url();
                                const ct = response.headers()['content-type'] || '';
                                if (ct.startsWith('video/') || (url.includes('.mp4') && !url.includes('_next/'))) {
                                    downloadUrl = url;
                                    log('*** Network intercepted download URL: ' + url.substring(0, 150));
                                }
                            };
                            page.on('response', downloadHandler);
                            
                            // Method A: Try right-click on the tile
                            await latestTile.click({ button: 'right' });
                            await sleep(2000);
                            
                            // Check if context menu appeared by looking for "Tải xuống" text anywhere
                            let downloadItem = page.locator('text="Tải xuống"').first();
                            let menuOpened = false;
                            try {
                                menuOpened = await downloadItem.isVisible({ timeout: 2000 });
                            } catch(e) {}
                            
                            // Method B: If right-click didn't work, try the 3-dot (more_vert) button
                            if (!menuOpened) {
                                log('Right-click menu not found, trying 3-dot button...');
                                await page.keyboard.press('Escape');
                                await sleep(500);
                                // Hover the tile first to make the 3-dot button appear
                                await latestTile.hover();
                                await sleep(1000);
                                const moreBtn = latestTile.locator('button:has(i:text("more_vert")), button[aria-label*="menu"], button[aria-label*="More"]').first();
                                try {
                                    if (await moreBtn.isVisible({ timeout: 2000 })) {
                                        await moreBtn.click();
                                        await sleep(2000);
                                        try {
                                            menuOpened = await downloadItem.isVisible({ timeout: 2000 });
                                        } catch(e) {}
                                    }
                                } catch(e) {}
                            }
                            
                            if (menuOpened) {
                                log('Context menu visible. Hovering "Tải xuống"...');
                                await downloadItem.hover();
                                await sleep(2000);
                                
                                // Now look for 720p in the sub-menu
                                const res720 = page.locator('text="720p"').first();
                                let found720 = false;
                                try {
                                    found720 = await res720.isVisible({ timeout: 3000 });
                                } catch(e) {}
                                
                                if (found720) {
                                    log('Found 720p option, hovering then clicking...');
                                    await res720.hover();
                                    await sleep(500);
                                    await res720.click();
                                    log('Clicked 720p! Waiting for download...');
                                    
                                    // Wait for either: download event, network intercept, or captured URL
                                    for (let w = 0; w < 30; w++) {
                                        if (videoSaved || downloadUrl) break;
                                        await sleep(1000);
                                    }
                                    

                                    if (videoSaved) {
                                        log('Video saved by global download listener!');
                                    }
                                    // If network intercepted a URL, download it manually
                                    else if (downloadUrl) {
                                        log('Downloading from intercepted URL: ' + downloadUrl.substring(0, 150));
                                        try {
                                            fs.mkdirSync(path.dirname(shot.output), { recursive: true });
                                            const vidResp = await page.request.get(downloadUrl);
                                            if (vidResp.ok()) {
                                                fs.writeFileSync(shot.output, await vidResp.body());
                                                if (fs.statSync(shot.output).size > 10000) {
                                                    videoSaved = true;
                                                    log('Video downloaded from network URL!');
                                                }
                                            }
                                        } catch(e) {
                                            log('Network download failed: ' + e.message);
                                        }
                                    }
                                    // Check capturedVideoUrl from the existing response listener
                                    else if (capturedVideoUrl) {
                                        log('Downloading from captured CDN URL: ' + capturedVideoUrl.substring(0, 150));
                                        try {
                                            fs.mkdirSync(path.dirname(shot.output), { recursive: true });
                                            const vidResp = await page.request.get(capturedVideoUrl);
                                            if (vidResp.ok()) {
                                                fs.writeFileSync(shot.output, await vidResp.body());
                                                if (fs.statSync(shot.output).size > 10000) {
                                                    videoSaved = true;
                                                    log('Video downloaded from CDN URL!');
                                                }
                                            }
                                        } catch(e) {
                                            log('CDN download failed: ' + e.message);
                                        }
                                    } else {
                                        log('No download detected after clicking 720p.');
                                    }
                                } else {
                                    log('720p option not visible in sub-menu.');
                                    await page.keyboard.press('Escape');
                                }
                            } else {
                                log('Could not open context menu on tile.');
                            }
                            
                            // Cleanup handler
                            page.removeListener('response', downloadHandler);
                        }
                    } catch (e) {
                        log('Strategy 1 failed: ' + e.message);
                        try { await page.keyboard.press('Escape'); } catch(x) {}
                    }
                }

                // Strategy 2: Blob extraction (Fallback)
                if (!videoSaved) {
                    try {
                        const videoBase64 = await page.evaluate(async () => {
                            const videos = document.querySelectorAll('video');
                            for (const vid of videos) {
                                if (vid.src && vid.src.startsWith('blob:')) {
                                    try {
                                        const resp = await fetch(vid.src);
                                        const blob = await resp.blob();
                                        if (blob.size < 10000) continue;
                                        const reader = new FileReader();
                                        return await new Promise((resolve) => {
                                            reader.onload = () => resolve(reader.result.split(',')[1]);
                                            reader.readAsDataURL(blob);
                                        });
                                    } catch (e) {}
                                }
                            }
                            return null;
                        });

                        if (videoBase64) {
                            fs.mkdirSync(path.dirname(shot.output), { recursive: true });
                            fs.writeFileSync(shot.output, Buffer.from(videoBase64, 'base64'));
                            if (fs.statSync(shot.output).size > 10000) {
                                videoSaved = true;
                                log('Strategy 2: Blob video saved!');
                            }
                        }
                    } catch (e) {}
                }

                if (videoSaved) {
                    log('Video saved successfully!');
                    break;
                }
            }

            if (!videoSaved) {
                const retryInfo = retryAttempts > 0 ? ` (after ${retryAttempts} retries${promptModified ? ' + prompt modification' : ''})` : '';
                console.log(JSON.stringify({ status: 'error', shot_id: shot.id, message: `Timeout waiting for video${retryInfo}` }));
            } else {
                console.log(JSON.stringify({ status: 'success', shot_id: shot.id, path: shot.output }));
            }
            await sleep(3000);
        }

        // Save cookies
        try {
            const cookies = await context.cookies();
            fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
        } catch (e) {}
        await context.close();

    } catch (e) {
        log(`Error: ${e.message}`);
        console.error(JSON.stringify({ status: 'error', message: e.message }));
        try { await context.close(); } catch {}
        process.exit(1);
    }
})();


// ── Helper Functions ──

async function _configureSettings(page, targetAR) {
    try {
        log('Configuring settings (Mode & Aspect Ratio)...');
        
        // Wait for prompt area to load
        try {
            const taLocator = page.locator('textarea, div[contenteditable="true"]').last();
            await taLocator.waitFor({ state: 'visible', timeout: 8000 });
        } catch(e) {
            log('Wait for textarea timeout in settings config');
        }
        await sleep(1000);
        
        // ── Step 1: Find and identify the settings chip button ──
        // The chip shows current mode info like "🍌 Nano Banana 2 crop_9_16 1x" (image mode)
        // or "Veo 2 crop_9_16 5s" (video mode)
        
        let settingsChip = null;
        
        // Method A: Find button with aria-haspopup="menu" near the prompt area
        // The settings chip always has aria-haspopup="menu" and contains model info
        try {
            const chips = page.locator('button[aria-haspopup="menu"]');
            const count = await chips.count();
            log(`Found ${count} buttons with aria-haspopup="menu"`);
            
            for (let i = count - 1; i >= 0; i--) {
                const chip = chips.nth(i);
                try {
                    const text = await chip.textContent({ timeout: 1000 });
                    const lower = (text || '').toLowerCase();
                    // Settings chip contains model names or mode indicators
                    if (lower.includes('banana') || lower.includes('imagen') || 
                        lower.includes('veo') || lower.includes('1x') || 
                        lower.includes('5s') || lower.includes('crop_')) {
                        settingsChip = chip;
                        log(`Found settings chip (Method A): "${text.trim().substring(0, 50)}"`);
                        break;
                    }
                } catch(e) {}
            }
        } catch(e) {}
        
        // Method B: Walk up from textarea to find the button
        if (!settingsChip) {
            try {
                const found = await page.evaluate(() => {
                    const ta = document.querySelector('textarea, div[contenteditable="true"]');
                    if (!ta) return null;
                    let container = ta.parentElement;
                    for (let i = 0; i < 5 && container; i++) {
                        const buttons = Array.from(container.querySelectorAll('button[aria-haspopup="menu"]'));
                        if (buttons.length > 0) {
                            // Return info about the last one (closest to submit)
                            const btn = buttons[buttons.length - 1];
                            return btn.textContent.trim().substring(0, 80);
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
            log('❌ Could not find settings chip button');
            return;
        }
        
        // ── Step 2: Check current mode before clicking ──
        let currentText = '';
        try {
            currentText = (await settingsChip.textContent({ timeout: 2000 })).toLowerCase();
        } catch(e) {}
        
        const isCurrentlyVideo = currentText.includes('veo') || currentText.includes('5s') || currentText.includes('8s');
        const isCurrentlyImage = currentText.includes('banana') || currentText.includes('imagen') || currentText.includes('1x');
        log(`Current mode: ${isCurrentlyVideo ? 'VIDEO' : isCurrentlyImage ? 'IMAGE' : 'UNKNOWN'} (text: "${currentText.trim().substring(0, 50)}")`);
        
        // ── Step 3: Click the chip to open popup ──
        await settingsChip.click();
        await sleep(2000);
        
        // ── Step 4: Switch to Video mode + Thành phần (Composition) ──
        // Radix UI tabs use role="tab" with data-state="active"/"inactive"
        // DOM .click() does NOT work — must use Playwright .click() for real mouse events
        //
        // Tab structure:
        //   <button role="tab" id="radix-:xxx:-trigger-VIDEO" data-state="inactive">
        //     <i class="google-symbols">videocam</i>Video
        //   </button>
        
        // Click "Video" tab
        log('Selecting Video mode...');
        let videoClicked = false;
        
        // Method 1: Radix ID selector (most reliable)
        try {
            const videoTab = page.locator('button[role="tab"][id*="trigger-VIDEO"], button[role="tab"][id*="VIDEO"]').first();
            if (await videoTab.isVisible({ timeout: 2000 })) {
                const state = await videoTab.getAttribute('data-state');
                log(`Video tab found, state: ${state}`);
                if (state !== 'active') {
                    await videoTab.click();
                    videoClicked = true;
                    log('✅ Clicked Video tab via Radix ID');
                } else {
                    videoClicked = true;
                    log('✅ Video tab already active');
                }
            }
        } catch(e) { log('Video tab Method 1: ' + e.message); }
        
        // Method 2: Find tab with "videocam" icon
        if (!videoClicked) {
            try {
                const videoTab = page.locator('button[role="tab"]:has(i:text("videocam"))').first();
                if (await videoTab.isVisible({ timeout: 1500 })) {
                    await videoTab.click();
                    videoClicked = true;
                    log('✅ Clicked Video tab via videocam icon');
                }
            } catch(e) {}
        }
        
        // Method 3: Text-based (Playwright click, not DOM)
        if (!videoClicked) {
            try {
                const videoTab = page.locator('button[role="tab"]:has-text("Video")').first();
                if (await videoTab.isVisible({ timeout: 1500 })) {
                    await videoTab.click();
                    videoClicked = true;
                    log('✅ Clicked Video tab via text match');
                }
            } catch(e) {}
        }
        
        log(videoClicked ? '✅ Video mode selected' : '⚠️ Could not select Video mode');
        await sleep(1500);
        
        // Click "Thành phần" (Composition) tab
        log('Selecting Thành phần (Composition)...');
        let compClicked = false;
        
        // Method 1: Radix ID selector
        try {
            const compTab = page.locator('button[role="tab"][id*="trigger-VIDEO_REFERENCES"], button[role="tab"][id*="VIDEO_REFERENCES"]').first();
            if (await compTab.isVisible({ timeout: 2000 })) {
                const state = await compTab.getAttribute('data-state');
                log(`Composition tab found, state: ${state}`);
                if (state !== 'active') {
                    await compTab.click();
                    compClicked = true;
                    log('✅ Clicked Composition tab via Radix ID');
                } else {
                    compClicked = true;
                    log('✅ Composition tab already active');
                }
            }
        } catch(e) { log('Composition tab Method 1: ' + e.message); }
        
        // Method 2: Find tab with "chrome_extension" icon
        if (!compClicked) {
            try {
                const compTab = page.locator('button[role="tab"]:has(i:text("chrome_extension"))').first();
                if (await compTab.isVisible({ timeout: 1500 })) {
                    await compTab.click();
                    compClicked = true;
                    log('✅ Clicked Composition tab via icon');
                }
            } catch(e) {}
        }
        
        // Method 3: Text-based (Vietnamese + English)
        if (!compClicked) {
            try {
                const compTab = page.locator('button[role="tab"]:has-text("Thành phần"), button[role="tab"]:has-text("Ingredients")').first();
                if (await compTab.isVisible({ timeout: 1500 })) {
                    await compTab.click();
                    compClicked = true;
                    log('✅ Clicked Composition tab via text match');
                }
            } catch(e) {}
        }
        
        log(compClicked ? '✅ Thành phần selected' : '⚠️ Could not select Thành phần');
        await sleep(1000);
        
        // ── Step 5: Set Aspect Ratio ──
        const arMap = { '4:3': '16:9', '3:4': '9:16' };
        const ar = arMap[targetAR] || targetAR || '9:16';
        
        // AR buttons are also Radix tabs with role="tab"
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
        
        // Method 2: Find by icon "crop_9_16" or "crop_16_9"
        if (!arClicked) {
            const cropIcon = ar === '9:16' ? 'crop_9_16' : ar === '16:9' ? 'crop_16_9' : `crop_${arId}`;
            try {
                const arTab = page.locator(`button[role="tab"]:has(i:text("${cropIcon}"))`).first();
                if (await arTab.isVisible({ timeout: 1500 })) {
                    await arTab.click();
                    arClicked = true;
                    log(`✅ Set AR to ${ar} via crop icon`);
                }
            } catch(e) {}
        }
        
        // Method 3: Text match
        if (!arClicked) {
            try {
                const arTab = page.locator(`button[role="tab"]:has-text("${ar}")`).first();
                if (await arTab.isVisible({ timeout: 1500 })) {
                    await arTab.click();
                    arClicked = true;
                }
            } catch(e) {}
        }
        
        log(arClicked ? `✅ Aspect ratio set to ${ar}` : `⚠️ Could not set AR to ${ar}`);
        
        await sleep(500);
        
        // Close popup
        await page.keyboard.press('Escape');
        await sleep(500);
        
        // ── Step 6: Verify final state ──
        try {
            const finalText = await settingsChip.textContent({ timeout: 2000 });
            const finalLower = (finalText || '').toLowerCase();
            const isVideo = finalLower.includes('veo') || finalLower.includes('video') || 
                           finalLower.includes('5s') || finalLower.includes('8s') || finalLower.includes('4s');
            log(`Final chip: "${(finalText || '').trim().substring(0, 60)}" → ${isVideo ? '✅ VIDEO' : '❌ IMAGE'}`);
            
            if (!isVideo) {
                log('⚠️ Still image mode — reopening for force switch...');
                await settingsChip.click();
                await sleep(2000);
                
                // Force click via Playwright
                try {
                    const vTab = page.locator('button[role="tab"][id*="VIDEO"], button[role="tab"]:has(i:text("videocam"))').first();
                    if (await vTab.isVisible({ timeout: 1500 })) await vTab.click();
                } catch(e) {}
                await sleep(1000);
                try {
                    const cTab = page.locator('button[role="tab"][id*="VIDEO_REFERENCES"], button[role="tab"]:has-text("Thành phần"), button[role="tab"]:has-text("Ingredients")').first();
                    if (await cTab.isVisible({ timeout: 1500 })) await cTab.click();
                } catch(e) {}
                await sleep(500);
                
                await page.keyboard.press('Escape');
                await sleep(500);
            }
        } catch(e) {}
        
    } catch (e) {
        log('_configureSettings error: ' + e.message);
        try { await page.keyboard.press('Escape'); } catch(x) {}
    }
}


async function _uploadRefImages(page, refImages) {
    log(`Uploading ${refImages.length} reference image(s)...`);
    
    for (const imgPath of refImages) {
        if (!fs.existsSync(imgPath)) {
            log(`  Ref image not found, skipping: ${imgPath}`);
            continue;
        }
        
        try {
            let uploaded = false;
            // Click the "+" button near the prompt to open upload dialog
            // Note: Use .last() because .first() might click the "New Project" (Dự án mới) button in the header
            const addBtn = page.locator('button:has(i:text("add_2"))').last();
            if (await addBtn.isVisible({ timeout: 2000 })) {
                await addBtn.click();
                await sleep(1500);
                
                // Look for upload area (the icon with text "upload")
                const uploadArea = page.locator('i:text-is("upload")').first();
                if (await uploadArea.isVisible({ timeout: 3000 })) {
                    // Count existing images in prompt area to know when upload finishes
                    const prevImgCount = await page.evaluate(() => document.querySelectorAll('img').length);

                    const [fileChooser] = await Promise.all([
                        page.waitForEvent('filechooser', { timeout: 5000 }),
                        uploadArea.click(),
                    ]);
                    await fileChooser.setFiles(imgPath);
                    uploaded = true;
                    log(`  Uploaded ref image via dialog: ${path.basename(imgPath)}`);
                    
                    // Wait until the number of images increases (meaning upload finished) or 15s timeout
                    log('  Waiting for image upload to complete...');
                    for (let i = 0; i < 30; i++) {
                        await sleep(500);
                        const currentImgCount = await page.evaluate(() => document.querySelectorAll('img').length);
                        if (currentImgCount > prevImgCount) {
                            log('  Image successfully attached to prompt!');
                            break;
                        }
                    }
                    await sleep(1000); // Extra buffer after upload
                } else {
                    log(`  Upload area not found after clicking +`);
                    try { await page.keyboard.press('Escape'); } catch(x) {}
                }
            } else {
                log(`  + button for upload not found`);
            }
            
            if (!uploaded) {
                log(`  Could not upload ref image — skipping`);
            }
        } catch (e) {
            log(`  Failed to upload ref image ${path.basename(imgPath)}: ${e.message}`);
            try { await page.keyboard.press('Escape'); } catch(x) {}
        }
    }
    await sleep(1000);
}
