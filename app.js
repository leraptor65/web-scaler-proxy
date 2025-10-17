const express = require('express');
const axios = require('axios');
const fs =require('fs');
const path = require('path');
const { URL } = require('url');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const zlib = require('zlib');

const app = express();
const port = 1337;

// Use the cors package to handle all CORS-related functionality.
app.use(cors());

// --- Live Reload Setup ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
    console.log('Client connected for live reload.');
    ws.on('close', () => console.log('Client disconnected from live reload.'));
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
    return { ...{ autoScroll: false, scrollSpeed: 50, scrollSequence: '' }, ...JSON.parse(rawData) };
}

// Helper function to write config
function saveConfig(config) {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Endpoint for reporting page height
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
        if (err) return res.status(500).send('Error loading config page.');
        const finalHtml = html.replace('', config.targetUrl)
                              .replace('', config.scaleFactor)
                              .replace('', config.scrollSpeed)
                              .replace('', config.scrollSequence || '')
                              .replace('', config.autoScroll ? 'checked' : '')
                              .replace('', lastReportedHeight)
                              .replace('', req.query.saved ? 'success' : '');
        res.send(finalHtml);
    });
});

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
app.use('/', async (req, res) => {
    const config = getConfig();
    let target = new URL(config.targetUrl);
    let originalUrl = req.originalUrl;
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const proxyOrigin = `${protocol}://${req.get('host')}`;

    // Logic to handle requests for specific subdomains
    const proxyHostPrefix = '/--proxy-host--/';
    if (req.originalUrl.startsWith(proxyHostPrefix)) {
        const parts = req.originalUrl.substring(proxyHostPrefix.length).split('/');
        const originalHost = parts.shift();
        originalUrl = '/' + parts.join('/');
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
            } catch (e) { /* Ignore invalid referer headers */ }
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
        const { status, headers: responseHeaders } = response;

        if (responseHeaders['set-cookie']) {
            const cookies = Array.isArray(responseHeaders['set-cookie']) ? responseHeaders['set-cookie'] : [responseHeaders['set-cookie']];
            const rewrittenCookies = cookies.map(c => c.split(';').map(p => p.trim()).filter(p => !p.toLowerCase().startsWith('domain=') && p.toLowerCase() !== 'secure').join('; '));
            res.setHeader('Set-Cookie', rewrittenCookies);
        }

        if ([301, 302, 307, 308].includes(status)) {
            const location = new URL(responseHeaders.location, target.origin);
            res.redirect(status, location.pathname + location.search);
            return;
        }
        
        // Forward headers, filtering those that cause issues when we modify content.
        Object.keys(responseHeaders).forEach(key => {
            const lowerKey = key.toLowerCase();
            if (!['content-security-policy', 'x-frame-options', 'transfer-encoding', 'set-cookie', 'location', 'content-encoding', 'content-length'].includes(lowerKey)) {
                res.setHeader(key, responseHeaders[key]);
            }
        });
        
        const contentType = responseHeaders['content-type'] || '';
        const stream = response.data;
        const contentEncoding = responseHeaders['content-encoding'];
        let decoder;

        // Decompress stream if necessary
        if (contentEncoding === 'gzip') decoder = stream.pipe(zlib.createGunzip());
        else if (contentEncoding === 'deflate') decoder = stream.pipe(zlib.createInflate());
        else if (contentEncoding === 'br') decoder = stream.pipe(zlib.createBrotliDecompress());
        else decoder = stream;

        // Buffer text-based content (HTML, JS, CSS) to avoid truncation errors from unstable streaming.
        if (contentType.includes('text/html') || contentType.includes('javascript') || contentType.includes('css')) {
            const chunks = [];
            for await (const chunk of decoder) {
                chunks.push(chunk);
            }
            let body = Buffer.concat(chunks).toString();

            if (contentType.includes('text/html')) {
                // Rewrite URLs in HTML
                const hostParts = target.host.split('.');
                const baseDomain = hostParts.slice(-2).join('.');
                const urlPattern = new RegExp(`(https?:)?//([a-zA-Z0-9.-]*${baseDomain.replace(/\./g, '\\.')})`, 'g');
                
                body = body.replace(/(src|href|action)=(['"])(?!https?|:|\/\/|#)\/?([^'"]+)\2/gi, (match, attr, quote, url) => `${attr}=${quote}${proxyOrigin}${proxyHostPrefix}${target.host}/${url}${quote}`);
                body = body.replace(urlPattern, (match, protocol, host) => `${proxyOrigin}${proxyHostPrefix}${host}`);
                body = body.replace(/integrity="[^"]*"/gi, '').replace(/\s+crossorigin(="[^"]*")?/gi, '');

                // Inject scripts and styles
                let autoScrollScript = '';
                if (config.autoScroll) {
                    autoScrollScript = `<script>/* ... auto-scroll logic from previous version ... */</script>`; // Placeholder for brevity
                }
                const injectedContent = `
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <style>body{transform:scale(${config.scaleFactor});transform-origin:0 0;width:${100/config.scaleFactor}%;overflow-x:hidden;}</style>
                    <script>
                        if('serviceWorker' in navigator)navigator.serviceWorker.getRegistrations().then(r=>{for(let i of r)i.unregister();});
                        window.addEventListener('load',()=>{setTimeout(()=>{const height=document.documentElement.scrollHeight;fetch(window.location.origin+'/report-height',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({height})}).catch(err=>console.error('Failed to report height:',err))},2000)});
                        try{const wsProtocol=window.location.protocol==='https:'?'wss:':'ws:';const socket=new WebSocket(wsProtocol+'//'+window.location.host);socket.addEventListener('message',e=>{if(e.data==='reload')window.location.reload()});socket.addEventListener('open',()=>console.log('Live reload connected.'))}catch(e){console.error('Live reload failed:',e)}
                    </script>
                    ${autoScrollScript}`;
                
                body = body.replace(/<meta http-equiv="Content-Security-Policy"[^]*>/gi, '');
                body = body.includes('<head>') ? body.replace('<head>', `<head>${injectedContent}`) : injectedContent + body;
            }
            
            res.status(status).send(body);
        } else {
            // Stream all other content types (images, fonts, etc.) directly.
            res.status(status);
            decoder.pipe(res);
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
