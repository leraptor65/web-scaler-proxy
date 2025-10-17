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

// Use the cors package to handle all CORS-related functionality,
// including preflight OPTIONS requests. This should be the first middleware.
app.use(cors());

// --- Live Reload Setup ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
    console.log('Client connected for live reload.');
    ws.on('close', () => {
        console.log('Client disconnected from live reload.');
    });
});

function broadcastReload() {
    console.log(`Broadcasting reload message to ${wss.clients.size} clients.`);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send('reload');
        }
    });
}
// --- End Live Reload Setup ---

let lastReportedHeight = 'N/A';

const dataDir = path.join(__dirname, 'data');
const configPath = path.join(dataDir, 'config.json');

// Helper function to read config, with defaults
function getConfig() {
    if (!fs.existsSync(configPath)) {
        return { targetUrl: 'https://www.google.com/', scaleFactor: 1.0, autoScroll: false, scrollSpeed: 50, scrollSequence: '' };
    }
    const rawData = fs.readFileSync(configPath);
    const config = JSON.parse(rawData);
    return {
        ...{ autoScroll: false, scrollSpeed: 50, scrollSequence: '' },
        ...config
    };
}

// Helper function to write config
function saveConfig(config) {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir);
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Endpoint for reporting height. We apply the express.json() middleware here
// specifically, so it doesn't interfere with the main proxy logic.
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

// --- Configuration Routes ---
app.get('/config', (req, res) => {
    const config = getConfig();
    fs.readFile(path.join(__dirname, 'config.html'), 'utf8', (err, html) => {
        if (err) {
            return res.status(500).send('Error loading config page.');
        }
        html = html.replace('<!--TARGET_URL-->', config.targetUrl)
                   .replace('<!--SCALE_FACTOR-->', config.scaleFactor)
                   .replace('<!--SCROLL_SPEED-->', config.scrollSpeed)
                   .replace('<!--SCROLL_SEQUENCE-->', config.scrollSequence || '')
                   .replace('<!--AUTOSCROLL_CHECKED-->', config.autoScroll ? 'checked' : '')
                   .replace('<!--LAST_HEIGHT-->', lastReportedHeight)
                   .replace('<!--SUCCESS_CLASS-->', req.query.saved ? 'success' : '');
        res.send(html);
    });
});

// We apply the express.urlencoded() middleware here specifically for the config form.
app.post('/config', express.urlencoded({ extended: true }), (req, res) => {
    const { targetUrl, scaleFactor, scrollSpeed, scrollSequence } = req.body;
    const autoScroll = req.body.autoScroll === 'on';

    if (targetUrl && scaleFactor && scrollSpeed) {
        saveConfig({
            targetUrl,
            scaleFactor: parseFloat(scaleFactor),
            autoScroll,
            scrollSpeed: parseInt(scrollSpeed, 10),
            scrollSequence: scrollSequence || ''
        });
        broadcastReload();
        res.redirect('/config?saved=true');
    } else {
        res.status(400).send('Invalid data submitted.');
    }
});

