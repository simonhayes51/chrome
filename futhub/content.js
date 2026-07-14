// content.js - Enhanced with Premium restrictions and better user feedback
(function () {
  if (!/ea\.com$/i.test(location.hostname)) return;

  // Inject page-context hook for tradepile capture
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject.js');
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.remove();
    console.log('[FUT Content] Inject script loaded');
  } catch (e) {
    console.error('[FUT Content] Failed to load inject script:', e);
  }

  // Enhanced persistent cache for buy prices
  const LS_KEY = '__fut_purchase_cache_v4';
  let cache = { 
    byItemId: {}, 
    byAssetId: {}, 
    byTradeId: {},
    playerNames: {},
    cardTypes: {}
  };

  // Premium status tracking
  let premiumStatus = {
    checked: false,
    isPremium: false,
    connected: false,
    lastCheck: 0
  };

  function loadCache() {
    try { 
      const stored = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      cache = {
        byItemId: stored.byItemId || {},
        byAssetId: stored.byAssetId || {},
        byTradeId: stored.byTradeId || {},
        playerNames: stored.playerNames || {},
        cardTypes: stored.cardTypes || {}
      };
      console.log('[FUT Content] Cache loaded:', Object.keys(cache.byItemId).length, 'buy prices cached');
    } catch (e) {
      console.error('[FUT Content] Cache load error:', e);
    }
  }

  function saveCache() { 
    try { 
      localStorage.setItem(LS_KEY, JSON.stringify(cache));
      console.log('[FUT Content] Cache saved');
    } catch (e) {
      console.error('[FUT Content] Cache save error:', e);
    }
  }

  // Premium status checking
  async function checkPremiumStatus() {
    const now = Date.now();
    // Only check every 2 minutes to avoid spam
    if (now - premiumStatus.lastCheck < 2 * 60 * 1000 && premiumStatus.checked) {
      return premiumStatus;
    }

    try {
      chrome.runtime.sendMessage({ type: 'CHECK_PREMIUM' }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[FUT Content] Premium check error:', chrome.runtime.lastError);
          premiumStatus = { checked: true, isPremium: false, connected: false, lastCheck: now };
          return;
        }

        premiumStatus = {
          checked: true,
          isPremium: response?.isPremium || false,
          connected: !!response?.isPremium || !!response?.roles?.length,
          lastCheck: now
        };

        console.log('[FUT Content] Premium status updated:', premiumStatus);
      });
    } catch (e) {
      console.error('[FUT Content] Premium check failed:', e);
      premiumStatus = { checked: true, isPremium: false, connected: false, lastCheck: now };
    }

    return premiumStatus;
  }

  // Enhanced price setting with multiple ID types
  const setBought = (itemId, assetId, tradeId, price) => {
    if (!(price > 0)) return;
    
    const priceNum = Number(price);
    if (itemId != null) cache.byItemId[String(itemId)] = priceNum;
    if (assetId != null) cache.byAssetId[String(assetId)] = priceNum;
    if (tradeId != null) cache.byTradeId[String(tradeId)] = priceNum;
    
    console.log(`[FUT Content] Buy price cached: ${priceNum} for IDs: ${itemId}/${assetId}/${tradeId}`);
  };

  // Enhanced price getting with fallback logic
  const getBought = (itemId, assetId, tradeId) => {
    const sources = [
      tradeId != null ? cache.byTradeId[String(tradeId)] : null,
      itemId != null ? cache.byItemId[String(itemId)] : null,
      assetId != null ? cache.byAssetId[String(assetId)] : null
    ].filter(Boolean);
    
    const price = sources[0] || 0;
    if (price > 0) {
      console.log(`[FUT Content] Buy price found: ${price} for IDs: ${itemId}/${assetId}/${tradeId}`);
    }
    return price;
  };

  // Enhanced player name and card type caching
  const setPlayerInfo = (itemId, assetId, tradeId, playerName, cardType) => {
    if (playerName && playerName !== 'Unknown Player') {
      if (itemId != null) cache.playerNames[String(itemId)] = playerName;
      if (assetId != null) cache.playerNames[String(assetId)] = playerName;
      if (tradeId != null) cache.playerNames[String(tradeId)] = playerName;
    }
    
    if (cardType && cardType !== 'Standard') {
      if (itemId != null) cache.cardTypes[String(itemId)] = cardType;
      if (assetId != null) cache.cardTypes[String(assetId)] = cardType;
      if (tradeId != null) cache.cardTypes[String(tradeId)] = cardType;
    }
  };

  const getPlayerInfo = (itemId, assetId, tradeId) => {
    const nameKey = [
      tradeId != null ? String(tradeId) : null,
      itemId != null ? String(itemId) : null,
      assetId != null ? String(assetId) : null
    ].find(key => key && cache.playerNames[key]);
    
    const typeKey = [
      tradeId != null ? String(tradeId) : null,
      itemId != null ? String(itemId) : null,
      assetId != null ? String(assetId) : null
    ].find(key => key && cache.cardTypes[key]);
    
    return {
      playerName: nameKey ? cache.playerNames[nameKey] : null,
      cardType: typeKey ? cache.cardTypes[typeKey] : null
    };
  };

  loadCache();

  // Storage variables
  let latestTradepile = null;
  const processedTradeIds = new Set();

  // ---------------- Fair Value price overlays ----------------
  // fairValueCache: cardId -> { data: <fair_value_mv row|null>, at: ms }
  // A `data: null` entry means "we checked, backend has nothing for this
  // card yet" - still cached, so we don't re-request it every scan.
  const fairValueCache = new Map();
  const FV_CACHE_TTL_MS = 5 * 60 * 1000;
  const FV_REQUEST_BATCH_MS = 400;
  let fvRequestTimer = null;
  const fvPendingCardIds = new Set();
  let lastOverlayNotice = null; // avoid re-toasting the same setup error
  let latestProcessedItems = []; // most recent FUT_CACHE_ITEMS batch, for row<->item pairing

  const FV_STYLES = {
    steal: { bg: 'rgba(145,219,50,0.85)', fg: '#0e1a00', label: 'STEAL' },
    under: { bg: 'rgba(185,233,124,0.85)', fg: '#0e1a00', label: 'UNDER' },
    fair: { bg: 'rgba(255,255,255,0.15)', fg: '#fff', label: 'FAIR' },
    overpriced: { bg: 'rgba(248,113,113,0.85)', fg: '#2a0000', label: 'OVERPAY' },
    falling: { bg: 'rgba(249,115,22,0.9)', fg: '#2a1200', label: '⚠ FALLING' },
    pending: { bg: 'rgba(250,204,21,0.85)', fg: '#2a1d00', label: 'VERIFYING' },
  };

  // Mirrors verdictFrom() in the site's FairValueBadge.jsx so the extension
  // and the dashboard never disagree about what counts as a "steal".
  function fvVerdict(fv) {
    if (!fv) return null;
    if (fv.data_quality_suspect) return 'pending';
    // A crashing card also shows a big discount_pct (current_bin has
    // already dropped, the 24h median hasn't caught up yet) - that's a
    // falling knife, not a steal. Overrides the number either way.
    if (fv.trend_falling) return 'falling';
    const d = fv.discount_pct;
    if (d == null) return null;
    if (d >= 8) return 'steal';
    if (d >= 3) return 'under';
    if (d <= -5) return 'overpriced';
    return 'fair';
  }

  function scheduleFairValueRequest(cardIds) {
    const now = Date.now();
    for (const id of cardIds) {
      const hit = fairValueCache.get(id);
      if (hit && now - hit.at < FV_CACHE_TTL_MS) continue;
      fvPendingCardIds.add(id);
    }
    if (!fvPendingCardIds.size || fvRequestTimer) return;
    fvRequestTimer = setTimeout(runFairValueRequest, FV_REQUEST_BATCH_MS);
  }

  function runFairValueRequest() {
    fvRequestTimer = null;
    if (!fvPendingCardIds.size) return;
    const ids = Array.from(fvPendingCardIds).slice(0, 100);
    fvPendingCardIds.clear();

    chrome.runtime.sendMessage({ type: 'GET_FAIR_VALUES', cardIds: ids }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[FUT Content] Fair value request error:', chrome.runtime.lastError);
        return;
      }
      if (!response?.ok) {
        notifyOverlaySetupIssue(response?.error);
        return;
      }
      const now = Date.now();
      const items = response.items || {};
      for (const id of ids) {
        fairValueCache.set(id, { data: items[String(id)] || null, at: now });
      }
      applyFairValueOverlays();
    });
  }

  function notifyOverlaySetupIssue(error) {
    if (!error || error === lastOverlayNotice) return;
    lastOverlayNotice = error;
    if (error === 'no_api_key') {
      toast('Add a Market Data API key in Settings to see Fair Value overlays', 'premium');
    } else if (error === 'invalid_api_key') {
      toast('Market Data API key is invalid - check Settings', 'error');
    } else if (error === 'upgrade_required') {
      toast('Fair Value overlays need a Pro plan', 'premium');
    }
    // 'overlays_disabled' and 'rate_limited' are quiet by design - the
    // first is an explicit user choice, the second is self-correcting.
  }

  // Best-effort DOM<->item pairing: EA's web app doesn't expose a stable
  // per-row id we can rely on, so we pair visible rows with the most
  // recent batch of intercepted items by position, then cross-check
  // against a visible price on the row (when we can find one) so a
  // mismatch skips the row instead of labelling the wrong card - wrong
  // silence is fine here, a wrong verdict on someone's actual money isn't.
  function findRowPrice(row) {
    const el = row.querySelector('.currency-coins, .coins, .price, [class*="coin"], [class*="price"]');
    if (!el) return null;
    const n = parseCoins(el.textContent || '');
    return n > 0 ? n : null;
  }

  function itemVisiblePrice(item) {
    return item?.buyNowPrice || item?.currentBid || item?.startingBid || null;
  }

  function formatCoins(n) {
    if (n == null) return '?';
    return Math.round(n).toLocaleString();
  }

  // How stale our own tracked BIN is, right on the badge - so "is this
  // number current" is answerable by looking at the card, not by opening
  // the dashboard or FUTBIN in another tab.
  function formatAge(iso) {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return 'just now';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m ago`;
    return `${Math.round(mins / 60)}h ago`;
  }

  function ensureBadgeEl(row) {
    let badge = row.querySelector(':scope > [data-fut-fv-badge="1"]');
    if (badge) return badge;
    badge = document.createElement('div');
    badge.setAttribute('data-fut-fv-badge', '1');
    badge.style.cssText = `
      position: absolute;
      top: 4px;
      right: 4px;
      z-index: 999;
      pointer-events: none;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 2px;
      white-space: nowrap;
    `;
    const pill = document.createElement('div');
    pill.className = 'fut-fv-pill';
    pill.style.cssText = `
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.35);
    `;
    const detail = document.createElement('div');
    detail.className = 'fut-fv-detail';
    detail.style.cssText = `
      font-size: 9px;
      font-weight: 700;
      color: #fff;
      background: rgba(0,0,0,0.65);
      padding: 1px 6px;
      border-radius: 6px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.35);
    `;
    badge.appendChild(pill);
    badge.appendChild(detail);

    const style = getComputedStyle(row);
    if (style.position === 'static') row.style.position = 'relative';
    row.appendChild(badge);
    return badge;
  }

  // The web app uses different row markup in different screens - `.listFUTItem`
  // shows up in the Club list, but Transfer Market search results use
  // `.entityContainer` wrapping a `.player.item` card instead (confirmed live
  // via devtools). `.small` distinguishes the compact list-row rendering from
  // the large single-card detail view, which reuses the same component.
  // `:has()` isn't in every older Chrome build, so fall back to a manual
  // filter if the selector itself throws.
  function getCandidateRows() {
    const plain = Array.from(
      document.querySelectorAll('.listFUTItem:not(.won), [class*="listFUTItem"]:not(.won)')
    );
    let entityRows = [];
    try {
      entityRows = Array.from(document.querySelectorAll('.entityContainer:has(.player.item.small)'));
    } catch (e) {
      entityRows = Array.from(document.querySelectorAll('.entityContainer')).filter((el) =>
        el.querySelector('.player.item.small')
      );
    }
    return [...plain, ...entityRows];
  }

  function applyFairValueOverlays() {
    if (!latestProcessedItems.length) return;

    const rows = getCandidateRows();
    if (!rows.length) return;

    const len = Math.min(rows.length, latestProcessedItems.length);
    for (let i = 0; i < len; i++) {
      const row = rows[i];
      const item = latestProcessedItems[i];
      const cardId = item?.cardId;
      if (cardId == null) continue;

      const cached = fairValueCache.get(cardId);
      if (!cached || !cached.data) continue;

      // Cross-check when both sides have a visible price - skip on
      // disagreement rather than risk badging the wrong row.
      const domPrice = findRowPrice(row);
      const itemPrice = itemVisiblePrice(item);
      if (domPrice != null && itemPrice != null && domPrice !== itemPrice) continue;

      const verdict = fvVerdict(cached.data);
      if (!verdict) continue;

      const s = FV_STYLES[verdict];
      const badge = ensureBadgeEl(row);
      const pill = badge.querySelector('.fut-fv-pill');
      const detail = badge.querySelector('.fut-fv-detail');

      pill.style.background = s.bg;
      pill.style.color = s.fg;
      const pct = cached.data.discount_pct;
      const pctText = verdict !== 'pending' && verdict !== 'falling' && pct != null
        ? `<span>${pct > 0 ? '-' : '+'}${Math.abs(Math.round(pct))}%</span>`
        : '';
      pill.innerHTML = `<span>${s.label}</span>${pctText}`;

      // The actual tracked numbers, right on the card - so there's no
      // need to alt-tab to the dashboard or FUTBIN to sanity-check this.
      detail.textContent = verdict === 'pending'
        ? 'checking...'
        : `BIN ${formatCoins(cached.data.current_bin)} · ${formatAge(cached.data.bin_captured_at)}`;

      badge.title = verdict === 'pending'
        ? "FUT Trader Hub: still verifying this card's market data"
        : verdict === 'falling'
        ? 'FUT Trader Hub: price is trending down faster than the 24h median has caught up - wait before buying'
        : `FUT Trader Hub Fair Value: real 24h median ${formatCoins(cached.data.fair_value_24h)}, ${cached.data.sales_24h ?? 0} sales tracked`;
    }
  }

  function watchForFairValueTargets() {
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        applyFairValueOverlays();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------------- FUT Trader Hub side panel ----------------
  // A draggable, collapsible info panel injected into the page - shows the
  // live Undervalued board and this session's logged trades. Purely
  // informational: nothing here clicks, fills in, or navigates anything on
  // the page. You still find and buy cards yourself; this just saves a tab
  // switch to check the dashboard.
  const PANEL_POS_KEY = '__fut_panel_pos_v1';
  const PANEL_COLLAPSED_KEY = '__fut_panel_collapsed_v1';
  const UNDERVALUED_REFRESH_MS = 2 * 60 * 1000;

  const sessionStats = { loggedCount: 0, totalProfit: 0 };
  let panelEls = null; // { root, body, list, sessionEl, refreshBtn }
  let undervaluedTimer = null;

  function addSessionTrade(record) {
    sessionStats.loggedCount += 1;
    sessionStats.totalProfit += Number(record?.profit) || 0;
    renderSessionStats();
  }

  function renderSessionStats() {
    if (!panelEls) return;
    const p = sessionStats.totalProfit;
    const sign = p > 0 ? '+' : p < 0 ? '−' : '';
    panelEls.sessionEl.innerHTML = `
      <div class="fut-panel-stat"><span>Trades logged</span><strong>${sessionStats.loggedCount}</strong></div>
      <div class="fut-panel-stat"><span>Session profit</span><strong style="color:${p >= 0 ? '#91db32' : '#f87171'}">${sign}${Math.abs(Math.round(p)).toLocaleString()}</strong></div>
    `;
  }

  function renderUndervaluedList(items) {
    if (!panelEls) return;
    if (!items?.length) {
      panelEls.list.innerHTML = `<div class="fut-panel-empty">Nothing meets the bar right now - check back shortly.</div>`;
      return;
    }
    panelEls.list.innerHTML = items
      .slice(0, 8)
      .map((it) => {
        const pct = it.discount_pct != null ? `-${Math.round(it.discount_pct)}%` : '';
        return `
          <div class="fut-panel-row">
            <span class="fut-panel-row-name">${it.name ?? 'Unknown'} <span class="fut-panel-row-meta">${it.rating ?? ''} ${it.version ?? ''}</span></span>
            <span class="fut-panel-row-price">${formatCoins(it.current_bin)}<span class="fut-panel-row-pct">${pct}</span></span>
          </div>
        `;
      })
      .join('');
  }

  function renderUndervaluedIssue(error) {
    if (!panelEls) return;
    const messages = {
      no_api_key: 'Add a Market Data API key in Settings to see live picks.',
      invalid_api_key: 'Market Data API key is invalid - check Settings.',
      upgrade_required: 'The Undervalued board needs a Pro plan.',
      overlays_disabled: 'Overlays are turned off in Settings.',
      rate_limited: 'Rate limited - retrying shortly.',
    };
    panelEls.list.innerHTML = `<div class="fut-panel-empty">${messages[error] || 'Could not load picks right now.'}</div>`;
  }

  function refreshUndervaluedPanel() {
    if (!panelEls) return;
    chrome.runtime.sendMessage({ type: 'GET_UNDERVALUED', limit: 8 }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[FUT Content] Undervalued request error:', chrome.runtime.lastError);
        return;
      }
      if (!response?.ok) {
        renderUndervaluedIssue(response?.error);
        return;
      }
      renderUndervaluedList(response.items);
    });
  }

  // Manual shopping list only - shows the cheapest currently-priced cards
  // meeting a rating/position you type in from the SBC you're looking at.
  // Nothing here reads the SBC screen, fills a slot, or submits anything;
  // you still find, buy, and place every card yourself.
  const FODDER_ISSUE_MESSAGES = {
    no_api_key: 'Add a Market Data API key in Settings first.',
    invalid_api_key: 'Market Data API key is invalid - check Settings.',
    upgrade_required: 'This needs a Pro plan.',
    overlays_disabled: 'Overlays are turned off in Settings.',
    rate_limited: 'Rate limited - try again shortly.',
    invalid_rating: 'Enter a rating between 1 and 99.',
  };

  function renderFodderList(items) {
    if (!panelEls) return;
    if (!items?.length) {
      panelEls.fodderList.innerHTML = `<div class="fut-panel-empty">Nothing found at that rating right now.</div>`;
      return;
    }
    panelEls.fodderList.innerHTML = items
      .map((it) => `
        <div class="fut-panel-row">
          <span class="fut-panel-row-name">${it.name ?? 'Unknown'} <span class="fut-panel-row-meta">${it.rating ?? ''} ${it.position ?? ''}</span></span>
          <span class="fut-panel-row-price">${formatCoins(it.price_num)}</span>
        </div>
      `)
      .join('');
  }

  function runFodderSearch() {
    if (!panelEls) return;
    const minRating = Number(panelEls.fodderMinRating.value);
    const position = panelEls.fodderPosition.value.trim();
    if (!Number.isFinite(minRating) || minRating < 1 || minRating > 99) {
      panelEls.fodderList.innerHTML = `<div class="fut-panel-empty">${FODDER_ISSUE_MESSAGES.invalid_rating}</div>`;
      return;
    }
    panelEls.fodderList.innerHTML = `<div class="fut-panel-empty">Searching...</div>`;
    chrome.runtime.sendMessage(
      { type: 'GET_CHEAP_FODDER', query: { minRating, position: position || undefined } },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[FUT Content] Cheap fodder request error:', chrome.runtime.lastError);
          return;
        }
        if (!response?.ok) {
          panelEls.fodderList.innerHTML = `<div class="fut-panel-empty">${FODDER_ISSUE_MESSAGES[response?.error] || 'Could not search right now.'}</div>`;
          return;
        }
        renderFodderList(response.items);
      }
    );
  }

  function setPanelCollapsed(collapsed) {
    panelEls.root.classList.toggle('collapsed', collapsed);
    panelEls.toggleBtn.textContent = collapsed ? '▲' : '▼';
    try {
      localStorage.setItem(PANEL_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {}
    if (!collapsed) {
      refreshUndervaluedPanel();
      if (!undervaluedTimer) {
        undervaluedTimer = setInterval(refreshUndervaluedPanel, UNDERVALUED_REFRESH_MS);
      }
    } else if (undervaluedTimer) {
      clearInterval(undervaluedTimer);
      undervaluedTimer = null;
    }
  }

  function makePanelDraggable(root, handle) {
    let dragging = false;
    let startX, startY, startLeft, startTop;

    handle.addEventListener('mousedown', (e) => {
      // Ignore drags starting on a button inside the header.
      if (e.target.closest('button')) return;
      dragging = true;
      const rect = root.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const left = Math.max(0, Math.min(window.innerWidth - 60, startLeft + (e.clientX - startX)));
      const top = Math.max(0, Math.min(window.innerHeight - 40, startTop + (e.clientY - startY)));
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      try {
        localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ left: root.style.left, top: root.style.top }));
      } catch {}
    });
  }

  function buildFutHubPanel() {
    if (panelEls || document.getElementById('fut-hub-panel')) return;

    const style = document.createElement('style');
    style.textContent = `
      #fut-hub-panel {
        position: fixed;
        right: 20px;
        top: 110px;
        width: 260px;
        z-index: 9998;
        background: linear-gradient(180deg, rgba(22,18,43,0.97), rgba(13,10,26,0.97));
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 14px;
        box-shadow: 0 14px 40px rgba(0,0,0,0.5);
        font-family: Inter, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
        color: #e6e6f0;
        overflow: hidden;
      }
      #fut-hub-panel .fut-panel-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 12px; cursor: grab; user-select: none;
        background: rgba(255,255,255,0.03);
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      #fut-hub-panel .fut-panel-title { font-size: 12px; font-weight: 800; letter-spacing: 0.3px; }
      #fut-hub-panel .fut-panel-header button {
        background: none; border: none; color: #a7a4c4; cursor: pointer; font-size: 11px; padding: 2px 6px;
      }
      #fut-hub-panel .fut-panel-body { padding: 10px 12px; max-height: 340px; overflow-y: auto; }
      #fut-hub-panel.collapsed .fut-panel-body { display: none; }
      #fut-hub-panel .fut-panel-section-title {
        font-size: 10px; font-weight: 800; color: #a7a4c4; text-transform: uppercase;
        letter-spacing: 0.5px; margin: 8px 0 4px;
      }
      #fut-hub-panel .fut-panel-stat {
        display: flex; justify-content: space-between; font-size: 12px; padding: 3px 0;
      }
      #fut-hub-panel .fut-panel-row {
        display: flex; justify-content: space-between; align-items: center;
        font-size: 11px; padding: 5px 0; border-bottom: 1px solid rgba(255,255,255,0.05);
        gap: 8px;
      }
      #fut-hub-panel .fut-panel-row-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #fut-hub-panel .fut-panel-row-meta { color: #a7a4c4; font-weight: 400; }
      #fut-hub-panel .fut-panel-row-price { white-space: nowrap; font-weight: 700; text-align: right; }
      #fut-hub-panel .fut-panel-row-pct { display: block; color: #91db32; font-size: 10px; }
      #fut-hub-panel .fut-panel-empty { font-size: 11px; color: #a7a4c4; padding: 6px 0; }
      #fut-hub-panel .fut-panel-fodder-form { display: flex; gap: 4px; margin-bottom: 6px; }
      #fut-hub-panel .fut-panel-input {
        flex: 1; min-width: 0; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
        border-radius: 6px; color: #e6e6f0; font-size: 11px; padding: 4px 6px;
      }
      #fut-hub-panel .fut-panel-input::placeholder { color: #6b6886; }
      #fut-hub-panel .fut-panel-fodder-btn {
        background: linear-gradient(90deg,#6f3cf6,#8f5cff); border: none; border-radius: 6px;
        color: #fff; font-size: 11px; font-weight: 700; padding: 4px 10px; cursor: pointer; white-space: nowrap;
      }
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.id = 'fut-hub-panel';
    root.innerHTML = `
      <div class="fut-panel-header">
        <span class="fut-panel-title">FUT Trader Hub</span>
        <div>
          <button type="button" data-action="refresh" title="Refresh">↻</button>
          <button type="button" data-action="toggle" title="Collapse">▼</button>
        </div>
      </div>
      <div class="fut-panel-body">
        <div class="fut-panel-section-title">This Session</div>
        <div class="fut-panel-session"></div>
        <div class="fut-panel-section-title">Undervalued Right Now</div>
        <div class="fut-panel-list"><div class="fut-panel-empty">Loading...</div></div>
        <div class="fut-panel-section-title">SBC Cheap Fodder Finder</div>
        <div class="fut-panel-fodder-form">
          <input type="number" class="fut-panel-input" data-field="minRating" placeholder="Min rating" min="1" max="99">
          <input type="text" class="fut-panel-input" data-field="position" placeholder="Pos (optional)">
          <button type="button" class="fut-panel-fodder-btn" data-action="find-fodder">Find</button>
        </div>
        <div class="fut-panel-list fut-panel-fodder-list"></div>
      </div>
    `;
    document.body.appendChild(root);

    panelEls = {
      root,
      header: root.querySelector('.fut-panel-header'),
      body: root.querySelector('.fut-panel-body'),
      sessionEl: root.querySelector('.fut-panel-session'),
      list: root.querySelector('.fut-panel-list'),
      toggleBtn: root.querySelector('[data-action="toggle"]'),
      fodderList: root.querySelector('.fut-panel-fodder-list'),
      fodderMinRating: root.querySelector('[data-field="minRating"]'),
      fodderPosition: root.querySelector('[data-field="position"]'),
    };

    root.querySelector('[data-action="refresh"]').addEventListener('click', refreshUndervaluedPanel);
    panelEls.toggleBtn.addEventListener('click', () => {
      setPanelCollapsed(!root.classList.contains('collapsed'));
    });
    root.querySelector('[data-action="find-fodder"]').addEventListener('click', runFodderSearch);
    panelEls.fodderMinRating.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runFodderSearch();
    });

    makePanelDraggable(root, panelEls.header);

    try {
      const savedPos = JSON.parse(localStorage.getItem(PANEL_POS_KEY) || 'null');
      if (savedPos?.left && savedPos?.top) {
        root.style.left = savedPos.left;
        root.style.top = savedPos.top;
        root.style.right = 'auto';
        root.style.bottom = 'auto';
      }
    } catch {}

    renderSessionStats();
    // Default to collapsed on first run - it should never block anything
    // (like the Buy Now button) until you deliberately open it. Once you've
    // expanded or collapsed it once, that explicit choice is remembered.
    const startCollapsed = (() => {
      try {
        const saved = localStorage.getItem(PANEL_COLLAPSED_KEY);
        return saved === null ? true : saved === '1';
      } catch {
        return true;
      }
    })();
    setPanelCollapsed(startCollapsed);
  }

  // Enhanced message handler with purchase interception
  window.addEventListener('message', (event) => {
    const { type, payload } = event?.data || {};
    
    if (type === 'FUT_TRADEPILE' && payload) {
      console.log('[FUT Content] Tradepile data received:', payload);
      latestTradepile = payload;
      
      // Auto-cleanup processed IDs if getting large
      if (processedTradeIds.size > 3000) processedTradeIds.clear();
    }

    // NEW: Capture purchase transactions in real-time
    if (type === 'FUT_PURCHASE' && payload) {
      console.log('[FUT Content] Purchase detected:', payload);
      const { itemId, assetId, tradeId, price, playerName, cardType } = payload;
      
      if (price > 0) {
        setBought(itemId, assetId, tradeId, price);
        setPlayerInfo(itemId, assetId, tradeId, playerName, cardType);
        saveCache();
        console.log(`[FUT Content] Real-time purchase cached: ${playerName} for ${price} coins`);
      }
    }

    if (type === 'FUT_CACHE_ITEMS' && payload?.items?.length) {
      console.log(`[FUT Content] Caching ${payload.items.length} items from API`);

      // inject.js's collector recursively walks every nested object in an
      // API response, and a single real listing can match more than one of
      // its checks (once via the auctionInfo special-case, again when it
      // later recurses into that same object generically) - so this array
      // can contain duplicate entries for one real listing. The overlay
      // pairs DOM rows with this array by position, so an undeduped
      // duplicate shifts every row after it by one, pairing unrelated rows
      // with the wrong card's data (confirmed live: two different cards
      // showing the identical tracked BIN). Dedupe by per-instance id
      // before using this for anything position-sensitive.
      const seenInstance = new Set();
      const dedupedItems = payload.items.filter((it) => {
        const key = it?.tradeId ?? it?.assetId ?? it?.id;
        if (key == null) return true; // can't dedupe safely - keep it
        const k = String(key);
        if (seenInstance.has(k)) return false;
        seenInstance.add(k);
        return true;
      });
      if (dedupedItems.length !== payload.items.length) {
        console.log(`[FUT Content] Deduped ${payload.items.length - dedupedItems.length} duplicate item(s)`);
      }

      latestProcessedItems = dedupedItems;
      const cardIds = dedupedItems
        .map((it) => it?.cardId)
        .filter((id) => id != null);
      if (cardIds.length) {
        scheduleFairValueRequest([...new Set(cardIds)]);
      }
      applyFairValueOverlays();

      let cacheUpdates = 0;
      for (const item of payload.items) {
        const itemId = item?.id != null ? String(item.id) : null;
        const assetId = item?.assetId != null ? String(item.assetId) : null;
        const tradeId = item?.tradeId != null ? String(item.tradeId) : null;
        
        // Store buy price from multiple possible sources - AVOID startingBid as it's not purchase price
        let buyPrice = 0;
        if (typeof item.purchasedPrice === 'number' && item.purchasedPrice > 0) {
          buyPrice = item.purchasedPrice;
        } else if (typeof item.lastSalePrice === 'number' && item.lastSalePrice > 0) {
          buyPrice = item.lastSalePrice;
        }
        
        if (buyPrice > 0) {
          setBought(itemId, assetId, tradeId, buyPrice);
          cacheUpdates++;
        }
        
        // Store player name and card type
        const playerName = item.player_name || 'Unknown Player';
        const cardType = normalizeCardType(item.card_version, item.rating);
        
        setPlayerInfo(itemId, assetId, tradeId, playerName, cardType);
      }
      
      if (cacheUpdates > 0) {
        console.log(`[FUT Content] Cached ${cacheUpdates} buy prices`);
        saveCache();
      }
    }
  });

  // Helper functions
  function parseCoins(text) {
    if (!text) return 0;
    const m = String(text).replace(/[,.\s]/g, '').match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }

  // Enhanced card type normalization
  function normalizeCardType(typeStr, rating) {
    if (!typeStr || typeof typeStr !== 'string') {
      // Rating-based fallback
      const r = Number(rating || 0);
      return r >= 75 ? 'Gold' : r >= 65 ? 'Silver' : r > 0 ? 'Bronze' : 'Standard';
    }
    const t = typeStr.toLowerCase();
    if (t.includes('totw') || /team\s*of\s*the\s*week|if_/.test(t)) return 'TOTW';
    if (t.includes('icon')) return 'Icon';
    if (t.includes('hero')) return 'Hero';
    if (t.includes('ucl') || t.includes('ucl_')) return 'UCL';
    if (t.includes('special')) return 'Special';
    if (t.includes('rare') && t.includes('gold')) return 'Rare Gold';
    if (t.includes('gold')) return 'Gold';
    if (t.includes('silver')) return 'Silver';
    if (t.includes('bronze')) return 'Bronze';
    if (t.includes('rare')) return 'Rare';
    return typeStr.length > 20 ? 'Special' : typeStr;
  }

  // Enhanced name extraction from item data
  function extractPlayerName(item = {}, auction = {}) {
    console.log('[FUT] Attempting name extraction for:', { item, auction });
    if (item.preferredName && item.preferredName.trim()) return item.preferredName.trim();
    if (item.commonName && item.commonName.trim()) return item.commonName.trim();
    const first = item.firstName ? item.firstName.trim() : '';
    const last = item.lastName ? item.lastName.trim() : '';
    if (first && last) return `${first} ${last}`;
    if (last) return last;
    if (first) return first;
    if (item.name && item.name.trim()) return item.name.trim();
    if (item.displayName && item.displayName.trim()) return item.displayName.trim();
    if (item.player) return extractPlayerName(item.player);
    if (auction && auction.itemData && auction.itemData !== item) return extractPlayerName(auction.itemData);
    console.warn('[FUT] Could not extract player name from:', item);
    return 'Unknown Player';
  }

  // DOM-based sold row scraping
  function scrapeSoldRows() {
    const rows = Array.from(
      document.querySelectorAll(
        '.listFUTItem.won, .listFUTItem[data-state="won"], .ut-item-list .won, .won'
      )
    );

    const items = [];

    for (const el of rows) {
      try {
        // Visible "Sold for" price
        const priceEl = el.querySelector('.currency-coins, .coins, .price, [class*="coin"]');
        const sellPrice = parseCoins(priceEl?.textContent || '');

        // Player name
        const nameEl = el.querySelector(
          '.name, .player-name, .ut-item-player-name, [class*="name"]'
        );
        const playerName = (nameEl?.textContent || '').trim() || 'Unknown';

        // Card version / variant label
        let cardVersion = 'Standard';
        const badge = el.querySelector(
          '[class*="rarity"], [class*="version"], [class*="flag"], .badge'
        );
        if (badge && badge.textContent) {
          const v = badge.textContent.trim();
          if (v) cardVersion = v;
        }
        if (el.getAttribute('data-item-type')) {
          cardVersion = el.getAttribute('data-item-type');
        }

        // Enhanced "Bought For" detection in DOM
        let boughtFor = 0;
        
        // Method 1: explicit "Bought For" text
        const boughtLabel = Array.from(el.querySelectorAll('*')).find((n) =>
          /bought\s*(for|at|price)/i.test(n.textContent || '')
        );
        if (boughtLabel) {
          const coins = parseCoins(boughtLabel.textContent);
          if (coins > 0) boughtFor = coins;
          else {
            const siblingCoins = boughtLabel.parentElement?.querySelector(
              '.currency-coins, .coins, [class*="coin"]'
            );
            if (siblingCoins && siblingCoins !== priceEl) {
              boughtFor = parseCoins(siblingCoins.textContent);
            }
          }
        }
        
        // Method 2: multiple price elements (smaller is likely buy)
        if (!boughtFor) {
          const allPriceElements = Array.from(el.querySelectorAll('.currency-coins, .coins, [class*="coin"]'));
          if (allPriceElements.length >= 2) {
            const prices = allPriceElements
              .map(pe => parseCoins(pe.textContent))
              .filter(p => p > 0)
              .sort((a, b) => a - b);
            if (prices.length >= 2 && prices[0] < sellPrice) {
              boughtFor = prices[0];
              console.log(`[FUT Content] Found potential buy price ${boughtFor} vs sell price ${sellPrice}`);
            }
          }
        }
        
        // Method 3: data attributes
        if (!boughtFor) {
          const buyPriceAttr = el.getAttribute('data-buy-price') || el.getAttribute('data-purchased-price');
          if (buyPriceAttr) boughtFor = parseCoins(buyPriceAttr);
        }

        items.push({ el, playerName, cardVersion, sellPrice, boughtFor });
      } catch (e) {
        console.error('[FUT Content] Error scraping row:', e);
      }
    }

    return items;
  }

  // Enhanced record building that combines JSON data with cached buy prices and DOM scraping
  function buildEnhancedClosedRecords() {
    if (!latestTradepile?.auctionInfo) return [];

    const closedAuctions = latestTradepile.auctionInfo.filter(
      (a) => String(a?.tradeState).toLowerCase() === 'closed'
    );

    const domRows = scrapeSoldRows();
    console.log(`[FUT Content] Found ${closedAuctions.length} closed auctions, ${domRows.length} DOM rows`);

    // Build a multimap by sold price for matching
    const byPrice = new Map();
    for (const a of closedAuctions) {
      const soldFor =
        typeof a.currentBid === 'number' && a.currentBid > 0
          ? a.currentBid
          : typeof a.buyNowPrice === 'number' && a.buyNowPrice > 0
          ? a.buyNowPrice
          : 0;
      const key = String(soldFor);
      if (!byPrice.has(key)) byPrice.set(key, []);
      byPrice.get(key).push(a);
    }

    const matched = [];
    const usedTradeIds = new Set();

    // 1) Price-based matching between DOM and JSON
    for (const row of domRows) {
      const list = byPrice.get(String(row.sellPrice)) || [];
      let auction = null;
      for (const a of list) {
        if (usedTradeIds.has(a.tradeId)) continue;
        auction = a;
        break;
      }
      if (auction) {
        usedTradeIds.add(auction.tradeId);
        matched.push({ auction, dom: row });
      }
    }

    // 2) Remaining auctions without DOM matches (use JSON data only)
    const remainingAuctions = closedAuctions.filter((a) => !usedTradeIds.has(a.tradeId));
    const remainingRows = domRows.filter((r) => !matched.some((x) => x.dom === r));
    const len = Math.min(remainingAuctions.length, remainingRows.length);
    
    for (let i = 0; i < len; i++) {
      matched.push({ auction: remainingAuctions[i], dom: remainingRows[i] });
      usedTradeIds.add(remainingAuctions[i].tradeId);
    }

    // Handle any remaining auctions without DOM matches
    for (const auction of remainingAuctions.slice(len)) {
      matched.push({ auction, dom: null });
    }

    // Build final records with enhanced buy price logic
    return matched.map(({ auction, dom }) => {
      const item = auction?.itemData || {};
      const itemId = item?.id != null ? String(item.id) : null;
      const assetId = item?.assetId != null ? String(item.assetId) : null;
      const tradeId = auction.tradeId != null ? String(auction.tradeId) : null;

      // Determine sell price
      const soldFor =
        typeof auction.currentBid === 'number' && auction.currentBid > 0
          ? auction.currentBid
          : typeof auction.buyNowPrice === 'number' && auction.buyNowPrice > 0
          ? auction.buyNowPrice
          : dom?.sellPrice || 0;

      // Enhanced buy price logic: DOM → Cache → JSON → 0
      let boughtFor = 0;
      
      if (dom?.boughtFor > 0) {
        boughtFor = dom.boughtFor;
      } else {
        // Try cached buy price
        const cachedPrice = getBought(itemId, assetId, tradeId);
        if (cachedPrice > 0) {
          boughtFor = cachedPrice;
        } else {
          // Fallback to JSON data - AVOID startingBid as it's listing price, not purchase price
          if (typeof item.purchasedPrice === 'number' && item.purchasedPrice > 0) {
            boughtFor = item.purchasedPrice;
          } else if (typeof item.lastSalePrice === 'number' && item.lastSalePrice > 0) {
            boughtFor = item.lastSalePrice;
          }
        }
      }

      // Enhanced player name: DOM → Cache → JSON extraction
      let playerName = 'Unknown Player';
      if (dom?.playerName && dom.playerName !== 'Unknown') {
        playerName = dom.playerName;
      } else {
        const cachedInfo = getPlayerInfo(itemId, assetId, tradeId);
        if (cachedInfo.playerName) {
          playerName = cachedInfo.playerName;
        } else {
          playerName = extractPlayerName(item, auction);
        }
      }

      // Use rating instead of card version for more reliable data
      const rating = item.rating || 0;

      const eaTax = Math.floor(soldFor * 0.05);
      const afterTax = soldFor - eaTax;
      const profit = afterTax - (boughtFor || 0);

      const record = {
        trade_id: auction?.tradeId,
        player_name: playerName,
        rating: rating,
        card_version: rating, // Using rating as version surrogate (DB expects text; SW maps)
        buy_price: boughtFor || 0,
        sell_price: soldFor || 0,
        after_tax: afterTax,
        profit: profit,
        timestamp_ms: Date.now(),
      };

      console.log(`[FUT Content] Enhanced record: ${playerName} (${rating}) | Buy: ${boughtFor} | Sell: ${soldFor} | Profit: ${profit}`);
      return record;
    });
  }

  function sendItem(record) {
    try {
      chrome.runtime.sendMessage({ type: 'SOLD_ITEM_DATA', data: record }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[FUT Content] Send error:', chrome.runtime.lastError);
        } else if (response?.success) {
          console.log(`[FUT Content] Successfully sent: ${record.player_name}`);
          addSessionTrade(record);
        } else if (response?.needsPremium) {
          // Show premium upgrade message
          toast('Premium subscription required for auto-logging', 'warning');
          console.warn('[FUT Content] Premium required:', response?.error);
        } else {
          console.warn('[FUT Content] Send failed:', response?.error);
        }
      });
    } catch (e) {
      console.error('[FUT Content] Send error:', e);
    }
  }

  function recordAllClosedEnhanced() {
    if (!latestTradepile?.auctionInfo) return 0;

    const records = buildEnhancedClosedRecords();
    if (!records.length) return 0;

    // De-dupe by tradeId
    const toSend = records.filter(
      (r) => r.trade_id && !processedTradeIds.has(r.trade_id)
    );
    
    // Mark as processed
    for (const r of toSend) processedTradeIds.add(r.trade_id);

    if (!toSend.length) return 0;

    // Log summary table
    try {
      console.table(
        toSend.map((r) => ({
          id: r.trade_id,
          name: r.player_name,
          version: r.card_version,
          buy: r.buy_price,
          sell: r.sell_price,
          profit: r.profit,
        }))
      );
    } catch {}

    // Send each record
    for (const rec of toSend) sendItem(rec);
    
    // Save any cache updates
    saveCache();
    
    return toSend.length;
  }

  // Enhanced toast function with different message types
  function toast(msg, type = 'success') {
    const el = document.createElement('div');
    
    let bgColor, textColor, icon;
    switch (type) {
      case 'warning':
        bgColor = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
        textColor = '#000';
        icon = '⚠️';
        break;
      case 'error':
        bgColor = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
        textColor = '#fff';
        icon = '❌';
        break;
      case 'premium':
        bgColor = 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)';
        textColor = '#fff';
        icon = '👑';
        break;
      default:
        bgColor = 'linear-gradient(135deg, #91db32 0%, #6fbf26 100%)';
        textColor = '#0e1a00';
        icon = '✅';
    }
    
    el.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 10000;
      background: ${bgColor};
      color: ${textColor};
      padding: 16px 24px;
      border-radius: 12px;
      font-size: 14px;
      font-weight: 700;
      box-shadow: 0 14px 40px rgba(0, 0, 0, 0.35);
      animation: slideInRight 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.2);
      max-width: 320px;
    `;
    
    // Add CSS animation if not already added
    if (!document.querySelector('#fut-toast-styles')) {
      const style = document.createElement('style');
      style.id = 'fut-toast-styles';
      style.textContent = `
        @keyframes slideInRight {
          from { transform: translateX(100%) scale(0.98); opacity: 0; }
          to   { transform: translateX(0)     scale(1.00); opacity: 1; }
        }
        @keyframes slideOutRight {
          from { transform: translateX(0)     scale(1.00); opacity: 1; }
          to   { transform: translateX(100%)  scale(0.98); opacity: 0; }
        }
      `;
      document.head.appendChild(style);
    }
    
    el.innerHTML = `
      <div style="display: flex; align-items: center; gap: 10px;">
        <span style="font-size: 18px;">${icon}</span>
        <span>${msg}</span>
      </div>
    `;
    
    document.body.appendChild(el);
    
    setTimeout(() => {
      el.style.animation = 'slideOutRight 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
      setTimeout(() => el.remove(), 400);
    }, type === 'warning' || type === 'error' ? 5000 : 3500);
  }

  // Enhanced button creation with premium status awareness
  function createRecordAndClear(nativeBtn) {
    if (!nativeBtn || nativeBtn.dataset.futRecordAttached === '1') return;
    const container = nativeBtn.parentElement || document.body;
    if (container.querySelector('[data-fut-record="1"]')) {
      nativeBtn.dataset.futRecordAttached = '1';
      return;
    }

    const btn = nativeBtn.cloneNode(true);
    nativeBtn.dataset.futRecordAttached = '1';
    btn.dataset.futRecord = '1';
    btn.textContent = 'Record & Clear';

    // Style the button
    const h = Math.max(32, nativeBtn.offsetHeight || 0);
    btn.style.cssText = `
      background: linear-gradient(135deg, #91db32 0%, #6fbf26 100%);
      border: none;
      color: #fff;
      height: ${h}px;
      padding: 0 20px;
      border-radius: ${Math.round(h / 2)}px;
      font-weight: 600;
      font-size: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      vertical-align: middle;
      align-self: center;
      cursor: pointer;
      transition: all 0.25s ease;
      margin-left: 12px;
      box-shadow: 0 6px 14px rgba(145, 219, 50, 0.35);
      text-transform: none;
      letter-spacing: 0.3px;
      position: relative;
      overflow: hidden;
    `;
    
    // Hover and focus effects
    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'translateY(-2px)';
      btn.style.boxShadow = '0 10px 20px rgba(145, 219, 50, 0.45)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'translateY(0)';
      btn.style.boxShadow = '0 6px 14px rgba(145, 219, 50, 0.35)';
    });

    btn.addEventListener(
      'click',
      async (e) => {
        e.preventDefault();
        e.stopPropagation();

        btn.textContent = 'Checking Premium...';
        btn.disabled = true;
        
        try {
          // Check premium status before processing
          await checkPremiumStatus();
          
          if (!premiumStatus.isPremium) {
            toast('Premium subscription required for auto-logging', 'premium');
            btn.textContent = '👑 Premium Required';
            btn.style.background = 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)';
            btn.style.boxShadow = '0 4px 15px rgba(139, 92, 246, 0.4)';
            
            // Add click handler to open premium page
            btn.onclick = () => {
              chrome.runtime.sendMessage({ type: 'OPEN_PREMIUM' });
            };
            
            setTimeout(() => {
              btn.textContent = 'Record & Clear';
              btn.style.background = 'linear-gradient(135deg, #91db32 0%, #6fbf26 100%)';
              btn.style.boxShadow = '0 6px 14px rgba(145, 219, 50, 0.35)';
              btn.disabled = false;
              btn.onclick = null;
            }, 4000);
            
            return;
          }

          btn.textContent = 'Processing...';
          const count = recordAllClosedEnhanced();

          // Click the native Clear Sold after logging
          setTimeout(() => {
            try {
              nativeBtn.click();
            } catch (error) {
              console.error('Clear button click failed:', error);
            }
          }, 200);

          if (count > 0) {
            toast(`Logged ${count} sale${count === 1 ? '' : 's'} successfully`);
            btn.textContent = `✓ Logged ${count}`;
            btn.style.background = 'linear-gradient(135deg, #91db32 0%, #6fbf26 100%)';
            btn.style.boxShadow = '0 10px 20px rgba(145, 219, 50, 0.45)';
          } else {
            toast('No new sold items found');
            btn.textContent = `⚠ No Items`;
            btn.style.background = '#f59e0b';
            btn.style.boxShadow = '0 4px 15px rgba(245, 158, 11, 0.4)';
          }
          
          setTimeout(() => {
            btn.textContent = 'Record & Clear';
            btn.style.background = 'linear-gradient(135deg, #91db32 0%, #6fbf26 100%)';
            btn.style.boxShadow = '0 6px 14px rgba(145, 219, 50, 0.35)';
            btn.disabled = false;
          }, 2000);
          
        } catch (error) {
          console.error('[FUT Content] Record and clear error:', error);
          
          if (error.message && error.message.includes('Premium')) {
            toast('Premium subscription required for auto-logging', 'premium');
            btn.textContent = '👑 Premium Required';
            btn.style.background = 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)';
            btn.style.boxShadow = '0 4px 15px rgba(139, 92, 246, 0.4)';
          } else {
            toast('Error occurred. Check console for details.', 'error');
            btn.textContent = '✗ Error';
            btn.style.background = '#ef4444';
            btn.style.boxShadow = '0 4px 15px rgba(239, 68, 68, 0.4)';
          }
          
          setTimeout(() => {
            btn.textContent = 'Record & Clear';
            btn.style.background = 'linear-gradient(135deg, #91db32 0%, #6fbf26 100%)';
            btn.style.boxShadow = '0 6px 14px rgba(145, 219, 50, 0.35)';
            btn.disabled = false;
          }, 3000);
        }
      },
      { capture: true }
    );

    try {
      // Keep it in the same row as the native button
      container.insertBefore(btn, nativeBtn.nextSibling);
    } catch {
      // If insertion fails, still append to the same container
      try {
        container.appendChild(btn);
      } catch (e) {
        console.warn('[FUT Content] Could not attach Record & Clear next to native button:', e);
      }
    }
  }

  function watchForClearSold() {
    let scheduled = false;
    const scan = () => {
      scheduled = false;
      const btn = Array.from(document.querySelectorAll('button,a')).find((b) =>
        /clear\s*sold/i.test(b.textContent || '')
      );
      if (btn) {
        console.log('[FUT Content] Found Clear Sold button, adding Record & Clear');
        createRecordAndClear(btn);
      }
    };
    
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(scan);
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
    requestAnimationFrame(scan);
    
    console.log('[FUT Content] Watching for Clear Sold button');
  }

  // Initialize premium status check on load
  setTimeout(() => {
    checkPremiumStatus();
  }, 2000);

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      watchForClearSold();
      watchForFairValueTargets();
      buildFutHubPanel();
    });
  } else {
    watchForClearSold();
    watchForFairValueTargets();
    buildFutHubPanel();
  }

  console.log('[FUT Content] Enhanced FUT Trader Hub content script loaded with Premium restrictions');
})();