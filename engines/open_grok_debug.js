#!/usr/bin/env node
/**
 * Debug script: Opens browser with profile, navigates to grok.com/imagine,
 * and keeps it open so user can F12 inspect DOM.
 * Also logs all network responses containing video content.
 */

// Use the correct node_modules path where playwright is installed
const modulePath = require('path').join(__dirname, '..', '..', '..', '..', '..', 'tubecli', 'extensions', 'browser', 'node_modules');
require('module').globalPaths.push(modulePath);

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const profileName = 'trinhduyet';
const profilesDir = path.join(__dirname, '..', '..', '..', '..', 'data', 'browser_profiles');
const profileDir = path.join(profilesDir, profileName);
const cookiesPath = path.join(profileDir, 'cookies.json');

(async () => {
    console.log(`Opening browser with profile: ${profileName}`);
    console.log(`Profile dir: ${profileDir}`);
    
    const context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        args: ['--no-sandbox', '--test-type', '--disable-blink-features=AutomationControlled', '--start-maximized'],
        ignoreDefaultArgs: ['--enable-automation'],
        viewport: null,
    });

    // Load cookies
    if (fs.existsSync(cookiesPath)) {
        try {
            const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
            if (Array.isArray(cookies) && cookies.length > 0) {
                await context.addCookies(cookies);
                console.log(`Loaded ${cookies.length} cookies`);
            }
        } catch (e) { console.log('No cookies loaded'); }
    }

    const page = context.pages()[0] || await context.newPage();

    // Log ALL network responses that might be video
    page.on('response', async (response) => {
        const url = response.url();
        const ct = response.headers()['content-type'] || '';
        const cl = response.headers()['content-length'] || '?';
        
        if (ct.includes('video') || url.includes('.mp4') || ct.includes('octet-stream') || 
            url.includes('ext_tw_video') || url.includes('/media/')) {
            console.log(`\n[NETWORK VIDEO] Content-Type: ${ct}, Size: ${cl}`);
            console.log(`  URL: ${url}`);
        }
    });

    console.log('Navigating to grok.com/imagine...');
    await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    console.log('\n========================================');
    console.log('Browser is open! Please:');
    console.log('1. F12 to open DevTools');
    console.log('2. Generate a video or view existing one');
    console.log('3. Inspect the <video> element');
    console.log('4. Check the download button near video');
    console.log('');
    console.log('This script logs video network requests.');
    console.log('Press Ctrl+C to close when done.');
    console.log('========================================\n');

    // Keep alive - scan DOM every 10s
    setInterval(async () => {
        try {
            const videoInfo = await page.evaluate(() => {
                const videos = document.querySelectorAll('video');
                const results = [];
                videos.forEach((v, i) => {
                    results.push({
                        index: i,
                        src: v.src || '(no src)',
                        currentSrc: v.currentSrc || '(no currentSrc)',
                        width: v.videoWidth,
                        height: v.videoHeight,
                        duration: v.duration,
                        readyState: v.readyState,
                    });
                });
                return results;
            });
            if (videoInfo.length > 0) {
                console.log(`\n[DOM SCAN] Found ${videoInfo.length} video element(s):`);
                videoInfo.forEach(v => {
                    console.log(`  #${v.index}: src=${v.src.substring(0, 120)}, ${v.width}x${v.height}, dur=${v.duration}s, ready=${v.readyState}`);
                });
            }
        } catch(e) {}
    }, 10000);

    // Prevent exit
    await new Promise(() => {});
})();
