const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const zlib = require('zlib');

const app = express();
const port = 1337;

// --- Middleware and Server Setup ---
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- Live Reload Logic ---
wss.on('connection', ws => {
    console.log('Client connected for live reload.');
    ws.on('close', () => console.log('Client disconnected from live reload.'));
});

function broadcastReload() {
    console.log(`Broadcasting reload message to ${wss.clients.size} clients.`);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send('reload');
    });
}

// --- Configuration Management ---
let lastReportedHeight = 'N/A';
const dataDir = path.join(__dirname, 'data');
const configPath = path.join(dataDir, 'config.json');

const defaultConfig = {
    targetUrl: 'https://www.google.com/',
    scaleFactor: 1.0,
    autoScroll: false,
    scrollSpeed: 50,
    scrollSequence: ''
};

function getConfig() {
    if (!fs.existsSync(configPath)) {
        return defaultConfig;
    }
    try {
        const rawData = fs.readFileSync(configPath, 'utf8');
        return { ...defaultConfig, ...JSON.parse(rawData.trim() || '{}') };
    } catch (error) {
        console.error("Error reading config, using defaults:", error);
        return defaultConfig;
    }
}

function saveConfig(config) {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// --- Route Handlers ---

app.get('/favicon.ico', (req, res) => res.status(204).send());

app.post('/report-height', express.json(), (req, res) => {
    const { height } = req.body;
    if (height && typeof height === 'number') {
        lastReportedHeight = Math.round(height);
        console.log(`Received page height: ${lastReportedHeight}px`);
        res.status(200).send({ message: 'Height received' });
    } else {
        res.status(400).send({ message: 'Invalid height data' });
    }
});

app.get('/config', (req, res) => {
    const config = getConfig();
    fs.readFile(path.join(__dirname, 'config.html'), 'utf8', (err, html) => {
        if (err) return res.status(500).send('Error loading config page.');
        const finalHtml = html
            .replace('%%TARGET_URL%%', config.targetUrl)
            .replace('%%SCALE_FACTOR%%', config.scaleFactor)
            .replace('%%SCROLL_SPEED%%', config.scrollSpeed)
            .replace('%%SCROLL_SEQUENCE%%', config.scrollSequence || '')
            .replace('%%AUTOSCROLL_CHECKED%%', config.autoScroll ? 'checked' : '')
            .replace('%%PAGE_HEIGHT%%', lastReportedHeight)
            .replace('%%SUCCESS_CLASS%%', req.query.saved ? 'success' : '');
        res.send(finalHtml);
    });
});

app.post('/config', express.urlencoded({ extended: true }), (req, res) => {
    try {
        const { targetUrl, scaleFactor, scrollSpeed, scrollSequence } = req.body;
        saveConfig({
            targetUrl,
            scaleFactor: parseFloat(scaleFactor),
            autoScroll: req.body.autoScroll === 'on',
            scrollSpeed: parseInt(scrollSpeed, 10),
            scrollSequence: scrollSequence || ''
        });
        broadcastReload();
        res.redirect('/config?saved=true');
    } catch (error) {
        console.error("!!! CRITICAL: Failed to save configuration:", error);
        res.status(500).send(`<h1>Error Saving Configuration</h1><p>Check container logs. Error: ${error.message}</p><a href="/config">Go back</a>`);
    }
});

app.post('/reset', (req, res) => {
    try {
        saveConfig(defaultConfig);
        broadcastReload();
        res.redirect('/config');
    } catch (error) {
        console.error("!!! CRITICAL: Failed to reset configuration:", error);
        res.status(500).send(`<h1>Error Resetting Configuration</h1><p>Check container logs. Error: ${error.message}</p><a href="/config">Go back</a>`);
    }
});


// --- Main Proxy Handler (MUST BE LAST) ---
app.use('/', async (req, res) => {
    const config = getConfig();
    const proxyHost = req.get('host');

    if (config.targetUrl.includes(proxyHost)) {
        return res.status(500).send(`<h1>Configuration Error</h1><p>Target URL cannot be the proxy address. <a href="/config">Configure a different URL</a>.</p>`);
    }

    let target;
    try {
        target = new URL(config.targetUrl);
    } catch (error) {
        return res.status(500).send(`<h1>Invalid Target URL</h1><p>URL "${config.targetUrl}" is not valid. <a href="/config">Please correct it</a>.</p>`);
    }

    let originalUrl = req.originalUrl;
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const proxyOrigin = `${protocol}://${proxyHost}`;

    const proxyHostPrefix = '/--proxy-host--/';
    if (originalUrl.startsWith(proxyHostPrefix)) {
        const parts = originalUrl.substring(proxyHostPrefix.length).split('/');
        const originalHost = parts.shift();
        originalUrl = '/' + parts.join('/');
        target = new URL(`${target.protocol}//${originalHost}`);
    }

    const targetUrl = originalUrl === '/' ? new URL(config.targetUrl) : new URL(originalUrl, target.origin);

    try {
        const response = await axios({
            method: req.method,
            url: targetUrl.href,
            headers: { ...req.headers, host: target.host },
            responseType: 'stream',
            validateStatus: () => true,
            maxRedirects: 0,
            data: (req.method !== 'GET' && req.method !== 'HEAD') ? req : undefined,
        });

        if ([301, 302, 307, 308].includes(response.status)) {
            const location = new URL(response.headers.location, target.origin);
            return res.redirect(response.status, location.pathname + location.search);
        }
        
        // Forward headers, removing problematic ones
        Object.keys(response.headers).forEach(key => {
            if (!['content-security-policy', 'x-frame-options', 'transfer-encoding', 'content-encoding', 'content-length'].includes(key.toLowerCase())) {
                res.setHeader(key, response.headers[key]);
            }
        });
        
        const contentType = response.headers['content-type'] || '';
        const contentEncoding = response.headers['content-encoding'];
        let stream = response.data;
        
        // Decompress stream if necessary
        if (contentEncoding === 'gzip') stream = stream.pipe(zlib.createGunzip());
        else if (contentEncoding === 'deflate') stream = stream.pipe(zlib.createInflate());
        else if (contentEncoding === 'br') stream = stream.pipe(zlib.createBrotliDecompress());

        if (contentType.includes('text/html')) {
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            let body = Buffer.concat(chunks).toString();

            // URL Rewriting
            const urlPattern = new RegExp(`(https?:)?//([a-zA-Z0-9.-]*${target.host.replace(/\./g, '\\.')})`, 'g');
            body = body.replace(/(src|href|action)=(['"])(?!https?|:|\/\/|#)\/?([^'"]+)\2/gi, `$1=$2${proxyOrigin}${proxyHostPrefix}${target.host}/$3$2`);
            body = body.replace(urlPattern, `${proxyOrigin}${proxyHostPrefix}${target.host}`);
            body = body.replace(/integrity="[^"]*"/gi, '').replace(/\s+crossorigin(="[^"]*")?/gi, '');

            // FIX: Injected a full, robust auto-scrolling script
            const injectedScripts = `
                <script>
                    const config = {
                        autoScroll: ${config.autoScroll},
                        scrollSpeed: ${config.scrollSpeed},
                        scrollSequence: "${config.scrollSequence || ''}"
                    };
                </script>
                <script>
                    if (config.autoScroll) {
                        document.addEventListener('DOMContentLoaded', () => {
                            let lastTime = 0;
                            let currentSequenceIndex = 0;
                            let sequences = [];
                            let pauseUntil = 0;
                            const PAUSE_DURATION_MS = 3000; // 3 second pause between sequences

                            function parseSequences() {
                                const pageHeight = document.documentElement.scrollHeight - window.innerHeight;
                                if (!config.scrollSequence.trim()) {
                                    sequences.push({ start: 0, end: pageHeight });
                                    return;
                                }
                                sequences = config.scrollSequence.split(',')
                                    .map(s => s.trim().split('-').map(Number))
                                    .filter(p => p.length === 2 && !isNaN(p[0]) && !isNaN(p[1]))
                                    .map(p => ({ start: p[0], end: Math.min(p[1], pageHeight) }));
                                if (sequences.length === 0) {
                                     sequences.push({ start: 0, end: pageHeight });
                                }
                            }

                            function scrollStep(timestamp) {
                                if (!lastTime) lastTime = timestamp;
                                const deltaTime = timestamp - lastTime;
                                lastTime = timestamp;
                                
                                if (Date.now() < pauseUntil) {
                                    requestAnimationFrame(scrollStep);
                                    return;
                                }

                                const current = sequences[currentSequenceIndex];
                                const distance = (config.scrollSpeed / 1000) * deltaTime;
                                window.scrollBy(0, distance);
                                
                                // Check if we've reached the end of the current sequence
                                if (window.scrollY >= current.end) {
                                    currentSequenceIndex++;
                                    // If we've finished all sequences, loop back to the start
                                    if (currentSequenceIndex >= sequences.length) {
                                        currentSequenceIndex = 0;
                                    }
                                    // Set the new scroll position and pause
                                    window.scrollTo(0, sequences[currentSequenceIndex].start);
                                    pauseUntil = Date.now() + PAUSE_DURATION_MS;
                                }
                                requestAnimationFrame(scrollStep);
                            }

                            // Start the process
                            parseSequences();
                            if(sequences.length > 0) {
                                window.scrollTo(0, sequences[0].start);
                                requestAnimationFrame(scrollStep);
                            }
                        });
                    }
                </script>
                <script>
                    // Live reload and page height reporting logic
                    window.addEventListener('load', () => {
                        setTimeout(() => {
                            const height = document.documentElement.scrollHeight;
                            fetch('/report-height', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({height}) });
                        }, 2000);
                    });
                    const socket = new WebSocket((window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + window.location.host);
                    socket.addEventListener('message', e => e.data === 'reload' && window.location.reload());
                </script>
            `;
            const styling = `<style>body{transform:scale(${config.scaleFactor});transform-origin:0 0;width:${100/config.scaleFactor}%;overflow-x:hidden;}</style>`;
            
            body = body.replace('</head>', `${styling}${injectedScripts}</head>`);
            res.send(body);

        } else {
            res.status(response.status);
            stream.pipe(res);
        }
    } catch (error) {
        console.error('Proxy error:', error.message);
        res.status(500).send(`<h1>Proxy Error</h1><p>${error.message}</p>`);
    }
});

server.listen(port, () => {
    console.log(`Web Scaler Proxy running on http://localhost:${port}`);
});

