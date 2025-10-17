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

// FINAL FIX: This function is now extremely robust. It handles missing files,
// empty files, corrupted JSON, and missing keys, always returning a valid config.
function getConfig() {
    const defaults = {
        targetUrl: 'https://www.google.com/',
        scaleFactor: 1.0,
        autoScroll: false,
        scrollSpeed: 50,
        scrollSequence: ''
    };

    if (!fs.existsSync(configPath)) {
        return defaults;
    }

    try {
        const rawData = fs.readFileSync(configPath, 'utf8');
        // If the file is empty or just whitespace, return defaults
        if (!rawData.trim()) {
            return defaults;
        }
        const config = JSON.parse(rawData);
        // Ensure all keys are present by merging with defaults
        return { ...defaults, ...config };
    } catch (error) {
        console.error("Error reading or parsing config.json, using default values:", error);
        return defaults;
    }
}

function saveConfig(config) {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// --- Route Handlers ---

// FIX: Handle favicon requests explicitly to prevent them from hitting the proxy.
app.get('/favicon.ico', (req, res) => res.status(204).send());

// Endpoint for the client to report its page height
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

// The configuration page GET route
app.get('/config', (req, res) => {
    const config = getConfig(); // This is now guaranteed to be a valid object
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

// The configuration page POST route
app.post('/config', express.urlencoded({ extended: true }), (req, res) => {
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
});

// --- Main Proxy Handler (MUST BE LAST) ---
app.use('/', async (req, res) => {
    const config = getConfig();
    const proxyHost = req.get('host');
    
    // FINAL FIX: Prevent ERR_TOO_MANY_REDIRECTS by checking if the target
    // URL is the proxy's own address.
    if (config.targetUrl.includes(proxyHost)) {
        return res.status(500).send('<h1>Configuration Error</h1><p>The target URL cannot be the same as the proxy address. Please <a href="/config">configure a different URL</a>.</p>');
    }

    // (The rest of the proxy logic remains the same)
    let target = new URL(config.targetUrl);
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
        const axiosConfig = {
            method: req.method,
            url: targetUrl.href,
            headers: {
                ...req.headers,
                host: target.host,
                origin: target.origin,
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'accept-encoding': 'gzip, deflate, br',
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
        
        if ([301, 302, 307, 308].includes(status)) {
            const location = new URL(responseHeaders.location, target.origin);
            res.redirect(status, location.pathname + location.search);
            return;
        }

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

        if (contentEncoding === 'gzip') decoder = stream.pipe(zlib.createGunzip());
        else if (contentEncoding === 'deflate') decoder = stream.pipe(zlib.createInflate());
        else if (contentEncoding === 'br') decoder = stream.pipe(zlib.createBrotliDecompress());
        else decoder = stream;

        if (contentType.includes('text/html') || contentType.includes('javascript') || contentType.includes('css')) {
            const chunks = [];
            for await (const chunk of decoder) chunks.push(chunk);
            let body = Buffer.concat(chunks).toString();

            if (contentType.includes('text/html')) {
                // Perform URL rewriting and script injection as before
                 const hostParts = target.host.split('.');
                const baseDomain = hostParts.slice(-2).join('.');
                const urlPattern = new RegExp(`(https?:)?//([a-zA-Z0-9.-]*${baseDomain.replace(/\./g, '\\.')})`, 'g');
                body = body.replace(/(src|href|action)=(['"])(?!https?|:|\/\/|#)\/?([^'"]+)\2/gi, (match, attr, quote, url) => `${attr}=${quote}${proxyOrigin}${proxyHostPrefix}${target.host}/${url}${quote}`);
                body = body.replace(urlPattern, (match, protocol, host) => `${proxyOrigin}${proxyHostPrefix}${host}`);
                body = body.replace(/integrity="[^"]*"/gi, '').replace(/\s+crossorigin(="[^"]*")?/gi, '');
                
                const injectedContent = `<meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{transform:scale(${config.scaleFactor});transform-origin:0 0;width:${100/config.scaleFactor}%;overflow-x:hidden;}</style><script>if('serviceWorker' in navigator)navigator.serviceWorker.getRegistrations().then(r=>{for(let i of r)i.unregister();});window.addEventListener('load',()=>{setTimeout(()=>{const height=document.documentElement.scrollHeight;fetch(window.location.origin+'/report-height',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({height})}).catch(err=>console.error('Failed to report height:',err))},2000)});try{const wsProtocol=window.location.protocol==='https:'?'wss:':'ws:';const socket=new WebSocket(wsProtocol+'//'+window.location.host);socket.addEventListener('message',e=>{if(e.data==='reload')window.location.reload()});socket.addEventListener('open',()=>console.log('Live reload connected.'))}catch(e){console.error('Live reload failed:',e)}</script>`;
                body = body.replace(/<meta http-equiv="Content-Security-Policy"[^]*>/gi, '');
                body = body.includes('<head>') ? body.replace('<head>', `<head>${injectedContent}`) : injectedContent + body;

            }
            res.status(status).send(body);
        } else {
            res.status(status);
            decoder.pipe(res);
        }
    } catch (error) {
        console.error('Proxy error:', error.message);
        res.status(500).send(`<h1>Proxy Error</h1><p>${error.message}</p>`);
    }
});

server.listen(port, () => {
    console.log(`Web Scaler Proxy running on http://localhost:${port}`);
});
