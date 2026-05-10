#!/usr/bin/env node
/**
 * chatgpt_image.js — Generate images from ChatGPT using TubeCLI browser profile.
 * Processes multiple jobs sequentially using chatgpt.com.
 * 
 * Usage: node chatgpt_image.js --profile <name> --jobs <path_to_jobs.json> --profiles-dir <dir> [--timeout 120]
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
const headless = args.headless === 'true';
const perJobTimeout = parseInt(args.timeout || '120') * 1000;

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

function log(msg) { process.stderr.write('[ChatGPTImg] ' + msg + '\n'); }
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
    log(`Profile: ${profileName}, Batch: ${jobs.length} images`);

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
            viewport: { width: 1280, height: 900 },
        });

        if (fs.existsSync(cookiesPath)) {
            try {
                const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
                if (Array.isArray(cookies) && cookies.length > 0) await context.addCookies(cookies);
            } catch (e) {}
        }

        const page = context.pages()[0] || await context.newPage();

        // Navigate to ChatGPT
        log('Navigating to chatgpt.com...');
        await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(4000);

        // Check login status
        const isLoggedIn = await page.evaluate(() => {
            const body = document.body.innerText.toLowerCase();
            return !body.includes('log in') || body.includes('new chat') || body.includes('chatgpt');
        });

        if (!isLoggedIn) {
            log('Not logged in!');
            console.log(JSON.stringify({ status: 'error', message: `Profile "${profileName}" is not logged into ChatGPT.` }));
            await context.close();
            process.exit(1);
        }
        log('Logged in OK');

        // Process each job
        for (let ji = 0; ji < jobs.length; ji++) {
            const job = jobs[ji];
            log(`\n--- Job ${ji+1}/${jobs.length}: ${job.id} ---`);

            let saved = false;

            try {
                // Start new chat for each image to avoid context pollution
                log('Starting new chat...');
                try {
                    // Click "New chat" button
                    const newChatBtn = page.locator('a[href="/"], button:has-text("New chat"), nav a[data-testid="create-new-chat-button"]').first();
                    if (await newChatBtn.isVisible({ timeout: 3000 })) {
                        await newChatBtn.click();
                        await sleep(2000);
                    } else {
                        await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
                        await sleep(3000);
                    }
                } catch(e) {
                    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
                    await sleep(3000);
                }

                // Find prompt input
                let inputEl = null;
                const inputSelectors = [
                    'div[id="prompt-textarea"]',
                    'textarea[data-id="root"]',
                    'div[contenteditable="true"]',
                    'textarea',
                ];

                for (let a = 0; a < 5; a++) {
                    for (const sel of inputSelectors) {
                        try {
                            const el = page.locator(sel).last();
                            if (await el.isVisible({ timeout: 2000 })) { inputEl = el; break; }
                        } catch(e) {}
                    }
                    if (inputEl) break;
                    log('Waiting for input...');
                    await sleep(2000);
                }

                if (!inputEl) {
                    console.log(JSON.stringify({ status: 'error', id: job.id, message: 'Prompt input not found' }));
                    failCount++; continue;
                }

                // Upload reference images if provided
                const refImages = job.ref_images || [];
                if (refImages.length > 0) {
                    log(`Uploading ${refImages.length} reference images...`);
                    for (let ri = 0; ri < refImages.length; ri++) {
                        const refPath = refImages[ri];
                        if (!fs.existsSync(refPath)) {
                            log(`  Ref image not found: ${refPath} — skipping`);
                            continue;
                        }
                        try {
                            // ChatGPT has a hidden file input we can use
                            // First try to find any file input on the page
                            let fileInput = null;
                            
                            // Method 1: Look for existing hidden file input
                            try {
                                fileInput = await page.$('input[type="file"]');
                            } catch(e) {}
                            
                            // Method 2: Click the attach/paperclip button to trigger the file input
                            if (!fileInput) {
                                try {
                                    const attachBtn = page.locator('button[aria-label*="Attach"], button[aria-label*="attach"], button[aria-label*="Upload"], button[data-testid*="attach"], button[data-testid*="upload"]').first();
                                    if (await attachBtn.isVisible({ timeout: 2000 })) {
                                        await attachBtn.click();
                                        await sleep(1000);
                                    }
                                } catch(e) {}
                                
                                // After clicking attach, look for file input or upload option
                                try {
                                    // Look for "Upload from computer" menu item
                                    const uploadOption = page.locator('div[role="menuitem"]:has-text("Upload"), button:has-text("Upload from computer"), div:has-text("Upload from computer")').first();
                                    if (await uploadOption.isVisible({ timeout: 2000 })) {
                                        await uploadOption.click();
                                        await sleep(500);
                                    }
                                } catch(e) {}
                                
                                try {
                                    fileInput = await page.$('input[type="file"]');
                                } catch(e) {}
                            }
                            
                            if (fileInput) {
                                await fileInput.setInputFiles(refPath);
                                log(`  ✓ Uploaded ref image ${ri+1}/${refImages.length}: ${path.basename(refPath)}`);
                                await sleep(3000); // Wait for upload to complete
                                
                                // Wait for the image to be uploaded/processed by ChatGPT
                                await page.waitForTimeout(2000);
                            } else {
                                log(`  ✗ Could not find file input for ref image upload`);
                            }
                        } catch(e) {
                            log(`  ✗ Failed to upload ref image: ${e.message}`);
                        }
                    }
                    // Extra wait after all uploads
                    await sleep(2000);
                }

                // Build prompt: Ask ChatGPT to generate an image
                const imgPrompt = `Generate an image: ${job.prompt.replace(/\n+/g, ' ').trim()}`;

                // Type prompt
                await inputEl.click(); await sleep(300);
                try {
                    // ChatGPT uses contenteditable div, need to handle differently
                    await inputEl.fill('');
                    await sleep(200);
                    await inputEl.fill(imgPrompt);
                } catch(e) {
                    // Fallback: use keyboard
                    await page.keyboard.type(imgPrompt, { delay: 5 });
                }
                await sleep(1000);

                // Submit
                log('Submitting prompt...');
                let submitted = false;

                // Method 1: Send button (data-testid)
                try {
                    const sendBtn = page.locator('button[data-testid="send-button"]').first();
                    if (await sendBtn.isVisible({ timeout: 2000 })) {
                        await sendBtn.click();
                        submitted = true;
                        log('Submitted via send button');
                    }
                } catch(e) {}

                // Method 2: Any button with arrow SVG near input
                if (!submitted) {
                    try {
                        const sendBtn = page.locator('button:has(svg):near(div[id="prompt-textarea"])').last();
                        if (await sendBtn.isVisible({ timeout: 1000 })) {
                            await sendBtn.click();
                            submitted = true;
                        }
                    } catch(e) {}
                }

                // Method 3: Enter key
                if (!submitted) {
                    await page.keyboard.press('Enter');
                    log('Submitted via Enter');
                }

                log('Prompt submitted. Waiting for image generation...');
                
                const jobDeadline = Date.now() + perJobTimeout;
                let capturedImageUrl = null;

                // Setup network listener for generated image URLs
                const imgHandler = async (response) => {
                    try {
                        const url = response.url();
                        const ct = response.headers()['content-type'] || '';
                        if (ct.startsWith('image/') && 
                            (url.includes('oaidalleapiprodscus') || url.includes('openai') || 
                             url.includes('dalle') || url.includes('blob.core.windows.net') ||
                             url.includes('chatgpt.com/backend') || url.includes('/files/') ||
                             url.includes('estuary'))) {
                            capturedImageUrl = url;
                            log('Captured image URL from network: ' + url.substring(0, 120));
                        }
                    } catch(e) {}
                };
                page.on('response', imgHandler);

                // ═══ PHASE 1: Wait for generation to START ═══
                // Detect: image-gen-loading-state-dots appears
                log('Phase 1: Waiting for image generation to start...');
                let genStarted = false;
                let loadingDotsEverSeen = false;
                for (let w = 0; w < 60 && !genStarted; w++) { // Max 120s (image gen can take time to start)
                    await sleep(2000);
                    try {
                        const phase1Status = await page.evaluate(() => {
                            if (document.querySelector('[data-testid="image-gen-loading-state-dots"]')) return 'loading-dots';
                            if (document.querySelector('[data-testid="loading-halftone-dots-animation"]')) return 'loading-dots';
                            const streaming = document.querySelectorAll('.result-streaming, [data-state="streaming"]');
                            if (streaming.length > 0) return 'text-streaming';
                            return 'idle';
                        });
                        
                        if (phase1Status === 'loading-dots') {
                            genStarted = true;
                            loadingDotsEverSeen = true;
                            log('✓ Image generation started! (loading dots detected)');
                        } else if (phase1Status === 'text-streaming') {
                            log(`Phase 1: ChatGPT is typing text... waiting for image gen (check #${w+1})`);
                        } else {
                            // idle — might be between text and image gen, or gen hasn't started
                            if (w > 5) { // After 10s of waiting
                                log(`Phase 1: Idle, check #${w+1} — still waiting for loading dots...`);
                            }
                        }
                    } catch(e) {}
                }
                if (!genStarted) {
                    log('Warning: image loading dots not detected after 120s, will try to download anyway...');
                }

                // ═══ PHASE 2: Wait for generation to FINISH ═══
                // Detect: image-gen-loading-state-dots disappears
                log('Phase 2: Waiting for image generation to finish...');
                let genFinished = false;
                let checkCount = 0;
                let idleCount = 0; // Track consecutive idle checks
                
                // Only run Phase 2 if we actually saw the loading dots
                if (loadingDotsEverSeen) {
                    while (Date.now() < jobDeadline && !genFinished) {
                        await sleep(5000);
                        checkCount++;

                        // Check rate limit — ONLY look at active banners/popups, not old messages
                        try {
                            const rl = await page.evaluate(() => {
                                const banners = document.querySelectorAll('[role="alert"], [class*="banner"], [class*="notice"], [class*="toast"]');
                                for (const el of banners) {
                                    const text = el.innerText.toLowerCase();
                                    if (text.includes('rate limit') || text.includes('too many requests') ||
                                        text.includes('usage cap') || text.includes('image creation limit')) {
                                        return true;
                                    }
                                }
                                const bottomNotices = document.querySelectorAll('.text-sm.text-token-text-secondary');
                                for (const el of bottomNotices) {
                                    const text = el.innerText.toLowerCase();
                                    if ((text.includes('reached') && text.includes('limit')) ||
                                        text.includes('upgrade to chatgpt plus')) {
                                        return true;
                                    }
                                }
                                return false;
                            });
                            if (rl) {
                                log('Rate limit banner detected! Will try to download anyway...');
                                break;
                            }
                        } catch(e) {}

                        // Check if generation is still in progress
                        try {
                            const status = await page.evaluate(() => {
                                if (document.querySelector('[data-testid="image-gen-loading-state-dots"]')) return 'image-generating';
                                if (document.querySelector('[data-testid="loading-halftone-dots-animation"]')) return 'image-generating';
                                const streaming = document.querySelectorAll('.result-streaming, [data-state="streaming"]');
                                if (streaming.length > 0) return 'streaming';
                                const stopBtns = document.querySelectorAll('button[aria-label="Stop generating"], button[aria-label="Dừng tạo"], button[data-testid="stop-button"]');
                                for (const btn of stopBtns) {
                                    if (btn.offsetParent !== null) return 'stop-button';
                                }
                                return 'idle';
                            });
                            
                            log(`Check #${checkCount}: status=${status}`);
                            
                            if (status === 'idle') {
                                idleCount++;
                                if (idleCount >= 2) { // Need 2 consecutive idle checks (10s)
                                    log('Generation finished! Waiting 8s for image to fully render...');
                                    await sleep(8000);
                                    genFinished = true;
                                }
                            } else {
                                idleCount = 0; // Reset if not idle
                            }
                        } catch(e) {
                            log(`Check #${checkCount} error: ${e.message}`);
                        }
                    }
                } else {
                    // Never saw loading dots — wait a fixed time then proceed
                    log('Loading dots never appeared, waiting 30s then proceeding to download...');
                    await sleep(30000);
                    genFinished = true;
                }
                
                if (!genFinished) {
                    log('Warning: generation timeout reached');
                }

                // ═══ PHASE 3: Download the generated image ═══
                log('Phase 3: Finding and downloading generated image...');
                
                // Helper: fetch image inside browser context (has full cookies/session)
                const fetchImageInBrowser = async (url) => {
                    try {
                        const base64 = await page.evaluate(async (imgUrl) => {
                            try {
                                const resp = await fetch(imgUrl, { credentials: 'include' });
                                if (!resp.ok) return null;
                                const blob = await resp.blob();
                                return new Promise((resolve) => {
                                    const reader = new FileReader();
                                    reader.onloadend = () => resolve(reader.result);
                                    reader.onerror = () => resolve(null);
                                    reader.readAsDataURL(blob);
                                });
                            } catch(e) { return null; }
                        }, url);
                        
                        if (base64 && base64.includes(',')) {
                            const data = base64.split(',')[1];
                            return Buffer.from(data, 'base64');
                        }
                    } catch(e) {
                        log('In-browser fetch error: ' + e.message);
                    }
                    return null;
                };
                
                // Find the last large image src (generated image = last in conversation)
                let lastLargeImgSrc = null;
                try {
                    lastLargeImgSrc = await page.evaluate(() => {
                        const imgs = Array.from(document.querySelectorAll('img'));
                        for (let i = imgs.length - 1; i >= 0; i--) {
                            const img = imgs[i];
                            const w = img.naturalWidth || img.width || 0;
                            const h = img.naturalHeight || img.height || 0;
                            if (w < 150 || h < 150) continue;
                            const src = img.src || '';
                            if (src.includes('avatar') || src.includes('favicon') || src.includes('sprite')) continue;
                            if (src.startsWith('data:') || src.startsWith('blob:')) continue;
                            return src;
                        }
                        return null;
                    });
                    log(`Last large image src: ${lastLargeImgSrc ? lastLargeImgSrc.substring(0, 120) : 'NONE'}`);
                } catch(e) {
                    log('Error finding last image: ' + e.message);
                }
                
                // METHOD 1: In-browser fetch of captured network URL
                if (!saved && capturedImageUrl) {
                    log('Method 1: In-browser fetch of network URL...');
                    try {
                        const buf = await fetchImageInBrowser(capturedImageUrl);
                        if (buf && buf.length > 5000) {
                            fs.mkdirSync(path.dirname(job.output), { recursive: true });
                            fs.writeFileSync(job.output, buf);
                            saved = true;
                            log(`✓ Method 1 success! (${buf.length} bytes)`);
                        } else {
                            log(`Method 1: ${buf ? 'too small (' + buf.length + ' bytes)' : 'fetch returned null'}`);
                        }
                    } catch(e) {
                        log('Method 1 error: ' + e.message);
                    }
                }
                
                // METHOD 2: In-browser fetch of last large image src
                if (!saved && lastLargeImgSrc) {
                    log('Method 2: In-browser fetch of last large image...');
                    try {
                        const buf = await fetchImageInBrowser(lastLargeImgSrc);
                        if (buf && buf.length > 5000) {
                            fs.mkdirSync(path.dirname(job.output), { recursive: true });
                            fs.writeFileSync(job.output, buf);
                            saved = true;
                            log(`✓ Method 2 success! (${buf.length} bytes)`);
                        } else {
                            log(`Method 2: ${buf ? 'too small (' + buf.length + ' bytes)' : 'fetch returned null'}`);
                        }
                    } catch(e) {
                        log('Method 2 error: ' + e.message);
                    }
                }
                
                // METHOD 3: Screenshot of the last large image element
                if (!saved) {
                    log('Method 3: Taking screenshot of generated image element...');
                    try {
                        const allImgs = page.locator('img');
                        const totalImgs = await allImgs.count();
                        for (let ii = totalImgs - 1; ii >= 0; ii--) {
                            const img = allImgs.nth(ii);
                            try {
                                const box = await img.boundingBox();
                                if (!box || box.width < 150 || box.height < 150) continue;
                                const src = await img.getAttribute('src') || '';
                                if (src.includes('avatar') || src.includes('favicon') || src.includes('sprite')) continue;
                                
                                log(`Taking screenshot of img at index ${ii}: ${Math.round(box.width)}x${Math.round(box.height)}`);
                                fs.mkdirSync(path.dirname(job.output), { recursive: true });
                                await img.screenshot({ path: job.output });
                                if (fs.existsSync(job.output) && fs.statSync(job.output).size > 5000) {
                                    saved = true;
                                    log(`✓ Method 3 success! Screenshot saved (${fs.statSync(job.output).size} bytes)`);
                                }
                                break;
                            } catch(scrErr) {
                                log(`Screenshot error for img #${ii}: ${scrErr.message}`);
                            }
                        }
                    } catch(e) {
                        log('Method 3 error: ' + e.message);
                    }
                }
                
                // METHOD 4: Click image → Save button (last resort)
                if (!saved) {
                    log('Method 4: Trying click-save approach...');
                    try {
                        const allImgs = page.locator('img');
                        const totalImgs = await allImgs.count();
                        
                        for (let ii = totalImgs - 1; ii >= 0 && !saved; ii--) {
                            const img = allImgs.nth(ii);
                            try {
                                const box = await img.boundingBox();
                                if (!box || box.width < 150 || box.height < 150) continue;
                                
                                const src = await img.getAttribute('src') || '';
                                if (src.includes('avatar') || src.includes('favicon') || src.includes('sprite')) continue;
                                
                                log(`Clicking image at index ${ii}: ${Math.round(box.width)}x${Math.round(box.height)}`);
                                await img.scrollIntoViewIfNeeded();
                                await sleep(1000);
                                await img.click({ timeout: 5000 });
                                await sleep(3000);
                                
                                // Look for Save/Lưu button
                                const saveSelectors = [
                                    'button[aria-label="Lưu"]',
                                    'button[aria-label="Save"]',
                                    'button[aria-label="Download"]',
                                    'button[aria-label*="Lưu"]',
                                    'button[aria-label*="Save"]',
                                    'button[aria-label*="Download"]',
                                    'a[download]',
                                ];
                                
                                let saveBtn = null;
                                for (const sel of saveSelectors) {
                                    try {
                                        const btn = page.locator(sel).first();
                                        if (await btn.isVisible({ timeout: 2000 })) {
                                            saveBtn = btn;
                                            log(`Found save button: ${sel}`);
                                            break;
                                        }
                                    } catch(e) {}
                                }
                                
                                if (saveBtn) {
                                    fs.mkdirSync(path.dirname(job.output), { recursive: true });
                                    try {
                                        const [download] = await Promise.all([
                                            page.waitForEvent('download', { timeout: 15000 }),
                                            saveBtn.click()
                                        ]);
                                        const dlPath = await download.path();
                                        if (dlPath && fs.existsSync(dlPath)) {
                                            fs.copyFileSync(dlPath, job.output);
                                            if (fs.statSync(job.output).size > 5000) {
                                                saved = true;
                                                log('✓ Method 4 success! Image saved via Save button!');
                                            }
                                        }
                                    } catch(dlErr) {
                                        log('Download event failed: ' + dlErr.message);
                                    }
                                } else {
                                    log('Save button not found in viewer');
                                }
                                
                                try { await page.keyboard.press('Escape'); await sleep(500); } catch(e) {}
                                break;
                                
                            } catch(imgErr) {
                                log(`img #${ii} error: ${imgErr.message}`);
                            }
                        }
                    } catch(e) {
                        log('Method 4 error: ' + e.message);
                    }
                }

                page.removeListener('response', imgHandler);

            } catch(e) {
                log('Job error: ' + e.message);
            }

            if (saved) {
                successCount++;
                console.log(JSON.stringify({ status: 'success', id: job.id, path: job.output }));
            } else {
                failCount++;
                console.log(JSON.stringify({ status: 'error', id: job.id, message: 'Timeout or image not found' }));
            }

            await sleep(2000);
        }

        // Save cookies
        try {
            const cookies = await context.cookies();
            fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
        } catch(e) {}

        console.log(JSON.stringify({ status: 'batch_done', total: jobs.length, success: successCount, failed: failCount }));
        await context.close();

    } catch(e) {
        log('Fatal: ' + e.message);
        console.log(JSON.stringify({ status: 'error', message: e.message }));
        if (context) try { await context.close(); } catch(x) {}
        process.exit(1);
    }
})();
