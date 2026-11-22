/* gg-builder.js: <gg-builder> of the Gift Guide (sections/gg-bundle-builder.liquid). Vanilla, no Alpine.
   Visual layer over the store's automatic quantity discount: every tap puts a 50 ml bottle straight into the cart,
   Shopify applies the discount, this file only reads the cart back and shows count, step, saving and next step.
   Data: <script data-gg-config> { steps:[{min,pct}], qualify:[product ids of the discount collections], wrap, t }
         <script data-gg-pool> [ { v:"50ml variant id", pid, n, t, i, o, f, g, b, w, p, img, c } ] in collection order
   Counted bottle = cart line without _bundle_items / _free_product, not the packaging, whose product is in `qualify`
   or that Shopify already discounted. Saving = original_line_price - final_line_price of those lines (real cart).
   Cart writes run one after another (queue) so fast taps never race; the header bubble is re-rendered after each,
   additions never open the drawer (the sticky bar's cart icon does). Listens to the theme's cartUpdate (drawer edits) and 'gg:preset'.
   tryscent.co: texts come from the hidden [data-gg-texts] divs (Weglot translates page text, never JS text), config "t" is
   the fallback; Insureful's switch only exists in the drawer once the cart has items (syncIns re-checks after each change);
   checkout goes through Subscribfy's guest link in the drawer. */
