/*
 * Gift wrap add-on (snippets/gift-wrap.liquid): one per order, quantity always 0 or 1 via /cart/update.js.
 * <gift-wrap>     cart drawer card; data-fix (0|1) from Liquid is applied on connect (lone wrap -> 0, qty > 1 -> 1).
 * <gift-wrap-pdp> product page card; with an empty cart the tick is only remembered and applied by afterAdd(),
 *                 called on product-form's cartUpdate event or directly by custom add-to-cart fetches.
 * Repaints only the drawer's .drawer__inner and the bubble (never renderContents/open, so the drawer stays shut),
 * then publishes the full cart as source 'cart-items' (the drawer's own listener ignores that source).
 * Needs global.js (fetchConfig, cartSectionsUrl, cartTranslateSections), pubsub.js and constants.js.
 */
(() => {
  const SECTIONS = ['cart-drawer', 'cart-icon-bubble'];
  const parse = (html, sel) => new DOMParser().parseFromString(html, 'text/html').querySelector(sel);
  const all = (sel) => document.querySelectorAll(sel);
  let busy = false;
  const setBusy = (on) => {
    busy = on;
    all('gift-wrap, gift-wrap-pdp').forEach((el) => el.toggleAttribute('aria-busy', on));
  };

  const setWrap = (id, qty) => {
    setBusy(true);
    return fetch(routes.cart_update_url, {
      ...fetchConfig(),
      body: JSON.stringify({ updates: { [id]: qty }, sections: SECTIONS, sections_url: cartSectionsUrl() }),
    })
      .then((r) => r.json())
      .then((state) => {
        if (!state.items) throw new Error(state.description || 'cart update failed');
        // On a translated page the sections come back through the page's own path (global.js).
        return cartTranslateSections(state.sections, SECTIONS).then((sections) => ({ ...state, sections }));
      })
      .then((state) => {
        const inner = document.querySelector('#CartDrawer .drawer__inner');
        const bubble = document.getElementById('cart-icon-bubble');
        const drawerHtml = state.sections && state.sections['cart-drawer'];
        const bubbleHtml = state.sections && state.sections['cart-icon-bubble'];
        if (inner && drawerHtml) inner.innerHTML = parse(drawerHtml, '.drawer__inner').innerHTML;
        if (bubble && bubbleHtml) bubble.innerHTML = parse(bubbleHtml, '.shopify-section').innerHTML;
        document.querySelector('cart-drawer')?.classList.toggle('is-empty', state.item_count === 0);
        const inCart = state.items.some((i) => String(i.variant_id) === String(id));
        all('gift-wrap-pdp input').forEach((el) => { el.checked = inCart; });
        publish(PUB_SUB_EVENTS.cartUpdate, { source: 'cart-items', cartData: state });
      })
      .catch(() => all('gift-wrap input, gift-wrap-pdp input').forEach((el) => { el.checked = !qty; }))
      .finally(() => setBusy(false));
  };

  // While a request runs, every gift wrap checkbox ignores clicks (Space included).
  const guard = (box) => box.addEventListener('click', (e) => { if (busy) e.preventDefault(); });

  customElements.get('gift-wrap') || customElements.define('gift-wrap', class extends HTMLElement {
    connectedCallback() {
      const box = this.querySelector('input');
      const id = this.dataset.variant;
      guard(box);
      box.addEventListener('change', () => {
        setWrap(id, box.checked ? 1 : 0).then(() => document.querySelector('gift-wrap input')?.focus());
      });
      if (this.dataset.fix !== undefined && !busy) setWrap(id, Number(this.dataset.fix));
    }
  });

  customElements.get('gift-wrap-pdp') || customElements.define('gift-wrap-pdp', class extends HTMLElement {
    connectedCallback() {
      const box = this.querySelector('input');
      guard(box);
      box.addEventListener('change', () => {
        if (!document.querySelector('cart-drawer.is-empty')) setWrap(this.dataset.variant, box.checked ? 1 : 0);
      });
      this.unsubscribe = subscribe(PUB_SUB_EVENTS.cartUpdate, (e) => {
        // Only the first card acts, so two buy boxes on one page don't send two requests.
        if (e.source === 'product-form' && document.querySelector('gift-wrap-pdp') === this) this.afterAdd();
      });
    }
    disconnectedCallback() { this.unsubscribe?.(); }
    // ponytail: runs alongside the drawer's own refresh after an add; if that older fetch lands last the totals
    // can lag one update (same as the reference theme). Await the drawer refresh if it shows up in testing.
    afterAdd() {
      return this.querySelector('input').checked ? setWrap(this.dataset.variant, 1) : Promise.resolve();
    }
  });
})();
