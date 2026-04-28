#!/usr/bin/env node
/**
 * grok_image.js — Generate images from Grok using TubeCLI browser profile.
 * Processes multiple shots in ONE browser session.
 */

const minimist = require('minimist');
const fs = require('fs');
const path = require('path');
// Use vanilla Playwright to sidestep MissingKeyError from browser-with-fingerprints
const { chromium } = require('playwright');

const args = minimist(process.argv.slice(2));
const profileName = args.profile || args.p;
const shotsFile = args['shots-file'];
const profilesDir = args['profiles-dir'] || path.join(__dirname, '..', '..', '..', '..', 'data', 'browser_profiles');
const headless = args.headless === true || args.headless === 'true';
const timeout = parseInt(args.timeout || '120') * 1000;

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
const fingerprintPath = path.join(profileDir, 'fingerprint.json');
const cookiesPath = path.join(profileDir, 'cookies.json');
const storageDir = profileDir; // <- FIXED: Using root profile mapping, NOT chromium_data.

if (!fs.existsSync(profileDir)) {
    console.error(JSON.stringify({ status: 'error', message: `Profile "${profileName}" not found at ${profileDir}` }));
    process.exit(1);
}

function log(msg) {
    process.stderr.write('[GrokImage] ' + msg + '\n');
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

(async () => {
    log(`Profile: ${profileName}, Processing ${shots.length} shots.`);

    let plugin = chromium;

    // Cleanup stale lock files that prevent browser launch after crash
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
        } catch (e) {
            log(`Could not remove lock ${path.basename(lf)}: ${e.message}`);
        }
    }

    log('Launching browser...');
    const context = await plugin.launchPersistentContext(storageDir, {
        channel: 'chrome',
        headless,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--start-maximized'],
        no_viewport: !headless,
        viewport: headless ? { width: 1280, height: 800 } : null,
    });

    if (fs.existsSync(cookiesPath)) {
        try {
            const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
            if (Array.isArray(cookies) && cookies.length > 0) await context.addCookies(cookies);
        } catch (e) { }
    }

    const page = context.pages()[0] || await context.newPage();
    let capturedImageUrl = null;
    page.on('response', async (response) => {
        const url = response.url();
        const ct = response.headers()['content-type'] || '';
        if (ct.startsWith('image/') && !capturedImageUrl) {
            // Grok generated images usually hit pbs.twimg.com/media or specific media endpoints.
            // DO NOT capture assets like Grok logos from x.ai
            if (url.includes('pbs.twimg.com/media') || (url.includes('grok.com') && url.includes('media'))) {
                const size = parseInt(response.headers()['content-length'] || '0');
                if (size > 50000) capturedImageUrl = url;
            }
        }
    });

    try {
        log('Navigating to grok.x.ai...');
        await page.goto('https://grok.x.ai', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);

        const loginBtn = await page.$('a[href*="login"], button:text("Sign in")');
        if (loginBtn) {
            console.error(JSON.stringify({ status: 'error', message: `Profile "${profileName}" is not logged into Grok.` }));
            await context.close();
            process.exit(1);
        }

        const pageTitle = (await page.title()).toLowerCase();
        const bodyText = await page.evaluate(() => document.body.innerText.toLowerCase());
        const isBlocked = pageTitle.includes('cloudflare') || pageTitle.includes('attention required') || bodyText.includes('you have been blocked');
        if (isBlocked) {
            console.error(JSON.stringify({ status: 'error', message: `Cloudflare/Bot protection block detected.` }));
            await context.close();
            process.exit(1);
        }

        for (let idx=0; idx < shots.length; idx++) {
            const shot = shots[idx];
            log(`--- Shot ${shot.id} [${idx+1}/${shots.length}] ---`);
            capturedImageUrl = null;
            let imageSaved = false;

            const inputSelectors = ['textarea[placeholder]', 'div[contenteditable="true"]', '[data-testid="message-input"]', 'textarea'];
            let inputEl = null;
            for (let attempt=0; attempt<3; attempt++) {
                for (const sel of inputSelectors) {
                    try {
                        const el = page.locator(sel).first();
                        if (await el.isVisible({ timeout: 2000 })) { inputEl = el; break; }
                    } catch (e) {}
                }
                if (inputEl) break;
                await sleep(2000);
            }

            if (!inputEl) {
                console.log(JSON.stringify({ status: 'error', shot_id: shot.id, message: 'Could not find input box' }));
                continue; // try next shot
            }

            // Helper to get all currenly fully visual generated images
            async function getValidImageSrcs() {
                const results = new Set();
                try {
                    const imgs = page.locator('img, canvas');
                    const count = await imgs.count();
                    for (let i = 0; i < count; i++) {
                        const targetImg = imgs.nth(i);
                        const box = await targetImg.boundingBox();
                        const rawSrc = await targetImg.getAttribute('src');
                        const src = rawSrc || '';
                        let isValid = box && box.width > 150 && box.height > 150 && 
                                           !src.includes('icon') && !src.includes('avatar');
                        if (src.includes('.svg') || src.includes('/svg') || src.includes('svg+xml') || 
                            src.includes('spinner') || src.includes('loading') || src.includes('placeholder')) {
                            isValid = false;
                        }
                        if (src) {
                            const isFinalMedia = src.startsWith('blob:') || src.includes('media') || 
                                                 (src.startsWith('http') && src.match(/\.(jpeg|jpg|png|webp)$/i));
                            if (!isFinalMedia) isValid = false;
                        } else {
                            isValid = false;
                        }
                        if (isValid && src) results.add(src);
                    }
                } catch(e) {}
                return results;
            }

            const seenSrcs = await getValidImageSrcs();

            await inputEl.click();
            await sleep(500);
            await inputEl.fill(`Generate an image of: ${shot.prompt}`);
            await sleep(500);
            await inputEl.press('Enter');
            log('Prompt submitted. Waiting for image...');

            let lastBlobSize = 0;
            let stableCount = 0;
            let shotRetries = 0;
            
            let deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                await sleep(3000);

                // Auto-retry if Grok fails internally (e.g., "Grok was unable to finish replying.")
                if (!imageSaved && shotRetries < 2) {
                    try {
                        const errLoc = page.locator('text=/unable to finish replying|try again later|thử lại/i').first();
                        const errVisible = await errLoc.isVisible({ timeout: 500 }).catch(()=>false);
                        const retryBtn = page.locator('button:has-text("Retry"), button:has-text("Thử lại")').first();
                        const btnVisible = await retryBtn.isVisible({ timeout: 500 }).catch(()=>false);

                        if (errVisible || btnVisible) {
                            log(`Grok internal error detected. Waiting 5s before retry... (${shotRetries+1}/2)`);
                            await sleep(5000);
                            if (btnVisible) {
                                await retryBtn.click().catch(()=>{});
                            } else {
                                await inputEl.fill(`Generate an image of: ${shot.prompt}`);
                                await sleep(500);
                                await inputEl.press('Enter');
                            }
                            shotRetries++;
                            deadline = Date.now() + timeout; // Reset timeout
                            continue;
                        }
                    } catch (e) {}
                }
                
                // Method 1: CDN URL captured from response
                if (capturedImageUrl && !imageSaved && !seenSrcs.has(capturedImageUrl)) {
                    // Usually captured URLs are fully resolved, no stream check needed
                    try {
                        const imgResp = await page.request.get(capturedImageUrl);
                        if (imgResp.ok()) {
                            fs.mkdirSync(path.dirname(shot.output), { recursive: true });
                            fs.writeFileSync(shot.output, await imgResp.body());
                            imageSaved = true;
                            break;
                        }
                    } catch (e) { capturedImageUrl = null; }
                }

                // Method 2: Check DOM for large images or canvases inside the chat
                if (!imageSaved) {
                    try {
                        const imgs = page.locator('img, canvas');
                        const count = await imgs.count();
                        
                        // Scan backwards to find the newest generated image
                        for (let i = count - 1; i >= 0; i--) {
                            const targetImg = imgs.nth(i);
                            const box = await targetImg.boundingBox();
                            const rawSrc = await targetImg.getAttribute('src');
                            const src = rawSrc || '';
                            
                            // A generated image will be large (not an icon or avatar)
                            let isGenerated = box && box.width > 150 && box.height > 150 && 
                                               !src.includes('icon') && !src.includes('avatar');
                                               
                            // Filter out placeholders (SVG animations, spinners, loading states)
                            if (src.includes('.svg') || src.includes('/svg') || src.includes('svg+xml') || 
                                src.includes('spinner') || src.includes('loading') || src.includes('placeholder')) {
                                isGenerated = false;
                            }
                            
                            // Must be a proper media URL (Blob or Image CDN) to guarantee it's done rendering
                            if (src) {
                                const isFinalMedia = src.startsWith('blob:') || src.includes('media') || 
                                                     (src.startsWith('http') && src.match(/\.(jpeg|jpg|png|webp)$/i));
                                if (!isFinalMedia) {
                                    isGenerated = false;
                                }
                            } else {
                                isGenerated = false;
                            }

                            // EXTREMELY IMPORTANT: Make sure this image wasn't already on the screen before we pressed Enter!
                            if (isGenerated && src && seenSrcs.has(src)) {
                                isGenerated = false;
                            }

                            if (isGenerated) {
                                // NEW: Stability Check loop to prevent downloading blurry/unfinished streaming blobs!
                                let currentSize = src.length;
                                if (src.startsWith('blob:')) {
                                    currentSize = await page.evaluate(async (url) => {
                                        try {
                                            const r = await fetch(url);
                                            const b = await r.blob();
                                            return b.size;
                                        } catch(e) { return 0; }
                                    }, src);
                                }
                                
                                if (currentSize > 0 && currentSize === lastBlobSize) {
                                    stableCount++;
                                } else {
                                    lastBlobSize = currentSize;
                                    stableCount = 0;
                                }
                                
                                // We wait exactly 1 polling cycle (3 seconds) of no changes before capturing
                                if (stableCount < 1) {
                                    break; // Skip to next while loop cycle (wait 3s)
                                }

                                fs.mkdirSync(path.dirname(shot.output), { recursive: true });
                                
                                if (rawSrc && (src.startsWith('blob:') || src.startsWith('data:'))) {
                                    // Blob or Data URLs: evaluate or screenshot
                                    const base64Data = await page.evaluate(async (imgSrc) => {
                                        try {
                                            const res = await fetch(imgSrc);
                                            if (!res.ok) return null;
                                            const blob = await res.blob();
                                            return new Promise((resolve) => {
                                                const reader = new FileReader();
                                                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                                                reader.readAsDataURL(blob);
                                            });
                                        } catch(e) { return null; }
                                    }, src);
                                    
                                    if (base64Data) {
                                        fs.writeFileSync(shot.output, Buffer.from(base64Data, 'base64'));
                                        imageSaved = true;
                                    } else {
                                        await targetImg.screenshot({ path: shot.output });
                                        imageSaved = true;
                                    }
                                } else if (rawSrc && src.startsWith('http')) {
                                    // Regular HTTP fetch for standard URLs
                                    try {
                                        const imgResp = await page.request.get(src);
                                        if (imgResp.ok()) {
                                            fs.writeFileSync(shot.output, await imgResp.body());
                                            imageSaved = true;
                                        } else {
                                            await targetImg.screenshot({ path: shot.output });
                                            imageSaved = true;
                                        }
                                    } catch (e) {
                                        await targetImg.screenshot({ path: shot.output });
                                        imageSaved = true;
                                    }
                                } else {
                                    // No src, or it's a canvas or some other structure -> fallback to screenshot immediately
                                    await targetImg.screenshot({ path: shot.output });
                                    imageSaved = true;
                                }
                                
                                if (imageSaved) break; // Break out of inner for-loop
                            }
                        }
                    } catch (e) {}
                }
                
                if (imageSaved) break; // Break out of the 120s while loop!
            }

            if (!imageSaved) {
                try {
                    const msg = page.locator('article').last();
                    const screenshotPath = shot.output.replace(/\.[^.]+$/, '.png');
                    await msg.screenshot({ path: screenshotPath });
                    console.log(JSON.stringify({ status: 'success', shot_id: shot.id, path: screenshotPath }));
                } catch (e) {
                    console.log(JSON.stringify({ status: 'error', shot_id: shot.id, message: 'Timeout waiting for image' }));
                }
            } else {
                console.log(JSON.stringify({ status: 'success', shot_id: shot.id, path: shot.output }));
            }
            // Small sleep before next prompt
            await sleep(2000);
        }

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
