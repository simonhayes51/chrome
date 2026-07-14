// FUTHub Helper content injector with readiness gate, merged into FUT Trader Hub.
(async function () {
  const get = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  const { futhubEnabled = true } = await get({ futhubEnabled: true });

  if (!futhubEnabled) {
    console.debug('[FUTHub Helper] injection disabled');
    return;
  }

  function isEAReady() {
    try {
      return !!(
        window.UTItemSearchViewModel ||
        window.UTAppSettingsViewController ||
        (window.services && typeof window.services.searchConceptItems === 'function') ||
        (window.requirejs && window.define)
      );
    } catch (e) {
      return false;
    }
  }

  function whenEAReady(timeoutMs = 20000, intervalMs = 200) {
    return new Promise((resolve) => {
      const start = performance.now();
      const timer = setInterval(() => {
        if (isEAReady()) {
          clearInterval(timer);
          resolve(true);
        } else if (performance.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, intervalMs);
    });
  }

  console.debug('[FUTHub Helper] waiting for EA app...');
  await whenEAReady();

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page/page-helper.js');
  script.type = 'text/javascript';
  (document.head || document.documentElement).appendChild(script);
  script.onload = function () { this.remove(); };
  console.debug('[FUTHub Helper] page-helper injected');
})();
