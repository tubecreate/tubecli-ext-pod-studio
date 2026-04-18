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

    log('Launching browser...');
    const context = await plugin.launchPersistentContext(storageDir, {
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
                
                // Clear any existing text just in case
                await inputEl.fill('');
                await sleep(200);

                // Use robust filling
                const promptClean = shot.prompt.replace(/\n+/g, ' ').trim();
                try {
                    await inputEl.fill(promptClean);
                } catch(e) {
                    await page.keyboard.type(promptClean, { delay: 5 });
                }
                await sleep(1000); // Wait for the submit button to become active
                
                // Try multiple ways to submit!
                log('Submitting prompt...');
                let submitted = false;
                
                // 1. Try to find the button inside the input's bounding box/container
                try {
                    const submitBtn = page.locator('button[aria-label*="Submit"], button[aria-label*="Send"], button[aria-label*="Gửi"], button[title*="Submit"]').first();
                    if (await submitBtn.isVisible({ timeout: 500 })) {
                        await submitBtn.click();
                        submitted = true;
                    }
                } catch(e) {}

                // 2. Click the last button with an SVG (that isn't one of our pills)
                if (!submitted) {
                    try {
                        const allBtns = page.locator('button:has(svg)');
                        const count = await allBtns.count();
                        if (count > 0) {
                            await allBtns.nth(count - 1).click();
                        }
                    } catch(e) {}
                }

                // 3. Fallback to Enter key
                await sleep(500);
                try {
                    await inputEl.press('Enter', { delay: 50 });
                } catch(e) {
                    await page.keyboard.press('Enter');
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

                if (!videoSaved && shotRetries < 2) {
                    try {
                        const errLoc = page.locator('text=/unable to finish replying|try again later|thử lại/i').first();
                        const errVisible = await errLoc.isVisible({ timeout: 500 }).catch(()=>false);
                        const retryBtn = page.locator('button:has-text("Retry"), button:has-text("Thử lại")').first();
                        const btnVisible = await retryBtn.isVisible({ timeout: 500 }).catch(()=>false);

                        if (errVisible || btnVisible) {
                            log(`Grok internal error detected. Retrying video... (${shotRetries+1}/2)`);
                            await sleep(5000);
                            if (btnVisible) {
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
                    // Find the cancel button which is always present during generation
                    const cancelBtn = page.locator('button:has-text("Cancel"), button:has-text("cancel"), div:has-text("Cancel")').last();
                    if (await cancelBtn.count() > 0 && await cancelBtn.isVisible({ timeout: 500 })) {
                        isGenerating = true;
                        // Extract text from the button itself (which usually contains "Generating 16% | Cancel Video")
                        const text = await cancelBtn.textContent();
                        if (text) {
                            const match = text.match(/(\d+)%/);
                            if (match) genPercent = parseInt(match[1]);
                        }
                    } else {
                        // Fallback: check text across the page if button not found but "Generating X%" is visible
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
                
                if (videoSaved) {
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
