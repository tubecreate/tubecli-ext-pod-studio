#!/usr/bin/env node
/**
 * veo3_char_image.js — Generate single character/scene reference images using Google VideoFX (Image mode).
 * Uses TubeCLI browser profile, navigates to labs.google/fx/vi/tools/flow and uses the "Hình ảnh" tab.
 * 
 * Usage: node veo3_char_image.js --profile <name> --prompt "..." --output <path> --profiles-dir <dir> [--aspect-ratio 1:1] [--timeout 120]
 * 
 * Output: JSON on stdout:
 *   { "status": "success", "path": "<output_path>" }
 *   { "status": "error", "message": "<reason>" }
 */

const fs = require('fs');
const path = require('path');

// Inline arg parser
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
const prompt = args.prompt;
const outputPath = args.output;
const profilesDir = args['profiles-dir'] || path.join(__dirname, '..', '..', '..', '..', 'data', 'browser_profiles');
const aspectRatio = args['aspect-ratio'] || '1:1';
const headless = args.headless === 'true';
const timeout = parseInt(args.timeout || '120') * 1000;

const VEO3_FLOW_URL = 'https://labs.google/fx/vi/tools/flow';
const BROWSER_EXT_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'tubecli', 'extensions', 'browser');

// Catch-all crash handlers
process.on('uncaughtException', (err) => {
    process.stdout.write(JSON.stringify({ status: 'error', message: 'Crash: ' + (err.message || String(err)) }) + '\n');
    process.exit(1);
});
process.on('unhandledRejection', (err) => {
    process.stdout.write(JSON.stringify({ status: 'error', message: 'Rejection: ' + (err && err.message ? err.message : String(err)) }) + '\n');
    process.exit(1);
});

if (!profileName || !prompt || !outputPath) {
    console.log(JSON.stringify({ status: 'error', message: 'Required: --profile, --prompt, --output' }));
    process.exit(1);
}

const profileDir = path.join(profilesDir, profileName);
const cookiesPath = path.join(profileDir, 'cookies.json');

if (!fs.existsSync(profileDir)) {
    console.log(JSON.stringify({ status: 'error', message: `Profile "${profileName}" not found at: ${profileDir}` }));
    process.exit(1);
}

