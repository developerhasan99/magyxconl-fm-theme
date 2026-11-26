/* ts-goal-combo.js: combined goals bar above a collection grid (snippets/ts-goal-combo.liquid). Display only.

   One track with every reward in the order it unlocks:
   - bottle discount steps: the top bar's goal line (snippets/tb-goal-line.liquid) renders them as data-steps
     ("5:40" = 5 bottles, 40% off); read from that element, never duplicated. No goal line = no bottle steps.
   - Kite goals (gift / free shipping, cart value thresholds per market): window.gfg.settings, read like
     assets/ts-cart-goals.js; Kite fills it ~1-3 s after load, so it is retried for ~12 s.
   Scale = bottles. Kite amounts are placed at amount / (cart value / bottles); an empty cart uses data-unit-price;
   without either they sit evenly after the bottle steps. Markers keep a minimum distance so labels never collide,
   and the fill follows the same piecewise scale (computeTrack, exposed as window.tsGoalComboComputeTrack).

   Bottles counted like tb-goal-line.js: bundle lines count the bottles they carry, "5X 100ml" boxes count 5,
   Kite's gift lines (_free_product) never count. Cart: Liquid's copy first, then /cart.js once and on every Dawn
   cart update and back/forward cache return. A failed fetch (429) keeps the last state. */
