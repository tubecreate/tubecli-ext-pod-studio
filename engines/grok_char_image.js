#!/usr/bin/env node
/**
 * grok_char_image.js — Generate single character reference images from Grok Imagine.
 * Uses TubeCLI browser profile, navigates to grok.com/imagine in Image mode.
 * 
 * Usage: node grok_char_image.js --profile <name> --prompt "..." --output <path> --profiles-dir <dir>
 */

const minimist = require('minimist');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { chromium } = require('playwright');

const args = minimist(process.argv.slice(2));
const profileName = args.profile || args.p;
const prompt = args.prompt;
const outputPath = args.output;
const profilesDir = args['profiles-dir'] || path.join(__dirname, '..', '..', '..', '..', 'data', 'browser_profiles');
const headless = args.headless === true || args.headless === 'true';
const timeout = parseInt(args.timeout || '120') * 1000;

if (!profileName || !prompt || !outputPath) {
    console.error(JSON.stringify({ status: 'error', message: 'Required: --profile, --prompt, --output' }));
    process.exit(1);
}

const profileDir = path.join(profilesDir, profileName);
const cookiesPath = path.join(profileDir, 'cookies.json');

if (!fs.existsSync(profileDir)) {
    console.error(JSON.stringify({ status: 'error', message: `Profile "${profileName}" not found` }));
    process.exit(1);
}

