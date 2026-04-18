const { plugin } = require('playwright-with-fingerprints');
const fs = require('fs');
const path = require('path');

const profilesDir = Object.values(process.env).find(v => v.includes('browser_profiles')) || path.join(__dirname, '..', '..', '..', 'data', 'browser_profiles');
let profileName = 'grok'; // just guess or use default

(async () => {
    // Attempt to locate grok profile
    try {
        const dirs = fs.readdirSync(profilesDir);
        for (const d of dirs) {
            if (d.includes('grok') || d.includes('ai')) profileName = d;
        }
    } catch(e) {}
    
    console.log(`Using profile: ${profileName} at ${profilesDir}`);
    
    const context = await plugin.launchPersistentContext(path.join(profilesDir, profileName), {
        headless: false, // Run headful so user can see what's happening
        viewport: null
    });
    
    const page = context.pages()[0] || await context.newPage();
    console.log('Navigating to grok...');
    
    // Listen to network to catch video blobs/streams
    page.on('response', resp => {
        const url = resp.url();
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('video') || url.includes('.mp4') || (resp.headers()['content-length'] && parseInt(resp.headers()['content-length']) > 1000000)) {
            console.log(`[NETWORK] ${ct} -> ${url}`);
        }
    });

    await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('Page loaded. Waiting for 25 seconds for a video to appear or user to trigger one...');
    await page.waitForTimeout(25000);
    
    const html = await page.content();
    fs.writeFileSync('grok_debug_dom.html', html);
    console.log('Saved big DOM.');
    
    const videos = await page.$$('video');
    console.log(`Found ${videos.length} <video> tags`);
    for (let i=0; i<videos.length; i++) {
        const v = videos[i];
        const src = await v.getAttribute('src');
        console.log(`Video SRC: ${src}`);
        
        try {
            // Find parent to snapshot the UI controls
            const parentHTML = await page.evaluate(el => el.parentElement.parentElement.parentElement.innerHTML, v);
            fs.writeFileSync(`grok_video_parent_${i}.html`, parentHTML);
        } catch(e) {}
    }
    
    await context.close();
    console.log('Done!');
})();
