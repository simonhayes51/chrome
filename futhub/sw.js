// sw.js – FUT Trader Hub service worker (MV3) with Premium restriction
// - Maps content.js sale records to your API schema
// - Posts to POST {apiBase}/api/trades/
// - Sends timestamp as UNIX seconds (fallback to ISO if server 500s)
// - Handles auth via chrome.storage, de-dupe, notifications
// - PREMIUM ONLY: Restricts extension to premium users

console.log('[FUT SW] Service worker starting...');

// ------------ Settings & state ------------
let settings = {
  apiBase: "https://api.futhub.co.uk",
  token: "",
  enabled: true,
  platform: "Console",
  tag: "Web App",
  userId: "",
  isPremium: false,
  userRoles: [],
  lastPremiumCheck: 0,
  // Market data (Fair Value price overlays) - separate from the OAuth
  // `token` above, which is only for /api/trades and /api/entitlements.
  // Overlays go through the public data API instead, which is X-API-Key
  // authed (see app/auth/api_keys.py on the backend) - the user generates
  // this from their dashboard's API Keys page (requires Pro+).
  apiKey: "",
  overlaysEnabled: true
};

// Runtime de-dupe set (cleared periodically)
const sentItems = new Set();

// Load persisted settings
chrome.storage.local.get(['settings']).then(r => {
  if (r.settings) settings = { ...settings, ...r.settings };
  console.log('[FUT SW] Settings loaded:', redactedSettings(settings));
}).catch(e => console.warn('[FUT SW] settings load error:', e));

// Watch for settings updates
chrome.storage.onChanged.addListener(c => {
  if (c.settings) {
    settings = { ...settings, ...c.settings.newValue };
    console.log('[FUT SW] Settings updated:', redactedSettings(settings));
  }
});

function redactedSettings(s) {
  const copy = { ...s };
  if (copy.token) copy.token = `•••(${copy.token.length})`;
  if (copy.apiKey) copy.apiKey = `•••(${copy.apiKey.length})`;
  return copy;
}

