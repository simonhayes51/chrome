// options.js - Enhanced with Premium status checking
const API_BASE = "https://api.futhub.co.uk";
const apiBaseEl = document.getElementById("apiBase");
const tokenEl = document.getElementById("token");
const oauthStatus = document.getElementById("oauthStatus");
const statusPill = document.getElementById("statusPill");
const premiumSection = document.getElementById("premiumSection");
const premiumTitle = document.getElementById("premiumTitle");
const premiumDescription = document.getElementById("premiumDescription");
const premiumAction = document.getElementById("premiumAction");
const connectionStatus = document.getElementById("connectionStatus");
const warningBox = document.getElementById("warningBox");
const successBox = document.getElementById("successBox");
const marketApiKeyEl = document.getElementById("marketApiKey");
const overlaysEnabledEl = document.getElementById("overlaysEnabled");
const marketKeyStatus = document.getElementById("marketKeyStatus");

// Feature icons
const autoLogIcon = document.getElementById("autoLogIcon");
const realTimeIcon = document.getElementById("realTimeIcon");
const smartDetectionIcon = document.getElementById("smartDetectionIcon");
const notificationsIcon = document.getElementById("notificationsIcon");

let currentState = {
  connected: false,
  isPremium: false,
  userRoles: []
};

function setStatus(connected, isPremium = false, roles = []) {
  currentState = { connected, isPremium, userRoles: roles };
  
  // Update main status pill
  if (connected && isPremium) {
    statusPill.textContent = "Premium Active";
    statusPill.className = "pill on";
  } else if (connected && !isPremium) {
    statusPill.textContent = "Connected (No Premium)";
    statusPill.className = "pill off";
  } else {
    statusPill.textContent = "Not Connected";
    statusPill.className = "pill off";
  }
  
  // Update premium section
  updatePremiumSection(connected, isPremium, roles);
  
  // Update connection status
  updateConnectionStatus(connected, isPremium);
  
  // Update feature icons
  updateFeatureIcons(connected, isPremium);
}

function updatePremiumSection(connected, isPremium, roles) {
  if (isPremium) {
    premiumSection.className = "premium-section active";
    premiumTitle.textContent = "Premium Active";
    premiumDescription.textContent = "You have full access to the Chrome extension features.";
    premiumAction.textContent = "✓ Premium Active";
    premiumAction.className = "btn premium-active-btn";
    premiumAction.onclick = null;
  } else if (connected) {
    premiumSection.className = "premium-section";
    premiumTitle.textContent = "Premium Required";
    premiumDescription.textContent = "The Chrome extension requires a Premium subscription to function.";
    premiumAction.textContent = "Upgrade to Premium";
    premiumAction.className = "btn upgrade-btn";
    premiumAction.onclick = openBillingPage;
  } else {
    premiumSection.className = "premium-section";
    premiumTitle.textContent = "Connect Your Account";
    premiumDescription.textContent = "Connect your account first to check Premium status.";
    premiumAction.textContent = "Connect Account";
    premiumAction.className = "btn primary";
    premiumAction.onclick = startOAuth;
  }
}

function updateConnectionStatus(connected, isPremium) {
  if (connected && isPremium) {
    connectionStatus.textContent = "Connected & Premium Active";
    connectionStatus.style.color = "var(--success)";
    warningBox.style.display = "none";
    successBox.style.display = "block";
  } else if (connected && !isPremium) {
    connectionStatus.textContent = "Connected (Premium Required)";
    connectionStatus.style.color = "var(--danger)";
    warningBox.style.display = "block";
    successBox.style.display = "none";
  } else {
    connectionStatus.textContent = "Not Connected";
    connectionStatus.style.color = "var(--muted)";
    warningBox.style.display = "none";
    successBox.style.display = "none";
  }
}

function updateFeatureIcons(connected, isPremium) {
  const icons = [autoLogIcon, realTimeIcon, smartDetectionIcon, notificationsIcon];
  const isActive = connected && isPremium;
  
  icons.forEach(icon => {
    if (isActive) {
      icon.textContent = "✓";
      icon.className = "check";
      icon.style.color = "var(--success)";
    } else {
      icon.textContent = "✗";
      icon.className = "cross";
      icon.style.color = "var(--danger)";
    }
  });
}

async function openBillingPage() {
  try {
    const { settings } = await chrome.storage.local.get(['settings']);
    const apiBase = settings?.apiBase || API_BASE;
    const dashboardUrl = apiBase.replace('api.', '').replace('/api', '') + '/billing';
    chrome.tabs.create({ url: dashboardUrl });
  } catch (error) {
    console.error('Error opening billing page:', error);
    // Fallback
    chrome.tabs.create({ url: 'https://futhub.co.uk/billing' });
  }
}

