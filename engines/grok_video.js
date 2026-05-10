#!/usr/bin/env node
/**
 * grok_video.js — Generate videos from Grok using TubeCLI browser profile.
 * Processes multiple shots directly using grok.com/imagine dedicated video mode.
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
const timeout = parseInt(args.timeout || '240') * 1000; // 4 minutes

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
    process.stderr.write('[GrokVideo] ' + msg + '\n');
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

(async () => {
    log(`Profile: ${profileName}, Processing ${shots.length} shots for video.`);

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
        args: ['--no-sandbox', '--test-type', '--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
        ignoreDefaultArgs: ['--enable-automation'],
        viewport: { width: 1280, height: 800 },
    });

    if (fs.existsSync(cookiesPath)) {
        try {
            const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
            if (Array.isArray(cookies) && cookies.length > 0) await context.addCookies(cookies);
        } catch (e) { }
    }

    const page = context.pages()[0] || await context.newPage();
    let capturedVideoUrl = null;
    page.on('response', async (response) => {
        const url = response.url();
        const ct = response.headers()['content-type'] || '';
        
        // Grok Imagine videos come from TWO different CDNs:
        // NEW generated: https://assets.grok.com/users/{UID}/generated/{POST_ID}/generated_video.mp4
        // Shared/gallery: https://imagine-public.x.ai/imagine-public/share-videos/{UUID}.mp4
        const isVideoContent = ct.startsWith('video/') || (url.includes('.mp4') && !url.includes('_next/'));
        
        if (isVideoContent) {
            if (url.includes('assets.grok.com') && url.includes('generated_video')) {
                // This is a FRESHLY generated video - highest priority!
                capturedVideoUrl = url;
                log('*** CAPTURED NEW VIDEO URL: ' + url);
            } else if (!capturedVideoUrl && (url.includes('imagine-public.x.ai') || url.includes('share-videos'))) {
                const sizeStr = response.headers()['content-length'] || '0';
                const size = parseInt(sizeStr);
                if (size > 100000 || sizeStr === '0') {
                    capturedVideoUrl = url;
                    log('*** CAPTURED GALLERY VIDEO URL: ' + url);
                }
            }
        }
    });

    try {
        log('Navigating to grok.com/imagine...');
        await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 30000 });
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
            capturedVideoUrl = null;
            let videoSaved = false;

            // Go to pure imagine page for every shot to avoid chat clutter
            log('Loading fresh imagine page...');
            try {
                await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded' });
                await sleep(3000);
            } catch(e) {}

            async function getValidVideoSrcs() {
                const results = new Set();
                try {
                    const vids = page.locator('video');
                    const count = await vids.count();
                    for (let i = 0; i < count; i++) {
                        const rawSrc = await vids.nth(i).getAttribute('src');
                        if (rawSrc) results.add(rawSrc);
                    }
                } catch(e) {}
                return results;
            }
            const seenSrcs = await getValidVideoSrcs();

            // Click Video Pill
            log('Selecting Video option...');
            try {
                // Wait for the bottom input area to render first
                await sleep(2000);
                const btnVideo = page.locator('button:has-text("Video"), div:text-is("Video"), span:text-is("Video"), text="Video"').last();
                if (await btnVideo.isVisible({ timeout: 2000 })) {
                    await btnVideo.evaluate(el => el.click());
                    await sleep(1000);
                }
            } catch(e) {
                log('Video pill not found or clickable');
            }

            // Setup 10s
            try {
                const btn10s = page.locator('button:text-is("10s"), div:text-is("10s"), span:text-is("10s"), text="10s"').last();
                if (await btn10s.isVisible({ timeout: 1000 })) {
                    log('Selecting 10s video length...');
                    await btn10s.evaluate(el => el.click());
                    await sleep(500);
                }
            } catch(e) {}
            
            // Setup 720p
            try {
                const btn720p = page.locator('button:text-is("720p"), div:text-is("720p"), span:text-is("720p"), text="720p"').last();
                if (await btn720p.isVisible({ timeout: 1000 })) {
                    log('Selecting 720p quality...');
                    await btn720p.evaluate(el => el.click());
                    await sleep(500);
                }
            } catch(e) {}

            // Setup aspect ratio from shot data (dynamic)
            try {
                // Map project AR to Grok-supported AR (Grok only has: 2:3, 3:2, 1:1, 9:16, 16:9)
                const arMap = { '4:3': '3:2', '3:4': '2:3' };
                const rawAR = shot.aspect_ratio || '16:9';
                const targetAR = arMap[rawAR] || rawAR;
                log(`Setting aspect ratio to ${targetAR} (project: ${rawAR})...`);
                
                // The trigger button has aria-label="Aspect Ratio" (Radix UI dropdown)
                const arTrigger = page.locator('button[aria-label="Aspect Ratio"]');
                if (await arTrigger.isVisible({ timeout: 2000 }).catch(()=>false)) {
                    // Read current AR from the span inside the button
                    const currentAR = await arTrigger.locator('span').textContent().catch(()=>'');
                    log(`Current aspect ratio: ${currentAR}`);
                    
                    if (currentAR.trim() !== targetAR) {
                        // Click to open the Radix dropdown menu
                        await arTrigger.click();
                        await sleep(600);
                        
                        // Radix UI renders menu items with role="menuitemradio" or role="menuitem"
                        // Try multiple selectors for the menu item
                        const menuItem = page.locator(`[role="menuitemradio"]:has-text("${targetAR}"), [role="menuitem"]:has-text("${targetAR}"), [data-radix-collection-item]:has-text("${targetAR}")`).first();
                        if (await menuItem.isVisible({ timeout: 1500 }).catch(()=>false)) {
                            await menuItem.click();
                            await sleep(500);
                            log(`Successfully selected ${targetAR}`);
                        } else {
                            // Fallback: try any clickable element with exact text in the popup
                            const fallback = page.locator(`div[role="menu"] >> text="${targetAR}"`).first();
                            if (await fallback.isVisible({ timeout: 500 }).catch(()=>false)) {
                                await fallback.click();
                                await sleep(500);
                                log(`Selected ${targetAR} via fallback`);
                            } else {
                                log(`Could not find ${targetAR} in dropdown menu`);
                                await page.keyboard.press('Escape');
                            }
                        }
                    } else {
                        log(`Aspect ratio already set to ${targetAR}, skipping`);
                    }
                } else {
                    log('Aspect Ratio button not found');
                }
            } catch(e) {
                log('Failed to set aspect ratio: ' + e.message);
                try { await page.keyboard.press('Escape'); } catch(x) {}
            }

            // Input Prompt
            let inputEl = null;
            try {
                const inputSelectors = [
                    'textarea[placeholder*="imagine"]',
                    'textarea[placeholder*="Ask"]',
                    'div[contenteditable="true"]',
                    'textarea'
                ];
                
                await sleep(1000);
                for (let attempt=0; attempt<3; attempt++) {
                    for (const sel of inputSelectors) {
                        try {
                            const el = page.locator(sel).last();
                            if (await el.isVisible({ timeout: 1000 })) { inputEl = el; break; }
                        } catch (e) {}
                    }
                    if (inputEl) break;
                    log('Waiting for input box to render...');
                    await sleep(2000);
                }
                
                if (!inputEl) throw new Error('Input box invisible');
                
                await inputEl.click();
                await sleep(500);

                // --- UPLOAD REFERENCE IMAGES (if any) ---
                const refImages = shot.ref_images || [];
                if (refImages.length > 0) {
                    log(`Uploading ${refImages.length} reference image(s) for this shot...`);
                    for (const imgPath of refImages) {
                        if (!fs.existsSync(imgPath)) {
                            log(`  Ref image not found, skipping: ${imgPath}`);
                            continue;
                        }
                        try {
                            let fileChooserTriggered = false;

                            // Method 1 (fastest): Find hidden input[type="file"] and set directly
                            const fileInputs = page.locator('input[type="file"]');
                            const fileInputCount = await fileInputs.count();
                            if (fileInputCount > 0) {
                                await fileInputs.first().setInputFiles(imgPath);
                                fileChooserTriggered = true;
                                log(`  Uploaded ref image via hidden input: ${path.basename(imgPath)}`);
                                await sleep(3000);
                            }

                            // Method 2: Click "+" near input area, then click "Upload or drop" zone
                            if (!fileChooserTriggered) {
                                // Find the + button: it's near the bottom input area (textarea)
                                // Use the textarea's bounding box to find the nearby + button
                                const textareaBox = await inputEl.boundingBox();
                                if (textareaBox) {
                                    // The + button is typically to the left of the textarea
                                    const plusX = textareaBox.x - 30;
                                    const plusY = textareaBox.y + textareaBox.height / 2;
                                    await page.mouse.click(plusX, plusY);
                                    await sleep(1500);
                                    log('  Clicked near + area by coordinates');
                                }

                                // Now look for "Upload or drop" text in the popup
                                const uploadArea = page.locator('text=/Upload or drop/i, text=/Tải lên/i').first();
                                if (await uploadArea.isVisible({ timeout: 3000 })) {
                                    const [fileChooser] = await Promise.all([
                                        page.waitForEvent('filechooser', { timeout: 5000 }),
                                        uploadArea.click(),
                                    ]);
                                    await fileChooser.setFiles(imgPath);
                                    fileChooserTriggered = true;
                                    log(`  Uploaded ref image via popup: ${path.basename(imgPath)}`);
                                    await sleep(3000);
                                }
                            }

                            if (!fileChooserTriggered) {
                                log(`  Could not upload ref image — skipping`);
                                try { await page.keyboard.press('Escape'); } catch(x) {}
                            }
                        } catch (e) {
                            log(`  Failed to upload ref image ${path.basename(imgPath)}: ${e.message}`);
                            try { await page.keyboard.press('Escape'); } catch(x) {}
                        }
                    }
                    await sleep(1000);
                }
                
                // Clear any existing text just in case
                await inputEl.fill('');
                await sleep(200);

                const aspectRatio = shot.aspect_ratio || '16:9';
                let promptClean = (shot.prompt || '').replace(/\n+/g, ' ').trim();

                // Panoramic mode: prompt is empty, image ref is enough — submit directly
                if (!promptClean) {
                    log('Panoramic mode: no prompt text, submitting with image ref only...');
                    await sleep(500);
                    // Try submit button first
                    let submitted = false;
                    try {
                        const submitBtn = page.locator('button[aria-label*="Submit"], button[aria-label*="Send"], button[aria-label*="Gửi"]').first();
                        if (await submitBtn.isVisible({ timeout: 800 })) {
                            await submitBtn.click();
                            submitted = true;
                        }
                    } catch(e) {}
                    if (!submitted) {
                        try {
                            const allBtns = page.locator('button:has(svg)');
                            const count = await allBtns.count();
                            if (count > 0) await allBtns.nth(count - 1).click();
                        } catch(e) {}
                    }
                    await sleep(300);
                    try { await inputEl.press('Enter', { delay: 50 }); } catch(e) {
                        await page.keyboard.press('Enter');
                    }
                } else {
                    // Normal mode: fill prompt then submit
                    // After image upload, input may lose focus — re-click and use type() not fill()
                    if (!promptClean.includes('aspect ratio') && !promptClean.includes('16:9') && !promptClean.includes('9:16')) {
                        const arLabel = aspectRatio === '9:16' ? 'portrait' : aspectRatio === '1:1' ? 'square' : 'widescreen';
                        promptClean += ` Output in ${aspectRatio} ${arLabel} aspect ratio.`;
                    }
                    
                    // Re-focus the input (uploads may have shifted focus)
                    try {
                        await inputEl.click({ force: true });
                        await sleep(400);
                    } catch(e) {}
                    
                    // Clear existing content (Ctrl+A then Delete works for both textarea and contenteditable)
                    try {
                        await page.keyboard.press('Control+a');
                        await sleep(100);
                        await page.keyboard.press('Delete');
                        await sleep(100);
                    } catch(e) {}

                    // Try fill() first (works for textarea), then keyboard.type() as fallback (works for contenteditable)
                    let filled = false;
                    try {
                        await inputEl.fill(promptClean);
                        const val = await inputEl.inputValue().catch(() => inputEl.textContent());
                        if ((val || '').length > 3) filled = true;
                    } catch(e) {}
                    
                    if (!filled) {
                        try {
                            await inputEl.click({ force: true });
                            await sleep(300);
                            await page.keyboard.type(promptClean, { delay: 8 });
                            filled = true;
                            log('Prompt typed via keyboard.type()');
                        } catch(e) {
                            log('Failed to type prompt: ' + e.message);
                        }
                    }
                    
                    await sleep(800); // Wait for submit button to activate

                    log('Submitting prompt...');
                    let submitted = false;
                    try {
                        const submitBtn = page.locator('button[aria-label*="Submit"], button[aria-label*="Send"], button[aria-label*="Gửi"], button[title*="Submit"]').first();
                        if (await submitBtn.isVisible({ timeout: 500 })) {
                            await submitBtn.click();
                            submitted = true;
                        }
                    } catch(e) {}
                    if (!submitted) {
                        try {
                            const allBtns = page.locator('button:has(svg)');
                            const count = await allBtns.count();
                            if (count > 0) await allBtns.nth(count - 1).click();
                        } catch(e) {}
                    }
                    await sleep(500);
                    try { await page.keyboard.press('Enter'); } catch(e) {}
                }

                
                log('Direct video prompt submitted. Waiting for generation...');
                // CRITICAL: Reset captured URL AFTER submit so we only capture the NEW video
                capturedVideoUrl = null;
            } catch (e) {
                console.log(JSON.stringify({ status: 'error', shot_id: shot.id, message: 'Could not find input box on imagine page' }));
                continue;
            }

            let shotRetries = 0;
            
            let deadline = Date.now() + timeout;
            while (Date.now() < deadline) {
                await sleep(5000); // Check every 5s

                if (!videoSaved && shotRetries < 3) {
                    try {
                        const errLoc = page.locator('text=/unable to finish replying|try again later|thử lại/i').first();
                        const errVisible = await errLoc.isVisible({ timeout: 500 }).catch(()=>false);
                        const retryBtn = page.locator('button:has-text("Retry"), button:has-text("Thử lại")').first();
                        const btnVisible = await retryBtn.isVisible({ timeout: 500 }).catch(()=>false);

                        // Detect Grok content block: large eye-off icon overlay
                        const blockDetected = await page.evaluate(() => {
                            // Primary: exact Lucide eye-off class (most reliable)
                            const eyeOff = document.querySelector('svg.lucide-eye-off.size-24, svg.lucide.lucide-eye-off[class*="size-2"]');
                            if (eyeOff) return true;
                            // Secondary: any large eye-off SVG inside a fullscreen overlay
                            const overlays = document.querySelectorAll('div.absolute.w-full.h-full');
                            for (const ov of overlays) {
                                const svg = ov.querySelector('svg.lucide-eye-off, svg[class*="eye-off"]');
                                if (svg) return true;
                            }
                            // Tertiary: check for the diagonal slash path in a large SVG
                            const svgs = document.querySelectorAll('svg');
                            for (const s of svgs) {
                                if (s.clientWidth >= 60 && s.clientHeight >= 60) {
                                    const paths = s.querySelectorAll('path');
                                    for (const p of paths) {
                                        const d = p.getAttribute('d') || '';
                                        if (d.match(/m\s*2\s+2\s+20\s+20/i)) return true;
                                    }
                                }
                            }
                            return false;
                        }).catch(()=>false);

                        const rateLimitDetected = await page.evaluate(() => {
                            const text = document.body.innerText.toLowerCase();
                            // Only match actual rate limit error messages, NOT sidebar "Upgrade to SuperGrok" ad
                            return text.includes("you've reached your limit") ||
                                   text.includes("you've reached your current limit") ||
                                   text.includes('rate limit reached') ||
                                   text.includes("reached your limit for today") ||
                                   text.includes("check back soon");
                        }).catch(()=>false);

                        if (rateLimitDetected) {
                            console.log(JSON.stringify({ status: 'error', shot_id: shot.id, message: 'RATE_LIMIT_REACHED' }));
                            log('Rate limit reached detected. Aborting immediately.');
                            await context.close();
                            process.exit(1);
                        }

                        if (errVisible || btnVisible || blockDetected) {
                            log(`Grok internal error or block detected. Retrying video... (${shotRetries+1}/3)`);
                            await sleep(2000);
                            
                            if (blockDetected) {
                                log('Block detected! Adjusting prompt to bypass filter...');
                                shot.prompt += " (safe for work, general audience)";
                            }

                            if (btnVisible && !blockDetected) {
                                await retryBtn.click().catch(()=>{});
                            } else {
                                await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded' });
                                await sleep(3000);
                                const btnVideo = page.locator('button:text-is("Video"), div:text-is("Video"), span:text-is("Video"), text="Video"').last();
                                if (await btnVideo.isVisible({ timeout: 1000 })) await btnVideo.evaluate(el => el.click());
                                await sleep(500);
                                const newInp = page.locator('textarea').first();
                                if (await newInp.isVisible()) {
                                    await newInp.fill(shot.prompt);
                                    await newInp.press('Enter');
                                }
                            }
                            shotRetries++;
                            deadline = Date.now() + timeout;
                            continue;
                        }
                    } catch (e) {}
                }

                // Wait for the "Generating XX%" or "Cancel Video" to disappear!
                let isGenerating = false;
                let genPercent = 0;
                try {
                    // Only detect the SPECIFIC "Cancel Video" button during generation
                    // Use narrow selectors to avoid false positives from sidebar/menu "Cancel" buttons
                    const cancelVideoBtn = page.locator('button:has-text("Cancel Video"), button:has-text("Cancel video")').first();
                    if (await cancelVideoBtn.count() > 0 && await cancelVideoBtn.isVisible({ timeout: 500 })) {
                        isGenerating = true;
                        const text = await cancelVideoBtn.textContent();
                        if (text) {
                            const match = text.match(/(\d+)%/);
                            if (match) genPercent = parseInt(match[1]);
                        }
                    } else {
                        // Fallback: check for "Generating X%" text specifically
                        const genText = page.locator('text=/Generating\\s*\\d+%/i');
                        if (await genText.count() > 0 && await genText.first().isVisible({ timeout: 500 })) {
                            isGenerating = true;
                            const text = await genText.first().textContent();
                            const match = text.match(/(\d+)%/);
                            if (match) genPercent = parseInt(match[1]);
                        }
                    }
                } catch(e) {}
                
                if (isGenerating) {
                    // Emit real-time progress to stdout for backend to pick up
                    console.log(JSON.stringify({ status: 'generating', shot_id: shot.id, percent: genPercent }));
                    log(`Still generating... ${genPercent}%`);
                    continue; // Do not attempt to save while it's explicitly generating!
                }

                // If not generating, try to download!
                
                // Strategy 0: Network Intercepted CDN URL (highest priority, most reliable)
                if (capturedVideoUrl && !videoSaved) {
                    try {
                        log('Strategy 0: Downloading from intercepted URL: ' + capturedVideoUrl);
                        fs.mkdirSync(path.dirname(shot.output), { recursive: true });
                        const vidResp = await page.request.get(capturedVideoUrl);
                        if (vidResp.ok()) {
                            fs.writeFileSync(shot.output, await vidResp.body());
                            if (fs.statSync(shot.output).size > 10000) {
                                videoSaved = true;
                            }
                        }
                    } catch (e) {
                        log('Strategy 0 failed: ' + e.message);
                    }
                }

                // Strategy 1: DOM scan for new video with HTTP src
                if (!videoSaved) {
                    try {
                        const vids = page.locator('video');
                        const count = await vids.count();
                        
                        for (let i = 0; i < count; i++) {
                            const targetVid = vids.nth(i);
                            const rawSrc = await targetVid.getAttribute('src');
                            const src = rawSrc || '';
                            
                            // Skip videos without src or already seen
                            if (!src || seenSrcs.has(src)) continue;
                            
                            // Must be an HTTP video URL (not empty, not blob)
                            if (!src.startsWith('http')) continue;
                            
                            log('Strategy 1: Found new video in DOM: ' + src.substring(0, 100));
                            fs.mkdirSync(path.dirname(shot.output), { recursive: true });
                            
                            try {
                                const vidResp = await page.request.get(src);
                                if (vidResp.ok()) {
                                    fs.writeFileSync(shot.output, await vidResp.body());
                                    if (fs.statSync(shot.output).size > 10000) {
                                        videoSaved = true;
                                        break;
                                    }
                                }
                            } catch(e) {
                                log('Strategy 1 HTTP fetch failed: ' + e.message);
                            }
                        }
                    } catch (e) {}
                }

                // Strategy 2: DOM scan for video with blob: src — extract via page.evaluate
                if (!videoSaved) {
                    try {
                        const vids = page.locator('video');
                        const count = await vids.count();
                        
                        for (let i = 0; i < count; i++) {
                            const targetVid = vids.nth(i);
                            const rawSrc = await targetVid.getAttribute('src');
                            const src = rawSrc || '';
                            
                            if (!src.startsWith('blob:')) continue;
                            if (seenSrcs.has(src)) continue;
                            
                            log('Strategy 2: Found blob video in DOM, extracting...');
                            
                            try {
                                const videoBase64 = await page.evaluate(async (videoSelector) => {
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
                                            } catch(e) {}
                                        }
                                    }
                                    return null;
                                });
                                
                                if (videoBase64) {
                                    fs.mkdirSync(path.dirname(shot.output), { recursive: true });
                                    fs.writeFileSync(shot.output, Buffer.from(videoBase64, 'base64'));
                                    if (fs.statSync(shot.output).size > 10000) {
                                        videoSaved = true;
                                        log('Strategy 2: Blob video saved successfully!');
                                        break;
                                    }
                                }
                            } catch(e) {
                                log('Strategy 2 blob extraction failed: ' + e.message);
                            }
                        }
                    } catch(e) {}
                }

                // Strategy 3: Find download button on the post page and trigger download
                if (!videoSaved) {
                    try {
                        const dlBtn = page.locator('a[download], button[aria-label*="Download"], button[aria-label*="download"], a[href*=".mp4"]').first();
                        if (await dlBtn.count() > 0 && await dlBtn.isVisible({ timeout: 500 })) {
                            const href = await dlBtn.getAttribute('href');
                            if (href && href.startsWith('http')) {
                                log('Strategy 3: Downloading from download button href: ' + href.substring(0, 100));
                                fs.mkdirSync(path.dirname(shot.output), { recursive: true });
                                const vidResp = await page.request.get(href);
                                if (vidResp.ok()) {
                                    fs.writeFileSync(shot.output, await vidResp.body());
                                    if (fs.statSync(shot.output).size > 10000) {
                                        videoSaved = true;
                                        log('Strategy 3: Download button video saved!');
                                    }
                                }
                            }
                        }
                    } catch(e) {
                        log('Strategy 3 failed: ' + e.message);
                    }
                }
                
                if (videoSaved) {
                    // Final verification: ensure the page doesn't show a block overlay
                    // (Grok sometimes lets the video URL through but the content is blurred/blocked)
                    const postSaveBlock = await page.evaluate(() => {
                        const eyeOff = document.querySelector('svg.lucide-eye-off.size-24, svg.lucide.lucide-eye-off[class*="size-2"]');
                        if (eyeOff) return true;
                        const overlays = document.querySelectorAll('div.absolute.w-full.h-full');
                        for (const ov of overlays) {
                            if (ov.querySelector('svg.lucide-eye-off, svg[class*="eye-off"]')) return true;
                        }
                        return false;
                    }).catch(()=>false);
                    
                    if (postSaveBlock && shotRetries < 3) {
                        log('⚠️ Block overlay detected AFTER download! Discarding blurred video and retrying...');
                        videoSaved = false;
                        capturedVideoUrl = null;
                        try { fs.unlinkSync(shot.output); } catch(e) {}
                        
                        shot.prompt = shot.prompt.replace(/\s*\(safe for work.*?\)/g, '');
                        shot.prompt += ' (safe for work, educational, general audience, no violence)';
                        
                        shotRetries++;
                        await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded' });
                        await sleep(3000);
                        const btnVideo = page.locator('button:text-is("Video"), div:text-is("Video"), span:text-is("Video"), text="Video"').last();
                        if (await btnVideo.isVisible({ timeout: 1000 })) await btnVideo.evaluate(el => el.click());
                        await sleep(500);
                        const newInp = page.locator('textarea').first();
                        if (await newInp.isVisible()) {
                            await newInp.fill(shot.prompt);
                            await newInp.press('Enter');
                        }
                        deadline = Date.now() + timeout;
                        continue;
                    }
                    
                    log('Video generation finished and file saved successfully!');
                    break;
                }
            }

            if (!videoSaved) {
                console.log(JSON.stringify({ status: 'error', shot_id: shot.id, message: 'Timeout waiting for video' }));
            } else {
                console.log(JSON.stringify({ status: 'success', shot_id: shot.id, path: shot.output }));
            }
            await sleep(3000);
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
