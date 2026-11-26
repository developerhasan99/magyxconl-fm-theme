/*
 * Gift wrap add-on (snippets/gift-wrap.liquid): one per order, quantity always 0 or 1 via /cart/update.js.
 * <gift-wrap>     cart drawer card; data-fix (0|1) from Liquid is applied on connect (lone wrap -> 0, qty > 1 -> 1).
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
    all('gift-wrap').forEach((el) => el.toggleAttribute('aria-busy', on));
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
        publish(PUB_SUB_EVENTS.cartUpdate, { source: 'cart-items', cartData: state });
      })
      .catch(() => all('gift-wrap input').forEach((el) => { el.checked = !qty; }))
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
})();