(function () {
  var MIN_GAP = 0.24;

  // "5:40, 8:50" -> [{ n: 5, pct: 40 }, ...] (same rules as tb-goal-line.js parseSteps)
  function parseSteps(text) {
    var seen = {};
    return String(text || '').split(',').map(function (part) {
      var m = /^\s*(\d+)\s*:\s*(\d+(?:[.,]\d+)?)\s*%?\s*$/.exec(part);
      return m ? { n: parseInt(m[1], 10), pct: parseFloat(m[2].replace(',', '.')) } : null;
    }).filter(function (s) {
      if (!s || s.n < 1 || !(s.pct > 0) || seen[s.n]) return false;
      seen[s.n] = true;
      return true;
    }).sort(function (a, b) { return a.n - b.n; });
  }

  // Same counting as tb-goal-line.js bottlesIn.
  function bottlesIn(items) {
    var count = 0;
    (items || []).forEach(function (it) {
      var p = it.properties || {};
      var gift = p._free_product;
      if (gift !== undefined && gift !== null && gift !== '' && String(gift) !== 'false') return;
      var q = Number(it.quantity) || 0;
      if (p._bundle_items) {
        count += String(p._bundle_items).split(',').filter(function (x) { return x.trim(); }).length * q;
        return;
      }
      var text = [it.variant_title, it.product_title, it.title].join(' ');
      var box = /(\d+)\s*[x×]\s*\d+\s*ml/i.exec(text);
      if (box) count += parseInt(box[1], 10) * q;
      else if (/\d\s*ml\b/i.test(text)) count += q;
    });
    return count;
  }

  /* rewards: [{ kind: 'pct', n, pct } | { kind: 'gift' | 'ship', amount (cents) }]
     Returns { markers: [{ ...reward, pos, x (0..1), reached }], fill (0..1), next (marker or null), done }. */
  // Bottle abbreviation under a discount step on phones, by page language
  var SHORT_BOTTLE = ({ nl: 'fl.', fr: 'fl.', de: 'Fl.' })[(document.documentElement.lang || '').slice(0, 2).toLowerCase()] || 'btl.';

  function computeTrack(rewards, bottles, cents, unitPrice) {
    bottles = Math.max(0, Number(bottles) || 0);
    cents = Math.max(0, Number(cents) || 0);
    unitPrice = Number(unitPrice) || 0;
    var unit = bottles > 0 && cents > 0 ? cents / bottles : unitPrice > 0 ? unitPrice : 0;
    var steps = (rewards || []).filter(function (r) { return r && r.kind === 'pct' && r.n > 0; })
      .sort(function (a, b) { return a.n - b.n; });
    var kites = (rewards || []).filter(function (r) { return r && r.kind !== 'pct' && r.amount > 0; })
      .sort(function (a, b) { return a.amount - b.amount; });
    // Kite goals only: the track can run on cart value itself.
    if (!unit && !steps.length) unit = 1;
    var last = steps.length ? steps[steps.length - 1].n : 0;
    var spacing = last > 0 ? last / steps.length : 1;

    var markers = [];
    steps.forEach(function (s) {
      markers.push({ kind: 'pct', n: s.n, pct: s.pct, pos: s.n, reached: bottles >= s.n });
    });
    kites.forEach(function (k, i) {
      markers.push({
        kind: k.kind, amount: k.amount,
        pos: unit > 0 ? k.amount / unit : last + (i + 1) * spacing,
        reached: cents >= k.amount
      });
    });
    markers.forEach(function (m, i) { m.order = i; });
    // Unlock order; on a tie the reached one first, then discount steps before Kite.
    markers.sort(function (a, b) {
      return a.pos - b.pos || (b.reached ? 1 : 0) - (a.reached ? 1 : 0) || a.order - b.order;
    });

    var k = markers.length;
    var progress = bottles > 0 ? bottles : unit > 0 ? cents / unit : 0;
    if (!k) return { markers: [], fill: 0, next: null, done: false };

    var max = Math.max(markers[k - 1].pos, 1e-9);
    var gap = Math.min(MIN_GAP, 1 / k);
    markers.forEach(function (m, i) {
      var raw = m.pos / max;
      m.x = Math.max(raw, i ? markers[i - 1].x + gap : gap / 2);
    });
    markers[k - 1].x = Math.min(markers[k - 1].x, 1);
    for (var j = k - 2; j >= 0; j--) markers[j].x = Math.min(markers[j].x, markers[j + 1].x - gap);
    markers.forEach(function (m) { m.x = Math.max(0, Math.min(1, m.x)); });

    // Fill on the same piecewise scale: (0,0), then (pos, x) for each marker.
    var fill = 1;
    var px = 0;
    var pp = 0;
    for (var i = 0; i < k; i++) {
      var m = markers[i];
      if (progress < m.pos) {
        fill = m.pos > pp ? px + ((progress - pp) / (m.pos - pp)) * (m.x - px) : px;
        break;
      }
      px = m.x;
      pp = m.pos;
    }
    if (progress <= 0) fill = 0;
    fill = Math.max(0, Math.min(1, fill));

    var next = null;
    for (var n = 0; n < k; n++) if (!markers[n].reached) { next = markers[n]; break; }
    markers.forEach(function (mm) { delete mm.order; });
    return { markers: markers, fill: fill, next: next, done: !next };
  }

  // Self-check hook: node loads this file through module.exports, the browser exposes computeTrack on window.
  if (typeof module !== 'undefined' && module.exports) module.exports = { computeTrack: computeTrack, parseSteps: parseSteps, bottlesIn: bottlesIn };
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  window.tsGoalComboComputeTrack = computeTrack;

  if (window.tsGoalComboReady) return;
  window.tsGoalComboReady = true;

  // Kite goals for this market (as assets/ts-cart-goals.js readGoals; any CONSOLIDATED_* bar type).
  function readKite(market) {
    var data = window.gfg && window.gfg.settings && window.gfg.settings.consolidatedCombinedDiscount ? window.gfg.settings : null;
    if (!data) {
      var el = document.getElementById('kite-app-data');
      try { data = el && el.textContent ? JSON.parse(el.textContent) : null; } catch (e) { data = null; }
    }
    if (!data) return [];
    var rate = parseFloat(window.Shopify && window.Shopify.currency && window.Shopify.currency.rate) || 1;
    var out = [];
    (data.consolidatedCombinedDiscount || []).forEach(function (c) {
      if (!c || c.isEnabled === false || !/^CONSOLIDATED_/.test(c.discountFunctionType || '')) return;
      ((c.segmentsData && c.segmentsData.segmentsList) || []).forEach(function (s) {
        var r = ((s.buyXRulesData && s.buyXRulesData.rulesList) || [])[0];
        if (!r || !/subtotal/i.test(r.ruleType || '')) return;
        var rv = r.ruleValue || {};
        var amount = parseFloat(rv.qualifierValue) * rate;
        (rv.marketValues || []).forEach(function (m) {
          if (m && m.handle === market && parseFloat(m.value) > 0) amount = parseFloat(m.value);
        });
        if (!(amount > 0)) return;
        out.push({ kind: s.goalType === 'FREE_GIFT' ? 'gift' : 'ship', amount: Math.round(amount * 100) });
      });
    });
    return out;
  }

  function readSteps() {
    var el = document.querySelector('[data-tb-goal]:not([data-tg-sticky])');
    return el ? parseSteps(el.getAttribute('data-steps')) : [];
  }

  var NAMES = ['bottles', 'gift', 'ship', 'done', 'pct', 'giftLabel', 'shipLabel', 'one', 'many'];

  function init(root) {
    if (root.dataset.started) return;
    root.dataset.started = '1';

    // Texts: Swedish settings; Weglot pages (da / fi) use their textarea, one line each in NAMES order. Copied from
    // tb-goal-line.js. Without all lines: no bar.
    var all = {};
    try { all = JSON.parse(root.querySelector('[data-gc-i18n]').textContent); } catch (e) { all = {}; }
    var lines = (all.sv || []).map(function (s) { return String(s || '').trim(); });
    var lang = (document.documentElement.getAttribute('data-wg-translated') || '').slice(0, 2).toLowerCase();
    if (lang && lang !== 'sv') {
      lines = String(all[lang] || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (lines.length < NAMES.length) {
        root.remove();
        return;
      }
    }
    var t = {};
    NAMES.forEach(function (n, i) { t[n] = lines[i] || ''; });

    var textEl = root.querySelector('[data-gc-text]');
    var fillEl = root.querySelector('[data-gc-fill]');
    var marksEl = root.querySelector('[data-gc-marks]');
    var labelsEl = root.querySelector('[data-gc-labels]');
    var unitPrice = parseFloat(root.dataset.unitPrice) || 0;
    var market = root.dataset.market || '';
    var steps = readSteps();
    var kite = [];
    var bottles = 0;
    var cents = 0;
    var nodes = {};
    var lineKey = '';
    var started = false;

    try {
      var initial = JSON.parse(root.querySelector('[data-gc-cart]').textContent);
      bottles = bottlesIn(initial.items);
      cents = Number(initial.total_price) || 0;
    } catch (e) { /* first /cart.js fills it */ }

    function money(c) {
      var whole = Math.ceil((Number(c) || 0) / 100);
      return (root.dataset.money || '0').replace(/\d+(?:[.,]\d+)?/, String(whole));
    }
    function pct(v) { return String(Math.round(v * 10) / 10).replace('.', ',') + '%'; }
    function bottleWord(n) { return n + ' ' + (n === 1 ? t.one : t.many); }
    function capital(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
    function rewardLabel(m) {
      if (m.kind === 'pct') return t.pct.replace('[pct]', pct(m.pct));
      return m.kind === 'gift' ? t.giftLabel : t.shipLabel;
    }

    // Template with its tokens as their own bold elements (built as nodes, never as HTML).
    function writeLine(template, values) {
      var key = template + '|' + JSON.stringify(values);
      if (key === lineKey) return;
      lineKey = key;
      textEl.textContent = '';
      template.split(/(\[count\]|\[amount\]|\[reward\]|\[pct\])/).forEach(function (part, i) {
        if (!part) return;
        var token = /^\[(count|amount|reward|pct)\]$/.exec(part);
        if (!token) {
          textEl.appendChild(document.createTextNode(i === 0 ? capital(part) : part));
          return;
        }
        var b = document.createElement('b');
        b.className = token[1] === 'count' ? 'ts-gc__num' : 'ts-gc__hot';
        b.textContent = values[token[1]] || '';
        textEl.appendChild(b);
      });
    }

    function icon(kind) {
      var span = document.createElement('span');
      span.className = 'ts-gc__icon';
      if (kind === 'pct') {
        // '%' on wide screens; phones show the step's own value (25%) in the marker instead of a label line
        var sign = document.createElement('span');
        sign.className = 'ts-gc__pct-sign';
        sign.textContent = '%';
        var val = document.createElement('span');
        val.className = 'ts-gc__pct-val';
        span.appendChild(sign);
        span.appendChild(val);
        span.classList.add('ts-gc__icon--pct');
        return span;
      }
      var src = root.querySelector('.ts-gc__src [data-icon="' + kind + '"] svg');
      if (src) span.appendChild(src.cloneNode(true));
      return span;
    }

    function render() {
      var rewards = steps.map(function (s) { return { kind: 'pct', n: s.n, pct: s.pct }; }).concat(kite);
      var track = computeTrack(rewards, bottles, cents, unitPrice);
      if (!track.markers.length) return false;

      var seen = {};
      track.markers.forEach(function (m) {
        var key = m.kind + ':' + (m.kind === 'pct' ? m.n : m.amount);
        seen[key] = true;
        var node = nodes[key];
        if (!node) {
          node = { mark: document.createElement('span'), label: document.createElement('span') };
          node.mark.className = 'ts-gc__mark ts-gc__mark--' + m.kind;
          node.mark.appendChild(icon(m.kind));
          node.label.className = 'ts-gc__label';
          node.reward = document.createElement('span');
          node.reward.className = 'ts-gc__reward';
          node.at = document.createElement('span');
          node.at.className = 'ts-gc__at';
          node.short = document.createElement('span');
          node.short.className = 'ts-gc__short';
          node.label.appendChild(node.reward);
          node.label.appendChild(node.at);
          node.label.appendChild(node.short);
          marksEl.appendChild(node.mark);
          labelsEl.appendChild(node.label);
          nodes[key] = node;
        }
        node.reward.textContent = rewardLabel(m);
        node.at.textContent = m.kind === 'pct' ? bottleWord(m.n) : money(m.amount);
        node.short.textContent = m.kind === 'pct' ? m.n + ' ' + SHORT_BOTTLE : money(m.amount);
        var val = node.mark.querySelector('.ts-gc__pct-val');
        if (val) val.textContent = Math.round(m.pct) + '%';
        node.mark.style.setProperty('--x', String(m.x));
        node.label.style.setProperty('--x', String(m.x));
        var was = node.mark.classList.contains('is-reached');
        node.mark.classList.toggle('is-reached', m.reached);
        node.mark.classList.toggle('is-next', track.next === m);
        node.label.classList.toggle('is-reached', m.reached);
        if (started && m.reached && !was) {
          node.mark.classList.remove('is-pop');
          void node.mark.offsetWidth;
          node.mark.classList.add('is-pop');
        }
      });
      Object.keys(nodes).forEach(function (key) {
        if (seen[key]) return;
        nodes[key].mark.remove();
        nodes[key].label.remove();
        delete nodes[key];
      });

      // More than 4 rewards: labels alternate between two rows by position, so neighbours never touch.
      var byX = track.markers.slice().sort(function (a, b) { return a.x - b.x; });
      var stagger = byX.length > 4;
      labelsEl.classList.toggle('is-staggered', stagger);
      byX.forEach(function (m, i) {
        var n = nodes[m.kind + ':' + (m.kind === 'pct' ? m.n : m.amount)];
        if (n) n.label.classList.toggle('is-low', stagger && i % 2 === 1);
      });

      var f = track.fill;
      fillEl.style.width = f >= 1 ? '100%' : f <= 0 ? '0px' : 'calc(' + f + ' * (100% - var(--gc-mark)) + var(--gc-mark) / 2)';
      root.classList.toggle('is-done', track.done);

      var nx = track.next;
      if (!nx) writeLine(t.done, {});
      else if (nx.kind === 'pct') writeLine(t.bottles, { count: bottleWord(nx.n - bottles), reward: rewardLabel(nx), pct: pct(nx.pct) });
      else writeLine(nx.kind === 'gift' ? t.gift : t.ship, { amount: money(Math.ceil((nx.amount - cents) / 100) * 100), reward: rewardLabel(nx) });

      root.classList.add('is-ready');
      started = true;
      return true;
    }

    function update() {
      if (!steps.length) steps = readSteps();
      return render();
    }

    function applyCart(c) {
      if (!c || typeof c.total_price !== 'number' || !c.items) return;
      bottles = bottlesIn(c.items);
      cents = c.total_price;
      if (root.isConnected) update();
    }

    function refreshCart() {
      var base = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
      fetch(base + 'cart.js', { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(applyCart)
        .catch(function () {});
    }

    function pollKite(tries) {
      if (!root.isConnected) return;
      var found = readKite(market);
      if (found.length) {
        kite = found;
        update();
        return;
      }
      if (tries < 24) {
        setTimeout(function () { pollKite(tries + 1); }, 500);
        return;
      }
      // Kite never came: the bar lives on bottle steps alone, or goes when there are none.
      if (!update()) root.remove();
    }

    update();
    refreshCart();
    pollKite(0);

    if (typeof subscribe === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
      subscribe(PUB_SUB_EVENTS.cartUpdate, function (e) {
        if (!root.isConnected) return;
        // The drawer publishes the whole cart; an add publishes only the added line, so fetch the cart then.
        if (e && e.cartData && typeof e.cartData.total_price === 'number' && e.cartData.items) applyCart(e.cartData);
        else refreshCart();
      });
    }
    window.addEventListener('pageshow', function (e) { if (e.persisted) refreshCart(); });
  }

  function startAll() { document.querySelectorAll('[data-ts-gc]').forEach(init); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startAll);
  else startAll();
  document.addEventListener('shopify:section:load', startAll);
})();
