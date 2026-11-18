/**
 * MAGYX search overlay (sections/mgx-search.liquid), after qcollectionparfums.nl.
 *
 * - Opens from any [data-mgx-search-open] (snippets/mgx-search-trigger.liquid): one capture-phase
 *   click listener on the document. Triggers are <a href="/search">, so without JS (or with a
 *   modifier key) they still lead to the search page.
 * - Products come from /collections/all?view=mgx-search-index (templates/collection.mgx-search-
 *   index.liquid), fetched once on first intent (pointer, touch or focus on a trigger, or the open
 *   itself) and kept in sessionStorage for 30 minutes. Typing then needs no network: every input
 *   event scores all products with window.mgxSearchCore (assets/mgx-search-core.js).
 * - The phone's back button closes it (history entry), Esc and the X too; the query is kept for the
 *   next open. Arrow keys move the highlighted row, Enter opens it (or the full results page).
 * - Fires mgx:search:open / mgx:search:close on document and sets html.mgx-search-open while open.
 *
 * window.mgxSearch = { open(opener?), close() }
 */
(() => {
  if (window.mgxSearch) return;

  const INDEX_KEY = 'mgxSearchIndex:v1';
  const QUERY_KEY = 'mgxSearchQuery:v1';
  const INDEX_TTL = 30 * 60 * 1000;
  const MAX_ROWS = 20;

  const designMode = () => !!(window.Shopify && window.Shopify.designMode);
  const getRoot = () => document.querySelector('[data-mgx-search]');
  const fill = (template, values) =>
    String(template || '').replace(/\[(count|query)\]/g, (_, key) => (key in values ? values[key] : ''));
  const escapeHtml = (value) =>
    String(value == null ? '' : value).replace(
      /[&<>"']/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
    );
  const store = (method, key, value) => {
    try {
      return method === 'get' ? window.sessionStorage.getItem(key) : window.sessionStorage.setItem(key, value);
    } catch (e) {
      return null;
    }
  };

  const state = {
    open: false,
    pushed: false, // our history entry is (or should be) on top
    restored: false, // opened because the page loaded on our history entry (reload, no bfcache)
    skipPop: 0,
    opener: null,
    prevOverflow: '',
    query: '',
    hits: [],
    active: -1,
  };

  // ---------- elements ----------
  let ui = null;
  const getUi = () => {
    const root = getRoot();
    if (!root) return null;
    if (ui && ui.root === root) return ui;
    ui = {
      root,
      input: root.querySelector('.mgx-search__input'),
      clear: root.querySelector('[data-mgx-search-clear]'),
      start: root.querySelector('[data-mgx-search-start]'),
      results: root.querySelector('[data-mgx-search-results]'),
      msg: root.querySelector('[data-mgx-search-msg]'),
      list: root.querySelector('[data-mgx-search-list]'),
      all: root.querySelector('[data-mgx-search-all]'),
      emptyCats: root.querySelector('[data-mgx-search-empty]'),
      status: root.querySelector('[data-mgx-search-status]'),
      text: root.dataset,
    };
    if (!ui.input || !ui.list || !ui.results || !ui.start) {
      ui = null;
      return null;
    }
    bind(ui);
    return ui;
  };

  // ---------- index ----------
  let items = null;
  let loading = null;
  let failed = false;

  // The index carries formatted prices, so a cached copy is only valid for the same currency,
  // language and market.
  const cacheKey = (url) => {
    const shop = window.Shopify || {};
    const currency = (shop.currency && shop.currency.active) || '';
    return [url, currency, shop.locale || '', shop.country || ''].join('|');
  };

  const readCache = (key) => {
    try {
      const data = JSON.parse(store('get', INDEX_KEY) || 'null');
      if (data && data.k === key && Array.isArray(data.items) && Date.now() - data.t < INDEX_TTL) return data.items;
    } catch (e) {}
    return null;
  };

  const onIndexSettled = () => {
    if (state.open && ui && ui.input.value.trim()) render();
  };

  const loadIndex = () => {
    if (items) return Promise.resolve(items);
    if (loading) return loading;
    if (failed) return Promise.reject(new Error('mgx-search: index failed'));
    const root = getRoot();
    const url = root && root.dataset.indexUrl;
    if (!url) return Promise.reject(new Error('mgx-search: no index url'));
    const key = cacheKey(url);
    const cached = readCache(key);
    if (cached) {
      items = cached;
      onIndexSettled();
      return Promise.resolve(items);
    }
    loading = fetch(url, { credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) throw new Error(`mgx-search: index HTTP ${response.status}`);
        return response.text();
      })
      .then((body) => {
        const data = JSON.parse(body);
        if (!data || !Array.isArray(data.items)) throw new Error('mgx-search: unexpected index');
        // Cached before any scoring, so the memoised haystacks (item._hay) never go into storage.
        store('set', INDEX_KEY, JSON.stringify({ t: Date.now(), k: key, items: data.items }));
        items = data.items;
        loading = null;
        onIndexSettled();
        return items;
      })
      .catch((error) => {
        loading = null;
        failed = true;
        onIndexSettled();
        throw error;
      });
    return loading;
  };

  const prefetch = () => {
    if (items || loading) return;
    loadIndex().catch(() => {});
  };

  // ---------- highlighting ----------
  // Folds one character the way mgx-search-core folds text (umlauts to ae/oe/ue/ss or plain,
  // accents off, apostrophes dropped, anything else non-alphanumeric to a space), so the bold
  // parts can be mapped back onto the original title.
  const UMLAUTS = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' };
  const foldChar = (ch, umlauts) => {
    let text = ch.toLowerCase();
    if (/['’`]/.test(text)) return '';
    if (umlauts) text = text.replace(/[äöüß]/g, (letter) => UMLAUTS[letter]);
    try {
      text = text.normalize('NFD').replace(/[̀-ͯ]/g, '');
    } catch (e) {}
    return text
      .replace(/ß/g, 'ss')
      .replace(/æ/g, 'ae')
      .replace(/œ/g, 'oe')
      .replace(/ø/g, 'o')
      .replace(/[^a-z0-9]/g, ' ');
  };

  const foldMap = (text, umlauts) => {
    let folded = '';
    const starts = [];
    const ends = [];
    for (let i = 0; i < text.length; ) {
      const ch = String.fromCodePoint(text.codePointAt(i));
      const out = foldChar(ch, umlauts);
      for (let k = 0; k < out.length; k += 1) {
        folded += out[k];
        starts.push(i);
        ends.push(i + ch.length);
      }
      i += ch.length;
    }
    return { folded, starts, ends };
  };

  // Same rules as the matcher: numbers as whole numbers (leading zeros ignored), terms up to 3
  // letters at a word start, longer terms anywhere.
  const hitsIn = (folded, term) => {
    const found = [];
    if (/^\d+$/.test(term)) {
      const digits = /\d+/g;
      let match = digits.exec(folded);
      while (match) {
        if (match[0].replace(/^0+(?=\d)/, '') === term) found.push([match.index, match.index + match[0].length]);
        match = digits.exec(folded);
      }
      return found;
    }
    let at = folded.indexOf(term);
    while (at > -1) {
      if (term.length > 3 || at === 0 || folded[at - 1] === ' ') found.push([at, at + term.length]);
      at = folded.indexOf(term, at + 1);
    }
    return found;
  };

  const highlight = (value, terms) => {
    let text = String(value == null ? '' : value);
    try {
      text = text.normalize('NFC');
    } catch (e) {}
    if (!text || !terms.length) return escapeHtml(text);
    const ranges = [];
    [true, false].forEach((umlauts) => {
      const { folded, starts, ends } = foldMap(text, umlauts);
      terms.forEach((term) => {
        if (term) hitsIn(folded, term).forEach(([from, to]) => ranges.push([starts[from], ends[to - 1]]));
      });
    });
    if (!ranges.length) return escapeHtml(text);
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    ranges.forEach(([from, to]) => {
      const last = merged[merged.length - 1];
      if (last && from <= last[1]) last[1] = Math.max(last[1], to);
      else merged.push([from, to]);
    });
    let html = '';
    let pos = 0;
    merged.forEach(([from, to]) => {
      html += `${escapeHtml(text.slice(pos, from))}<mark>${escapeHtml(text.slice(from, to))}</mark>`;
      pos = to;
    });
    return html + escapeHtml(text.slice(pos));
  };

  // ---------- rendering ----------
  const viewAllUrl = (shown) => {
    const base = (ui && ui.text.searchUrl) || '/search';
    return `${base}?q=${encodeURIComponent(shown)}&options%5Bprefix%5D=last`;
  };

  const setStatus = (line) => {
    if (ui && ui.status && ui.status.textContent !== line) ui.status.textContent = line;
  };

  const setActive = (index, scroll) => {
    if (!ui) return;
    const rows = ui.list.children;
    const previous = rows[state.active];
    if (previous) {
      previous.classList.remove('is-active');
      previous.setAttribute('aria-selected', 'false');
    }
    state.active = index >= 0 && index < rows.length ? index : -1;
    const row = rows[state.active];
    if (row) {
      row.classList.add('is-active');
      row.setAttribute('aria-selected', 'true');
      ui.input.setAttribute('aria-activedescendant', row.id);
      if (scroll) row.scrollIntoView({ block: 'nearest' });
    } else {
      ui.input.removeAttribute('aria-activedescendant');
    }
  };

  const rowHtml = (item, index, terms) => {
    const id = `${ui.list.id}-opt-${index}`;
    const image = item.image
      ? `<img src="${escapeHtml(item.image)}" alt="" width="56" height="56" decoding="async"${
          index > 7 ? ' loading="lazy"' : ''
        }>`
      : '';
    const inspiration = item.inspiration
      ? `<span class="mgx-search__insp">${escapeHtml(ui.text.inspiredLabel || '')} ${highlight(
          item.inspiration,
          terms
        )}</span>`
      : '';
    const was = item.compare ? `<s class="mgx-search__was">${escapeHtml(item.compare)}</s>` : '';
    return (
      `<li class="mgx-search__row" id="${id}" role="option" aria-selected="false" data-index="${index}">` +
      `<a class="mgx-search__link" href="${escapeHtml(item.url)}" tabindex="-1">` +
      `<span class="mgx-search__thumb">${image}</span>` +
      `<span class="mgx-search__text"><span class="mgx-search__title">${highlight(item.title, terms)}</span>${inspiration}</span>` +
      `<span class="mgx-search__price"><span class="mgx-search__now">${escapeHtml(item.price)}</span>${was}</span>` +
      '</a></li>'
    );
  };

  const showRows = (html) => {
    ui.list.innerHTML = html;
    state.active = -1;
    ui.input.setAttribute('aria-expanded', html ? 'true' : 'false');
    if (!html) ui.input.removeAttribute('aria-activedescendant');
  };

  function render() {
    if (!getUi()) return;
    const raw = ui.input.value;
    const shown = raw.trim();
    state.query = raw;
    store('set', QUERY_KEY, raw);
    if (ui.clear) ui.clear.hidden = !raw;
    const core = window.mgxSearchCore;
    const query = core ? core.parseQuery(raw) : { terms: shown ? [shown] : [], compact: '' };
    state.hits = [];

    if (!query.terms.length) {
      ui.start.hidden = false;
      ui.results.hidden = true;
      showRows('');
      setStatus('');
      return;
    }

    ui.start.hidden = true;
    ui.results.hidden = false;
    ui.all.href = viewAllUrl(shown);
    ui.all.textContent = fill(ui.text.viewAllLabel, { query: shown });
    if (ui.emptyCats) ui.emptyCats.hidden = true;

    // The index failed (or the matcher is missing): only the way to the full results page.
    if (!core || (!items && failed)) {
      showRows('');
      ui.msg.hidden = true;
      ui.all.hidden = false;
      setStatus('');
      return;
    }

    if (!items) {
      showRows('');
      ui.msg.textContent = ui.text.loadingText || '';
      ui.msg.hidden = false;
      ui.all.hidden = true;
      setStatus(ui.text.loadingText || '');
      prefetch();
      return;
    }

    const scored = [];
    items.forEach((item, order) => {
      const points = core.score(item, query);
      if (points > 0) scored.push([points, order, item]);
    });
    // Score first, then title (as the plan ranks), then catalogue order.
    scored.sort((a, b) => b[0] - a[0] || byTitle(a[2], b[2]) || a[1] - b[1]);
    state.hits = scored.slice(0, MAX_ROWS).map((entry) => entry[2]);

    if (!state.hits.length) {
      showRows('');
      const line = fill(ui.text.emptyText, { query: shown });
      ui.msg.textContent = line;
      ui.msg.hidden = false;
      ui.all.hidden = true;
      if (ui.emptyCats) ui.emptyCats.hidden = false;
      setStatus(line);
      return;
    }

    ui.msg.hidden = true;
    ui.all.hidden = false;
    showRows(state.hits.map((item, index) => rowHtml(item, index, query.terms)).join(''));
    setActive(0, false);
    setStatus(fill(ui.text.countText, { count: scored.length }));
  }

  const go = (url) => {
    if (url) window.location.assign(url);
  };

  let collator = null;
  try {
    collator = new Intl.Collator('de');
  } catch (e) {}
  function byTitle(a, b) {
    const x = String((a && a.title) || '');
    const y = String((b && b.title) || '');
    return collator ? collator.compare(x, y) : x < y ? -1 : x > y ? 1 : 0;
  }

  // ---------- open / close ----------
  // The phone menu (Dawn's header-drawer) closes first, so its focus trap and scroll lock are gone
  // before the overlay takes over.
  const closeHeaderDrawer = () => {
    document.querySelectorAll('header-drawer, menu-drawer').forEach((drawer) => {
      const details = drawer.querySelector('details');
      if (!details || !details.hasAttribute('open')) return;
      const summary = details.querySelector('summary');
      try {
        drawer.closeMenuDrawer(new CustomEvent('mgx:search:open'), summary);
      } catch (e) {
        details.classList.remove('menu-opening');
        details.removeAttribute('open');
        document.body.classList.remove('overflow-hidden-tablet', 'overflow-hidden-desktop', 'overflow-hidden-mobile');
      }
      if (summary) summary.setAttribute('aria-expanded', 'false');
    });
  };

  // A trigger inside a closed menu cannot take focus; the caller then tries the next target.
  const focusBack = (el) => {
    if (!el || !el.isConnected || typeof el.focus !== 'function') return false;
    el.focus({ preventScroll: true });
    return document.activeElement === el;
  };

  const open = (opener, options = {}) => {
    if (!getUi()) return false;
    if (state.open) {
      if (options.focus !== false) ui.input.focus({ preventScroll: true });
      return true;
    }
    closeHeaderDrawer();
    state.opener = opener || (document.activeElement !== document.body ? document.activeElement : null);
    state.open = true;
    ui.root.hidden = false;
    state.prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.classList.add('mgx-search-open');
    if (!ui.input.value && state.query) ui.input.value = state.query;
    // Focus in the same tap, so the phone keyboard comes up (iOS ignores focus() after a delay).
    if (options.focus !== false) {
      ui.input.focus({ preventScroll: true });
      try {
        const end = ui.input.value.length;
        ui.input.setSelectionRange(end, end);
      } catch (e) {}
    }
    // A failed index is tried again on every open; reset first, so a kept query shows the
    // loading line instead of the failure state while it loads.
    if (failed) failed = false;
    prefetch();
    render();
    if (options.fromHistory) {
      state.pushed = true;
    } else if (!designMode()) {
      try {
        window.history.pushState({ mgxSearch: true }, '');
        state.pushed = true;
      } catch (e) {
        state.pushed = false;
      }
    }
    window.requestAnimationFrame(() => {
      if (state.open && ui) ui.root.classList.add('is-visible');
    });
    document.dispatchEvent(new CustomEvent('mgx:search:open'));
    return true;
  };

  const close = (options = {}) => {
    if (!state.open) return;
    state.open = false;
    if (ui) {
      ui.root.classList.remove('is-visible');
      ui.root.hidden = true;
    }
    document.body.style.overflow = state.prevOverflow;
    document.documentElement.classList.remove('mgx-search-open');

    const onOurEntry = !!(window.history.state && window.history.state.mgxSearch);
    if (!options.fromHistory && state.pushed && onOurEntry) {
      if (state.restored) {
        // The page was reloaded on our entry, so the entry below belongs to an older document and
        // going back would reload the page: mark this entry as "closed" instead.
        try {
          window.history.replaceState(null, '');
        } catch (e) {}
      } else {
        state.skipPop += 1;
        window.history.back();
      }
    }
    state.pushed = false;
    state.restored = false;

    if (!options.keepFocus) {
      const opener = state.opener;
      if (!focusBack(opener)) {
        // Opened from the phone menu, which is closed now: back to the menu button.
        const drawer = opener && opener.closest && opener.closest('header-drawer, menu-drawer');
        focusBack(drawer && drawer.querySelector('summary'));
      }
    }
    state.opener = null;
    document.dispatchEvent(new CustomEvent('mgx:search:close'));
  };

  // ---------- events inside the overlay ----------
  const focusables = (root) =>
    [...root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]')].filter(
      (el) => el.tabIndex > -1 && el.getClientRects().length > 0
    );

  const onInputKeydown = (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    const count = state.hits.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!count) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      let next = state.active + step;
      if (next >= count) next = 0;
      if (next < 0) next = count - 1;
      setActive(next, true);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const hit = state.hits[state.active];
      if (hit) go(hit.url);
      else if (ui.input.value.trim()) go(viewAllUrl(ui.input.value.trim()));
    }
  };

  const onRootKeydown = (event) => {
    if (event.key === 'Escape' || event.key === 'Esc') {
      // Also stops type="search" from clearing the field: the query is kept for the next open.
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      const list = focusables(ui.root);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !ui.root.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !ui.root.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const onRootClick = (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    if (target.closest('[data-mgx-search-close]')) {
      event.preventDefault();
      close();
      return;
    }
    if (target.closest('[data-mgx-search-clear]')) {
      event.preventDefault();
      ui.input.value = '';
      render();
      ui.input.focus({ preventScroll: true });
      return;
    }
    const term = target.closest('[data-mgx-search-term]');
    if (term) {
      event.preventDefault();
      ui.input.value = term.dataset.mgxSearchTerm || term.textContent.trim();
      render();
      ui.input.focus({ preventScroll: true });
      try {
        const end = ui.input.value.length;
        ui.input.setSelectionRange(end, end);
      } catch (e) {}
      return;
    }
    // A click on the grey field around the input puts the caret in it.
    if (target.closest('.mgx-search__field') && target !== ui.input) ui.input.focus({ preventScroll: true });
  };

  const onRootMousemove = (event) => {
    const row = event.target && event.target.closest && event.target.closest('.mgx-search__row');
    if (!row) return;
    const index = Number(row.dataset.index);
    if (index !== state.active) setActive(index, false);
  };

  function bind(refs) {
    if (refs.root.dataset.mgxSearchReady) return;
    refs.root.dataset.mgxSearchReady = '1';
    refs.input.addEventListener('input', render);
    refs.input.addEventListener('keydown', onInputKeydown);
    refs.root.addEventListener('keydown', onRootKeydown);
    refs.root.addEventListener('click', onRootClick);
    refs.root.addEventListener('mousemove', onRootMousemove);
  }

  // ---------- page-level listeners ----------
  // Every trigger, wherever it is (header pill, icon, phone row, menu drawer, buttons in sections).
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      const trigger = target && target.closest && target.closest('[data-mgx-search-open]');
      if (!trigger) return;
      // Modified clicks open /search in a new tab, as the link says.
      if (event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!getUi()) return;
      event.preventDefault();
      open(trigger);
    },
    true
  );

  // Start loading the index as soon as a shopper is about to open the search.
  const onIntent = (event) => {
    if (items || loading) return;
    const target = event.target;
    if (target && target.closest && target.closest('[data-mgx-search-open]')) prefetch();
  };
  document.addEventListener('pointerenter', onIntent, { capture: true, passive: true });
  document.addEventListener('touchstart', onIntent, { capture: true, passive: true });
  document.addEventListener('focusin', onIntent, true);

  // Focus that lands outside the open overlay comes back to the field.
  document.addEventListener('focusin', (event) => {
    if (!state.open || !ui || designMode()) return;
    if (event.target instanceof Node && !ui.root.contains(event.target)) ui.input.focus({ preventScroll: true });
  });

  // Steps onto or off our own entry only open or close the overlay; other popstate listeners
  // (Dawn's facets.js on /search and collections, loaded after this file) must not see them, or
  // forward onto our entry (state without searchParams) re-renders the grid unfiltered.
  window.addEventListener('popstate', (event) => {
    if (state.skipPop > 0) {
      state.skipPop -= 1;
      event.stopImmediatePropagation();
      return;
    }
    const entry = event.state;
    if (entry && entry.mgxSearch) {
      if (!state.open) open(null, { fromHistory: true, focus: false });
      event.stopImmediatePropagation();
    } else if (state.open) {
      close({ fromHistory: true });
      event.stopImmediatePropagation();
    }
  });

  // The matcher can arrive after this file (it is shared with the collection search bar).
  document.addEventListener('mgx:search-core:ready', () => {
    if (state.open && ui && ui.input.value.trim()) render();
  });

  // ---------- theme editor ----------
  const holdsOverlay = (node) => !!(node && node.querySelector && node.querySelector('[data-mgx-search]'));

  document.addEventListener('shopify:section:unload', (event) => {
    if (!holdsOverlay(event.target)) return;
    if (state.open) close({ fromHistory: true, keepFocus: true });
    ui = null;
  });

  document.addEventListener('shopify:section:load', (event) => {
    if (!holdsOverlay(event.target)) return;
    const wasOpen = state.open;
    if (wasOpen) {
      state.open = false;
      document.body.style.overflow = state.prevOverflow;
      document.documentElement.classList.remove('mgx-search-open');
    }
    ui = null;
    if (!getUi()) return;
    if (state.query) ui.input.value = state.query;
    // No focus: the merchant is typing in the editor's sidebar.
    if (wasOpen) open(null, { fromHistory: true, focus: false });
  });

  document.addEventListener('shopify:section:select', (event) => {
    if (holdsOverlay(event.target)) open(null, { focus: false });
  });

  document.addEventListener('shopify:section:deselect', (event) => {
    if (holdsOverlay(event.target)) close({ fromHistory: true, keepFocus: true });
  });

  document.addEventListener('shopify:block:select', (event) => {
    const block = event.target;
    if (!block || !block.closest || !block.closest('[data-mgx-search]')) return;
    if (state.open && ui && ui.input.value) {
      // Show the "before typing" screen, where the blocks are.
      ui.input.value = '';
      render();
    }
    open(null, { focus: false });
    if (block.scrollIntoView) block.scrollIntoView({ block: 'nearest' });
  });

  // ---------- start ----------
  const start = () => {
    if (!getUi()) return;
    // The page was reloaded (or restored without bfcache) on our history entry: show the overlay
    // again with the last query, so the next back press closes it as expected.
    const entry = window.history.state;
    if (entry && entry.mgxSearch && !designMode() && !state.open) {
      state.query = store('get', QUERY_KEY) || '';
      if (open(null, { fromHistory: true, focus: false })) state.restored = true;
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.mgxSearch = {
    open: (opener) => open(opener || null),
    close: () => close(),
  };
})();