// ------------ Premium checking ------------
async function checkPremiumStatus() {
  if (!settings.token) {
    settings.isPremium = false;
    settings.userRoles = [];
    return false;
  }

  // Only check every 5 minutes to avoid spam
  const now = Date.now();
  if (now - settings.lastPremiumCheck < 5 * 60 * 1000 && settings.lastPremiumCheck > 0) {
    return settings.isPremium;
  }

  try {
    const url = settings.apiBase.replace(/\/+$/, '') + '/api/entitlements';
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${settings.token}`,
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.warn('[FUT SW] Premium check failed:', response.status);
      settings.isPremium = false;
      settings.userRoles = [];
      return false;
    }

    const data = await response.json();
    settings.isPremium = Boolean(data?.is_premium);
    settings.userRoles = Array.isArray(data?.roles) ? data.roles : [];
    settings.lastPremiumCheck = now;

    // Save updated premium status
    await chrome.storage.local.set({ settings });

    console.log('[FUT SW] Premium status:', settings.isPremium, 'Roles:', settings.userRoles);
    return settings.isPremium;

  } catch (error) {
    console.error('[FUT SW] Premium check error:', error);
    settings.isPremium = false;
    settings.userRoles = [];
    return false;
  }
}

// ------------ Fair Value price overlays (Public Data API v2) ------------
async function fetchFairValues(cardIds) {
  const res = await chrome.storage.local.get(['settings']);
  if (res.settings) settings = { ...settings, ...res.settings };

  if (settings.overlaysEnabled === false) {
    return { ok: false, error: 'overlays_disabled' };
  }
  if (!settings.apiKey) {
    return { ok: false, error: 'no_api_key' };
  }
  if (!Array.isArray(cardIds) || !cardIds.length) {
    return { ok: true, items: {} };
  }

  // The batch endpoint caps at 100 ids per call and counts as a single
  // request against the key's rate limit/quota either way.
  const capped = [...new Set(cardIds)].slice(0, 100);
  const url = settings.apiBase.replace(/\/+$/, '') + '/api/public/v2/fair-value/batch';

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-API-Key': settings.apiKey
      },
      body: JSON.stringify({ card_ids: capped })
    });

    if (r.status === 401) return { ok: false, error: 'invalid_api_key' };
    if (r.status === 402) return { ok: false, error: 'upgrade_required' };
    if (r.status === 429) return { ok: false, error: 'rate_limited' };
    if (!r.ok) return { ok: false, error: `http_${r.status}` };

    const data = await r.json();
    return { ok: true, items: data?.items || {} };
  } catch (e) {
    console.error('[FUT SW] Fair value fetch error:', e);
    return { ok: false, error: String(e?.message || e) };
  }
}

// ------------ Undervalued board (for the in-page side panel) ------------
async function fetchUndervalued(limit) {
  const res = await chrome.storage.local.get(['settings']);
  if (res.settings) settings = { ...settings, ...res.settings };

  if (settings.overlaysEnabled === false) {
    return { ok: false, error: 'overlays_disabled' };
  }
  if (!settings.apiKey) {
    return { ok: false, error: 'no_api_key' };
  }

  const n = Math.max(1, Math.min(Number(limit) || 8, 30));
  const url = settings.apiBase.replace(/\/+$/, '') + `/api/public/v2/undervalued?limit=${n}`;

  try {
    const r = await fetch(url, {
      headers: { 'Accept': 'application/json', 'X-API-Key': settings.apiKey }
    });

    if (r.status === 401) return { ok: false, error: 'invalid_api_key' };
    if (r.status === 402) return { ok: false, error: 'upgrade_required' };
    if (r.status === 429) return { ok: false, error: 'rate_limited' };
    if (!r.ok) return { ok: false, error: `http_${r.status}` };

    const data = await r.json();
    return { ok: true, items: data?.items || [] };
  } catch (e) {
    console.error('[FUT SW] Undervalued fetch error:', e);
    return { ok: false, error: String(e?.message || e) };
  }
}

// ------------ Helper functions ------------
async function openPremiumPage() {
  try {
    const dashboardUrl = settings.apiBase.replace('api.', '').replace('/api', '') + '/billing';
    await chrome.tabs.create({ url: dashboardUrl });
    console.log('[FUT SW] Opened premium billing page:', dashboardUrl);
  } catch (error) {
    console.error('[FUT SW] Error opening premium page:', error);
    // Fallback to generic billing URL
    await chrome.tabs.create({ url: 'https://app.futhub.co.uk/#/billing' });
  }
}

// ------------ Message handling ------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'SOLD_ITEM_DATA') {
    handleSoldItemData(msg.data, sendResponse);
    return true; // async
  }

  if (msg.type === 'PING') {
    sendResponse({ 
      pong: true, 
      ts: Date.now(), 
      settings: redactedSettings(settings),
      isPremium: settings.isPremium 
    });
    return false;
  }

  if (msg.type === 'START_OAUTH') {
    startOAuth().then(() => sendResponse({ success: true }))
                .catch((e) => sendResponse({ success: false, error: String(e) }));
    return true;
  }

  if (msg.type === 'SIGN_OUT') {
    settings.token = '';
    settings.enabled = false;
    settings.isPremium = false;
    settings.userRoles = [];
    chrome.storage.local.set({ settings }, () => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === 'CHECK_PREMIUM') {
    checkPremiumStatus().then(isPremium => {
      sendResponse({ isPremium, roles: settings.userRoles });
    }).catch(e => {
      sendResponse({ isPremium: false, roles: [], error: String(e) });
    });
    return true;
  }

  if (msg.type === 'OPEN_PREMIUM') {
    openPremiumPage().then(() => sendResponse({ success: true }))
                    .catch((e) => sendResponse({ success: false, error: String(e) }));
    return true;
  }

  if (msg.type === 'GET_FAIR_VALUES') {
    fetchFairValues(msg.cardIds).then(sendResponse).catch(e => {
      sendResponse({ ok: false, error: String(e?.message || e) });
    });
    return true; // async
  }

  if (msg.type === 'GET_UNDERVALUED') {
    fetchUndervalued(msg.limit).then(sendResponse).catch(e => {
      sendResponse({ ok: false, error: String(e?.message || e) });
    });
    return true; // async
  }

  if (msg.type === 'GET_CHEAP_FODDER') {
    fetchCheapFodder(msg.query).then(sendResponse).catch(e => {
      sendResponse({ ok: false, error: String(e?.message || e) });
    });
    return true; // async
  }

  if (msg.type === 'DEBUG_AUTH_CHECK') {
    sendResponse({
      hasToken: !!settings.token,
      tokenLength: settings.token ? settings.token.length : 0,
      enabled: settings.enabled,
      apiBase: settings.apiBase,
      isPremium: settings.isPremium,
      roles: settings.userRoles
    });
    return false;
  }

  return false;
});

// ------------ Core: handle a sold item (PREMIUM ONLY) ------------
async function handleSoldItemData(itemData, sendResponse) {
  try {
    // Always fetch fresh settings (in case UI just changed them)
    const res = await chrome.storage.local.get(['settings']);
    if (res.settings) settings = { ...settings, ...res.settings };

    if (!settings.enabled) {
      sendResponse({ success: false, error: 'Extension disabled in settings.' });
      return;
    }
    
    if (!settings.token) {
      sendResponse({ success: false, error: 'Not signed in. Open the extension and connect.' });
      return;
    }

    // PREMIUM CHECK: Verify user has premium access
    const isPremium = await checkPremiumStatus();
    if (!isPremium) {
      sendResponse({ 
        success: false, 
        error: 'Premium subscription required to use the Chrome extension.',
        needsPremium: true 
      });
      
      // Show premium required notification
      try {
        chrome.notifications?.create({
          type: "basic",
          iconUrl: "icons/icon48.png",
          title: "FUT Trader Hub - Premium Required",
          message: "🔒 The Chrome extension requires a Premium subscription. Visit your dashboard to upgrade."
        });
      } catch {}
      
      return;
    }

    // Normalize from content.js
    const tradeIdRaw = itemData?.trade_id ?? Date.now();
    const tradeIdInt = Number.isFinite(+tradeIdRaw) ? Math.trunc(+tradeIdRaw) : Date.now();
    const tradeIdStr = String(tradeIdRaw);

    const player    = String(itemData?.player_name ?? 'Unknown');
    const version   = String(itemData?.card_version ?? 'Standard');
    const sell      = Math.trunc(Number(itemData?.sell_price ?? 0));
    const buy       = Math.trunc(Number(itemData?.buy_price ?? 0));
    const ea_tax    = Math.trunc(sell * 0.05);
    const profit    = Math.trunc(Number.isFinite(itemData?.profit) ? itemData.profit : (sell - ea_tax - buy));
    const tsMs      = Number(itemData?.timestamp_ms ?? Date.now());
    const tsSec     = Math.trunc(tsMs / 1000);

    // Required by your API
    const quantity  = 1;
    const platform  = String(settings.platform || 'Console');
    const tag       = String(settings.tag || 'FUT Web App');
    const notes     = '';
    const user_id   = settings.userId ? String(settings.userId) : undefined;

    // Build two variants to survive server expectations:
    // A) UNIX seconds timestamp + numeric trade_id (common)
    const payloadA = {
      user_id,
      player,
      version,
      buy,
      sell,
      quantity,
      platform,
      tag,
      notes,
      ea_tax,
      profit,
      timestamp: tsSec,
      trade_id: tradeIdInt
    };

    // B) ISO timestamp + string trade_id (fallback)
    const payloadB = {
      user_id,
      player,
      version,
      buy,
      sell,
      quantity,
      platform,
      tag,
      notes,
      ea_tax,
      profit,
      timestamp: new Date(tsMs).toISOString(),
      trade_id: tradeIdStr
    };

    // De-dupe within this SW lifetime
    const k1 = `trade_${tradeIdStr}`;
    const k2 = `${player}_${sell}_${Math.floor(tsMs / 60000)}`;
    if (sentItems.has(k1) || sentItems.has(k2)) {
      console.log('[FUT SW] Duplicate skipped:', k1);
      sendResponse({ success: true, message: 'Duplicate skipped' });
      return;
    }

    const url = settings.apiBase.replace(/\/+$/, '') + '/api/trades';

    // Try A first; if 500, try B automatically
    let result = await postJSON(url, settings.token, payloadA);
    if (!result.ok && result.status === 500) {
      console.warn('[FUT SW] 500 with UNIX timestamp; retrying with ISO/string trade_id...');
      result = await postJSON(url, settings.token, payloadB);
    }

    if (!result.ok) {
      console.warn('[FUT SW] Upload failed:', result.status, result.body);
      sendResponse({ success: false, error: `Upload failed: ${result.status} ${result.body || ''}` });
      return;
    }

    // Mark sent
    sentItems.add(k1);
    sentItems.add(k2);

    // Success notification
    try {
      const pfx = profit >= 0 ? '+' : '−';
      chrome.notifications?.create({
        type: "basic",
        iconUrl: "icons/icon48.png",
        title: "FUT Trader Hub",
        message: `✅ Logged: ${player} — ${version}\nSold ${sell.toLocaleString()} • Profit ${pfx}${Math.abs(profit).toLocaleString()}`
      });
    } catch {}

    sendResponse({ success: true, data: result.json || null });
  } catch (err) {
    console.error('[FUT SW] Error:', err);
    sendResponse({ success: false, error: String(err?.message || err) });
  }
}

// ------------ HTTP helper ------------
async function postJSON(url, token, body) {
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    console.log('[FUT SW] → POST', url, body);
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await r.text();
    console.log('[FUT SW] ←', r.status, text || '(no body)');
    if (r.ok) { let json = null; try { json = text ? JSON.parse(text) : null; } catch {} ; return { ok: true, status: r.status, body: text, json }; }
    return { ok: false, status: r.status, body: text };
  } catch (e) {
    return { ok: false, status: 0, body: String(e) };
  }
}

// ------------ OAuth helper with premium check ------------
async function startOAuth() {
  const redirectUrl = chrome.identity.getRedirectURL("oauth2");
  const startUrl = `${settings.apiBase.replace(/\/+$/, '')}/oauth/start?redirect_uri=${encodeURIComponent(redirectUrl)}`;
  const finalUrl = await chrome.identity.launchWebAuthFlow({ url: startUrl, interactive: true });
  const u = new URL(finalUrl);
  const params = new URLSearchParams(u.hash.slice(1));
  const token = params.get("token");
  if (!token) throw new Error("No token returned");
  
  settings = { ...settings, token, enabled: true };
  
  // Check premium status immediately after auth
  const isPremium = await checkPremiumStatus();
  
  await chrome.storage.local.set({ settings });
  
  try {
    if (isPremium) {
      chrome.notifications?.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "FUT Trader Hub",
        message: "🎉 Connected! Premium auto-logging enabled."
      });
    } else {
      chrome.notifications?.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "FUT Trader Hub",
        message: "🔒 Connected, but Premium subscription required for Chrome extension."
      });
    }
  } catch {}
}

// ------------ Housekeeping ------------
setInterval(() => {
  if (sentItems.size > 2000) {
    sentItems.clear();
    console.log('[FUT SW] Dedupe cache cleared.');
  }
}, 60 * 60 * 1000); // hourly

// Check premium status on startup
checkPremiumStatus().then(isPremium => {
  console.log('[FUT SW] Startup premium check:', isPremium);
}).catch(e => {
  console.warn('[FUT SW] Startup premium check failed:', e);
});

console.log('[FUT SW] Ready with Premium restrictions.');