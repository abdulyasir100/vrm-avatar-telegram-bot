
'use strict';

const https = require('https');
const http  = require('http');

const TOKEN      = process.env.BOT_TOKEN;
const ALLOWED_ID = Number(process.env.ALLOWED_ID);

const AVATAR_SERVER_URL = process.env.AVATAR_SERVER_URL || 'http://localhost:8800';
const CLOCKIN_SERVICE_URL = process.env.CLOCKIN_SERVICE_URL || 'http://localhost:8804';
const MEME_SERVICE_URL = process.env.MEME_SERVICE_URL || 'http://localhost:8807';
const AVATAR_TIMEOUT = 360000; // 360s (code mode uses Opus, can take ~5min)

const API_PORT = 3001;

const MAX_LOGS = 200;
const logBuffer = [];
const startTime = Date.now();
let messageCount = 0;
let lastMessageTime = null;
let lastMessageFrom = null;
let lastMessageText = null;

const origLog  = console.log.bind(console);
const origErr  = console.error.bind(console);
const origWarn = console.warn.bind(console);

function pushLog(level, args) {
  const entry = {
    ts: Date.now(),
    level,
    msg: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '),
  };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
}

console.log   = (...args) => { pushLog('info', args);  origLog(...args); };
console.error = (...args) => { pushLog('error', args); origErr(...args); };
console.warn  = (...args) => { pushLog('warn', args);  origWarn(...args); };

let offset = 0;

function apiRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
    ).toString();

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}${query ? '?' + query : ''}`,
      method: 'GET',
      timeout: 35000,
    };

    const req = https.get(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse failed: ' + data.slice(0, 100))); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

function apiPost(method, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      timeout: 35000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok) reject(new Error(json.description || 'Telegram API error'));
          else resolve(json);
        } catch (e) { reject(new Error('JSON parse failed: ' + data.slice(0, 100))); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sendMessage(chatId, text) {
  return apiPost('sendMessage', { chat_id: chatId, text }).catch(e =>
    console.error('[sendMessage error]', e.message)
  );
}

function sendMessageWithKeyboard(chatId, text, inlineKeyboard) {
  const body = { chat_id: chatId, text };
  if (inlineKeyboard && inlineKeyboard.length > 0) {
    body.reply_markup = JSON.stringify({ inline_keyboard: inlineKeyboard });
  }
  return apiPost('sendMessage', body).catch(e =>
    console.error('[sendMessageWithKeyboard error]', e.message)
  );
}

function editMessageText(chatId, messageId, text, inlineKeyboard) {
  const body = { chat_id: chatId, message_id: messageId, text };
  if (inlineKeyboard && inlineKeyboard.length > 0) {
    body.reply_markup = JSON.stringify({ inline_keyboard: inlineKeyboard });
  } else {
    body.reply_markup = JSON.stringify({ inline_keyboard: [] });
  }
  return apiPost('editMessageText', body).catch(e =>
    console.error('[editMessageText error]', e.message)
  );
}

function answerCallbackQuery(callbackQueryId, text) {
  return apiPost('answerCallbackQuery', { callback_query_id: callbackQueryId, text }).catch(e =>
    console.error('[answerCallbackQuery error]', e.message)
  );
}

function sendSticker(chatId, fileId) {
  return apiPost('sendSticker', { chat_id: chatId, sticker: fileId }).catch(e =>
    console.error('[sendSticker error]', e.message)
  );
}

function avatarChat(message, userName, image_base64 = null) {
  return new Promise((resolve, reject) => {
    const body = {
      message,
      context: 'telegram',
      user_name: userName,
    };
    if (image_base64) {
      body.image_base64 = image_base64;
    }
    const payload = JSON.stringify(body);

    const url = new URL(AVATAR_SERVER_URL + '/chat');

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      timeout: AVATAR_TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    let settled = false;

    const hardTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        req.destroy();
        reject(new Error('Avatar server hard timeout'));
      }
    }, AVATAR_TIMEOUT + 5000);

    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error('Avatar server returned invalid JSON'));
        }
      });
    });

    req.on('timeout', () => {
      if (!settled) { settled = true; clearTimeout(hardTimer); req.destroy(); reject(new Error('Avatar server timeout')); }
    });
    req.on('error', e => {
      if (!settled) { settled = true; clearTimeout(hardTimer); reject(e); }
    });
    req.write(payload);
    req.end();
  });
}

function downloadTelegramFile(fileId) {
  return new Promise(async (resolve, reject) => {
    try {
      // Step 1: Get file path from Telegram
      const fileInfo = await apiRequest('getFile', { file_id: fileId });
      if (!fileInfo.ok || !fileInfo.result.file_path) {
        return reject(new Error('Failed to get file path from Telegram'));
      }

      const filePath = fileInfo.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

      // Step 2: Download the file
      https.get(fileUrl, { timeout: 30000 }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

function avatarTranscribe(audioBuffer, contentType) {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="voice.ogg"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, audioBuffer, footer]);

    const url = new URL(AVATAR_SERVER_URL + '/transcribe');
    console.log(`[stt] POST ${url.href} (${body.length} bytes, boundary=${boundary})`);

    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      timeout: 30000,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`[stt] Response ${res.statusCode}: ${data.slice(0, 200)}`);
        try {
          const json = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(json.detail || `STT error ${res.statusCode}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`STT returned invalid JSON: ${data.slice(0, 100)}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('STT timeout')); });
    req.on('error', e => { console.error(`[stt] Request error: ${e.message}`); reject(e); });
    req.write(body);
    req.end();
  });
}

function avatarStatus() {
  return new Promise((resolve, reject) => {
    const url = new URL(AVATAR_SERVER_URL + '/status');

    const req = http.get({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      timeout: 5000,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', e => reject(e));
  });
}

function adminGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(AVATAR_SERVER_URL + path);
    const req = http.get({
      hostname: url.hostname, port: url.port, path: url.pathname, timeout: 5000,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function adminPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(AVATAR_SERVER_URL + path);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST', timeout: 5000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// --- Clock-in service helpers ---
function clockinGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(CLOCKIN_SERVICE_URL + path);
    const req = http.get({
      hostname: url.hostname, port: url.port, path: url.pathname, timeout: 5000,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function clockinPost(pathWithQuery) {
  return new Promise((resolve, reject) => {
    const url = new URL(CLOCKIN_SERVICE_URL + pathWithQuery);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method: 'POST', timeout: 30000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': 0 },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// --- Meme service helpers ---
function memeGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(MEME_SERVICE_URL + path);
    const req = http.get({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, timeout: 5000,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function memePost(pathWithQuery) {
  return new Promise((resolve, reject) => {
    const url = new URL(MEME_SERVICE_URL + pathWithQuery);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method: 'POST', timeout: 5000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': 0 },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// --- Emoji toggle for emotion tags in replies ---
let showEmotionTags = true;

// --- Sticker toggle ---
let stickersEnabled = true;

async function handleVoiceMessage(msg) {
  const chatId = msg.chat.id;
  const voice = msg.voice || msg.audio;
  const userName = 'Venomaru';

  console.log(`[voice] from=${msg.from.id} duration=${voice.duration}s size=${voice.file_size}`);

  if (voice.duration > 60) {
    await sendMessage(chatId, 'Voice message too long (max 60s).');
    return;
  }

  await sendMessage(chatId, '...');

  try {
    // Download voice file from Telegram
    const audioBuffer = await downloadTelegramFile(voice.file_id);
    console.log(`[voice] Downloaded ${audioBuffer.length} bytes`);

    // Transcribe via avatar-server STT
    const sttResult = await avatarTranscribe(audioBuffer, voice.mime_type || 'audio/ogg');
    const transcribed = sttResult.text;
    console.log(`[voice] Transcribed (${sttResult.language}): "${transcribed}"`);

    if (!transcribed) {
      await sendMessage(chatId, "Couldn't hear what you said. Try again?");
      return;
    }

    // Send to chat pipeline
    const result = await avatarChat(transcribed, 'Venomaru');
    const emotionTag = (showEmotionTags && result.emotion) ? `[${result.emotion}] ` : '';
    await sendMessage(chatId, emotionTag + result.reply);
    if (stickersEnabled && result.sticker_id && Math.random() < 0.75) {
      await sendSticker(chatId, result.sticker_id);
    }
    console.log(`[avatar] replied: [${result.emotion}] ${result.reply.slice(0, 80)}`);
  } catch (e) {
    console.error(`[voice] Error: ${e.message || e}`);
    console.error(`[voice] Stack: ${e.stack || 'no stack'}`);
    if (e.message && (e.message.includes('STT') || e.message.includes('503'))) {
      await sendMessage(chatId, 'Voice recognition is offline. Send text instead.');
    } else {
      await sendMessage(chatId, 'Failed to process voice message. Try again.');
    }
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;

  // Handle voice messages
  if (msg.voice || msg.audio) {
    if (msg.from.id !== ALLOWED_ID) {
      await sendMessage(chatId, 'Unauthorized.');
      return;
    }
    messageCount++;
    lastMessageTime = Date.now();
    lastMessageFrom = msg.from.first_name || msg.from.username || String(msg.from.id);
    lastMessageText = '(voice message)';
    return handleVoiceMessage(msg);
  }

  // Handle photo messages — download, base64, send to avatar-server with caption
  if (msg.photo) {
    if (msg.from.id !== ALLOWED_ID) {
      await sendMessage(chatId, 'Unauthorized.');
      return;
    }
    messageCount++;
    lastMessageTime = Date.now();
    lastMessageFrom = msg.from.first_name || msg.from.username || String(msg.from.id);
    lastMessageText = msg.caption ? msg.caption.slice(0, 100) : '(photo)';

    await sendMessage(chatId, '...');

    try {
      // Pick largest photo size (last in array)
      const photoSize = msg.photo[msg.photo.length - 1];
      const photoBuffer = await downloadTelegramFile(photoSize.file_id);
      console.log(`[photo] Downloaded ${photoBuffer.length} bytes`);

      const base64 = photoBuffer.toString('base64');
      const caption = msg.caption || '[User sent an image]';

      const result = await avatarChat(caption, 'Venomaru', base64);
      const emotionTag = (showEmotionTags && result.emotion) ? `[${result.emotion}] ` : '';
      await sendMessage(chatId, emotionTag + result.reply);
      if (stickersEnabled && result.sticker_id && Math.random() < 0.75) {
        await sendSticker(chatId, result.sticker_id);
      }
      console.log(`[avatar] replied: [${result.emotion}] ${result.reply.slice(0, 80)}`);
    } catch (e) {
      console.error(`[photo] Error: ${e.message || e}`);
      await sendMessage(chatId, 'Failed to process image. Try again.');
    }
    return;
  }

  // Handle sticker messages — lightweight: emoji → emotion → send sticker back (no LLM/TTS)
  if (msg.sticker) {
    if (msg.from.id !== ALLOWED_ID) return;
    if (!stickersEnabled) return;
    messageCount++;
    lastMessageTime = Date.now();
    lastMessageFrom = msg.from.first_name || msg.from.username || String(msg.from.id);
    lastMessageText = '(sticker)';
    const emoji = msg.sticker.emoji || '';
    const emojiToEmotion = {
      '😀': 'HAPPY', '😁': 'HAPPY', '😂': 'HAPPY', '🤣': 'HAPPY', '😊': 'HAPPY',
      '😄': 'HAPPY', '😆': 'HAPPY', '🥰': 'HAPPY', '😍': 'HAPPY', '🎉': 'HAPPY',
      '👍': 'HAPPY', '❤️': 'HAPPY', '💕': 'HAPPY', '✨': 'HAPPY', '🌟': 'HAPPY',
      '😢': 'SAD', '😭': 'SAD', '🥺': 'SAD', '😞': 'SAD', '😔': 'SAD', '💔': 'SAD',
      '😠': 'ANGRY', '😡': 'ANGRY', '🤬': 'ANGRY', '💢': 'ANGRY', '👊': 'ANGRY',
      '😮': 'SURPRISED', '😱': 'SURPRISED', '🤯': 'SURPRISED', '😲': 'SURPRISED', '❗': 'SURPRISED',
      '🤔': 'THINKING', '🧐': 'THINKING', '💭': 'THINKING', '❓': 'THINKING',
    };
    const emotion = emojiToEmotion[emoji] || ['HAPPY', 'ANGRY', 'SURPRISED'][Math.floor(Math.random() * 3)];
    try {
      const stickers = await adminGet('/stickers');
      const matches = stickers.filter(s => s.emotion === emotion && s.file_id);
      if (matches.length > 0) {
        const pick = matches[Math.floor(Math.random() * matches.length)];
        await sendSticker(chatId, pick.file_id);
        console.log(`[sticker] ${emoji} → ${emotion} → sent sticker back`);
      }
    } catch (e) {
      console.warn(`[sticker] Failed to fetch stickers: ${e.message}`);
    }
    return;
  }

  const text = (msg.text || '').trim();

  if (!text) return;

  messageCount++;
  lastMessageTime = Date.now();
  lastMessageFrom = msg.from.first_name || msg.from.username || String(msg.from.id);
  lastMessageText = text.slice(0, 100);

  console.log(`[msg] from=${msg.from.id} text="${text}"`);

  if (msg.from.id !== ALLOWED_ID) {
    console.warn('[auth] blocked user:', msg.from.id);
    await sendMessage(chatId, 'Unauthorized.');
    return;
  }

  if (text === '/start' || text === '/help') {
    let helpText =
      'Companion Bot\n\n' +
      '--- System ---\n' +
      '/ping — test bot\n' +
      '/avatar — server status\n' +
      '/settings — current config\n' +
      '/set <key> <value> — change setting\n' +
      '\n--- Toggles ---\n' +
      '/stt, /tts, /sleep, /sticker, /emotion, /touch, /meme — on|off\n' +
      '\n--- Settings ---\n' +
      '/idle <hours> — idle talk interval\n' +
      '/mood <0-100> — set mood value\n' +
      '/stepgoal <number> — daily step goal\n' +
      '/memory stats|clear — memory\n';

    // Dynamic plugin commands
    try {
      const pluginData = await adminGet('/plugin/list');
      if (pluginData.plugins && pluginData.plugins.length > 0) {
        helpText += '\n--- Plugins ---\n';
        for (const p of pluginData.plugins) {
          for (const cmd of (p.commands || [])) {
            helpText += `/p.${cmd.command} — ${cmd.description}\n`;
          }
        }
      }
    } catch (e) {
      helpText += '\n--- Plugins ---\n(server unreachable)\n';
    }

    helpText += '\n/guide — tool trigger reference\n/help — this message';
    await sendMessage(chatId, helpText);
    return;
  }

  if (text === '/guide') {
    let guideText = `Tool Trigger Examples

