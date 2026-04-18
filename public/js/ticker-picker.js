// ── Ticker autocomplete component ─────────────────────────────────────────────
// Usage: x-data="tickerPicker('fieldName', callback)"
// Reads watchlist from the parent app() via Alpine.$root context
function tickerPicker(fieldName, onSelect) {
  const MAX_EMPTY = 80;
  const MAX_FILTER = 60;

  return {
    query: '',
    open: false,
    highlighted: -1,
    suggestions: [],

    init() {
      this.$nextTick(() => {
        const v = this._app?.[fieldName];
        if (v && typeof v === 'string') this.query = v;
      });
    },
    // Reference to parent app state
    get _app() { return Alpine.store ? null : document.querySelector('[x-data="app()"]')?._x_dataStack?.[0]; },
    /** WATCHLIST file + toàn bộ DB; fallback active scanner nếu chưa tải xong. */
    get _universe() {
      try {
        const u = window.__tickerPickerUniverse__;
        if (Array.isArray(u) && u.length) return u;
        return window.__watchlist__ || [];
      } catch { return []; }
    },
    get _signalSummary() {
      try { return window.__signalSummary__ || {}; } catch { return {}; }
    },
    get signalSummary() { return this._signalSummary; },

    onInput() {
      this.open = true;
      this.highlighted = -1;
      const q = this.query.toUpperCase().trim();
      const wl = this._universe;
      const nameU = (s) => String(s.name || '').toUpperCase();
      const secU = (s) => String(s.sector || '').toUpperCase();
      if (!q) {
        const withSig = wl.filter((s) => this._signalSummary[s.ticker]);
        const without = wl.filter((s) => !this._signalSummary[s.ticker]);
        this.suggestions = [...withSig, ...without].slice(0, MAX_EMPTY);
      } else {
        this.suggestions = wl
          .filter(
            (s) =>
              s.ticker.startsWith(q) ||
              nameU(s).includes(q) ||
              secU(s).includes(q) ||
              s.ticker.includes(q),
          )
          .slice(0, MAX_FILTER);
      }
    },
    onBlur() { setTimeout(() => { this.open = false; }, 150); },
    moveDown() {
      if (!this.open) { this.onInput(); return; }
      this.highlighted = Math.min(this.highlighted + 1, this.suggestions.length - 1);
      this.scrollToHighlighted();
    },
    moveUp() {
      this.highlighted = Math.max(this.highlighted - 1, -1);
      this.scrollToHighlighted();
    },
    scrollToHighlighted() {
      this.$nextTick(() => {
        const el = this.$el.querySelector(`.ticker-dropdown div:nth-child(${this.highlighted + 1})`);
        if (el) el.scrollIntoView({ block: 'nearest' });
      });
    },
    selectHighlighted() {
      if (this.highlighted >= 0 && this.suggestions[this.highlighted]) {
        this.selectItem(this.suggestions[this.highlighted]);
      } else if (this.suggestions.length === 1) {
        this.selectItem(this.suggestions[0]);
      } else {
        const q = this.query.toUpperCase().trim();
        const match = this._universe.find((s) => s.ticker === q);
        if (match) this.selectItem(match);
        else if (/^[A-Z][A-Z0-9]{1,14}$/.test(q)) this.applyRawTicker(q);
      }
    },
    applyRawTicker(ticker) {
      this.query = ticker;
      this.open = false;
      this.highlighted = -1;
      const appEl = this.$el.closest('[x-data]');
      if (appEl && appEl._x_dataStack) {
        const parentData = appEl._x_dataStack.find((d) => fieldName in d);
        if (parentData) parentData[fieldName] = ticker;
      }
      if (onSelect) onSelect();
    },
    selectItem(stock) {
      this.applyRawTicker(stock.ticker);
    },
    clear() {
      this.query = '';
      this.open = false;
      const appEl = this.$el.closest('[x-data]');
      if (appEl && appEl._x_dataStack) {
        const parentData = appEl._x_dataStack.find(d => fieldName in d);
        if (parentData) parentData[fieldName] = '';
      }
      this.$refs.input.focus();
    },
  };
}
