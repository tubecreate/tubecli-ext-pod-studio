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
                if (fs.existsSync(currentOutput) && fs.statSync(currentOutput).size > 5000) {
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
        log('Setting Image mode + aspect ratio (once for all jobs)...');
        try {
            const modeBtn = page.locator('button:has-text("Video"):has(i.google-symbols), button:has-text("Hình ảnh"):has(i.google-symbols)').first();
            if (await modeBtn.isVisible({ timeout: 5000 })) {
                await modeBtn.click(); await sleep(1500);

                // Select Image mode
                const imgOpt = page.locator('text="Hình ảnh"').first();
                if (await imgOpt.isVisible({ timeout: 3000 })) {
                    await imgOpt.click(); await sleep(1000);
                    log('✅ Image mode selected');
                }

                // Select aspect ratio
                const arText = page.locator(`text="${aspectRatio}"`).first();
                try {
                    if (await arText.isVisible({ timeout: 2000 })) {
                        await arText.click(); await sleep(500);
                        log(`✅ Aspect ratio: ${aspectRatio}`);
                    } else {
                        const arMap = { '16:9': 'crop_16_9', '9:16': 'crop_9_16', '1:1': 'crop_square' };
                        const arIcon = arMap[aspectRatio];
                        if (arIcon) {
                            const arBtn = page.locator(`i:text("${arIcon}")`).first();
                            if (await arBtn.isVisible({ timeout: 2000 })) { await arBtn.click(); await sleep(500); }
                        }
                    }
                } catch(e) {}

                await page.keyboard.press('Escape'); await sleep(500);
            }
        } catch(e) { log('Mode/ratio setup: ' + e.message); }

        // ── Process each job ──
        for (let ji = 0; ji < jobs.length; ji++) {
            const job = jobs[ji];
            log(`\n--- Job ${ji+1}/${jobs.length}: ${job.id} ---`);
            currentOutput = job.output;
            currentSaved = false;

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

                // Type prompt
                await inputEl.click(); await sleep(300);
                await inputEl.fill(''); await sleep(200);
                try { await inputEl.fill(job.prompt.replace(/\n+/g, ' ').trim()); }
                catch(e) { await page.keyboard.type(job.prompt.replace(/\n+/g, ' ').trim(), { delay: 5 }); }
                await sleep(500);

                // Submit
                try {
                    const submitBtn = page.locator('button[type="submit"], button:has(svg):near(textarea), button[aria-label*="Tạo"], button[aria-label*="Generate"]').last();
                    if (await submitBtn.isVisible({ timeout: 3000 })) { await submitBtn.click(); }
                    else { await page.keyboard.press('Enter'); }
                } catch(e) { await page.keyboard.press('Enter'); }

                log('Prompt submitted. Waiting for generation...');

                // Wait for generation + download
                const jobDeadline = Date.now() + perJobTimeout;
                while (Date.now() < jobDeadline && !currentSaved) {
                    await sleep(5000);

                    // Check rate limit
                    try {
                        const rl = await page.evaluate(() => document.body.innerText.toLowerCase().includes('rate limit') || document.body.innerText.toLowerCase().includes('giới hạn'));
                        if (rl) {
                            console.log(JSON.stringify({ status: 'error', id: job.id, message: 'RATE_LIMIT' }));
                            // Save cookies and exit
                            try { fs.writeFileSync(cookiesPath, JSON.stringify(await context.cookies(), null, 2)); } catch(e) {}
                            console.log(JSON.stringify({ status: 'batch_done', total: jobs.length, success: successCount, failed: failCount + (jobs.length - ji) }));
                            await context.close(); process.exit(1);
                        }
                    } catch(e) {}

                    // Check generating state
                    let generating = false;
                    try {
                        generating = await page.evaluate(() => {
                            const s = document.querySelectorAll('[class*="spinner"], [class*="loading"], [class*="progress"]');
                            if (s.length > 0) return true;
                            const t = document.body.innerText;
                            return t.includes('Đang tạo') || t.includes('Generating') || t.includes('Processing');
                        });
                    } catch(e) {}
                    if (generating) { log('Generating...'); continue; }

                    // Strategy 1: Right-click → Tải xuống → 1K
                    if (!currentSaved) {
                        try {
                            let tile = null;
                            for (const sel of ['[data-tile-id]', '[class*="tile"]']) {
                                const el = page.locator(sel).first();
                                try { if (await el.isVisible({ timeout: 1000 })) { tile = el; break; } } catch(e) {}
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

                                    for (let w = 0; w < 30 && !currentSaved && !dlUrl; w++) await sleep(1000);

                                    if (!currentSaved && dlUrl) {
                                        try {
                                            fs.mkdirSync(path.dirname(currentOutput), { recursive: true });
                                            const resp = await page.request.get(dlUrl);
                                            if (resp.ok()) {
                                                fs.writeFileSync(currentOutput, await resp.body());
                                                if (fs.statSync(currentOutput).size > 5000) { currentSaved = true; log('Downloaded from network!'); }
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

                    // Strategy 2: Direct DOM img src download
                    if (!currentSaved) {
                        try {
                            const imgUrl = await page.evaluate(() => {
                                const tiles = document.querySelectorAll('[data-tile-id]');
                                for (const t of tiles) {
                                    const img = t.querySelector('img');
                                    if (img && img.src && img.naturalWidth > 100) return img.src;
                                }
                                return null;
                            });
                            if (imgUrl) {
                                const resp = await page.request.get(imgUrl);
                                if (resp.ok()) {
                                    fs.mkdirSync(path.dirname(currentOutput), { recursive: true });
                                    fs.writeFileSync(currentOutput, await resp.body());
                                    if (fs.statSync(currentOutput).size > 5000) { currentSaved = true; log('Strategy 2: DOM download OK!'); }
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
