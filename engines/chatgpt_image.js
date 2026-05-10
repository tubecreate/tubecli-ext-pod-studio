#!/usr/bin/env node
/**
 * chatgpt_image.js — Generate images from ChatGPT using TubeCLI browser profile.
 * Processes multiple jobs sequentially using chatgpt.com.
 * 
 * Usage: node chatgpt_image.js --profile <name> --jobs <path_to_jobs.json> --profiles-dir <dir> [--timeout 120]
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

        // Close all existing tabs from previous sessions, keep only one clean tab
        const existingPages = context.pages();
        let page;
        if (existingPages.length === 0) {
            page = await context.newPage();
        } else {
            page = existingPages[0];
            for (let pi = 1; pi < existingPages.length; pi++) {
                try { await existingPages[pi].close(); } catch(e) {}
            }
        }

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
                // Start new chat for each image
                log('Starting new chat...');
                try {
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
                        if (!fs.existsSync(refPath)) { log(`  Ref image not found: ${refPath}`); continue; }
                        try {
                            let fileInput = null;
                            try { fileInput = await page.$('input[type="file"]'); } catch(e) {}
                            if (!fileInput) {
                                try {
                                    const attachBtn = page.locator('button[aria-label*="Attach"], button[aria-label*="attach"], button[aria-label*="Upload"], button[data-testid*="attach"], button[data-testid*="upload"]').first();
                                    if (await attachBtn.isVisible({ timeout: 2000 })) { await attachBtn.click(); await sleep(1000); }
                                } catch(e) {}
                                try {
                                    const uploadOption = page.locator('div[role="menuitem"]:has-text("Upload"), button:has-text("Upload from computer"), div:has-text("Upload from computer")').first();
                                    if (await uploadOption.isVisible({ timeout: 2000 })) { await uploadOption.click(); await sleep(500); }
                                } catch(e) {}
                                try { fileInput = await page.$('input[type="file"]'); } catch(e) {}
                            }
                            if (fileInput) {
                                await fileInput.setInputFiles(refPath);
                                log(`  ✓ Uploaded ref ${ri+1}/${refImages.length}`);
                                await sleep(3000);
                            } else {
                                log(`  ✗ Could not find file input`);
                            }
                        } catch(e) {
                            log(`  ✗ Failed to upload ref: ${e.message}`);
                        }
                    }
                    await sleep(2000);
                }

                // Type and submit prompt
                const imgPrompt = `Generate an image: ${job.prompt.replace(/\n+/g, ' ').trim()}`;
                await inputEl.click(); await sleep(300);
                try {
                    await inputEl.fill('');
                    await sleep(200);
                    await inputEl.fill(imgPrompt);
                } catch(e) {
                    await page.keyboard.type(imgPrompt, { delay: 5 });
                }
                await sleep(1000);

                log('Submitting prompt...');
                let submitted = false;
                try {
                    const sendBtn = page.locator('button[data-testid="send-button"]').first();
                    if (await sendBtn.isVisible({ timeout: 2000 })) { await sendBtn.click(); submitted = true; }
                } catch(e) {}
                if (!submitted) {
                    try {
                        const sendBtn = page.locator('button:has(svg):near(div[id="prompt-textarea"])').last();
                        if (await sendBtn.isVisible({ timeout: 1000 })) { await sendBtn.click(); submitted = true; }
                    } catch(e) {}
                }
                if (!submitted) { await page.keyboard.press('Enter'); }

                log('Waiting for image generation...');
                const jobDeadline = Date.now() + perJobTimeout;
                let capturedImageUrl = null;

                // Network listener for generated image URLs
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
                            log('Captured image URL: ' + url.substring(0, 120));
                        }
                    } catch(e) {}
                };
                page.on('response', imgHandler);

                // PHASE 1: Wait for generation to start (loading dots)
                log('Phase 1: Waiting for image generation to start...');
                let genStarted = false;
                let loadingDotsEverSeen = false;
                for (let w = 0; w < 60 && !genStarted; w++) {
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
                            log('✓ Image generation started!');
                        } else if (w > 5) {
                            log(`Phase 1: check #${w+1} — status=${phase1Status}`);
                        }
                    } catch(e) {}
                }
                if (!genStarted) log('Warning: loading dots not detected, continuing...');

                // PHASE 2: Wait for generation to finish
                log('Phase 2: Waiting for generation to finish...');
                let genFinished = false;
                let checkCount = 0;
                let idleCount = 0;

                if (loadingDotsEverSeen) {
                    while (Date.now() < jobDeadline && !genFinished) {
                        await sleep(5000);
                        checkCount++;
                        try {
                            const rl = await page.evaluate(() => {
                                const banners = document.querySelectorAll('[role="alert"], [class*="banner"], [class*="notice"], [class*="toast"]');
                                for (const el of banners) {
                                    const text = el.innerText.toLowerCase();
                                    if (text.includes('rate limit') || text.includes('too many requests') ||
                                        text.includes('usage cap') || text.includes('image creation limit')) return true;
                                }
                                return false;
                            });
                            if (rl) { log('Rate limit detected!'); break; }
                        } catch(e) {}

                        try {
                            const status = await page.evaluate(() => {
                                if (document.querySelector('[data-testid="image-gen-loading-state-dots"]')) return 'image-generating';
                                if (document.querySelector('[data-testid="loading-halftone-dots-animation"]')) return 'image-generating';
                                const streaming = document.querySelectorAll('.result-streaming, [data-state="streaming"]');
                                if (streaming.length > 0) return 'streaming';
                                const stopBtns = document.querySelectorAll('button[aria-label="Stop generating"], button[data-testid="stop-button"]');
                                for (const btn of stopBtns) { if (btn.offsetParent !== null) return 'stop-button'; }
                                return 'idle';
                            });
                            log(`Check #${checkCount}: ${status}`);
                            if (status === 'idle') {
                                idleCount++;
                                if (idleCount >= 2) {
                                    log('Generation finished! Waiting 8s...');
                                    await sleep(8000);
                                    genFinished = true;
                                }
                            } else {
                                idleCount = 0;
                            }
                        } catch(e) {}
                    }
                } else {
                    log('Loading dots never appeared, waiting 30s...');
                    await sleep(30000);
                    genFinished = true;
                }

                if (!genFinished) log('Warning: generation timeout');

                // ═══ PHASE 3: Download the generated image ═══
                log('Phase 3: Finding and downloading generated image...');

                // Helper: fetch image inside browser context (has session cookies)
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
                            return Buffer.from(base64.split(',')[1], 'base64');
                        }
                    } catch(e) { log('fetchImageInBrowser error: ' + e.message); }
                    return null;
                };

                // Find the generated image: priority alt="Generated image" > id=_r_XX_ > estuary URL > last large img
                let generatedImgSrc = null;
                let generatedImgId = null;
                try {
                    const imgInfo = await page.evaluate(() => {
                        const imgs = Array.from(document.querySelectorAll('img'));
                        for (let i = imgs.length - 1; i >= 0; i--) {
                            const img = imgs[i];
                            if ((img.alt || '').toLowerCase().includes('generated image') || /^_r_\d+_$/.test(img.id || '')) {
                                return { src: img.src, id: img.id, alt: img.alt };
                            }
                        }
                        for (let i = imgs.length - 1; i >= 0; i--) {
                            const src = imgs[i].src || '';
                            if (src.includes('estuary') || src.includes('oaidalleapiprodscus') || src.includes('dalle')) {
                                return { src, id: imgs[i].id, alt: imgs[i].alt };
                            }
                        }
                        for (let i = imgs.length - 1; i >= 0; i--) {
                            const img = imgs[i];
                            const w = img.naturalWidth || img.width || 0;
                            const h = img.naturalHeight || img.height || 0;
                            if (w < 150 || h < 150) continue;
                            const src = img.src || '';
                            if (!src || src.includes('avatar') || src.includes('favicon') || src.startsWith('data:') || src.startsWith('blob:')) continue;
                            return { src, id: img.id, alt: img.alt };
                        }
                        return null;
                    });
                    if (imgInfo) {
                        generatedImgSrc = imgInfo.src;
                        generatedImgId = imgInfo.id;
                        log(`Found generated image: id="${imgInfo.id}" src=${generatedImgSrc.substring(0, 100)}`);
                    } else {
                        log('Could not find generated image in DOM');
                    }
                } catch(e) { log('Error finding image: ' + e.message); }

                // METHOD 1: In-browser fetch of captured network URL
                if (!saved && capturedImageUrl) {
                    log('Method 1: fetch network URL...');
                    try {
                        const buf = await fetchImageInBrowser(capturedImageUrl);
                        if (buf && buf.length > 5000) {
                            fs.mkdirSync(path.dirname(job.output), { recursive: true });
                            fs.writeFileSync(job.output, buf);
                            saved = true;
                            log(`✓ Method 1 success! (${buf.length} bytes)`);
                        } else {
                            log(`Method 1: ${buf ? 'too small' : 'null'}`);
                        }
                    } catch(e) { log('Method 1 error: ' + e.message); }
                }

                // METHOD 2: In-browser fetch of generated image src
                if (!saved && generatedImgSrc) {
                    log('Method 2: fetch generated image src...');
                    try {
                        const buf = await fetchImageInBrowser(generatedImgSrc);
                        if (buf && buf.length > 5000) {
                            fs.mkdirSync(path.dirname(job.output), { recursive: true });
                            fs.writeFileSync(job.output, buf);
                            saved = true;
                            log(`✓ Method 2 success! (${buf.length} bytes)`);
                        } else {
                            log(`Method 2: ${buf ? 'too small' : 'null'}`);
                        }
                    } catch(e) { log('Method 2 error: ' + e.message); }
                }

                // METHOD 3: Click the image container to open viewer → click Save button
                if (!saved) {
                    log('Method 3: Click image to open viewer, then click Save...');
                    try {
                        // Find and click the parent cursor-pointer container wrapping the generated image
                        const clicked = await page.evaluate((imgId) => {
                            const img = imgId
                                ? (document.getElementById(imgId) || document.querySelector(`img[id="${imgId}"]`))
                                : document.querySelector('img[alt*="Generated image"]');
                            if (!img) return false;
                            // Walk up to find cursor-pointer parent and click it
                            let el = img.parentElement;
                            while (el && el !== document.body) {
                                if (el.classList.contains('cursor-pointer') || el.style.cursor === 'pointer') {
                                    el.click();
                                    return true;
                                }
                                el = el.parentElement;
                            }
                            // Fallback: click the img itself
                            img.click();
                            return true;
                        }, generatedImgId || '');

                        if (clicked) {
                            log('Clicked image container, waiting for viewer to open...');
                            await sleep(2000);

                            // Look for Save/Download button
                            const saveBtnSelectors = [
                                'button[aria-label="Save"]',
                                'button[aria-label="Lưu"]',
                                'button[aria-label="Download"]',
                                'button[aria-label*="Save"]',
                                'button[aria-label*="Download"]',
                                'button[aria-label*="Lưu"]',
                                'a[download]',
                            ];

                            let saveBtn = null;
                            for (const sel of saveBtnSelectors) {
                                try {
                                    const btn = page.locator(sel).last();
                                    if (await btn.isVisible({ timeout: 2000 })) {
                                        saveBtn = btn;
                                        log(`Found Save button: ${sel}`);
                                        break;
                                    }
                                } catch(e) {}
                            }

                            // JS fallback: find button by aria-label
                            if (!saveBtn) {
                                const found = await page.evaluate(() => {
                                    for (const btn of document.querySelectorAll('button')) {
                                        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
                                        if (label === 'save' || label === 'lưu' || label === 'download') {
                                            btn.setAttribute('data-chatgpt-save', 'true');
                                            return true;
                                        }
                                    }
                                    return false;
                                });
                                if (found) saveBtn = page.locator('[data-chatgpt-save="true"]').last();
                            }

                            if (saveBtn) {
                                log('Clicking Save button...');
                                fs.mkdirSync(path.dirname(job.output), { recursive: true });
                                try {
                                    const [download] = await Promise.all([
                                        page.waitForEvent('download', { timeout: 20000 }),
                                        saveBtn.click()
                                    ]);
                                    const dlPath = await download.path();
                                    if (dlPath && fs.existsSync(dlPath)) {
                                        fs.copyFileSync(dlPath, job.output);
                                        const size = fs.statSync(job.output).size;
                                        if (size > 5000) {
                                            saved = true;
                                            log(`✓ Method 3 success! Downloaded (${size} bytes)`);
                                        }
                                    }
                                } catch(dlErr) {
                                    log('Download event failed: ' + dlErr.message + ' — trying direct click');
                                    try { await saveBtn.click(); await sleep(3000); } catch(e) {}
                                }
                            } else {
                                log('Method 3: Save button not found after clicking image');
                            }
                            // Close viewer
                            try { await page.keyboard.press('Escape'); await sleep(500); } catch(e) {}
                        }
                    } catch(e) { log('Method 3 error: ' + e.message); }
                }

                // METHOD 4: Screenshot the generated image element
                if (!saved) {
                    log('Method 4: Screenshot of generated image element...');
                    try {
                        let target = null;
                        if (generatedImgId) {
                            try {
                                const el = page.locator(`#${generatedImgId}`).first();
                                if (await el.isVisible({ timeout: 2000 })) target = el;
                            } catch(e) {}
                        }
                        if (!target) {
                            const els = page.locator('img[alt*="Generated image"]');
                            if (await els.count() > 0) target = els.last();
                        }
                        if (!target) {
                            const allImgs = page.locator('img');
                            const n = await allImgs.count();
                            for (let ii = n - 1; ii >= 0; ii--) {
                                const img = allImgs.nth(ii);
                                try {
                                    const box = await img.boundingBox();
                                    if (!box || box.width < 150 || box.height < 150) continue;
                                    const src = await img.getAttribute('src') || '';
                                    if (src.includes('avatar') || src.includes('favicon')) continue;
                                    target = img; break;
                                } catch(e) {}
                            }
                        }
                        if (target) {
                            fs.mkdirSync(path.dirname(job.output), { recursive: true });
                            await target.screenshot({ path: job.output });
                            if (fs.existsSync(job.output) && fs.statSync(job.output).size > 5000) {
                                saved = true;
                                log(`✓ Method 4 success! Screenshot (${fs.statSync(job.output).size} bytes)`);
                            }
                        }
                    } catch(e) { log('Method 4 error: ' + e.message); }
                }

                // METHOD 5: Full page screenshot fallback
                if (!saved) {
                    log('Method 5: Full page screenshot...');
                    try {
                        fs.mkdirSync(path.dirname(job.output), { recursive: true });
                        await page.screenshot({ path: job.output, fullPage: false });
                        if (fs.existsSync(job.output) && fs.statSync(job.output).size > 5000) {
                            saved = true;
                            log(`✓ Method 5 success! (${fs.statSync(job.output).size} bytes)`);
                        }
                    } catch(e) { log('Method 5 error: ' + e.message); }
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
                console.log(JSON.stringify({ status: 'error', id: job.id, message: 'Image not saved after all methods' }));
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
