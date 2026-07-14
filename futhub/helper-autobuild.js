// Floating FUTHub helper control, merged from the helper extension.
(async function () {
  const get = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  const { futhubEnabled = true } = await get({ futhubEnabled: true });

  if (!futhubEnabled) return;

  const LOG_PREFIX = '[FUTHub Helper]';
  const EA_MATCHERS = [/ea\.com/i, /easports\.com/i, /ea-sports/i, /ultimate[- ]?team/i, /fc(25|26)?/i];

  function onReady(fn) {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      setTimeout(fn, 0);
    } else {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    }
  }

  function isEAPage() {
    return EA_MATCHERS.some((rx) => rx.test(location.href));
  }

  function ensureStyle() {
    if (document.getElementById('futhub-helper-style')) return;

    const style = document.createElement('style');
    style.id = 'futhub-helper-style';
    style.textContent = `
      .futhub-fab {
        position: fixed;
        left: 24px;
        top: 120px;
        z-index: 2147483000;
        padding: 10px 14px;
        border-radius: 10px;
        font-weight: 800;
        background: #39ff14;
        color: #0b0f10;
        border: none;
        box-shadow: 0 8px 22px rgba(57, 255, 20, 0.35);
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        letter-spacing: 0.2px;
      }
      .futhub-fab:hover { filter: brightness(0.92); transform: translateY(-1px); }
      img[src*="flag"], .flag, .icon-flag, .autosbc-flag, .sbc-flag-button, .flag-icon { display: none !important; }
    `;
    document.documentElement.appendChild(style);
  }

  function createFAB() {
    if (document.getElementById('futhub-fab')) return;

    ensureStyle();

    const btn = document.createElement('button');
    btn.id = 'futhub-fab';
    btn.className = 'futhub-fab';

    const wandUrl = chrome.runtime.getURL('assets/wand.svg');
    btn.innerHTML = `<img src="${wandUrl}" alt="FUTHub" style="width:18px;height:18px"><span>FUTHub Auto Build</span>`;

    btn.addEventListener('click', () => {
      console.log(LOG_PREFIX, 'Auto Build clicked');
      window.dispatchEvent(new CustomEvent('FUTHUB_AUTOBUILD_CLICK'));
    });

    document.body.appendChild(btn);
  }

  function init() {
    if (!isEAPage()) return;

    const tryMount = () => {
      if (document.body && document.querySelector('button,div,span')) createFAB();
    };

    tryMount();
    const observer = new MutationObserver(tryMount);
    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('FUTHUB_AUTOBUILD_CLICK', () => {
      console.log(LOG_PREFIX, 'Custom event received. Wire this to the FUT Trader Hub auto-build flow when available.');
      if (window.FUTHub?.autoBuild) window.FUTHub.autoBuild();
      else if (window.AutoSBC?.start) window.AutoSBC.start();
    });
  }

  onReady(init);
})();
