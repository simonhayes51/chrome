// inject.js - Enhanced data extraction from EA API (Updated for FC26)
(function () {
  const lastPostAt = { ANY: 0 };
  const THROTTLE_MS = 500;

  function post(type, payload) {
    const now = Date.now();
    if (type === 'FUT_CACHE_ITEMS') {
      if (now - (lastPostAt.ANY || 0) < THROTTLE_MS) return;
      lastPostAt.ANY = now;
    }
    try { 
      window.postMessage({ type, payload }, '*'); 
      console.log(`[FUT Inject] Posted ${type}:`, payload);
    } catch (e) {
      console.error('[FUT Inject] Post error:', e);
    }
  }

  // Enhanced item data collection with better player name extraction
  function collectItems(node, out) {
    if (!node) return;
    if (Array.isArray(node)) { 
      for (const v of node) collectItems(v, out); 
      return; 
    }
    
    if (typeof node === 'object') {
      // Extract auction info with item data
      if (Array.isArray(node.auctionInfo)) {
        for (const a of node.auctionInfo) {
          if (a?.itemData) {
            const item = a.itemData;
            const auctionData = {
              ...item,
              // Include auction-specific data
              tradeId: a.tradeId,
              tradeState: a.tradeState,
              currentBid: a.currentBid,
              buyNowPrice: a.buyNowPrice, 
              startingBid: a.startingBid,
              expires: a.expires
            };
            out.push(auctionData);
          }
        }
      }
      
      // Direct item arrays
      if (Array.isArray(node.itemData)) out.push(...node.itemData);
      if (Array.isArray(node.items)) out.push(...node.items);
      
      // Single item with proper structure
      if (node.assetId && (node.rating || node.firstName || node.lastName || node.preferredName)) {
        out.push(node);
      }
      
      // Recursively search nested objects
      for (const k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        const v = node[k];
        if (v && typeof v === 'object') {
          collectItems(v, out);
        }
      }
    }
  }

  function extractPlayerName(item) {
    // Multiple strategies to get full player name
    console.log('[FUT Inject] Extracting name from item:', item);
    
    if (item.preferredName && item.preferredName.trim()) {
      console.log('[FUT Inject] Using preferredName:', item.preferredName);
      return item.preferredName.trim();
    }
    
    if (item.commonName && item.commonName.trim()) {
      console.log('[FUT Inject] Using commonName:', item.commonName);
      return item.commonName.trim();
    }
    
    // Build from first + last name
    const first = item.firstName ? item.firstName.trim() : '';
    const last = item.lastName ? item.lastName.trim() : '';
    
    if (first && last) {
      const fullName = `${first} ${last}`;
      console.log('[FUT Inject] Built full name:', fullName);
      return fullName;
    }
    if (last) {
      console.log('[FUT Inject] Using lastName only:', last);
      return last;
    }
    if (first) {
      console.log('[FUT Inject] Using firstName only:', first);
      return first;
    }
    
    // Try other possible name fields
    if (item.name && item.name.trim()) {
      console.log('[FUT Inject] Using name field:', item.name);
      return item.name.trim();
    }
    if (item.displayName && item.displayName.trim()) {
      console.log('[FUT Inject] Using displayName:', item.displayName);
      return item.displayName.trim();
    }
    
    // Check for nested player data
    if (item.player) {
      console.log('[FUT Inject] Checking nested player data');
      return extractPlayerName(item.player);
    }
    
    console.warn('[FUT Inject] No player name found in item:', item);
    return 'Unknown Player';
  }

  function normalizeCardType(item) {
    const itemType = item.itemType || item.type || '';
    const typeStr = String(itemType).toLowerCase();
    
    // Handle EA's specific card type codes
    if (typeStr.includes('totw') || typeStr.includes('if_')) return 'TOTW';
    if (typeStr.includes('icon')) return 'Icon';
    if (typeStr.includes('hero')) return 'Hero';
    if (typeStr.includes('ucl')) return 'UCL';
    if (typeStr.includes('special')) return 'Special';
    if (typeStr.includes('rare')) return 'Rare Gold';
    
    // Rating-based fallback
    const rating = Number(item.rating || 0);
    if (rating >= 75) return 'Gold';
    if (rating >= 65) return 'Silver';
    if (rating > 0) return 'Bronze';
    
    return 'Standard';
  }

  // The numeric id FUTHub's own market data (fair value, price history) is
  // keyed on is EA's card definition id - on the web app's own item JSON
  // this shows up under a few different field names depending on the
  // endpoint (search results vs tradepile vs club items). Try the known
  // candidates in order rather than betting on one; log which one hit so
  // a future EA API change is visible in the console instead of silently
  // going dark.
  function extractCardId(item) {
    const candidates = ['resourceId', 'definitionId', 'cardId', 'baseId'];
    for (const key of candidates) {
      const v = item?.[key];
      if (v != null && Number.isFinite(Number(v))) {
        return { cardId: Number(v), source: key };
      }
    }
    return { cardId: null, source: null };
  }

  function handleJson(url, json) {
    // UPDATED: Accept EA FC24/FC25/FC26 routes - now includes FC26
    if (!/\/ut\/game\/fc(24|25|26)\//i.test(url)) return;

    console.log(`[FUT Inject] Processing JSON from: ${url}`);
    console.log(`[FUT Inject] Full JSON response:`, json);
    
    const items = [];
    collectItems(json, items);
    
    if (items.length) {
      console.log(`[FUT Inject] Found ${items.length} items in API response`);
      console.log(`[FUT Inject] Raw items before processing:`, items);
      
      let cardIdSourceLogged = false;
      const processedItems = items.map((item, index) => {
        console.log(`[FUT Inject] Processing item ${index}:`, item);

        const { cardId, source } = extractCardId(item);
        if (source && !cardIdSourceLogged) {
          cardIdSourceLogged = true;
          console.log(`[FUT Inject] card_id resolved from field '${source}'`);
        }

        const processed = {
          // IDs for matching
          id: item?.id ?? null,
          assetId: item?.assetId ?? null,
          tradeId: item?.tradeId ?? null,
          cardId, // EA's card definition id - matches FUTHub's market data card_id

          // Player info - with detailed logging
          player_name: extractPlayerName(item),
          rating: item?.rating ?? null,
          card_version: normalizeCardType(item),
          
          // Price data - multiple possible sources
          purchasedPrice: item?.purchasedPrice ?? null,
          lastSalePrice: item?.lastSalePrice ?? item?.lastSoldPrice ?? item?.lastSaleAmount ?? null,
          currentBid: item?.currentBid ?? null,
          buyNowPrice: item?.buyNowPrice ?? null,
          startingBid: item?.startingBid ?? null,
          
          // Auction state
          tradeState: item?.tradeState ?? item?.state ?? null,
          expires: item?.expires ?? null,
          
          // Raw item for debugging
          _rawItem: item
        };
        
        console.log(`[FUT Inject] Processed item ${index}:`, processed);
        return processed;
      });
      
      post('FUT_CACHE_ITEMS', { items: processedItems });
    }

    // Send tradepile data separately for sale detection - UPDATED for FC26
    if (/\/ut\/game\/fc(24|25|26)\/tradepile/i.test(url)) {
      console.log('[FUT Inject] Tradepile data detected:', json);
      post('FUT_TRADEPILE', json);
    }
  }

  // Patch fetch with better error handling
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    
    try {
      const url = (typeof args[0] === 'string' ? args[0] : args[0]?.url) || '';
      const ct = res.headers.get('content-type') || '';
      
      // UPDATED: Include FC26 in URL pattern matching
      if (/\/ut\/game\/fc(24|25|26)\//i.test(url) && res.ok && ct.includes('application/json')) {
        console.log(`[FUT Inject] Intercepting API response: ${url}`);
        
        res.clone().json().then(json => {
          console.log(`[FUT Inject] JSON data:`, json);
          handleJson(url, json);
        }).catch(e => {
          console.error(`[FUT Inject] JSON parse error for ${url}:`, e);
        });
      }
    } catch (e) {
      console.error('[FUT Inject] Fetch patch error:', e);
    }
    
    return res;
  };

  // Patch XHR with better logging
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.addEventListener('load', () => {
      try {
        if (this.status < 200 || this.status >= 300) return;
        const ct = this.getResponseHeader?.('content-type') || '';
        
        // UPDATED: Include FC26 in URL pattern matching
        if (/\/ut\/game\/fc(24|25|26)\//i.test(url) && ct.includes('application/json')) {
          console.log(`[FUT Inject] XHR response from: ${url}`);
          const jsonData = JSON.parse(this.responseText);
          console.log(`[FUT Inject] XHR JSON:`, jsonData);
          handleJson(url, jsonData);
        }
      } catch (e) {
        console.error(`[FUT Inject] XHR handler error:`, e);
      }
    });
    return origOpen.call(this, method, url, ...rest);
  };

  console.log('[FUT Inject] Enhanced API interception active - now supporting FC26');
})();