async function startOAuth() {
  oauthStatus.textContent = "Starting authentication...";
  chrome.runtime.sendMessage({ type: "START_OAUTH" }, (response) => {
    if (chrome.runtime.lastError) {
      oauthStatus.textContent = "Authentication failed: " + chrome.runtime.lastError.message;
    } else {
      oauthStatus.textContent = "Authentication completed. Checking status...";
      setTimeout(load, 1500);
    }
  });
}

async function load() {
  try {
    // Get stored settings
    const { settings } = await chrome.storage.local.get(["settings"]);
    const hasToken = !!(settings && settings.token);
    
    // Update token field
    tokenEl.value = settings?.token || "";
    marketApiKeyEl.value = settings?.apiKey || "";
    overlaysEnabledEl.checked = settings?.overlaysEnabled !== false;

    if (!hasToken) {
      setStatus(false, false, []);
      return;
    }
    
    // Check premium status via service worker
    chrome.runtime.sendMessage({ type: 'CHECK_PREMIUM' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Premium check error:', chrome.runtime.lastError);
        setStatus(hasToken, false, []);
        return;
      }
      
      const isPremium = response?.isPremium || false;
      const roles = response?.roles || [];
      console.log('Premium check result:', { hasToken, isPremium, roles });
      setStatus(hasToken, isPremium, roles);
    });
    
  } catch (error) {
    console.error('Load error:', error);
    setStatus(false, false, []);
  }
}

// Initial load
load();

// Event listeners
document.getElementById("connect").addEventListener("click", startOAuth);

document.getElementById("signout").addEventListener("click", async () => {
  chrome.runtime.sendMessage({ type: "SIGN_OUT" }, () => {
    oauthStatus.textContent = "Signed out successfully.";
    setTimeout(load, 400);
  });
});

document.getElementById("save").addEventListener("click", async () => {
  const token = tokenEl.value.trim();

  // Merge into existing settings rather than replacing the whole object -
  // this field also holds apiKey/overlaysEnabled/platform/tag/etc, and a
  // blind overwrite here would silently wipe them every time someone
  // pastes a token.
  const { settings: existing } = await chrome.storage.local.get(["settings"]);
  await chrome.storage.local.set({
    settings: {
      ...(existing || {}),
      apiBase: API_BASE,
      token: token,
      enabled: !!token,
    },
  });

  if (token) {
    oauthStatus.textContent = "Token saved. Checking premium status...";
    setTimeout(load, 500);
  } else {
    oauthStatus.textContent = "Token cleared.";
    setTimeout(load, 400);
  }
});

document.getElementById("saveMarketKey").addEventListener("click", async () => {
  const apiKey = marketApiKeyEl.value.trim();
  const overlaysEnabled = overlaysEnabledEl.checked;

  const { settings: existing } = await chrome.storage.local.get(["settings"]);
  await chrome.storage.local.set({
    settings: {
      ...(existing || {}),
      apiBase: existing?.apiBase || API_BASE,
      apiKey,
      overlaysEnabled,
    },
  });

  marketKeyStatus.style.color = "var(--success)";
  marketKeyStatus.textContent = apiKey
    ? "✓ Market Data API key saved."
    : "API key cleared - overlays will show a setup reminder instead.";
});

document.getElementById("test").addEventListener("click", async () => {
  if (!currentState.connected) {
    oauthStatus.textContent = "Connect your account first.";
    return;
  }
  
  if (!currentState.isPremium) {
    oauthStatus.textContent = "Premium subscription required to send test trades.";
    return;
  }

  const { settings } = await chrome.storage.local.get(["settings"]);
  if (!settings?.token) {
    oauthStatus.textContent = "No authentication token found.";
    return;
  }

  const base = (settings.apiBase || API_BASE).replace(/\/+$/, "");
  const url = `${base}/api/trades`;

  // Sample payload aligned with sw.js schema
  const sell = 12345;
  const buy = 10000;
  const ea_tax = Math.trunc(sell * 0.05);
  const profit = sell - ea_tax - buy;

  const payload = {
    user_id: settings.userId || undefined,
    player: "Extension Test",
    version: "Test",
    buy,
    sell,
    quantity: 1,
    platform: settings.platform || "ps",
    tag: "test",
    notes: "Test trade from Chrome extension",
    ea_tax,
    profit,
    timestamp: Math.floor(Date.now() / 1000), // UNIX seconds
    trade_id: Date.now(),
  };

  oauthStatus.textContent = "Sending test trade...";

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.token}`,
      },
      body: JSON.stringify(payload),
    });
    
    const text = await res.text();
    
    if (res.ok) {
      oauthStatus.textContent = "✓ Test trade sent successfully!";
      oauthStatus.style.color = "var(--success)";
    } else {
      oauthStatus.textContent = `Test failed: ${res.status} ${text || ""}`;
      oauthStatus.style.color = "var(--danger)";
    }
  } catch (e) {
    oauthStatus.textContent = "Test failed: " + e.message;
    oauthStatus.style.color = "var(--danger)";
  }
});