Start with a nickname to trigger plugins:

--- Plugins (need nickname) ---
"suichan, i ate nasi goreng" → calorie
"suichan, i spent 50k on food" → expense
"suichan, check my balance" → balance
"suichan, add task buy groceries" → todo
"suichan, whats the weather" → weather
"suichan, whats my schedule" → calendar
"suichan, find me frieren" → anime search
"suichan, find me frieren latest ep" → anime stream
"suichan, show me jokowi meme" → meme

--- Main Features (no nickname) ---
"change to maid costume" → costume
"remember that I like coffee" → memory
"open gacha" / "spin roulette" → games
"give THR" → THR envelopes
"screen time" / "steps today" → sensor
"search for X" → web search (smart mode)`;

    await sendMessage(chatId, guideText);
    return;
  }

  if (text === '/ping') {
    await sendMessage(chatId, 'Pong! Bot is running on Ubuntu server.');
    return;
  }

  // --- Admin commands ---

  if (text === '/settings') {
    try {
      const cfg = await adminGet('/admin/config');
      const s = cfg.sleep || {};
      const m = cfg.memory || {};
      let clockinStatus = 'unreachable';
      try {
        const ci = await clockinGet('/status');
        clockinStatus = ci.enabled ? 'on' : 'off';
      } catch (e) { /* service down */ }
      const stickerPct = Math.round((cfg.sticker_chance || 0) * 100);
      const lines = [
        'Current Settings',
        '',
        `STT: ${cfg.stt_enabled ? 'on' : 'off'}`,
        `TTS: ${cfg.tts_enabled ? 'on' : 'off'} (${cfg.tts_engine || '?'})`,
        `Voice: ${cfg.tts_language === 'jp' ? 'Japanese' : 'English'}`,
        `Idle talk: ${cfg.idle_talk_hours}h`,
        `Sticker chance: ${stickerPct}%`,
        `Stickers: ${stickersEnabled ? 'on' : 'off'}`,
        `Emotion tags: ${showEmotionTags ? 'on' : 'off'}`,
        `Touch: ${cfg.touch_enabled ? 'on' : 'off'}`,
        `Sleep: ${s.is_sleeping ? 'sleeping' : 'awake'} (${s.sleep_schedule})`,
        `Memory: ${m.total_messages} msgs, ${m.core_memories} core`,
        `Clock-in auto: ${clockinStatus}`,
      ];
      await sendMessage(chatId, lines.join('\n'));
    } catch (e) {
      await sendMessage(chatId, 'Failed to get settings: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/stt')) {
    const val = text.split(' ')[1];
    if (val !== 'on' && val !== 'off') {
      await sendMessage(chatId, 'Usage: /stt on|off');
      return;
    }
    try {
      await adminPost('/admin/config', { stt_enabled: val === 'on' });
      await sendMessage(chatId, `STT ${val === 'on' ? 'enabled' : 'disabled'}.`);
    } catch (e) {
      await sendMessage(chatId, 'Failed: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/tts')) {
    const val = text.split(' ')[1];
    if (val !== 'on' && val !== 'off') {
      await sendMessage(chatId, 'Usage: /tts on|off');
      return;
    }
    try {
      await adminPost('/admin/config', { tts_enabled: val === 'on' });
      await sendMessage(chatId, `TTS ${val === 'on' ? 'enabled' : 'disabled'}.`);
    } catch (e) {
      await sendMessage(chatId, 'Failed: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/sleep')) {
    const val = text.split(' ')[1];
    if (val !== 'on' && val !== 'off') {
      await sendMessage(chatId, 'Usage: /sleep on|off');
      return;
    }
    try {
      await adminPost('/admin/config', { sleep_force: val });
      await sendMessage(chatId, val === 'on' ? 'Going to sleep.' : 'Woke up.');
    } catch (e) {
      await sendMessage(chatId, 'Failed: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/idle')) {
    const val = parseFloat(text.split(' ')[1]);
    if (isNaN(val) || val < 0.1 || val > 24) {
      await sendMessage(chatId, 'Usage: /idle <hours> (0.1-24)');
      return;
    }
    try {
      await adminPost('/admin/config', { idle_talk_hours: val });
      await sendMessage(chatId, `Idle talk interval set to ${val}h.`);
    } catch (e) {
      await sendMessage(chatId, 'Failed: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/language')) {
    const val = text.split(' ')[1];
    if (val === 'en' || val === 'jp') {
      try {
        await adminPost('/admin/config', { tts_language: val });
        await sendMessage(chatId, `Voice language: ${val === 'jp' ? 'Japanese 🇯🇵' : 'English 🇺🇸'}`);
      } catch (e) {
        await sendMessage(chatId, 'Failed: ' + e.message);
      }
      return;
    }
    try {
      const cfg = await adminGet('/admin/config');
      const lang = cfg.tts_language || 'en';
      await sendMessage(chatId, `Current: ${lang === 'jp' ? 'Japanese 🇯🇵' : 'English 🇺🇸'}\nUsage: /language en|jp`);
    } catch (e) {
      await sendMessage(chatId, 'Usage: /language en|jp');
    }
    return;
  }

  if (text.startsWith('/sticker')) {
    const val = text.split(' ')[1];
    if (val !== 'on' && val !== 'off') {
      await sendMessage(chatId, 'Usage: /sticker on|off');
      return;
    }
    stickersEnabled = val === 'on';
    await sendMessage(chatId, `Stickers ${val === 'on' ? 'enabled' : 'disabled'}.`);
    return;
  }

  if (text.startsWith('/touch')) {
    const val = text.split(' ')[1];
    if (val !== 'on' && val !== 'off') {
      await sendMessage(chatId, 'Usage: /touch on|off');
      return;
    }
    try {
      await adminPost('/admin/config', { touch_enabled: val === 'on' });
      await sendMessage(chatId, `Touch interaction ${val === 'on' ? 'enabled' : 'disabled'}.`);
    } catch (e) {
      await sendMessage(chatId, 'Failed: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/set')) {
    const parts = text.split(/\s+/);
    const key = parts[1];
    const rawVal = parts[2];
    const validKeys = {
      sticker_chance: { min: 0, max: 1, desc: '0-1' },
      sleep_hour: { min: 0, max: 23, desc: '0-23' },
      wake_hour: { min: 0, max: 23, desc: '0-23' },
    };
    if (!key || !rawVal || !validKeys[key]) {
      const keys = Object.entries(validKeys).map(([k, v]) => `  ${k} (${v.desc})`).join('\n');
      await sendMessage(chatId, `Usage: /set <key> <value>\n\nValid keys:\n${keys}`);
      return;
    }
    const val = parseFloat(rawVal);
    const range = validKeys[key];
    if (isNaN(val) || val < range.min || val > range.max) {
      await sendMessage(chatId, `${key} must be ${range.desc}`);
      return;
    }
    try {
      await adminPost('/admin/config', { [key]: val });
      const display = (key === 'sticker_chance' || key === 'idle_tool_chance')
        ? `${Math.round(val * 100)}%` : String(val);
      await sendMessage(chatId, `${key} set to ${display}.`);
    } catch (e) {
      await sendMessage(chatId, 'Failed: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/mood')) {
    const val = parseInt(text.split(' ')[1]);
    if (isNaN(val) || val < 0 || val > 100) {
      await sendMessage(chatId, 'Usage: /mood <0-100>');
      return;
    }
    try {
      const result = await avatarChat(`/mood ${val}`, 'Venomaru');
      await sendMessage(chatId, result.reply);
    } catch (e) {
      await sendMessage(chatId, 'Failed: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/emotion')) {
    const val = text.split(' ')[1];
    if (val !== 'on' && val !== 'off') {
      await sendMessage(chatId, 'Usage: /emotion on|off');
      return;
    }
    showEmotionTags = val === 'on';
    await sendMessage(chatId, `Emotion tags ${val === 'on' ? 'shown' : 'hidden'} in replies.`);
    return;
  }

  if (text.startsWith('/memory')) {
    const sub = text.split(' ')[1];
    if (sub === 'stats') {
      try {
        const stats = await adminGet('/admin/memory/stats');
        const lines = [
          'Memory Stats',
          '',
          `Messages: ${stats.total_messages}`,
          `Core memories: ${stats.core_memories}`,
          `Session: ${stats.session}`,
        ];
        if (stats.core_memory_list && stats.core_memory_list.length > 0) {
          lines.push('', `Core memories (${stats.core_memories} total):`);
          for (const m of stats.core_memory_list) {
            lines.push(`  #${m.id} [${m.category}] ${m.content}`);
          }
        }
        await sendMessage(chatId, lines.join('\n'));
      } catch (e) {
        await sendMessage(chatId, 'Failed: ' + e.message);
      }
      return;
    }
    if (sub === 'clear') {
      try {
        const result = await adminPost('/admin/memory/clear', {});
        await sendMessage(chatId, `Cleared ${result.cleared} messages. Core memories kept.`);
      } catch (e) {
        await sendMessage(chatId, 'Failed: ' + e.message);
      }
      return;
    }
    if (sub === 'forget') {
      const arg = text.split(' ').slice(2).join(' ').trim();
      if (!arg) {
        await sendMessage(chatId, 'Usage: /memory forget <id or keyword>\nExamples:\n  /memory forget 5\n  /memory forget boyfriend');
        return;
      }
      try {
        // If arg is a number, delete by ID
        if (/^\d+$/.test(arg)) {
          const result = await adminPost('/admin/memory/delete', { id: parseInt(arg) });
          if (result.ok) {
            await sendMessage(chatId, `Deleted memory #${arg}.`);
          } else {
            await sendMessage(chatId, result.error || 'Memory not found.');
          }
        } else {
          // Search and delete by keyword
          const result = await adminPost('/admin/memory/search-delete', { query: arg });
          if (result.deleted_count === 0) {
            await sendMessage(chatId, `No memories found matching "${arg}".`);
          } else {
            const lines = [`Deleted ${result.deleted_count} memor${result.deleted_count === 1 ? 'y' : 'ies'}:`];
            for (const m of result.deleted) {
              lines.push(`  #${m.id}: ${m.content}`);
            }
            await sendMessage(chatId, lines.join('\n'));
          }
        }
      } catch (e) {
        await sendMessage(chatId, 'Failed: ' + e.message);
      }
      return;
    }
    await sendMessage(chatId, 'Usage: /memory stats|clear|forget <id or keyword>');
    return;
  }

  // Clock-in moved to plugin: /p.clockin, /p.clockin.status

  if (text.startsWith('/meme')) {
    const sub = text.split(' ')[1];
    if (sub === 'on' || sub === 'off') {
      try {
        await memePost(`/toggle?enabled=${sub === 'on'}`);
        await sendMessage(chatId, `Political memes ${sub === 'on' ? 'enabled' : 'disabled'}.`);
      } catch (e) {
        await sendMessage(chatId, 'Meme service unreachable: ' + e.message);
      }
      return;
    }
    if (!sub || sub === 'status') {
      try {
        const st = await memeGet('/status');
        await sendMessage(chatId, `Meme service: ${st.enabled ? 'ON' : 'OFF'}\nFigures: ${st.figures}\nTotal memes: ${st.total_memes}`);
      } catch (e) {
        await sendMessage(chatId, 'Meme service unreachable: ' + e.message);
      }
      return;
    }
    await sendMessage(chatId, 'Usage: /meme on|off|status');
    return;
  }

  if (text.startsWith('/stepgoal')) {
    const arg = text.split(' ')[1];
    if (arg && !isNaN(arg)) {
      const goal = parseInt(arg);
      if (goal < 100 || goal > 100000) {
        await sendMessage(chatId, 'Step goal must be between 100 and 100,000.');
        return;
      }
      try {
        await adminPost('/sensor/step-goal', { goal });
        await sendMessage(chatId, `Step goal set to ${goal.toLocaleString()} steps.`);
      } catch (e) {
        await sendMessage(chatId, 'Failed to set step goal: ' + e.message);
      }
    } else {
      try {
        const data = await adminGet('/sensor/step-goal');
        await sendMessage(chatId, `Current step goal: ${Number(data.step_goal).toLocaleString()} steps.\n\nUsage: /stepgoal <number>`);
      } catch (e) {
        await sendMessage(chatId, 'Failed to get step goal: ' + e.message);
      }
    }
    return;
  }

  // Dynamic plugin commands: /p.tasks, /p.balance, /p.calories.target 5000, etc.
  if (text.startsWith('/p.')) {
    const parts = text.slice(3).split(' ');
    const cmdParts = parts[0].split('.');  // e.g. ["tasks"] or ["balance", "budget"]
    const args = parts.slice(1).join(' ');

    // Find which plugin owns this command
    try {
      const pluginList = await adminGet('/plugin/list');
      let targetPlugin = null;
      let targetCommand = null;

      for (const p of pluginList.plugins) {
        for (const cmd of (p.commands || [])) {
          // Match: /p.tasks → command="tasks", /p.balance.budget → command="balance.budget"
          if (cmd.command === parts[0] || cmd.command === cmdParts[0]) {
            targetPlugin = p.name;
            targetCommand = cmd.command;
            break;
          }
        }
        if (targetPlugin) break;
      }

      if (!targetPlugin) {
        await sendMessage(chatId, `Unknown plugin command: /p.${parts[0]}`);
        return;
      }

      const result = await adminPost('/plugin/command', {
        plugin: targetPlugin,
        command: targetCommand,
        args: args,
      });

      if (result.ok && result.text) {
        if (result.inline_keyboard) {
          await sendMessageWithKeyboard(chatId, result.text, result.inline_keyboard);
        } else {
          await sendMessage(chatId, result.text);
        }
      } else {
        await sendMessage(chatId, result.text || 'Plugin command failed.');
      }
    } catch (e) {
      await sendMessage(chatId, 'Plugin system error: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/ask ')) {
    const question = text.slice(5).trim();
    if (!question) {
      await sendMessage(chatId, 'Usage: /ask <your question>');
      return;
    }

    await sendMessage(chatId, '...');

    try {
      const result = await avatarChat(question, 'Venomaru');
      const emotionTag = (showEmotionTags && result.emotion) ? `[${result.emotion}] ` : '';
      await sendMessage(chatId, emotionTag + result.reply);
      if (stickersEnabled && result.sticker_id && Math.random() < 0.75) {
        await sendSticker(chatId, result.sticker_id);
      }
      console.log(`[avatar] replied: [${result.emotion}] ${result.reply.slice(0, 80)}`);
    } catch (e) {
      console.warn(`[avatar] AI server unreachable: ${e.message}`);
      await sendMessage(chatId, 'AI server is offline. Try again later.\n\nCore commands still work: /ping');
    }
    return;
  }

  if (text === '/avatar') {
    try {
      const status = await avatarStatus();
      const lines = [
        'Avatar AI Server',
        '',
        `Server: ${status.server}`,
        `LM Studio: ${status.lm_studio}`,
        `TTS: ${status.tts}`,
        `RVC: ${status.rvc}`,
        `STT: ${status.stt}`,
        `WebSocket clients: ${status.websocket_clients}`,
        `Uptime: ${Math.floor(status.uptime_seconds / 60)}m ${status.uptime_seconds % 60}s`,
      ];
      await sendMessage(chatId, lines.join('\n'));
    } catch (e) {
      await sendMessage(chatId, 'Avatar AI server is offline.');
    }
    return;
  }

  if (!text.startsWith('/')) {
    await sendMessage(chatId, '...');
    try {
      const result = await avatarChat(text, 'Venomaru');
      const emotionTag = (showEmotionTags && result.emotion) ? `[${result.emotion}] ` : '';
      await sendMessage(chatId, emotionTag + result.reply);
      if (stickersEnabled && result.sticker_id && Math.random() < 0.75) {
        await sendSticker(chatId, result.sticker_id);
      }
      console.log(`[avatar] replied: [${result.emotion}] ${result.reply.slice(0, 80)}`);
    } catch (e) {
      console.warn(`[avatar] AI server unreachable: ${e.message}`);
      await sendMessage(chatId, 'AI server is offline. Try again later.\n\nCore commands still work: /ping');
    }
    return;
  }

  await sendMessage(chatId, `Unknown command: ${text}\nSend /help for usage.`);
}

