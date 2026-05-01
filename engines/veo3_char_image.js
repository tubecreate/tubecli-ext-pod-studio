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

        // Step 0a: Handle landing page "Create with Flow" button
        try {
            const landingBtn = page.locator('button:has-text("Create with Flow"), button:has-text("Tạo bằng Flow"), a:has-text("Create with Flow")').first();
            if (await landingBtn.isVisible({ timeout: 3000 })) {
                log('Landing page detected, clicking Create with Flow...');
                await landingBtn.click();
                await sleep(5000);
            }
        } catch (e) {}

        // Step 0b: Handle login if redirected to accounts.google.com
        if (page.url().includes('accounts.google.com') || page.url().includes('signin')) {
            log('⚠️ Not logged in — checking for auto-login...');
            
            // Read credentials from profile config.json
            const configPath = path.join(profileDir, 'config.json');
            let googleCreds = null;
            try {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                googleCreds = config.google_account;
            } catch (e) {}
            
            if (googleCreds && googleCreds.email && googleCreds.password) {
                log(`Auto-login with account: ${googleCreds.email}`);
                try {
                    const browserExtDir = path.resolve(__dirname, '..', '..', '..', '..', 'tubecli', 'extensions', 'browser');
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
                } catch (loginErr) {
                    log('Auto-login error: ' + loginErr.message);
                }
            } else {
                // Try clicking existing account
                try {
                    const accountLink = page.locator('div[data-email], li div[role="link"]:has-text("@")').first();
                    if (await accountLink.isVisible({ timeout: 2000 })) {
                        await accountLink.click();
                        await sleep(3000);
                    }
                } catch(e) {}
            }
            
            // Wait for login to complete
            let loginWait = 0;
            while (page.url().includes('accounts.google.com') || page.url().includes('signin')) {
                await sleep(2000);
                loginWait++;
                if (loginWait > 30) {
                    console.log(JSON.stringify({ status: 'error', message: `Profile "${profileName}" is not logged into Google. Login timeout.` }));
                    await context.close();
                    process.exit(1);
                }
                if (loginWait % 5 === 0) log(`Waiting for login... ${loginWait * 2}s`);
            }
            log('✅ Login detected!');
            
            // Re-navigate to Flow after login
            if (!page.url().includes('tools/flow')) {
                await page.goto(VEO3_FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await sleep(4000);
            }
            
            // Click landing button again if needed
            try {
                const landingBtn = page.locator('button:has-text("Create with Flow"), button:has-text("Tạo bằng Flow")').first();
                if (await landingBtn.isVisible({ timeout: 2000 })) {
                    await landingBtn.click();
                    await sleep(5000);
                }
            } catch(e) {}
        }

        // Step 0c: Create new project
        log('Creating new project...');
        try {
            const newProjectBtn = page.locator('button:has-text("Dự án mới"), button:has-text("New project")').first();
            if (await newProjectBtn.isVisible({ timeout: 5000 })) {
                await newProjectBtn.click();
                await sleep(3000);
                log('New project created');
            } else {
                // Maybe already in a project view, check for prompt input
                const promptCheck = page.locator('textarea, div[contenteditable="true"]').first();
                if (await promptCheck.isVisible({ timeout: 3000 })) {
                    log('Already in a project view');
                } else {
                    // Try the "+" button
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

        // Step 1: Open mode/aspect ratio dropdown and switch to Image mode
        log('Opening mode selector dropdown...');
        try {
            // The dropdown button contains "Video" text + crop icon + "1x"
            // Click it to open the mode menu
            const modeBtn = page.locator('button:has-text("Video"):has(i.google-symbols), button:has-text("Hình ảnh"):has(i.google-symbols)').first();
            let menuOpened = false;
            
            if (await modeBtn.isVisible({ timeout: 5000 })) {
                await modeBtn.click();
                await sleep(1500);
                log('Mode dropdown clicked');
                menuOpened = true;
            } else {
                // Fallback: try any button near the prompt that has crop icons
                const altBtn = page.locator('button:has(i:text("crop_9_16")), button:has(i:text("crop_16_9")), button:has(i:text("crop_square"))').first();
                if (await altBtn.isVisible({ timeout: 3000 })) {
                    await altBtn.click();
                    await sleep(1500);
                    log('Alt mode dropdown clicked');
                    menuOpened = true;
                }
            }
            
            if (menuOpened) {
                // Select "Hình ảnh" (Image) mode from the menu
                const imageOption = page.locator('text="Hình ảnh"').first();
                if (await imageOption.isVisible({ timeout: 3000 })) {
                    await imageOption.click();
                    await sleep(1000);
                    log('✅ Switched to Image mode');
                } else {
                    // Try English fallback
                    const imageOptionEn = page.locator('text="Image"').first();
                    if (await imageOptionEn.isVisible({ timeout: 2000 })) {
                        await imageOptionEn.click();
                        await sleep(1000);
                        log('✅ Switched to Image mode (EN)');
                    } else {
                        log('Image option not found in menu - may already be in image mode');
                    }
                }
                
                // Step 2: Set aspect ratio from the same menu or re-open
                log(`Setting aspect ratio: ${aspectRatio}...`);
                const arMap = { '16:9': 'crop_16_9', '9:16': 'crop_9_16', '1:1': 'crop_square', '4:3': 'crop_4_3', '3:4': 'crop_3_4' };
                const arIcon = arMap[aspectRatio];
                
                // Try clicking the aspect ratio option
                // First check if menu is still open, if not re-open it
                const arTextBtn = page.locator(`text="${aspectRatio}"`).first();
                try {
                    if (await arTextBtn.isVisible({ timeout: 2000 })) {
                        await arTextBtn.click();
                        await sleep(500);
                        log(`✅ Aspect ratio set to ${aspectRatio}`);
                    } else if (arIcon) {
                        // Try clicking the icon button
                        const arIconBtn = page.locator(`i:text("${arIcon}"), button:has(i:text("${arIcon}"))`).first();
                        if (await arIconBtn.isVisible({ timeout: 2000 })) {
                            await arIconBtn.click();
                            await sleep(500);
                            log(`✅ Aspect ratio set to ${aspectRatio} (via icon)`);
                        }
                    }
                } catch(e) {
                    log('Could not set aspect ratio: ' + e.message);
                }
                
                // Close menu if still open (click elsewhere)
                await page.keyboard.press('Escape');
                await sleep(500);
            } else {
                log('Mode dropdown not found - trying direct image tab click...');
                // Fallback: try direct "Hình ảnh" text anywhere on page
                const imageTab = page.locator('text="Hình ảnh"').first();
                if (await imageTab.isVisible({ timeout: 3000 })) {
                    await imageTab.click();
                    await sleep(1500);
                }
            }
        } catch(e) {
            log('Mode switch error: ' + e.message);
        }

        // Step 3: Type the prompt
        log('Typing prompt...');
        let inputEl = null;
        const inputSelectors = [
            'textarea[placeholder*="tạo"]',
            'textarea[placeholder*="create"]',
            'textarea[placeholder*="muốn"]',
            'textarea',
            'div[contenteditable="true"]',
        ];
        for (let attempt = 0; attempt < 5; attempt++) {
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
            log(`Waiting for input box... attempt ${attempt + 1}/5`);
            await sleep(3000);
        }
        
        if (!inputEl) {
            console.log(JSON.stringify({ status: 'error', message: 'Prompt input not found on VideoFX after project creation' }));
            await context.close();
            process.exit(1);
        }

        await inputEl.click();
        await sleep(300);
        await inputEl.fill('');
        await sleep(200);
        try {
            await inputEl.fill(prompt.replace(/\n+/g, ' ').trim());
        } catch(e) {
            await page.keyboard.type(prompt.replace(/\n+/g, ' ').trim(), { delay: 5 });
        }
        await sleep(500);
        log('Prompt entered');

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

        // Step 5: Wait for generation + download (continuous retry like video engine)
        log('Waiting for image generation...');
        const deadline = Date.now() + timeout;

        while (Date.now() < deadline && !imageSaved) {
            await sleep(5000);

            // Check for rate limit / error
            try {
                const errorText = await page.evaluate(() => {
                    const text = document.body.innerText.toLowerCase();
                    if (text.includes('rate limit') || text.includes('giới hạn')) return 'RATE_LIMIT';
                    return null;
                });
                if (errorText === 'RATE_LIMIT') {
                    console.log(JSON.stringify({ status: 'error', message: 'RATE_LIMIT_REACHED' }));
                    await context.close();
                    process.exit(1);
                }
            } catch(e) {}

            // Check if still generating (spinners, loading indicators)
            let isGenerating = false;
            try {
                isGenerating = await page.evaluate(() => {
                    const spinners = document.querySelectorAll('[class*="spinner"], [class*="loading"], [class*="progress"]');
                    if (spinners.length > 0) return true;
                    const text = document.body.innerText;
                    if (text.includes('Đang tạo') || text.includes('Generating') || text.includes('Processing')) return true;
                    return false;
                });
            } catch(e) {}

            if (isGenerating) {
                const elapsed = Math.round((Date.now() - (deadline - timeout)) / 1000);
                log(`Still generating... ${elapsed}s elapsed`);
                continue;
            }

            // Strategy 1: UI Download via Context Menu (same pattern as veo3_video.js)
            if (!imageSaved) {
                try {
                    // Find any tile element
                    let latestTile = null;
                    for (const sel of ['[data-tile-id]', '[class*="tile"]', '[class*="media-card"]']) {
                        const el = page.locator(sel).first();
                        try {
                            if (await el.isVisible({ timeout: 1000 })) {
                                latestTile = el;
                                log(`Found tile with selector: ${sel}`);
                                break;
                            }
                        } catch(e) {}
                    }

                    if (latestTile) {
                        // Setup network interceptor
                        let downloadUrl = null;
                        const downloadHandler = async (response) => {
                            const url = response.url();
                            const ct = response.headers()['content-type'] || '';
                            if (ct.startsWith('image/') && !url.includes('_next/') && !url.includes('favicon') && url.length > 50) {
                                downloadUrl = url;
                                log('*** Network intercepted image URL: ' + url.substring(0, 150));
                            }
                        };
                        page.on('response', downloadHandler);

                        // Method A: Right-click on tile
                        log('Right-clicking tile...');
                        await latestTile.click({ button: 'right' });
                        await sleep(2000);

                        let downloadItem = page.locator('text="Tải xuống"').first();
                        let menuOpened = false;
                        try { menuOpened = await downloadItem.isVisible({ timeout: 2000 }); } catch(e) {}

                        // Method B: 3-dot button
                        if (!menuOpened) {
                            log('Right-click menu not found, trying 3-dot button...');
                            await page.keyboard.press('Escape');
                            await sleep(500);
                            await latestTile.hover();
                            await sleep(1000);
                            const moreBtn = latestTile.locator('button:has(i:text("more_vert")), button[aria-label*="menu"], button[aria-label*="More"]').first();
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

                            // Image: look for 1K in sub-menu
                            const res1K = page.locator('text="1K"').first();
                            let found1K = false;
                            try { found1K = await res1K.isVisible({ timeout: 3000 }); } catch(e) {}

                            if (found1K) {
                                log('Found 1K option, clicking...');
                                await res1K.hover();
                                await sleep(500);
                                await res1K.click();
                                log('Clicked 1K! Waiting for download...');
                            } else {
                                // No sub-menu → click directly
                                await downloadItem.click();
                                log('Clicked download directly (no sub-menu)');
                            }

                            // Wait for download event or network intercept
                            for (let w = 0; w < 30; w++) {
                                if (imageSaved || downloadUrl) break;
                                await sleep(1000);
                            }

                            if (imageSaved) {
                                log('Image saved by global download listener!');
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
                            } else {
                                log('No download detected after clicking. Will retry next loop...');
                            }
                        } else {
                            log('Could not open context menu. Will retry next loop...');
                        }

                        page.removeListener('response', downloadHandler);
                        // Dismiss any open menu
                        try { await page.keyboard.press('Escape'); } catch(x) {}
                    }
                } catch(e) {
                    log('Strategy 1 error: ' + e.message);
                    try { await page.keyboard.press('Escape'); } catch(x) {}
                }
            }

            // Strategy 2: Direct download from img src (handles VideoFX relative URLs)
            if (!imageSaved) {
                try {
                    // VideoFX images have src like: /fx/api/trpc/media.getMediaUrlRedirect?name=UUID
                    const imgUrl = await page.evaluate(() => {
                        const tiles = document.querySelectorAll('[data-tile-id]');
                        for (const tile of tiles) {
                            const img = tile.querySelector('img');
                            if (img && img.src && img.naturalWidth > 100) {
                                // Return absolute URL
                                return img.src;
                            }
                        }
                        // Fallback: any large image on page
                        const imgs = document.querySelectorAll('img');
                        for (const img of imgs) {
                            if (img.naturalWidth > 400 && img.naturalHeight > 400 && img.src) {
                                if (img.src.includes('_next/') || img.src.includes('favicon') || img.src.includes('avatar')) continue;
                                return img.src;
                            }
                        }
                        return null;
                    });

                    if (imgUrl) {
                        log('Strategy 2: Found image URL: ' + imgUrl.substring(0, 150));
                        const imgResp = await page.request.get(imgUrl);
                        if (imgResp.ok()) {
                            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                            fs.writeFileSync(outputPath, await imgResp.body());
                            if (fs.statSync(outputPath).size > 5000) {
                                imageSaved = true;
                                log('Strategy 2: Image saved from DOM src! (' + fs.statSync(outputPath).size + ' bytes)');
                            }
                        }
                    }
                } catch(e) {
                    log('Strategy 2 error: ' + e.message);
                }
            }

            if (imageSaved) {
                log('✅ Image saved successfully!');
                break;
            }

            const elapsed = Math.round((Date.now() - (deadline - timeout)) / 1000);
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