(function () {
  'use strict';
  if (!window.customElements || window.customElements.get('gg-builder')) return;

  var root = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';

  function fill(str, map) {
    return String(str || '').replace(/\[(\w+)\]/g, function (m, k) {
      return Object.prototype.hasOwnProperty.call(map, k) ? String(map[k]) : m;
    });
  }

  function norm(s) {
    var out = String(s || '').toLowerCase().replace(/ß/g, 'ss');
    if (out.normalize) out = out.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return out;
  }

  /* A Shopify money format ("{{amount_with_comma_separator}} kr SEK") applied to cents, the same rules as
     shopFormat in assets/gg-core.js (not exported there). Used for the drawer-style totals (money_with_currency,
     ",00" kept like the drawer) and as the fallback when gg-core.js is missing. */
  function shopFormat(cents, f) {
    var m = f ? String(f).match(/\{\{\s*(\w+)\s*\}\}/) : null;
    if (!m) return null;
    var key = m[1];
    var dec = key.indexOf('no_decimals') > -1 ? 0 : 2;
    var th = ',';
    var ds = '.';
    if (key.indexOf('comma_separator') > -1) { th = '.'; ds = ','; }
    else if (key.indexOf('space_separator') > -1) { th = ' '; ds = ','; }
    else if (key.indexOf('apostrophe_separator') > -1) { th = "'"; ds = '.'; }
    var parts = (Math.round(Number(cents) || 0) / 100).toFixed(dec).split('.');
    var whole = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, th);
    return String(f).replace(m[0], whole + (dec ? ds + parts[1] : ''));
  }

  /* Money in the shopper's currency: the section renders 123456789 cents through Liquid's money /
     money_with_currency ("1.234.567,89 kr", "1.234.567,89 DKK"), this reads its separators and affixes */
  var SAMPLE_RE = /^(.*?)1(\D?)234(\D?)567(\D?)89(.*)$/;
  function parseSample(s) {
    var m = SAMPLE_RE.exec(String(s || ''));
    return m ? { pre: m[1], th: m[2], ds: m[4], suf: m[5] } : null;
  }
  function sampleFormat(cents, f) {
    var parts = (Math.round(Number(cents) || 0) / 100).toFixed(2).split('.');
    return f.pre + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, f.th) + f.ds + parts[1] + f.suf;
  }
  var FMT = null;
  var FMT_CUR = null;

  /* Amounts never break across lines ("54 kr" stays together); ",00" trimmed like GG.money */
  function money(cents) {
    var out;
    if (FMT) out = sampleFormat(cents, FMT).replace(/[.,]00(?=\D*$)/, '');
    else if (window.GG && typeof window.GG.money === 'function') out = window.GG.money(cents);
    else out = shopFormat(cents, window.ggMoneyFormat) || String(Math.round(cents) / 100);
    return String(out).replace(/ /g, ' ');
  }

  /* money_with_currency, decimals kept, as the drawer prints it ("429,98 SEK") */
  function moneyCur(cents, fallbackFormat) {
    var txt = FMT_CUR ? sampleFormat(cents, FMT_CUR) : shopFormat(cents, fallbackFormat);
    return txt === null ? money(cents) : String(txt).replace(/ /g, ' ');
  }

  /* Kite-style track: markers centred in equal columns; the fill runs from 0 to the first marker, then marker to
     marker, and to the end once the last one is reached */
  function trackPos(stops, v) {
    var n = stops.length;
    if (!n || v <= 0) return 0;
    var seg = 100 / n;
    var prevAt = 0;
    var prevV = 0;
    for (var i = 0; i < n; i++) {
      var at = seg * (i + 0.5);
      if (v < stops[i]) return prevAt + (at - prevAt) * (v - prevV) / Math.max(1, stops[i] - prevV);
      prevAt = at;
      prevV = stops[i];
    }
    return 100;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function readJSON(root, sel, fallback) {
    var s = root.querySelector(sel);
    if (!s) return fallback;
    try {
      return JSON.parse(s.textContent);
    } catch (e) {
      if (window.console) console.warn('gg-builder: bad JSON in ' + sel, e);
      return fallback;
    }
  }

  function postJSON(url, body) {
    return fetch(root + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok || data.status) throw new Error(data.description || data.message || 'cart');
        return data;
      });
    });
  }

  var GENDERS = ['all', 'unisex', 'male', 'female'];

  class GGBuilder extends HTMLElement {
    connectedCallback() {
      if (this._ready) {
        /* Moved in the DOM (theme editor reorder): state and listeners are intact, only re-attach the window ones */
        if (this._onPreset) window.addEventListener('gg:preset', this._onPreset);
        if (this._onScroll) window.addEventListener('scroll', this._onScroll, { passive: true });
        return;
      }
      this._ready = true;

      this.cfg = readJSON(this, 'script[data-gg-config]', null) || { steps: [], t: {} };
      this.t = this.readTexts(this.cfg.t || {});
      FMT = parseSample(this.cfg.moneySample);
      FMT_CUR = parseSample(this.cfg.moneySampleCur);
      this.steps = (this.cfg.steps || []).slice().sort(function (a, b) { return a.min - b.min; });
      this.qualify = {};
      var self = this;
      (this.cfg.qualify || []).forEach(function (id) { self.qualify[String(id)] = true; });

      var pool = readJSON(this, 'script[data-gg-pool]', []) || [];
      this.byId = {};
      var best = [];
      var rest = [];
      pool.forEach(function (it) {
        if (!it || !it.v || self.byId[it.v]) return;
        it.v = String(it.v);
        it.fams = String(it.f || '')
          .split(',')
          .map(function (x) { return x.trim(); })
          .filter(Boolean);
        it.hay = norm([it.n, 'nr ' + it.n, 'nr. ' + it.n, it.t, it.i, it.o, it.fams.join(' ')].join(' '));
        self.byId[it.v] = it;
        (it.b ? best : rest).push(it);
      });
      /* Bestsellers first, then the rest, both in collection order */
      this.order = best.concat(rest);
      this.pinned = [];

      this.cart = { items: [] };
      this.queue = Promise.resolve();
      this.pending = 0;
      this.q = '';
      this.gender = 'all';
      this.family = '';
      this.rows = {};
      this.pageSize = Math.max(4, Number(this.cfg.pageSize) || 12);
      this.limit = this.pageSize;

      this.$ = {
        list: this.querySelector('[data-list]'),
        count: this.querySelector('[data-count]'),
        q: this.querySelector('[data-q]'),
        gGroup: this.querySelector('[data-g-group]'),
        fGroup: this.querySelector('[data-f-group]'),
        fList: this.querySelector('[data-f-list]'),
        sum: this.querySelector('[data-sum]'),
        of: this.querySelector('[data-of]'),
        status: this.querySelector('[data-status]'),
        saving: this.querySelector('[data-saving]'),
        fills: Array.prototype.slice.call(this.querySelectorAll('[data-steps-fill]')),
        marks: Array.prototype.slice.call(this.querySelectorAll('[data-step-min]')),
        picked: this.querySelector('[data-picked]'),
        addons: this.querySelector('[data-addons]'),
        wrap: this.querySelector('[data-wrap]'),
        chips: Array.prototype.slice.call(this.querySelectorAll('[data-set-variant]')),
        more: this.querySelector('[data-more]'),
        cta: this.querySelector('[data-cta]'),
        err: this.querySelector('[data-err]'),
        bar: this.querySelector('[data-bar]'),
        barCta: this.querySelector('[data-bar-cta]'),
        goals: this.querySelector('[data-goals]'),
        goalsFill: this.querySelector('[data-goals-fill]'),
        goalsList: this.querySelector('[data-goals-list]'),
        goalStatus: this.querySelector('[data-goal-status]'),
        added: Array.prototype.slice.call(this.querySelectorAll('[data-bb-added]')),
        insRow: this.querySelector('[data-ins-row]'),
        ins: this.querySelector('[data-ins]'),
        totals: this.querySelector('[data-totals]'),
        totSubRow: this.querySelector('[data-tot-sub-row]'),
        totOffRow: this.querySelector('[data-tot-off-row]'),
        totSub: this.querySelector('[data-tot-sub]'),
        totOff: this.querySelector('[data-tot-off]'),
        totTotal: this.querySelector('[data-tot-total]')
      };
      this.goals = [];

      this.buildFamilies();
      this.initGenders();
      this.bind();
      this.renderList();
      this.renderSummary();
      this.classList.add('is-ready');
      this.loadCart();
      this.startGoals(0);
      this.startIns(0);
    }

    /* Strings the JS writes: the hidden page text (translated by Weglot on da / fi / no) over the config fallback */
    readTexts(fallback) {
      var t = {};
      Object.keys(fallback).forEach(function (k) { t[k] = fallback[k]; });
      Array.prototype.forEach.call(this.querySelectorAll('[data-gg-texts] [data-k]'), function (d) {
        var v = d.textContent.trim();
        if (v) t[d.getAttribute('data-k')] = v;
      });
      return t;
    }

    /* ---------- Shipping protection (Insureful app) ---------- */
    /* The drawer's own Insureful switch is the source of truth: flipping ours clicks it, so the app keeps one choice.
       The drawer renders that switch only once the cart has items, and re-renders it after every cart change, so
       syncIns runs at start (a few retries while the app loads) and again after every cart read / drawer refresh. */
    insInput() {
      return document.querySelector('cart-drawer .pti-insurence-needed') || document.querySelector('.pti-insurence-needed');
    }

    startIns(tries) {
      var self = this;
      if (!this.$.insRow) return;
      if (!this.syncIns() && tries < 20) setTimeout(function () { self.startIns(tries + 1); }, 500);
    }

    /* Shows the row once the app's switch exists and copies its text, price and state; true when it was found */
    syncIns() {
      var self = this;
      if (!this.$.insRow) return false;
      var src = this.insInput();
      if (!src) return false;
      var wrap = src.closest('.insureful-widget') || document;
      var title = wrap.querySelector('.pti-title');
      var desc = wrap.querySelector('.pti-desc');
      var price = wrap.querySelector('.pti-price');
      if (title && title.textContent.trim()) this.querySelector('[data-ins-title]').textContent = title.textContent.trim();
      if (desc && desc.textContent.trim()) this.querySelector('[data-ins-sub]').textContent = desc.textContent.trim();
      /* Price in the shopper's currency through the same money format: the widget's number when it has one,
         else the app's fixed price (shop currency) times the market rate */
      var p = '';
      var num = price ? price.textContent.replace(/[^\d.,]/g, '').replace(/[.,](?=\d{3}(\D|$))/g, '').replace(',', '.') : '';
      var pti = window.ptiSettings || {};
      if (parseFloat(num) > 0) p = money(Math.round(parseFloat(num) * 100));
      else if (pti.fixed_plan_price) {
        var rate = parseFloat(window.Shopify && window.Shopify.currency && window.Shopify.currency.rate) || 1;
        p = money(Math.round(parseFloat(pti.fixed_plan_price) * rate * 100));
      }
      if (p) this.querySelector('[data-ins-price]').textContent = '+' + p;
      this.$.insRow.hidden = false;
      this.$.ins.checked = !!src.checked;
      if (!this._insBound) {
        this._insBound = true;
        this.$.ins.addEventListener('change', function () {
          var s = self.insInput();
          if (s && s.checked !== self.$.ins.checked) s.click();
        });
        /* The user flips the drawer's switch: keep ours in step */
        document.addEventListener('change', function (e) {
          if (e.target && e.target.classList && e.target.classList.contains('pti-insurence-needed')) self.$.ins.checked = !!e.target.checked;
        });
      }
      return true;
    }

    insLine() {
      var vendor = /^pt-insur/i;
      var hit = null;
      (this.cart.items || []).forEach(function (it) { if (!hit && vendor.test(it.vendor || '')) hit = it; });
      return hit;
    }

    /* Checkout: what the drawer's checkout does with Insureful (add its product when chosen, drop it when not), then go.
       Subscribfy replaced the drawer's checkout button: its visible guest link carries the locale
       ("/sv-se/checkout?locale=sv"), so that href wins over root + 'checkout'. */
    checkout() {
      var self = this;
      var go = function () {
        var guest = document.querySelector('cart-drawer a.exm-cta__btn--guest');
        var href = guest && guest.getAttribute('href');
        window.location.href = href || root + 'checkout';
      };
      this._leaving = true;
      this.$.cta.disabled = true;
      this.$.cta.setAttribute('aria-busy', 'true');
      this.queue = this.queue.then(function () { return self.loadCart(); }).then(function () {
        /* No shipping protection row on screen: the cart stays as it is */
        if (!self.$.ins || !self.$.insRow || self.$.insRow.hidden) return null;
        var want = !!self.$.ins.checked;
        var line = self.insLine();
        if (!want && line) return postJSON('cart/change.js', { id: line.key, quantity: 0 });
        if (want && !line) {
          var v = (window.insuranceVariant && window.insuranceVariant.id) || (window.ptiSettings && window.ptiSettings.variant_id);
          if (v) return postJSON('cart/add.js', { items: [{ id: Number(v), quantity: 1 }] });
        }
        return null;
      }).then(go, go);
    }

    /* ---------- Kite cart goals (gifts + free shipping), the same goals as the cart drawer bar ---------- */
    /* Kite loads after this element: its config lands in window.gfg.settings once its script ran. Retry ~10 s, then no goal row. */
    startGoals(tries) {
      var self = this;
      if (!this.$.goals) return;
      var goals = this.readGoals();
      if (!goals.length) {
        if (tries < 20) setTimeout(function () { self.startGoals(tries + 1); }, 500);
        return;
      }
      this.goals = goals;
      var t = this.t;
      var frag = document.createDocumentFragment();
      goals.forEach(function (g) {
        var li = el('li', 'gg-bb__step-mark');
        li.appendChild(el('strong', '', money(g.amount)));
        li.appendChild(el('span', '', g.ship ? t.goalShip : t.goalGift));
        frag.appendChild(li);
      });
      this.$.goalsList.textContent = '';
      this.$.goalsList.appendChild(frag);
      this.$.goals.hidden = false;
      this.renderSummary();
    }

    /* Kite progress bar goals (cart subtotal thresholds), this market's value, sorted by amount (same as pm-bundle-save) */
    readGoals() {
      var data = window.gfg && window.gfg.settings && window.gfg.settings.consolidatedCombinedDiscount ? window.gfg.settings : null;
      if (!data) {
        var tag = document.getElementById('kite-app-data');
        try { data = tag && tag.textContent ? JSON.parse(tag.textContent) : null; } catch (e) { data = null; }
      }
      if (!data) return [];
      var market = this.cfg.market || '';
      var rate = parseFloat(window.Shopify && window.Shopify.currency && window.Shopify.currency.rate) || 1;
      var out = [];
      (data.consolidatedCombinedDiscount || []).forEach(function (c) {
        if (!c || c.isEnabled === false || c.discountFunctionType !== 'CONSOLIDATED_PROGRESS_BAR') return;
        ((c.segmentsData && c.segmentsData.segmentsList) || []).forEach(function (s) {
          var r = ((s.buyXRulesData && s.buyXRulesData.rulesList) || [])[0];
          if (!r || !/subtotal/i.test(r.ruleType || '')) return;
          var rv = r.ruleValue || {};
          var amount = parseFloat(rv.qualifierValue) * rate;
          (rv.marketValues || []).forEach(function (m) {
            if (m && m.handle === market && parseFloat(m.value) > 0) amount = parseFloat(m.value);
          });
          if (!(amount > 0)) return;
          out.push({ amount: Math.round(amount * 100), ship: s.goalType !== 'FREE_GIFT' });
        });
      });
      return out.sort(function (a, b) { return a.amount - b.amount; });
    }

    renderGoals() {
      if (!this.goals.length || !this.$.goals) return;
      var t = this.t;
      var c = this.cart || {};
      var v = typeof c.items_subtotal_price === 'number' ? c.items_subtotal_price : (c.total_price || 0);
      this.$.goalsFill.style.width = trackPos(this.goals.map(function (g) { return g.amount; }), v) + '%';
      var marks = this.$.goalsList.children;
      var next = null;
      this.goals.forEach(function (g, i) {
        var hit = v >= g.amount;
        if (marks[i]) marks[i].classList.toggle('is-reached', hit);
        if (!hit && !next) next = g;
      });
      var txt = next
        ? fill(next.ship ? t.toShip : t.toGift, { amount: money(next.amount - v) })
        : t.goalsDone || '';
      this.$.goalStatus.textContent = txt;
      this.$.goalStatus.hidden = false;
    }

    disconnectedCallback() {
      if (this._onPreset) window.removeEventListener('gg:preset', this._onPreset);
      if (this._onScroll) window.removeEventListener('scroll', this._onScroll);
      if (this._unsub) this._unsub();
      if (this._io) this._io.disconnect();
    }

    /* ---------- cart state ---------- */

    loadCart() {
      var self = this;
      return fetch(root + 'cart.js', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (c) {
          self.cart = c || { items: [] };
          self.render();
          self.syncIns();
        })
        .catch(function () {});
    }

    isSetLine(it) {
      return !!(it.properties && it.properties._bundle_items);
    }

    /* A bottle that counts toward the quantity discount (see header) */
    counts(it) {
      var p = it.properties || {};
      if (p._bundle_items || p._free_product) return false;
      if (this.cfg.wrap && String(it.variant_id) === String(this.cfg.wrap.variantId)) return false;
      if (this.qualify[String(it.product_id)] === true) return true;
      return !!(it.line_level_discount_allocations && it.line_level_discount_allocations.length);
    }

    stats() {
      var self = this;
      var n = 0;
      var saved = 0;
      var full = 0;
      (this.cart.items || []).forEach(function (it) {
        if (!self.counts(it)) return;
        n += it.quantity;
        saved += Math.max(0, (it.original_line_price || 0) - (it.final_line_price || 0));
        full += it.original_line_price || 0;
      });
      var cur = null;
      var next = null;
      this.steps.forEach(function (s) {
        if (n >= s.min) cur = s;
        else if (!next) next = s;
      });
      return { n: n, saved: saved, full: full, cur: cur, next: next };
    }

    /* Plain bottles of one variant in the cart (set lines excluded) */
    qty(v) {
      var n = 0;
      var self = this;
      (this.cart.items || []).forEach(function (it) {
        if (String(it.variant_id) === v && !self.isSetLine(it)) n += it.quantity;
      });
      return n;
    }

    plainLine(v) {
      var self = this;
      var hit = null;
      (this.cart.items || []).forEach(function (it) {
        if (!hit && String(it.variant_id) === v && !self.isSetLine(it) && !(it.properties && it.properties._free_product)) hit = it;
      });
      return hit;
    }

    setLine(v) {
      var hit = null;
      (this.cart.items || []).forEach(function (it) {
        if (!hit && String(it.variant_id) === v && it.properties && it.properties._bundle_items) hit = it;
      });
      return hit;
    }

    /* One cart write at a time; each re-reads the cart and refreshes the header bubble. Builder additions never open the drawer (cart icon / CTA do) */
    run(job, open, note) {
      var self = this;
      this.muteDrawer(8000);
      this.pending++;
      this.hideError();
      this.renderSummary();
      this.queue = this.queue
        .then(job)
        .then(function () {
          if (note) self.showAdded();
          return self.loadCart().then(function () { return open === true ? self.openCart() : self.refreshBubble(); });
        })
        .catch(function () {
          self.showError();
          return self.loadCart();
        })
        .then(function () {
          self.pending--;
          self.render();
          self.muteDrawer(6000);
        });
      return this.queue;
    }

    addVariant(v, qty, props, note) {
      var item = { id: Number(v), quantity: qty || 1 };
      if (props) item.properties = props;
      return this.run(function () { return postJSON('cart/add.js', { items: [item] }); }, false, note);
    }

    /* Lines are looked up inside the queued job (cart re-read by the job before), never at tap time:
       fast taps would otherwise write stale quantities */
    removeOne(v) {
      var self = this;
      this.run(function () {
        var line = self.plainLine(v);
        return line ? postJSON('cart/change.js', { id: line.key, quantity: line.quantity - 1 }) : null;
      });
    }

    /* One less of the cart line with this key (× on a bottle tile or a set line) */
    decLine(key) {
      var self = this;
      this.run(function () {
        var line = null;
        (self.cart.items || []).forEach(function (it) { if (!line && it.key === key) line = it; });
        return line ? postJSON('cart/change.js', { id: line.key, quantity: line.quantity - 1 }) : null;
      });
    }

    /* Header count + drawer contents after every write, without opening the drawer: the same section swap as the
       theme's CartDrawer.renderContents (assets/cart-drawer.js) minus its open(). Apps that open the drawer
       themselves (Kite adds its free gift at 4 bottles) then show the real cart, not an empty one.
       No cartUpdate publish: the theme would open the drawer a second time; additions open it via openCart(). */
    refreshBubble() {
      var self = this;
      var drawer = document.querySelector('cart-drawer');
      var secs = drawer && typeof drawer.getSectionsToRender === 'function'
        ? drawer.getSectionsToRender()
        : [{ id: 'cart-icon-bubble' }];
      return fetch(window.location.pathname + '?sections=' + secs.map(function (s) { return s.id; }).join(',') + '&_=' + Date.now())
        .then(function (r) { return r.json(); })
        .then(function (data) {
          secs.forEach(function (s) {
            var html = data && data[s.id];
            var target = s.selector ? document.querySelector(s.selector) : document.getElementById(s.id);
            if (!html || !target) return;
            var src = new DOMParser().parseFromString(html, 'text/html').querySelector(s.selector || '.shopify-section');
            if (src) target.innerHTML = src.innerHTML;
          });
          if (drawer) {
            var empty = !(self.cart.items || []).length;
            drawer.classList.toggle('is-empty', empty);
            var inner = drawer.querySelector('.drawer__inner');
            if (inner) inner.classList.toggle('is-empty', empty);
            var overlay = drawer.querySelector('#CartDrawer-Overlay');
            if (overlay && typeof drawer.close === 'function' && !overlay._ggClose) {
              overlay._ggClose = true;
              overlay.addEventListener('click', drawer.close.bind(drawer));
            }
          }
          self.syncIns();
        })
        .catch(function () {});
    }

    openCart() {
      var drawer = document.querySelector('cart-drawer');
      if (!drawer || typeof drawer.open !== 'function') {
        window.location.href = this.cfg.cartUrl || root + 'cart';
        return;
      }
      /* Contents are fresh from the last write; refresh once more in case the cart changed elsewhere */
      return this.refreshBubble().then(function () {
        drawer._ggMuteUntil = 0;
        drawer.open();
      });
    }

    /* Kite opens the drawer when it adds a free gift after a builder addition: drawer.open() is ignored for ms
       after a builder write (the cart icon / CTA clear it first) */
    muteDrawer(ms) {
      var drawer = document.querySelector('cart-drawer');
      if (!drawer || typeof drawer.open !== 'function') return;
      if (!drawer._ggMuted) {
        var orig = drawer.open;
        drawer.open = function () {
          if (Date.now() < (drawer._ggMuteUntil || 0)) return;
          return orig.apply(drawer, arguments);
        };
        drawer._ggMuted = true;
        /* The header cart icon always opens the drawer, even right after a builder add */
        var unmute = function (e) {
          if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
          if (e.target && e.target.closest && e.target.closest('#cart-icon-bubble')) drawer._ggMuteUntil = 0;
        };
        document.addEventListener('click', unmute, true);
        document.addEventListener('keydown', unmute, true);
      }
      drawer._ggMuteUntil = Math.max(drawer._ggMuteUntil || 0, Date.now() + ms);
    }

    /* Short green "added" note in the box, replaces the old cart button (the add itself is the action) */
    showAdded() {
      var notes = this.$.added;
      var txt = this.t.added || '';
      notes.forEach(function (n) {
        n.textContent = txt;
        n.hidden = false;
        n.classList.remove('is-on');
        void n.offsetWidth;
        n.classList.add('is-on');
      });
      clearTimeout(this._addedT);
      this._addedT = setTimeout(function () {
        notes.forEach(function (n) { n.hidden = true; n.classList.remove('is-on'); });
      }, 2500);
    }

    showError() {
      if (!this.$.err) return;
      this.$.err.textContent = this.t.error || '';
      this.$.err.hidden = false;
    }

    hideError() {
      if (this.$.err) this.$.err.hidden = true;
    }

    numberText(it) {
      return it.n ? fill(this.t.number || 'No. [n]', { n: it.n }) : it.t;
    }

    /* ---------- filters ---------- */

    buildFamilies() {
      var counts = {};
      this.order.forEach(function (it) {
        it.fams.forEach(function (f) { counts[f] = (counts[f] || 0) + 1; });
      });
      var fams = Object.keys(counts).sort(function (a, b) {
        return counts[b] - counts[a] || a.localeCompare(b, 'sv');
      });
      if (!fams.length) {
        if (this.$.fGroup) this.$.fGroup.hidden = true;
        return;
      }
      /* Pill text = the hidden page text (Weglot-translated), data-f = the raw value used to filter */
      var labels = {};
      Array.prototype.forEach.call(this.querySelectorAll('[data-gg-fams] [data-f]'), function (d) {
        var v = d.textContent.trim();
        if (v) labels[d.getAttribute('data-f')] = v;
      });
      var frag = document.createDocumentFragment();
      fams.forEach(function (f) {
        var b = el('button', 'gg-bb__pill', labels[f] || f);
        b.type = 'button';
        b.setAttribute('data-f', f);
        b.setAttribute('aria-pressed', 'false');
        frag.appendChild(b);
      });
      this.$.fList.appendChild(frag);
    }

    initGenders() {
      if (!this.$.gGroup) return;
      var total = { unisex: 0, male: 0, female: 0 };
      this.order.forEach(function (it) { if (total[it.g] != null) total[it.g]++; });
      var any = false;
      ['unisex', 'male', 'female'].forEach(
        function (g) {
          var b = this.$.gGroup.querySelector('[data-g="' + g + '"]');
          if (b) b.hidden = total[g] === 0;
          if (total[g] > 0) any = true;
        }.bind(this)
      );
      if (!any) this.$.gGroup.hidden = true;
    }

    matchBase(it) {
      if (this.family && it.fams.indexOf(this.family) === -1) return false;
      if (this.qTerms && this.qTerms.length) {
        for (var i = 0; i < this.qTerms.length; i++) if (it.hay.indexOf(this.qTerms[i]) === -1) return false;
      }
      return true;
    }

    /* ---------- list ---------- */

    row(it) {
      if (this.rows[it.v]) return this.rows[it.v];
      var r = el('div', 'gg-bb__row');
      r.setAttribute('role', 'listitem');
      r.setAttribute('data-v', it.v);

      var thumb = el('span', 'gg-bb__thumb');
      if (it.img) {
        var img = document.createElement('img');
        img.src = it.img;
        img.alt = '';
        img.width = 400;
        img.height = 400;
        img.loading = 'lazy';
        img.decoding = 'async';
        thumb.appendChild(img);
      }
      r.appendChild(thumb);

      var info = el('span', 'gg-bb__info');
      var l1 = el('span', 'gg-bb__l1');
      l1.appendChild(el('strong', 'gg-bb__num', this.numberText(it)));
      /* Badges next to the number, in colour: Bestseller red, new green (Adrian 11.11) */
      if (it.b) l1.appendChild(el('span', 'gg-bb__tag gg-bb__tag--best', this.t.best || ''));
      if (it.w) l1.appendChild(el('span', 'gg-bb__tag gg-bb__tag--new', this.t.isNew || ''));
      info.appendChild(l1);
      var sub = it.i ? (this.t.inspired || '') + ' ' + it.i : it.n ? it.t : (it.s || '');
      if (sub) info.appendChild(el('span', 'gg-bb__insp', sub));
      info.appendChild(el('span', 'gg-bb__price', money(it.p)));
      r.appendChild(info);

      r.appendChild(el('span', 'gg-bb__act'));
      this.rows[it.v] = r;
      this.updateRow(r, it);
      return r;
    }

    updateRow(r, it) {
      var q = this.qty(it.v);
      var key = String(q);
      if (r._key === key) return;
      r._key = key;
      r.classList.toggle('is-picked', q > 0);
      var act = r.lastChild;
      act.textContent = '';
      var name = this.numberText(it);
      if (q === 0) {
        var add = el('button', 'gg-bb__add', this.t.add || '+');
        add.type = 'button';
        add.setAttribute('data-act', 'add');
        add.setAttribute('aria-label', (this.t.add || '+') + ': ' + name);
        act.appendChild(add);
      } else {
        var step = el('span', 'gg-bb__step');
        var dec = el('button', 'gg-bb__stepbtn', '−');
        dec.type = 'button';
        dec.setAttribute('data-act', 'dec');
        dec.setAttribute('aria-label', (this.t.remove || '−') + ': ' + name);
        var n = el('span', 'gg-bb__qty', String(q));
        var inc = el('button', 'gg-bb__stepbtn', '+');
        inc.type = 'button';
        inc.setAttribute('data-act', 'inc');
        inc.setAttribute('aria-label', (this.t.add || '+') + ': ' + name);
        step.appendChild(dec);
        step.appendChild(n);
        step.appendChild(inc);
        act.appendChild(step);
      }
    }

    renderList() {
      var self = this;
      var counts = { all: 0, unisex: 0, male: 0, female: 0 };
      var shown = [];
      var order = this.order;
      if (this.pinned.length) {
        var pin = this.pinned;
        order = pin.map(function (v) { return self.byId[v]; }).filter(Boolean)
          .concat(this.order.filter(function (it) { return pin.indexOf(it.v) === -1; }));
      }
      order.forEach(function (it) {
        if (!self.matchBase(it)) return;
        counts.all++;
        if (counts[it.g] != null) counts[it.g]++;
        if (self.gender === 'all' || it.g === self.gender) shown.push(it);
      });

      var frag = document.createDocumentFragment();
      shown.slice(0, this.limit).forEach(function (it) { frag.appendChild(self.row(it)); });
      this.$.list.textContent = '';
      if (shown.length) {
        this.$.list.appendChild(frag);
      } else {
        this.$.list.appendChild(el('p', 'gg-bb__none', this.t.none || ''));
      }
      if (this.$.more) {
        var left = shown.length - this.limit;
        this.$.more.hidden = left <= 0;
        if (left > 0) this.$.more.textContent = fill(this.t.showMore || '+[n]', { n: Math.min(left, this.pageSize) });
      }

      if (this.$.count) this.$.count.textContent = fill(this.t.count || '[n]', { n: shown.length });
      GENDERS.forEach(function (g) {
        var c = self.querySelector('[data-cnt="' + g + '"]');
        if (c) c.textContent = String(counts[g]);
      });
    }

    updateRows() {
      var self = this;
      Object.keys(this.rows).forEach(function (id) { self.updateRow(self.rows[id], self.byId[id]); });
    }

    /* ---------- box + sticky bar ---------- */

    nextText(s) {
      var t = this.t;
      if (!s.next) return s.cur ? t.top || '' : '';
      var left = s.next.min - s.n;
      var key = s.cur ? (left === 1 ? 'toNext' : 'toNextMany') : (left === 1 ? 'toFirst' : 'toFirstMany');
      if (s.n === 0) return fill(t.start, { n: s.next.min, pct: s.next.pct });
      return fill(t[key], { n: left, pct: s.next.pct });
    }

    renderSummary() {
      var t = this.t;
      var s = this.stats();

      this.$.of.textContent = s.n === 1 ? t.inCartOne : fill(t.inCart, { n: s.n });
      this.$.status.textContent = this.nextText(s);

      /* Bar: markers centred in equal columns (Kite cart bar look) */
      var pos = trackPos(this.steps.map(function (m) { return m.min; }), s.n);
      this.$.fills.forEach(function (f) { f.style.width = Math.min(100, pos) + '%'; });
      this.renderGoals();
      this.$.marks.forEach(function (m) {
        var min = Number(m.getAttribute('data-step-min'));
        m.classList.toggle('is-reached', s.n >= min);
        m.classList.toggle('is-current', !!(s.cur && s.cur.min === min));
      });

      /* Savings as the cart drawer shows them (whole cart): subtotal / discount / total */
      if (this.$.saving) this.$.saving.hidden = true;
      if (this.$.totals) {
        var c = this.cart || {};
        var orig = c.original_total_price || 0;
        var tot = c.total_price || 0;
        /* money_with_currency in the shopper's currency, as in the drawer: "€42,98 EUR" */
        var fmtCur = this.cfg.moneyWithCurrency;
        var withCur = function (v) { return moneyCur(v, fmtCur); };
        this.$.totals.hidden = !(c.items && c.items.length);
        var off = orig > tot;
        this.$.totSubRow.hidden = !off;
        this.$.totOffRow.hidden = !off;
        this.$.totSub.textContent = withCur(orig);
        this.$.totOff.textContent = '-' + withCur(orig - tot);
        this.$.totTotal.textContent = withCur(tot);
      }

      this.renderPicked();
      this.renderSets();

      var wrapLine = this.cfg.wrap ? this.plainLine(String(this.cfg.wrap.variantId)) : null;
      if (this.$.wrap) this.$.wrap.checked = !!wrapLine;

      var hasItems = (this.cart.items || []).length > 0;
      if (this.$.cta) {
        this.$.cta.disabled = !hasItems || !!this._leaving;
        this.$.cta.setAttribute('aria-busy', this.pending ? 'true' : 'false');
      }

      /* Sticky bar */
      if (this.$.bar) {
        this.$.barCta.disabled = !hasItems;
        var badge = this.$.barCta.querySelector('[data-bar-badge]');
        var count = this.cart.item_count || 0;
        if (badge) {
          badge.textContent = count > 99 ? '99+' : String(count);
          badge.hidden = !count;
        }
      }
      this.classList.toggle('is-busy', this.pending > 0);
    }

    /* Bottles in the cart as small tiles (thumbnail + quantity, × removes one) */
    renderPicked() {
      if (!this.$.picked) return;
      var self = this;
      var frag = document.createDocumentFragment();
      var any = false;
      (this.cart.items || []).forEach(function (it) {
        if (!self.counts(it)) return;
        any = true;
        var pool = self.byId[String(it.variant_id)];
        var tile = el('div', 'gg-bb__pick-tile');
        tile.setAttribute('role', 'listitem');
        var src = (pool && pool.img) || (it.image ? it.image + (it.image.indexOf('?') > -1 ? '&' : '?') + 'width=160' : '');
        if (src) {
          var img = document.createElement('img');
          img.src = src;
          img.alt = '';
          img.width = 80;
          img.height = 80;
          img.decoding = 'async';
          tile.appendChild(img);
        }
        var label = pool ? self.numberText(pool) : it.product_title;
        tile.appendChild(el('span', 'gg-vh', label));
        if (it.quantity > 1) tile.appendChild(el('span', 'gg-bb__pick-qty', '×' + it.quantity));
        var x = el('button', 'gg-bb__pick-x');
        x.type = 'button';
        x.setAttribute('data-line', it.key);
        x.setAttribute('data-q', String(it.quantity));
        x.setAttribute('aria-label', (self.t.remove || '×') + ': ' + label);
        x.appendChild(el('span', '', '×')).setAttribute('aria-hidden', 'true');
        tile.appendChild(x);
        frag.appendChild(tile);
      });
      this.$.picked.textContent = '';
      this.$.picked.appendChild(frag);
      this.$.picked.hidden = !any;
    }

    /* Ready-made sets: chip state + one line per set in the box (price, fair value struck, ×) */
    renderSets() {
      var self = this;
      var lines = [];
      this.$.chips.forEach(function (chip) {
        var line = self.setLine(chip.getAttribute('data-set-variant'));
        chip.classList.add('is-addon');
        chip.classList.toggle('is-added', !!line);
        chip.setAttribute('aria-pressed', line ? 'true' : 'false');
        if (line) lines.push({ chip: chip, line: line });
      });
      if (!this.$.addons) return;
      this.$.addons.textContent = '';
      this.$.addons.hidden = !lines.length;
      lines.forEach(function (x) {
        var c = x.chip;
        var price = Number(c.getAttribute('data-set-price')) || 0;
        var compare = Number(c.getAttribute('data-set-compare')) || 0;
        var title = c.getAttribute('data-set-title') || '';
        var li = el('div', 'gg-bb__addon');
        li.setAttribute('role', 'listitem');
        li.appendChild(el('span', 'gg-bb__addon-title', (x.line.quantity > 1 ? x.line.quantity + ' × ' : '+ ') + title));
        var pr = el('span', 'gg-bb__addon-prices');
        pr.appendChild(el('strong', 'gg-bb__addon-price', money(price * x.line.quantity)));
        if (compare > price) {
          pr.appendChild(document.createTextNode(' '));
          pr.appendChild(el('s', 'gg-bb__addon-was', money(compare * x.line.quantity)));
        }
        li.appendChild(pr);
        var rm = el('button', 'gg-bb__addon-x', '×');
        rm.type = 'button';
        rm.setAttribute('data-line', x.line.key);
        rm.setAttribute('data-q', '1');
        rm.setAttribute('aria-label', (self.t.remove || '×') + ': ' + title);
        li.appendChild(rm);
        self.$.addons.appendChild(li);
      });
    }

    render() {
      this.updateRows();
      this.renderSummary();
    }

    /* ---------- actions ---------- */

    toggleSet(chip) {
      var self = this;
      var v = chip.getAttribute('data-set-variant');
      var scents = [];
      try { scents = JSON.parse(chip.getAttribute('data-set-scents') || '[]'); } catch (e) { scents = []; }
      var item = window.GG && window.GG.bundleItem
        ? window.GG.bundleItem(v, scents, 'Bottle')
        : { id: Number(v), quantity: 1 };
      /* Add or remove decided inside the job, on the cart as it is then */
      this.run(function () {
        var line = self.setLine(v);
        if (line) return postJSON('cart/change.js', { id: line.key, quantity: 0 });
        return postJSON('cart/add.js', { items: [item] });
      }, false, !this.setLine(v));
    }

    toggleWrap(on) {
      var self = this;
      var w = this.cfg.wrap;
      if (!w) return;
      this.run(function () {
        var line = self.plainLine(String(w.variantId));
        if (on && !line) return postJSON('cart/add.js', { items: [{ id: Number(w.variantId), quantity: 1 }] });
        if (!on && line) return postJSON('cart/change.js', { id: line.key, quantity: 0 });
        return null;
      });
    }

    bind() {
      var self = this;

      this.$.list.addEventListener('click', function (e) {
        var b = e.target.closest('[data-act]');
        var r = e.target.closest('[data-v]');
        if (!r) return;
        var id = r.getAttribute('data-v');
        /* A tap anywhere on the card (or + / Lägg till) puts one bottle in the cart, − takes one out */
        if (b && b.getAttribute('data-act') === 'dec') self.removeOne(id);
        else self.addVariant(id, 1, null, true);
      });

      /* × on a bottle tile or a set line in the box: one less of that line */
      [this.$.picked, this.$.addons].forEach(function (box) {
        if (!box) return;
        box.addEventListener('click', function (e) {
          var b = e.target.closest('[data-line]');
          if (!b) return;
          self.decLine(b.getAttribute('data-line'));
        });
      });

      this.$.chips.forEach(function (chip) {
        chip.addEventListener('click', function () { self.toggleSet(chip); });
      });

      if (this.$.wrap) {
        this.$.wrap.addEventListener('change', function () { self.toggleWrap(self.$.wrap.checked); });
      }

      if (this.$.cta) this.$.cta.addEventListener('click', function () { self.checkout(); });
      if (this.$.barCta) this.$.barCta.addEventListener('click', function () { self.queue.then(function () { self.openCart(); }); });

      if (this.$.q) {
        var timer;
        this.$.q.addEventListener('input', function () {
          clearTimeout(timer);
          timer = setTimeout(function () {
            self.q = self.$.q.value;
            self.qTerms = norm(self.q).split(/\s+/).filter(Boolean);
            self.limit = self.pageSize;
            self.renderList();
          }, 120);
        });
      }

      if (this.$.gGroup) {
        this.$.gGroup.addEventListener('click', function (e) {
          var b = e.target.closest('[data-g]');
          if (!b) return;
          self.gender = b.getAttribute('data-g');
          self.limit = self.pageSize;
          self.$.gGroup.querySelectorAll('[data-g]').forEach(function (x) {
            var on = x === b;
            x.classList.toggle('is-active', on);
            x.setAttribute('aria-pressed', on ? 'true' : 'false');
          });
          self.renderList();
        });
      }

      if (this.$.fList) {
        this.$.fList.addEventListener('click', function (e) {
          var b = e.target.closest('[data-f]');
          if (!b) return;
          self.family = b.getAttribute('data-f') || '';
          self.limit = self.pageSize;
          self.$.fList.querySelectorAll('[data-f]').forEach(function (x) {
            var on = x === b;
            x.classList.toggle('is-active', on);
            x.setAttribute('aria-pressed', on ? 'true' : 'false');
          });
          self.renderList();
        });
      }

      if (this.$.more) {
        var loadMore = function () {
          if (self.$.more.hidden) return;
          self.limit += self.pageSize;
          self.renderList();
        };
        this.$.more.addEventListener('click', loadMore);
        /* Infinite scroll: the next page loads once the end of the grid is within 600px of the screen bottom,
           or already scrolled past (a fast fling skips any single trigger point, so this checks on every scroll
           frame instead of an IntersectionObserver). The button stays as a fallback and for keyboard users. */
        var ticking = false;
        this._onScroll = function () {
          if (ticking) return;
          ticking = true;
          window.requestAnimationFrame(function () {
            ticking = false;
            if (self.$.more.hidden || !self.isConnected) return;
            if (self.$.more.getBoundingClientRect().top < window.innerHeight + 600) loadMore();
          });
        };
        window.addEventListener('scroll', this._onScroll, { passive: true });
      }

      /* Sticky bar: visible while the builder is on screen and the box itself is not */
      if (this.$.bar && 'IntersectionObserver' in window) {
        var seen = { builder: false, box: false };
        var sync = function () { self.$.bar.hidden = !(seen.builder && !seen.box); };
        this._io = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) {
            if (en.target === self) seen.builder = en.isIntersecting;
            else if (en.target === self.$.sum) seen.box = en.isIntersecting;
          });
          sync();
        });
        this._io.observe(this);
        this._io.observe(this.$.sum);
      }

      /* Cart edited elsewhere (drawer, other buy boxes): re-read it */
      if (typeof subscribe === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
        this._unsub = subscribe(PUB_SUB_EVENTS.cartUpdate, function (ev) {
          if (ev && ev.source === 'gg-builder') return;
          self.loadCart();
        });
      }

      /* "Byt doft" on a gift card: its scents go to the top of the grid, the builder scrolls into view */
      this._onPreset = function (e) {
        if (document.querySelector('gg-builder') !== self) return;
        var ids = ((e.detail && e.detail.ids) || []).map(String).filter(function (v) { return !!self.byId[v]; });
        if (!ids.length) return;
        self.pinned = ids;
        self.limit = self.pageSize;
        self.renderList();
        var anchor = self.closest('.gg-bb');
        anchor = (anchor && anchor.querySelector('.gg-anchor')) || self;
        anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      window.addEventListener('gg:preset', this._onPreset);
    }
  }

  window.customElements.define('gg-builder', GGBuilder);
})();
