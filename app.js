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
        console.log("Config file not found, using defaults.");
        return defaultConfig;
    }

    try {
        const rawData = fs.readFileSync(configPath, 'utf8');
        if (!rawData.trim()) {
            console.log("Config file is empty, using defaults.");
            return defaultConfig;
        }
        const config = JSON.parse(rawData);
        // Ensure all keys are present by merging with defaults
        return { ...defaultConfig, ...config };
    } catch (error) {
        console.error("Error reading or parsing config.json, using default values:", error);
        return defaultConfig;
    }
}

// FIX: This function now throws an error if saving fails, allowing the route handler to catch it.
function saveConfig(config) {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log("Configuration saved successfully to:", configPath);
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
        if (err) {
            console.error("Error reading config.html:", err);
            return res.status(500).send('Error loading config page.');
        }

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

// FIX: Wrapped the logic in a try...catch block to handle save failures.
app.post('/config', express.urlencoded({ extended: true }), (req, res) => {
    try {
        const { targetUrl, scaleFactor, scrollSpeed, scrollSequence } = req.body;
        const newConfig = {
            targetUrl,
            scaleFactor: parseFloat(scaleFactor),
            autoScroll: req.body.autoScroll === 'on',
            scrollSpeed: parseInt(scrollSpeed, 10),
            scrollSequence: scrollSequence || ''
        };
        saveConfig(newConfig);
        broadcastReload();
        res.redirect('/config?saved=true');
    } catch (error) {
        console.error("!!! CRITICAL: Failed to save configuration:", error);
        res.status(500).send(`
            <body style="font-family: sans-serif; padding: 2em;">
                <h1>Error Saving Configuration</h1>
                <p>The server was unable to save the settings.</p>
                <p><strong>This is most likely a file permissions issue inside the Docker container.</strong> The application needs permission to write to the <code>/usr/src/app/data</code> directory.</p>
                <p>Please check the container logs for more details. The error was:</p>
                <pre style="background-color: #f0f0f0; padding: 1em; border-radius: 5px;">${error.message}</pre>
                <a href="/config">Go back to configuration</a>
            </body>
        `);
    }
});

// FIX: Wrapped the logic in a try...catch block to handle save failures on reset.
app.post('/reset', (req, res) => {
    try {
        console.log('Resetting configuration to default.');
        saveConfig(defaultConfig); // Overwrite with defaults
        broadcastReload();
        res.redirect('/config');
    } catch (error) {
        console.error("!!! CRITICAL: Failed to save configuration on reset:", error);
        res.status(500).send(`
            <body style="font-family: sans-serif; padding: 2em;">
                <h1>Error Resetting Configuration</h1>
                <p>The server was unable to save the default settings.</p>
                <p><strong>This is most likely a file permissions issue inside the Docker container.</strong> The application needs permission to write to the <code>/usr/src/app/data</code> directory.</p>
                <p>Please check the container logs for more details. The error was:</p>
                <pre style="background-color: #f0f0f0; padding: 1em; border-radius: 5px;">${error.message}</pre>
                <a href="/config">Go back to configuration</a>
            </body>
        `);
    }
});


// --- Main Proxy Handler (MUST BE LAST) ---
app.use('/', async (req, res) => {
    const config = getConfig();
    const proxyHost = req.get('host');

    if (config.targetUrl.includes(proxyHost)) {
        return res.status(500).send(`<h1>Configuration Error</h1><p>The target URL cannot be the same as the proxy address. Please <a href="/config">configure a different URL</a>.</p>`);
    }

    let target;
    try {
        target = new URL(config.targetUrl);
    } catch (error) {
        return res.status(500).send(`<h1>Invalid Target URL</h1><p>The configured URL "${config.targetUrl}" is not valid. Please <a href="/config">correct it</a>.</p>`);
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

