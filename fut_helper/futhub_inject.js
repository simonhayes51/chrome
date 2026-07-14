
(() => {
  const LOG_PREFIX = "[FUTHub Inject]";
  const EA_MATCHERS = [
    /ea\.com/i,
    /ea-sports/i,
    /ultimate[- ]?team/i,
    /fc(25|26)?/i
  ];

  function onReady(fn) {
    if (document.readyState === "complete" || document.readyState === "interactive") {
      setTimeout(fn, 0);
    } else {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    }
  }

  function isEAPage() {
    const href = location.href;
    return EA_MATCHERS.some(rx => rx.test(href));
  }

  // Floating FAB style so we don't mutate React DOM
  const style = document.createElement("style");
  style.textContent = `
    .futhub-fab {
      position: fixed;
      left: 24px;
      top: 120px;
      z-index: 2147483000;
      padding: 10px 14px;
      border-radius: 10px;
      font-weight: 800;
      background: #39FF14;
      color: #0b0f10;
      border: none;
      box-shadow: 0 8px 22px rgba(57,255,20,0.35);
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      letter-spacing: 0.2px;
    }
    .futhub-fab:hover { filter: brightness(0.92); transform: translateY(-1px); }
    /* Hide likely flag buttons/icons */
    img[src*="flag"], .flag, .icon-flag, .autosbc-flag, .sbc-flag-button, .flag-icon { display: none !important; }
  `;

  function createFAB() {
    if (document.getElementById("futhub-fab")) return null;

    const btn = document.createElement("button");
    btn.id = "futhub-fab";
    btn.className = "futhub-fab";
    const wandUrl = chrome?.runtime?.getURL
      ? chrome.runtime.getURL("assets/wand.svg")
      : null;
    btn.innerHTML = (wandUrl
      ? `<img src="${wandUrl}" alt="FUTHub" style="width:18px;height:18px">`
      : "✨"
    ) + `<span>FUTHub Auto Build</span>`;

    btn.addEventListener("click", () => {
      console.log(LOG_PREFIX, "FAB clicked");
      // Dispatch a custom event your main script can listen for
      window.dispatchEvent(new CustomEvent("FUTHUB_AUTOBUILD_CLICK"));
    });

    document.documentElement.appendChild(style);
    document.body.appendChild(btn);
    return btn;
  }

  function waitForUT() {
    // Poll for key UI hints to only show when SBC screen is present
    const hasSbcHints = !!document.querySelector('button,div,span');
    if (!hasSbcHints) return false;
    // Always try to show; FAB approach is safe across pages.
    return true;
  }

  function init() {
    if (!isEAPage()) return;

    const tryMount = () => {
      if (waitForUT()) {
        createFAB();
      }
    };

    tryMount();
    const mo = new MutationObserver(() => tryMount());
    mo.observe(document.body, { childList: true, subtree: true });

    // Optional: listen for our custom event in case the existing code needs to run something
    window.addEventListener("FUTHUB_AUTOBUILD_CLICK", () => {
      console.log(LOG_PREFIX, "Custom event received. Hook your auto-build function here.");
      // Example: if your original function is exposed globally, call it:
      // if (window.AutoSBC?.start) window.AutoSBC.start();
      // Or if renamed:
      // if (window.FUTHub?.autoBuild) window.FUTHub.autoBuild();
    });
  }

  onReady(init);
})();