let _firstPoll = true;
let _pollBackoff = 0;
const _POLL_BACKOFF_MAX = 60000; // max 60s between retries

async function handleCallbackQuery(query) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const data = query.data || '';

  // Format: plugin:<name>:<action>:<item_id>
  if (data.startsWith('plugin:')) {
    const parts = data.split(':');
    if (parts.length >= 4) {
      const pluginName = parts[1];
      const action = parts[2];
      const itemId = parts[3];

      try {
        const result = await adminPost('/plugin/callback', {
          plugin: pluginName,
          action,
          item_id: itemId,
        });

        await answerCallbackQuery(query.id, result.message || 'Done');

        // If updated view available, refresh the message
        if (result.ok && result.updated && result.updated.text) {
          await editMessageText(
            chatId, messageId,
            result.updated.text,
            result.updated.inline_keyboard
          );
        } else if (result.ok) {
          // Just append status to existing message
          const existingText = query.message?.text || '';
          await editMessageText(chatId, messageId, existingText + '\n\n' + (result.message || '✓'), null);
        }
      } catch (e) {
        await answerCallbackQuery(query.id, 'Error: ' + e.message);
      }
    }
  }
}

async function poll() {
  try {
    const res = await apiRequest('getUpdates', {
      offset,
      timeout: 30,
      allowed_updates: JSON.stringify(['message', 'callback_query']),
    });

    // Success — reset backoff
    if (_pollBackoff > 0) {
      console.log(`[poll] Recovered after network error (was backing off ${_pollBackoff / 1000}s)`);
    }
    _pollBackoff = 0;

    if (!res.ok) {
      console.error('[poll] Telegram error:', res.description);
    } else {
      if (_firstPoll && res.result.length > 0) {
        const skipped = res.result.length;
        offset = res.result[res.result.length - 1].update_id + 1;
        console.log(`[poll] Skipped ${skipped} stale message(s) from before restart`);
        _firstPoll = false;
      } else {
        _firstPoll = false;
        for (const update of res.result) {
          offset = update.update_id + 1;
          if (update.callback_query) {
            await handleCallbackQuery(update.callback_query).catch(e =>
              console.error('[handleCallback error]', e.message)
            );
          } else if (update.message) {
            await handleMessage(update.message).catch(e =>
              console.error('[handleMessage error]', e.message)
            );
          }
        }
      }
    }
  } catch (e) {
    // Exponential backoff: 5s → 10s → 20s → 40s → 60s (capped)
    _pollBackoff = Math.min((_pollBackoff || 2500) * 2, _POLL_BACKOFF_MAX);
    console.error(`[poll error] ${e.message} — retrying in ${_pollBackoff / 1000}s`);
    await new Promise(r => setTimeout(r, _pollBackoff));
  }

  setImmediate(poll);
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const apiServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${API_PORT}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/status') {
    const uptimeMs = Date.now() - startTime;
    const payload = {
      ok: true,
      status: 'running',
      uptime: formatUptime(uptimeMs),
      uptimeMs,
      messageCount,
      lastMessage: lastMessageTime ? {
        time: lastMessageTime,
        from: lastMessageFrom,
        text: lastMessageText,
      } : null,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  if (req.method === 'GET' && path === '/logs') {
    const since = url.searchParams.get('since');
    let entries = logBuffer;
    if (since) {
      const sinceTs = Number(since);
      entries = logBuffer.filter(e => e.ts > sinceTs);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, logs: entries }));
    return;
  }

  if (req.method === 'POST' && path === '/telegram') {
    try {
      const body = JSON.parse(await readBody(req));
      const text = String(body.text || '').slice(0, 4000);
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'text is required' }));
        return;
      }
      const result = await sendMessage(ALLOWED_ID, text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

function validateConfig() {
  const errors = [];
  if (!TOKEN)                        errors.push('BOT_TOKEN env var is not set');
  if (!ALLOWED_ID || isNaN(ALLOWED_ID)) errors.push('ALLOWED_ID env var is not set');
  if (errors.length) {
    console.error('Config errors:\n' + errors.map(e => '  - ' + e).join('\n'));
    process.exit(1);
  }
}

validateConfig();

console.log('═══════════════════════════════════════');
console.log(' Companion Bot — starting');
console.log(' Avatar  :', AVATAR_SERVER_URL);
console.log(' API     : http://0.0.0.0:' + API_PORT);
console.log('═══════════════════════════════════════');

apiServer.listen(API_PORT, '0.0.0.0', () => {
  console.log(`[api] HTTP API listening on port ${API_PORT}`);
});

poll();