function log(msg) {
    process.stderr.write('[Veo3CharImage] ' + msg + '\n');
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

(async () => {
    log(`Profile: ${profileName}, Generating AI image via VideoFX...`);
    log(`Aspect ratio: ${aspectRatio}`);

    let chromium;
    try {
        chromium = require(path.join(BROWSER_EXT_DIR, 'node_modules', 'playwright')).chromium;
        log('Playwright loaded OK');
    } catch(e) {
        console.log(JSON.stringify({ status: 'error', message: 'Playwright load failed: ' + e.message }));
        process.exit(1);
    }

    // Clean stale lock files
    for (const lf of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        const lfPath = path.join(profileDir, lf);
        if (fs.existsSync(lfPath)) {
            try { fs.unlinkSync(lfPath); log(`Cleaned lock: ${lf}`); } catch(e) {}
        }
    }
    const defaultLock = path.join(profileDir, 'Default', 'LOCK');
    if (fs.existsSync(defaultLock)) {
        try { fs.unlinkSync(defaultLock); } catch(e) {}
    }

    let context = null;

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

        // Setup download listener for image downloads
        let imageSaved = false;
        page.on('download', async (download) => {
            if (imageSaved) return;
            log('Download event captured!');
            try {
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                await download.saveAs(outputPath);
                if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 5000) {
                    imageSaved = true;
                    log(`Image saved via download: ${outputPath}`);
                }
            } catch(e) {
                log('Download save error: ' + e.message);
            }
        });

        // Navigate to VideoFX Flow
        log('Navigating to VideoFX Flow...');
        await page.goto(VEO3_FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(4000);

        // Check if logged in (Google account required)
        const needsLogin = await page.evaluate(() => {
            return !!document.querySelector('a[href*="accounts.google.com"], button:has-text("Sign in"), button:has-text("Đăng nhập")');
        }).catch(() => false);

        if (needsLogin) {
            log('⚠️ Not logged in — waiting up to 60s for manual login...');
            const loginDeadline = Date.now() + 60000;
            let loggedIn = false;
            while (Date.now() < loginDeadline) {
                await sleep(3000);
                const stillNeedsLogin = await page.evaluate(() => {
                    return !!document.querySelector('a[href*="accounts.google.com"], button:has-text("Sign in")');
                }).catch(() => false);
                if (!stillNeedsLogin) {
                    loggedIn = true;
                    log('✅ Login detected!');
                    await sleep(2000);
                    break;
                }
            }
            if (!loggedIn) {
                console.log(JSON.stringify({ status: 'error', message: `Profile "${profileName}" is not logged into Google.` }));
                await context.close();
                process.exit(1);
            }
        }

        // Step 1: Click "Hình ảnh" (Image) tab
        log('Switching to Image mode...');
        const imageTab = page.locator('text="Hình ảnh"').first();
        try {
            if (await imageTab.isVisible({ timeout: 5000 })) {
                await imageTab.click();
                await sleep(1500);
                log('Switched to Image mode');
            } else {
                log('Image tab not found - may already be in image mode or different UI');
            }
        } catch(e) {
            log('Could not click Image tab: ' + e.message);
        }

        // Step 2: Set aspect ratio
        log(`Setting aspect ratio: ${aspectRatio}...`);
        const arMap = {
            '16:9': '16:9',
            '4:3': '4:3',
            '1:1': '1:1',
            '3:4': '3:4',
            '9:16': '9:16',
        };
        const targetAR = arMap[aspectRatio] || '1:1';
        try {
            const arBtn = page.locator(`text="${targetAR}"`).first();
            if (await arBtn.isVisible({ timeout: 3000 })) {
                await arBtn.click();
                await sleep(500);
                log(`Aspect ratio set to ${targetAR}`);
            }
        } catch(e) {
            log('Could not set aspect ratio: ' + e.message);
        }

        // Step 3: Type the prompt
        log('Typing prompt...');
        const promptInput = page.locator('textarea, div[contenteditable="true"]').first();
        try {
            if (await promptInput.isVisible({ timeout: 5000 })) {
                await promptInput.click();
                await sleep(300);
                await promptInput.fill('');
                await sleep(200);
                await promptInput.fill(prompt.replace(/\n+/g, ' ').trim());
                await sleep(500);
                log('Prompt entered');
            } else {
                console.log(JSON.stringify({ status: 'error', message: 'Prompt input not found on VideoFX' }));
                await context.close();
                process.exit(1);
            }
        } catch(e) {
            console.log(JSON.stringify({ status: 'error', message: 'Failed to enter prompt: ' + e.message }));
            await context.close();
            process.exit(1);
        }

        // Step 4: Click submit/generate button
        log('Submitting prompt...');
        try {
            // The generate button is usually the arrow/submit button near the prompt
            const submitBtn = page.locator('button[type="submit"], button:has(svg):near(textarea), button[aria-label*="Tạo"], button[aria-label*="Generate"]').last();
            if (await submitBtn.isVisible({ timeout: 3000 })) {
                await submitBtn.click();
                log('Generate button clicked');
            } else {
                await page.keyboard.press('Enter');
                log('Pressed Enter as fallback');
            }
        } catch(e) {
            await page.keyboard.press('Enter');
        }

        // Step 5: Wait for generation to complete
        log('Waiting for image generation...');
        const deadline = Date.now() + timeout;

        // Track existing tiles before generation
        const existingTileCount = await page.locator('[data-tile-id]').count().catch(() => 0);
        log(`Existing tiles before generation: ${existingTileCount}`);

        while (Date.now() < deadline && !imageSaved) {
            await sleep(3000);

            // Check for new tiles (image generated)
            const currentTileCount = await page.locator('[data-tile-id]').count().catch(() => 0);
            
            if (currentTileCount > existingTileCount) {
                log(`New tile detected! (${existingTileCount} -> ${currentTileCount})`);
                await sleep(2000); // Let it fully render

                // Try to download via right-click context menu
                const latestTile = page.locator('[data-tile-id]').first();
                try {
                    if (await latestTile.isVisible({ timeout: 2000 })) {
                        // Setup network interceptor
                        let downloadUrl = null;
                        const downloadHandler = async (response) => {
                            const url = response.url();
                            const ct = response.headers()['content-type'] || '';
                            if (ct.startsWith('image/') && !url.includes('_next/') && !url.includes('favicon')) {
                                downloadUrl = url;
                                log('*** Network intercepted image URL: ' + url.substring(0, 150));
                            }
                        };
                        page.on('response', downloadHandler);

                        // Right-click to open context menu
                        await latestTile.click({ button: 'right' });
                        await sleep(2000);

                        // Find "Tải xuống" / "Download"
                        let downloadItem = page.locator('text="Tải xuống"').first();
                        let menuOpened = false;
                        try {
                            menuOpened = await downloadItem.isVisible({ timeout: 2000 });
                        } catch(e) {}

                        // Fallback: 3-dot button
                        if (!menuOpened) {
                            log('Right-click menu not found, trying 3-dot button...');
                            await page.keyboard.press('Escape');
                            await sleep(500);
                            await latestTile.hover();
                            await sleep(1000);
                            const moreBtn = latestTile.locator('button:has(i:text("more_vert"))').first();
                            try {
                                if (await moreBtn.isVisible({ timeout: 2000 })) {
                                    await moreBtn.click();
                                    await sleep(2000);
                                    try { menuOpened = await downloadItem.isVisible({ timeout: 2000 }); } catch(e) {}
                                }
                            } catch(e) {}
                        }

                        if (menuOpened) {
                            log('Context menu visible. Hovering "Tải xuống"...');
                            await downloadItem.hover();
                            await sleep(2000);

                            // For images, look for resolution options or direct download
                            // Images might have direct download without resolution sub-menu
                            const res720 = page.locator('text="720p"').first();
                            let found720 = false;
                            try { found720 = await res720.isVisible({ timeout: 2000 }); } catch(e) {}

                            if (found720) {
                                await res720.hover();
                                await sleep(500);
                                await res720.click();
                                log('Clicked 720p download');
                            } else {
                                // No sub-menu → click "Tải xuống" directly
                                await downloadItem.click();
                                log('Clicked download directly (no sub-menu)');
                            }

                            // Wait for download
                            for (let w = 0; w < 20; w++) {
                                if (imageSaved || downloadUrl) break;
                                await sleep(1000);
                            }

                            if (imageSaved) {
                                log('Image saved by download listener!');
                            } else if (downloadUrl) {
                                log('Downloading from intercepted URL...');
                                try {
                                    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                                    const imgResp = await page.request.get(downloadUrl);
                                    if (imgResp.ok()) {
                                        fs.writeFileSync(outputPath, await imgResp.body());
                                        if (fs.statSync(outputPath).size > 5000) {
                                            imageSaved = true;
                                            log('Image downloaded from network URL!');
                                        }
                                    }
                                } catch(e) {
                                    log('Network download failed: ' + e.message);
                                }
                            }
                        } else {
                            log('Context menu not found. Trying DOM extraction fallback...');
                        }

                        page.removeListener('response', downloadHandler);

                        // Fallback: DOM extraction if download didn't work
                        if (!imageSaved) {
                            log('Trying DOM image extraction...');
                            try {
                                const tileImg = latestTile.locator('img').first();
                                if (await tileImg.isVisible({ timeout: 2000 })) {
                                    const src = await tileImg.getAttribute('src');
                                    if (src && src.startsWith('http')) {
                                        const imgResp = await page.request.get(src);
                                        if (imgResp.ok()) {
                                            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                                            fs.writeFileSync(outputPath, await imgResp.body());
                                            if (fs.statSync(outputPath).size > 5000) {
                                                imageSaved = true;
                                                log('Image saved via DOM extraction!');
                                            }
                                        }
                                    } else if (src && src.startsWith('blob:')) {
                                        const base64 = await page.evaluate(async (blobUrl) => {
                                            const r = await fetch(blobUrl);
                                            const b = await r.blob();
                                            return new Promise(resolve => {
                                                const reader = new FileReader();
                                                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                                                reader.readAsDataURL(b);
                                            });
                                        }, src);
                                        if (base64) {
                                            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                                            fs.writeFileSync(outputPath, Buffer.from(base64, 'base64'));
                                            imageSaved = true;
                                            log('Image saved via blob extraction!');
                                        }
                                    }
                                }
                            } catch(e) {
                                log('DOM extraction failed: ' + e.message);
                            }
                        }
                    }
                } catch(e) {
                    log('Download attempt failed: ' + e.message);
                    try { await page.keyboard.press('Escape'); } catch(x) {}
                }

                if (imageSaved) break;
            }

            // Check for errors
            try {
                const hasError = await page.evaluate(() => {
                    const text = document.body.innerText.toLowerCase();
                    return text.includes('rate limit') || text.includes('error') || text.includes('try again');
                }).catch(() => false);
                // Don't break on generic "error" text - just log
            } catch(e) {}

            const elapsed = Math.round((timeout - (deadline - Date.now())) / 1000);
            log(`Waiting... ${elapsed}s elapsed`);
        }

        // Report result
        if (imageSaved && fs.existsSync(outputPath)) {
            const stat = fs.statSync(outputPath);
            log(`Image saved: ${stat.size} bytes`);
            console.log(JSON.stringify({ status: 'success', path: outputPath, size: stat.size }));
        } else {
            console.log(JSON.stringify({ status: 'error', message: 'Timeout - no image generated within ' + (timeout / 1000) + 's' }));
        }

        // Save cookies
        try {
            const cookies = await context.cookies();
            fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
        } catch(e) {}

    } catch (e) {
        console.log(JSON.stringify({ status: 'error', message: e.message || String(e) }));
    } finally {
        if (context) {
            try { await context.close(); } catch(e) {}
        }
    }
})();
