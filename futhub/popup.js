// popup.js - Enhanced with Premium status checking and merged helper toggle
const statusPill = document.getElementById('statusPill');
const premiumStatus = document.getElementById('premiumStatus');
const premiumTitle = document.getElementById('premiumTitle');
const premiumMessage = document.getElementById('premiumMessage');
const loadingState = document.getElementById('loadingState');
const loginText = document.getElementById('loginText');
const quickLoginBtn = document.getElementById('quickLogin');
const helperToggle = document.getElementById('helperToggle');

let currentState = {
  connected: false,
  isPremium: false,
  loading: true
};

function setStatus(connected, isPremium = false) {
  currentState = { connected, isPremium, loading: false };

  if (connected && isPremium) {
    statusPill.textContent = 'Premium Active';
    statusPill.className = 'pill on';
    premiumStatus.className = 'premium-banner active';
    premiumStatus.style.display = 'block';
    premiumTitle.innerHTML = '<span class="crown-icon">👑</span>Premium Active';
    premiumMessage.textContent = 'Chrome extension ready to auto-log your trades!';
    loginText.textContent = 'Connected';
  } else if (connected && !isPremium) {
    statusPill.textContent = 'Connected (No Premium)';
    statusPill.className = 'pill off';
    premiumStatus.className = 'premium-banner';
    premiumStatus.style.display = 'block';
    premiumTitle.innerHTML = '<span class="crown-icon">👑</span>Premium Required';
    premiumMessage.textContent = 'Upgrade to Premium to use the Chrome extension.';
    loginText.textContent = 'Upgrade Now';
  } else {
    statusPill.textContent = 'Not Connected';
    statusPill.className = 'pill off';
    premiumStatus.style.display = 'none';
    loginText.textContent = 'Connect';
  }

  loadingState.style.display = 'none';
}

function setLoading(loading = true) {
  loadingState.style.display = loading ? 'block' : 'none';
  if (loading) {
    statusPill.textContent = 'Checking...';
    statusPill.className = 'pill off';
    premiumStatus.style.display = 'none';
  }
}

async function checkStatus() {
  setLoading(true);

  try {
    const { settings } = await chrome.storage.local.get(['settings']);
    const hasToken = !!(settings && settings.token);

    if (!hasToken) {
      setStatus(false, false);
      return;
    }

    chrome.runtime.sendMessage({ type: 'CHECK_PREMIUM' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Premium check error:', chrome.runtime.lastError);
        setStatus(hasToken, false);
        return;
      }

      const isPremium = response?.isPremium || false;
      console.log('Premium check result:', { hasToken, isPremium, roles: response?.roles });
      setStatus(hasToken, isPremium);
    });
  } catch (error) {
    console.error('Status check error:', error);
    setStatus(false, false);
  }
}

async function refreshHelperToggle() {
  const { futhubEnabled = true } = await chrome.storage.local.get({ futhubEnabled: true });
  helperToggle.classList.toggle('on', !!futhubEnabled);
  helperToggle.setAttribute('aria-pressed', String(!!futhubEnabled));
}

helperToggle.addEventListener('click', async () => {
  const { futhubEnabled = true } = await chrome.storage.local.get({ futhubEnabled: true });
  await chrome.storage.local.set({ futhubEnabled: !futhubEnabled });
  await refreshHelperToggle();
});

quickLoginBtn.addEventListener('click', async () => {
  if (currentState.connected && !currentState.isPremium) {
    try {
      const { settings } = await chrome.storage.local.get(['settings']);
      const apiBase = settings?.apiBase || 'https://api.futhub.co.uk';
      const dashboardUrl = apiBase.replace('api.', '').replace('/api', '') + '/billing';
      chrome.tabs.create({ url: dashboardUrl });
    } catch (error) {
      console.error('Error opening billing page:', error);
      chrome.tabs.create({ url: 'https://app.futhub.co.uk/#/billing' });
    }
  } else if (!currentState.connected) {
    setLoading(true);
    chrome.runtime.sendMessage({ type: 'START_OAUTH' }, () => {
      if (chrome.runtime.lastError) {
        console.error('OAuth error:', chrome.runtime.lastError);
        setLoading(false);
        return;
      }
      setTimeout(() => checkStatus(), 1500);
    });
  }
});

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

refreshHelperToggle();
checkStatus();
setInterval(checkStatus, 30000);
