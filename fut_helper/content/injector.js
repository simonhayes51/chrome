// FUTHub Helper content injector with readiness gate
(async function() {
  const get = (keys) => new Promise(r => chrome.storage.local.get(keys, r));
  let { futhubEnabled } = await get({ futhubEnabled: true });
  if (!futhubEnabled) {
    console.debug('[FUTHub Helper] injection disabled');
    return;
  }

  function isEAReady() {
    try {
      // Heuristics: any of these being defined usually means the app bundle loaded
      return !!(window.UTItemSearchViewModel ||
                window.UTAppSettingsViewController ||
                (window.services && typeof window.services.searchConceptItems === 'function') ||
                (window.requirejs && window.define));
    } catch (e) { return false; }
  }

  function whenEAReady(timeoutMs = 20000, intervalMs = 200) {
    return new Promise((resolve, reject) => {
      const start = performance.now();
      const t = setInterval(() => {
        if (isEAReady()) {
          clearInterval(t);
          resolve(true);
        } else if (performance.now() - start > timeoutMs) {
          clearInterval(t);
          resolve(false); // proceed anyway; some builds hide globals
        }
      }, intervalMs);
    });
  }

  console.debug('[FUTHub Helper] waiting for EA app...');
  await whenEAReady();

  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('page/page-helper.js');
  s.type = 'text/javascript';
  (document.head || document.documentElement).appendChild(s);
  s.onload = function(){ this.remove(); };
  console.debug('[FUTHub Helper] page-helper injected');
})();