// --- Main Proxy Handler ---
// This now comes after the specific routes and does not have the body parsers running.
app.use('/', async (req, res) => {
    const config = getConfig();
    let target = new URL(config.targetUrl); // Start with default target from config
    let originalUrl = req.originalUrl;
    const proxyOrigin = `${req.protocol}://${req.get('host')}`;

    // --- NEW: Logic to handle requests for specific subdomains ---
    const proxyHostPrefix = '/--proxy-host--/';
    if (req.originalUrl.startsWith(proxyHostPrefix)) {
        // This is a request for a resource on a specific subdomain.
        const parts = req.originalUrl.substring(proxyHostPrefix.length).split('/');
        const originalHost = parts.shift(); // e.g., 'a.mortgagenewsdaily.com'
        originalUrl = '/' + parts.join('/'); // The rest of the path, e.g., '/assets/foo.png'

        // Create a new target URL object based on the extracted host for this request.
        target = new URL(`${target.protocol}//${originalHost}`);
    }
    
    const targetUrl = originalUrl === '/' ? new URL(config.targetUrl) : new URL(originalUrl, target.origin);

    try {
        console.log(`Proxying ${req.method} request for: ${targetUrl.href}`);

        const requestHeaders = { ...req.headers };
        delete requestHeaders.host;

        let referer = target.origin;
        if (requestHeaders.referer) {
            try {
                const refererUrl = new URL(requestHeaders.referer);
                if (!refererUrl.pathname.startsWith(proxyHostPrefix)) {
                     referer = new URL(refererUrl.pathname + refererUrl.search, target.origin).href;
                }
            } catch (e) {
                // Ignore invalid referer headers
            }
        }

        const axiosConfig = {
            method: req.method,
            url: targetUrl.href,
            headers: {
                ...requestHeaders,
                host: target.host,
                origin: target.origin,
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'accept-encoding': 'gzip, deflate, br',
                'referer': referer,
            },
            responseType: 'stream',
            validateStatus: () => true,
            maxRedirects: 0,
        };

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            axiosConfig.data = req;
        }

        const response = await axios(axiosConfig);
        const responseHeaders = response.headers;

        if (responseHeaders['set-cookie']) {
            const cookies = Array.isArray(responseHeaders['set-cookie']) ? responseHeaders['set-cookie'] : [responseHeaders['set-cookie']];
            const rewrittenCookies = cookies.map(c => c.split(';').map(p => p.trim()).filter(p => !p.toLowerCase().startsWith('domain=') && p.toLowerCase() !== 'secure').join('; '));
            res.setHeader('Set-Cookie', rewrittenCookies);
        }

        if ([301, 302, 307, 308].includes(response.status)) {
            const location = new URL(responseHeaders.location, target.origin);
            res.redirect(response.status, location.pathname + location.search);
            return;
        }
        
        Object.keys(responseHeaders).forEach(key => {
            const lowerKey = key.toLowerCase();
            if (!['content-security-policy', 'x-frame-options', 'transfer-encoding', 'set-cookie', 'location', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-allow-credentials'].includes(lowerKey)) {
                res.setHeader(key, responseHeaders[key]);
            }
        });
        
        const contentType = responseHeaders['content-type'] || '';
        
        if (contentType.includes('text/html')) {
            const stream = response.data;
            let decoder;
            const contentEncoding = responseHeaders['content-encoding'];

            if (contentEncoding === 'gzip') {
                decoder = stream.pipe(zlib.createGunzip());
            } else if (contentEncoding === 'deflate') {
                decoder = stream.pipe(zlib.createInflate());
            } else if (contentEncoding === 'br') {
                decoder = stream.pipe(zlib.createBrotliDecompress());
            } else {
                decoder = stream;
            }

            let body = '';
            for await (const chunk of decoder) {
                body += chunk.toString();
            }

            // --- FINAL, MORE ROBUST REWRITING LOGIC ---

            // 1. Rewrite relative and root-relative URLs (e.g., /path/to/file or path/to/file)
            body = body.replace(/(src|href|action)=(['"])(?!https?|:|\/\/|#)\/?([^'"]+)\2/gi, (match, attr, quote, url) => {
                 // Reconstruct the attribute with the full proxied URL, preserving the original host context.
                 return `${attr}=${quote}${proxyOrigin}${proxyHostPrefix}${target.host}/${url}${quote}`;
            });

            // 2. Rewrite absolute URLs that point to any subdomain of the target.
            const hostParts = target.host.split('.');
            const baseDomain = hostParts.slice(-2).join('.');
            const urlPattern = new RegExp(`(https?:)?//([a-zA-Z0-9.-]*${baseDomain.replace(/\./g, '\\.')})`, 'g');

            body = body.replace(urlPattern, (match, protocol, host) => {
                // Rewrite the URL to include the original host, so we can proxy it correctly later.
                return `${proxyOrigin}${proxyHostPrefix}${host}`;
            });

            body = body.replace(/integrity="[^"]*"/gi, '');
            body = body.replace(/\s+crossorigin(="[^"]*")?/gi, '');

            let autoScrollScript = '';
            if (config.autoScroll) {
                autoScrollScript = `
                <script>
                    (function() {
                        const SCROLL_SPEED_PX_PER_SEC = ${config.scrollSpeed};
                        const PIXELS_PER_FRAME = 2;
                        const FRAME_INTERVAL_MS = (1000 / SCROLL_SPEED_PX_PER_SEC) * PIXELS_PER_FRAME;
                        const SEQUENCE = "${config.scrollSequence || ''}";

                        let scrollInterval = null;
                        let currentSequenceIndex = 0;
                        let scrollRanges = [];

                        function parseSequence(seqStr) {
                            if (!seqStr.trim()) return [];
                            return seqStr.split(',')
                                .map(range => range.trim().split('-').map(Number))
                                .filter(range => range.length === 2 && !isNaN(range[0]) && !isNaN(range[1]) && range[0] < range[1]);
                        }

                        function startSequence() {
                            if (scrollRanges.length === 0) {
                                scrollFullPage();
                            } else {
                                executeNextScrollSegment();
                            }
                        }
                        
                        function executeNextScrollSegment() {
                            if (currentSequenceIndex >= scrollRanges.length) {
                                currentSequenceIndex = 0;
                            }
                            const [start, end] = scrollRanges[currentSequenceIndex];
                            window.scrollTo({ top: start, behavior: 'auto' });
                            setTimeout(() => {
                                scrollInterval = setInterval(() => {
                                    if (window.scrollY >= end) {
                                        clearInterval(scrollInterval);
                                        currentSequenceIndex++;
                                        setTimeout(executeNextScrollSegment, 2000);
                                    } else {
                                        window.scrollBy(0, PIXELS_PER_FRAME);
                                    }
                                }, FRAME_INTERVAL_MS);
                            }, 100);
                        }

                        function scrollFullPage() {
                            let atBottom = false;
                            if (scrollInterval) clearInterval(scrollInterval);
                            scrollInterval = setInterval(() => {
                                if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 5) {
                                    if (!atBottom) {
                                        atBottom = true;
                                        clearInterval(scrollInterval);
                                        setTimeout(() => {
                                            window.scrollTo({ top: 0, behavior: 'smooth' });
                                            setTimeout(() => {
                                                atBottom = false;
                                                scrollFullPage();
                                            }, 2000);
                                        }, 3000);
                                    }
                                } else {
                                    window.scrollBy(0, PIXELS_PER_FRAME);
                                }
                            }, FRAME_INTERVAL_MS);
                        }
                        
                        window.addEventListener('load', () => {
                            scrollRanges = parseSequence(SEQUENCE);
                            setTimeout(startSequence, 1500);
                        });
                    })();
                </script>`;
            }

            const injectedContent = `
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body {
                        transform: scale(${config.scaleFactor});
                        transform-origin: 0 0;
                        width: ${100 / config.scaleFactor}%;
                        overflow-x: hidden;
                    }
                </style>
                <script>
                    if ('serviceWorker' in navigator) {
                        navigator.serviceWorker.getRegistrations().then(r => { for(let i of r) i.unregister(); });
                    }
                    window.addEventListener('load', () => {
                        setTimeout(() => {
                            const height = document.documentElement.scrollHeight;
                            fetch(window.location.origin + '/report-height', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ height: height })
                            }).catch(err => console.error('Failed to report height:', err));
                        }, 2000);
                    });
                    try {
                        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                        const socket = new WebSocket(wsProtocol + '//' + window.location.host);
                        socket.addEventListener('message', e => {
                            if (e.data === 'reload') window.location.reload();
                        });
                        socket.addEventListener('open', () => console.log('Live reload connected.'));
                    } catch (e) { console.error('Live reload failed:', e); }
                </script>
                ${autoScrollScript}`;

            body = body.replace(/<meta http-equiv="Content-Security-Policy"[^]*>/gi, '');
            if (body.includes('<head>')) {
                body = body.replace('<head>', `<head>${injectedContent}`);
            } else {
                body = injectedContent + body;
            }
            
            res.status(response.status).send(body);
        } else {
            res.status(response.status);
            response.data.pipe(res);
        }

    } catch (error) {
        console.error('Proxy error:', error.message);
        res.status(500).send(`<h1>Proxy Error</h1><p>${error.message}</p>`);
    }
});

server.listen(port, () => {
    console.log(`Web Scaler Proxy running.`);
    console.log(`- View scaled page: http://localhost:${port}`);
    console.log(`- Configure: http://localhost:${port}/config`);
});