function log(msg) {
    process.stderr.write('[GrokCharImage] ' + msg + '\n');
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(dest);
        mod.get(url, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                downloadFile(response.headers.location, dest).then(resolve).catch(reject);
                return;
            }
            response.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

(async () => {
    log(`Profile: ${profileName}, Generating AI Character image...`);

    const context = await chromium.launchPersistentContext(profileDir, {
        headless,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--start-maximized'],
        viewport: headless ? { width: 1280, height: 800 } : null,
    });

    if (fs.existsSync(cookiesPath)) {
        try {
            const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
            if (Array.isArray(cookies) && cookies.length > 0) await context.addCookies(cookies);
        } catch (e) {}
    }

    const page = context.pages()[0] || await context.newPage();
    let capturedImageUrl = null;

    try {
        log('Navigating to grok.com...');
        await page.goto('https://grok.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);

        const loginBtn = await page.$('a[href*="login"], button:text("Sign in")');
        if (loginBtn) {
            console.log(JSON.stringify({ status: 'error', message: `Profile "${profileName}" is not logged into Grok.` }));
            await context.close();
            process.exit(1);
        }

        // Make sure we're in IMAGE mode (not Video)
        log('Selecting Image mode...');
        try {
            await sleep(2000);
            const imgBtn = page.locator('button:text-is("Image"), button:has-text("Image"), button:text-is("Hình ảnh"), button:has-text("Hình ảnh"), span:has-text("Hình ảnh")').last();
            if (await imgBtn.isVisible({ timeout: 2000 })) {
                log('Image mode button found, clicking...');
                await imgBtn.evaluate(el => el.click());
                await sleep(1000);
            }
        } catch(e) {
            log('Image mode button not found - may already be default');
        }

        // --- TRACK EXISTING IMAGES BEFORE SUBMIT ---
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
                                             (src.startsWith('http') && src.match(/\.(jpeg|jpg|png|webp)$/i)) ||
                                             (src.includes('grok.com') && src.includes('assets'));
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
        log(`Found ${seenSrcs.size} existing images on page prior to generation.`);

        // Type the prompt
        log('Typing prompt...');
        let inputEl = null;
        const inputSelectors = [
            'textarea[placeholder*="imagine"]',
            'textarea[placeholder*="Ask"]',
            'textarea[placeholder*="tưởng"]',
            'div[contenteditable="true"]',
            'textarea'
        ];
        
        await sleep(1000);
        for (let attempt = 0; attempt < 3; attempt++) {
            for (const sel of inputSelectors) {
                try {
                    const el = page.locator(sel).last();
                    if (await el.isVisible({ timeout: 1000 })) { inputEl = el; break; }
                } catch (e) {}
            }
            if (inputEl) break;
            await sleep(2000);
        }

        if (!inputEl) {
            console.log(JSON.stringify({ status: 'error', message: 'Input box not found' }));
            await context.close();
            process.exit(1);
        }

        await inputEl.click();
        await sleep(500);
        await inputEl.fill('');
        await sleep(200);

        let promptClean = prompt.replace(/\n+/g, ' ').trim();
        // Only add 1:1 instruction if not already in the prompt
        if (!promptClean.includes('1:1') && !promptClean.includes('square')) {
            promptClean = 'Generate in 1:1 square aspect ratio: ' + promptClean;
        }
        try {
            await inputEl.fill(promptClean);
        } catch(e) {
            await page.keyboard.type(promptClean, { delay: 5 });
        }
        await sleep(1000);

        // Submit
        log('Submitting prompt...');
        try {
            const submitBtn = page.locator('button[type="submit"], button[aria-label="Submit"], button:has(svg):near(textarea)').last();
            if (await submitBtn.isVisible({ timeout: 2000 })) {
                await submitBtn.click();
            } else {
                await page.keyboard.press('Enter');
            }
        } catch(e) {
            await page.keyboard.press('Enter');
        }

        // --- START NETWORK INTERCEPTOR ---
        page.on('response', async (response) => {
            try {
                const url = response.url();
                const ct = response.headers()['content-type'] || '';
                
                const isImage = ct.startsWith('image/') && (
                    url.includes('pbs.twimg.com/media') || 
                    (url.includes('grok.com') && url.includes('media')) ||
                    (url.includes('assets.grok.com') && url.includes('generated')) ||
                    url.includes('imagine-public.x.ai')
                );
                
                if (isImage && !url.includes('_next/') && !url.includes('favicon') && !seenSrcs.has(url)) {
                    const sizeStr = response.headers()['content-length'] || '0';
                    const size = parseInt(sizeStr);
                    // Filter out small icons/avatars (usually < 20KB). Generated images are > 50KB usually.
                    if (size > 30000 || sizeStr === '0') {
                        capturedImageUrl = url;
                        log('*** CAPTURED NEW IMAGE URL: ' + url);
                    }
                }
            } catch(e) {}
        });

        // Wait for image generation
        log('Waiting for image generation...');
        let imageSaved = false;
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
                            await inputEl.fill(promptClean);
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
                try {
                    const imgResp = await page.request.get(capturedImageUrl);
                    if (imgResp.ok()) {
                        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                        fs.writeFileSync(outputPath, await imgResp.body());
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
                                                 (src.startsWith('http') && src.match(/\.(jpeg|jpg|png|webp)$/i)) ||
                                                 (src.includes('grok.com') && src.includes('assets'));
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

                            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                            
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
                                    fs.writeFileSync(outputPath, Buffer.from(base64Data, 'base64'));
                                    imageSaved = true;
                                } else {
                                    await targetImg.screenshot({ path: outputPath });
                                    imageSaved = true;
                                }
                            } else if (rawSrc && src.startsWith('http')) {
                                // Regular HTTP fetch for standard URLs
                                try {
                                    const imgResp = await page.request.get(src);
                                    if (imgResp.ok()) {
                                        fs.writeFileSync(outputPath, await imgResp.body());
                                        imageSaved = true;
                                    } else {
                                        await targetImg.screenshot({ path: outputPath });
                                        imageSaved = true;
                                    }
                                } catch (e) {
                                    await targetImg.screenshot({ path: outputPath });
                                    imageSaved = true;
                                }
                            } else {
                                // No src, or it's a canvas or some other structure -> fallback to screenshot immediately
                                await targetImg.screenshot({ path: outputPath });
                                imageSaved = true;
                            }
                            
                            if (imageSaved) {
                                capturedImageUrl = src;
                                break; // Break out of inner for-loop
                            }
                        }
                    }
                } catch (e) {}
            }
            
            if (imageSaved) break; // Break out of the 120s while loop!

            const elapsed = Math.round((timeout - (deadline - Date.now())) / 1000);
            log(`Waiting... ${elapsed}s elapsed`);
        }

        if (!imageSaved) {
            // Last resort: screenshot the entire chat area
            log('No image captured via DOM/network. Attempting screenshot fallback...');
            try {
                const lastArticle = page.locator('article, [data-testid="conversation-turn"]').last();
                if (await lastArticle.isVisible({ timeout: 3000 })) {
                    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                    await lastArticle.screenshot({ path: outputPath });
                    imageSaved = true;
                    log('Screenshot fallback saved.');
                }
            } catch(e) {}
        }

        if (imageSaved && fs.existsSync(outputPath)) {
            const stat = fs.statSync(outputPath);
            log(`Image saved: ${stat.size} bytes`);
            console.log(JSON.stringify({ 
                status: 'success', 
                path: outputPath, 
                url: capturedImageUrl || 'screenshot',
                size: stat.size 
            }));
        } else {
            console.log(JSON.stringify({ status: 'error', message: 'Timeout - no image generated within ' + (timeout/1000) + 's' }));
        }

    } catch (e) {
        console.log(JSON.stringify({ status: 'error', message: e.message }));
    } finally {
        await context.close();
    }
})();
