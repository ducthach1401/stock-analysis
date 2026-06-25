/** Alpine x-data — giao diện chính (API, chart, tab) */
function app() {
  const urlTab = readTabFromUrl();
  const urlTicker = readTickerFromUrl();
  return {
    tab: urlTab || readSavedTab(),
    tabs: [
      {
        id: 'dashboard',
        label: 'Dashboard',
        icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V9m8 10V5m8 14v-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M3 19h18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
      },
      {
        id: 'market',
        label: 'Thị trường',
        icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10h16M6 10v8m4-8v8m4-8v8m4-8v8M3 18h18M12 4l8 4H4l8-4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      },
      {
        id: 'derivatives',
        label: 'Phái sinh',
        icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6v12h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 9l4 4 3-3 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      },
      {
        id: 'scanner',
        label: 'Scanner',
        icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 15l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
      },
      {
        id: 'signals',
        label: 'Tín hiệu',
        icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L5 13h6l-1 9 9-13h-6l1-7z" fill="currentColor"/></svg>',
      },
      {
        id: 'stocks',
        label: 'Cổ phiếu',
        icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18h16M6 15l4-4 3 3 5-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      },
      {
        id: 'guide',
        label: 'Chiến lược',
        icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h10a3 3 0 013 3v13H8a3 3 0 01-3-3V4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 8h7M8 12h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
      },
      {
        id: 'watchlist',
        label: 'Watchlist',
        icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 16.9 6.6 19.8l1-6.1-4.4-4.3 6.1-.9L12 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
      },
    ],
    loading: false,
    scanning: false,
    openPositions: [],
    closedPositions: [],
    watchlist: [],
    signalSummary: {},
    searchTicker: '',
    signals: [],
    signalTicker: urlTicker || readSavedTicker(STOCK_SIGNAL_TICKER_KEY),
    allChartSignals: [], // tất cả tín hiệu lịch sử (cho chart markers)
    signalStats: null, // { total, bullish, bearish, topTypes }
    /** GET /signals/backtest/summary — compound 12 tháng (đóng lệnh), fullPeriod trên từng dòng */
    backtestLeaderboard: { good: [], bad: [], total: 0 },
    /** GET /signals/:ticker/backtest/runs */
    backtestRuns: [],
    /** GET /signals/:ticker/backtest/runs/:id — gồm trades */
    backtestDetail: null,
    /** Thứ tự mã (vốn hoá + thanh khoản) từ API — dùng sort UI */
    signalOrderTickers: [],
    formingSetups: { tradingDate: '', items: [] },
    formingLoading: false,
    /** GET /scanner/latest-signals — feed tín hiệu mới nhất (watchlist) */
    scannerLatestSignals: [],
    currentRec: null,
    priceHistory: [],
    priceHistoryHasMore: false,
    priceHistoryLoadingMore: false,
    chartOlderLoading: false,
    /** Sau lazy-load nến cũ: dịch viewport để không nhảy về fitContent */
    _chartScrollRestore: null,
    /** Viewport logic gần nhất (main chart) — giữ khi render lại trước khi lazy-load xong */
    chartViewport: null,
    /** Mã tương ứng với barData hiện tại (để merge khi refresh) */
    _barDataTicker: '',
    latestBar: null,
    priceTicker: urlTicker || readSavedTicker(STOCK_PRICE_TICKER_KEY),
    barData: [],
    /** Chỉ số VNINDEX / VN30 — tab Thị trường */
    marketBarVni: [],
    marketBarVn30: [],
    /** Tín hiệu full range cho marker (GET .../chart) */
    marketSignalsVni: [],
    marketSignalsVn30: [],
    /** 20 tín hiệu mới nhất / chỉ số — hiển thị danh sách */
    marketLatestVni: [],
    marketLatestVn30: [],
    marketLoading: false,
    /** Đồng bộ queue VNINDEX/VN30 + phân tích nến */
    marketSyncLoading: false,
    /** Lazy-load nến cũ: còn dữ liệu phía trước / đang fetch */
    marketHasMoreVni: true,
    marketHasMoreVn30: true,
    marketOlderLoadingVni: false,
    marketOlderLoadingVn30: false,
    /** Sau lazy-load: giữ viewport chart (slot + logical range + số nến thêm) */
    _marketScrollRestore: null,
    /** { vni: { main, rsi, macd }, vn30: { ... } } */
    marketCharts: {},
    _marketChartRuntime: { vni: null, vn30: null },
    /** Phái sinh VN30 — nến chỉ số intraday (5m / 15m), tham chiếu vào lệnh */
    derivBars: [],
    /** Khớp `derivBars` với lần tải (đổi khung → tải lại). */
    derivBarsResolution: null,
    /** 5 | 15 | 1H — API /stocks/VN30/intraday-index */
    derivResolution: '5',
    derivLoading: false,
    derivAnalysis: null,
    derivDecisionLatest: null,
    derivDecisionHistory: [],
    derivFilterDate: '',
    derivFilterMonth: '',
    derivDecisionLoading: false,
    derivDecisionScanLoading: false,
    derivCharts: null,
    /** Intraday: kéo trái tải thêm nến cũ (chunk theo ngày, tới khi API trả rỗng / trùng hết) */
    derivHasMoreOlder: true,
    derivOlderLoading: false,
    derivSyncMonthLoading: false,
    _derivScrollRestore: null,
    _derivChartRuntime: null,
    /** Trong phiên: tự làm mới chart + tín hiệu định kỳ khi đang mở tab Phái sinh */
    _derivativesPollTimer: null,
    _derivativesPollFirst: null,
    derivSignalsLatest: [],
    /** Backtest chiến lược LONG */
    btFrom: new Date(new Date().getFullYear() + '-01-01')
      .toISOString()
      .slice(0, 10),
    btTo: new Date().toISOString().slice(0, 10),
    btTrailing: true,
    btRsicap: true,
    btLoading: false,
    btResult: null,
    btError: '',
    _btChart: null,
    lwChart: null,
    rsiChart: null,
    macdChart: null,
    _mainChartRuntime: null,
    indicators: { rsi: null, macd: null, macdSignal: null, macdHist: null },
    actionLoading: {
      sync: false,
      syncFull: false,
      scan: false,
      recommend: false,
      syncOne: false,
      syncOneFull: false,
      summary: false,
      analyze: false,
      analyzeHistory: false,
      analyzeHistoryAll: false,
      backtest: false,
    },
    actionLog: [],
    toast: { show: false, msg: '', type: 'success' },
    /** Menu ☰: Cổ phiếu, Chiến lược, Watchlist, thông báo, làm mới, giao diện */
    moreMenuOpen: false,
    // ── Watchlist management ──────────────────────────────────────────────
    wlItems: [], // toàn bộ (kể inactive)
    wlFilter: 'all', // 'all' | 'active' | 'inactive'
    wlSearch: '',
    wlAddForm: { show: false, ticker: '', name: '', sector: '' },
    wlCheckingLiquidity: false,
    wlLiquidityLoading: false,
    wlLiquidityPanel: false,
    wlLiquidityCandidates: [],
    wlLiquidityMeta: null,
    wlLiquidityExcludeDb: false,
    wlAddSubmitting: false,
    darkMode: localStorage.getItem('darkMode') === 'true',
    /** Bật: hiện chữ loại tín hiệu (VD RSI OVERSOLD). Tắt: chỉ mũi tên mua/bán. */
    chartSignalLabels: localStorage.getItem('chartSignalLabels') !== 'false',
    /** Bật/tắt lớp vẽ trên chart (localStorage, mặc định bật) */
    chartShowEma: localStorage.getItem('chartShowEma') !== 'false',
    chartShowSR: localStorage.getItem('chartShowSR') !== 'false',
    /** Tab Phái sinh — BB + nén (5m/15m), khớp logic server: BW &lt; 8% */
    derivShowBb: localStorage.getItem('derivShowBb') !== 'false',

    /** PWA + thông báo trình duyệt */
    pwaDeferredInstall: null,
    showPwaInstallBanner: false,
    /** Điện thoại + không standalone: màn cài (trừ khi đã bỏ qua trong localStorage) */
    pwaMandatoryGate: computePwaMandatoryGate(),
    /** Đồng bộ với localStorage — chỉ true sau khi người dùng bấm bỏ qua màn cài */
    pwaGateSkipped:
      typeof localStorage !== 'undefined' &&
      localStorage.getItem(PWA_GATE_SKIP_KEY) === '1',
    /** Gợn UI hướng dẫn Safari vs Chrome / Android */
    pwaIosUi: typeof navigator !== 'undefined' && isIosTouchDevice(),
    pwaAndroidUi: typeof navigator !== 'undefined' && isAndroidUi(),
    /** safari | chrome | firefox | edge | opera | other — chỉ meaningful khi pwaIosUi */
    pwaIosBrowser:
      typeof navigator !== 'undefined' ? getIosBrowserKind() : 'other',
    pwaCanWebShare:
      typeof navigator !== 'undefined' && typeof navigator.share === 'function',
    browserNotify:
      typeof localStorage !== 'undefined' &&
      localStorage.getItem('browserNotify') === 'true',
    notificationPermission:
      typeof Notification !== 'undefined' ? Notification.permission : 'denied',

    // ── Auth ────────────────────────────────────────────────────────────
    isAdmin: false,
    loginModal: {
      show: false,
      username: '',
      password: '',
      error: '',
      loading: false,
    },

    async doLogin() {
      this.loginModal.loading = true;
      this.loginModal.error = '';
      try {
        const res = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: this.loginModal.username,
            password: this.loginModal.password,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          this.loginModal.error =
            err?.message || 'Sai tên đăng nhập hoặc mật khẩu';
          return;
        }
        const data = await res.json();
        localStorage.setItem('adminToken', data.accessToken);
        this.isAdmin = true;
        this.loginModal = {
          show: false,
          username: '',
          password: '',
          error: '',
          loading: false,
        };
        this.showToast('Đăng nhập thành công', 'success');
      } catch (e) {
        this.loginModal.error = 'Không thể kết nối đến server';
      } finally {
        this.loginModal.loading = false;
      }
    },

    logout() {
      localStorage.removeItem('adminToken');
      this.isAdmin = false;
      this.showToast('Đã đăng xuất', 'info');
    },

    // Wrapper for authenticated fetch — shows login modal on 401
    async authFetch(url, options = {}) {
      const token = localStorage.getItem('adminToken');
      const res = await fetch(url, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        this.isAdmin = false;
        localStorage.removeItem('adminToken');
        this.loginModal.show = true;
        this.loginModal.error =
          'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
        throw new Error('Unauthorized');
      }
      return res;
    },

    /** Tab hiển thị trên thanh ngang (ẩn Cổ phiếu, Chiến lược, Watchlist — trong menu ☰). */
    mainNavTabs() {
      const hide = new Set(['stocks', 'guide', 'watchlist']);
      return this.tabs.filter((t) => !hide.has(t.id));
    },

    setTab(id) {
      if (!STOCK_APP_TAB_IDS.includes(id)) return;
      this.moreMenuOpen = false;
      this.tab = id;
      try {
        sessionStorage.setItem('stockAnalysisTab', id);
      } catch {}
      this.updateShareUrl();
      this.$dispatch('tab-changed', id);
    },

    /** Đồng bộ ?tab= & ?ticker= trên thanh địa chỉ (deep link) */
    updateShareUrl() {
      try {
        const p = new URLSearchParams();
        p.set('tab', this.tab);
        const t =
          this.tab === 'signals'
            ? this.signalTicker
            : this.tab === 'stocks'
              ? this.priceTicker
              : '';
        if (t && String(t).trim())
          p.set('ticker', String(t).trim().toUpperCase());
        const qs = p.toString();
        const next = qs
          ? `${window.location.pathname}?${qs}`
          : window.location.pathname;
        if (window.location.pathname + window.location.search !== next) {
          history.replaceState(null, '', next);
        }
      } catch {}
    },

    persistSignalTicker(v) {
      try {
        if (v)
          sessionStorage.setItem(
            STOCK_SIGNAL_TICKER_KEY,
            String(v).toUpperCase(),
          );
        else sessionStorage.removeItem(STOCK_SIGNAL_TICKER_KEY);
      } catch {}
    },
    persistPriceTicker(v) {
      try {
        if (v)
          sessionStorage.setItem(
            STOCK_PRICE_TICKER_KEY,
            String(v).toUpperCase(),
          );
        else sessionStorage.removeItem(STOCK_PRICE_TICKER_KEY);
      } catch {}
    },

    /** Nhãn loại tín hiệu (VN) — dùng chart, scanner, tab Tín hiệu */
    signalTypeLabelVi(type) {
      if (type == null || type === '') return '';
      const t = String(type).trim();
      return SIGNAL_LABELS_VI[t] || t.replace(/_/g, ' ');
    },

    /**
     * BEARISH trong summary không phải lúc nào cũng là “phân phối đỉnh”
     * (có thể là EMA nền giảm, MACD cross, v.v.) — tránh nhãn gây hiểu nhầm.
     */
    bearishSummaryLabel(s) {
      if (!s?.topSignal) return 'Giảm';
      const m = {
        DISTRIBUTION_BAR: 'Phân phối',
        VOLUME_CLIMAX_TOP: 'Climax đỉnh',
        FAILED_BREAKOUT: 'Bull trap',
        MINERVINI_EXTENDED: 'Quá xa MA50',
        RSI_BEARISH_DIVERGENCE: 'Phân kỳ RSI',
        MACD_BEARISH_DIVERGENCE: 'Phân kỳ MACD',
        EMA_DEATH_CROSS: 'Death cross',
        MA_DEATH_CROSS: 'Death cross (legacy)',
        SUPPORT_BREAKDOWN: 'Thủng hỗ trợ',
        EMA_BEARISH_STACK: 'Nền giảm',
        MACD_BEARISH_CROSS: 'MACD giảm',
        RSI_MOMENTUM_DOWN: 'Momentum giảm',
        RSI_OVERBOUGHT: 'Quá mua',
        BEARISH_ENGULFING: 'Nến đỏ',
        SHOOTING_STAR: 'Shooting star',
        BB_BREAKOUT_UP: 'BB trên (overbought)',
      };
      return (
        m[s.topSignal] ??
        this.signalTypeLabelVi(s.topSignal).split(' ').slice(0, 2).join(' ')
      );
    },

    toggleDark() {
      this.darkMode = !this.darkMode;
      localStorage.setItem('darkMode', this.darkMode);
      this.applyAppColorScheme();
      this.updateChartTheme();
    },

    applyAppColorScheme() {
      try {
        const m = document.querySelector(
          'meta[name="theme-color"]:not([media])',
        );
        if (m) m.setAttribute('content', this.darkMode ? '#0b1211' : '#0f766e');
        const cs = document.querySelector('meta[name="color-scheme"]');
        if (cs) cs.setAttribute('content', this.darkMode ? 'dark' : 'light');
      } catch {}
    },

    persistChartSignalLabels() {
      try {
        localStorage.setItem(
          'chartSignalLabels',
          this.chartSignalLabels ? 'true' : 'false',
        );
      } catch {}
      this.$nextTick(() => {
        if (this.barData.length && this.signalTicker) {
          requestAnimationFrame(() => this.renderChart(this.signalTicker));
        }
        if (
          this.tab === 'market' &&
          (this.marketBarVni.length || this.marketBarVn30.length)
        ) {
          requestAnimationFrame(() => {
            if (this.marketBarVni.length) {
              this.renderMarketIndexPanel(this.marketBarVni, 'vni');
            }
            if (this.marketBarVn30.length) {
              this.renderMarketIndexPanel(this.marketBarVn30, 'vn30');
            }
          });
        }
      });
    },

    persistChartOverlays() {
      try {
        localStorage.setItem(
          'chartShowEma',
          this.chartShowEma ? 'true' : 'false',
        );
        localStorage.setItem(
          'chartShowSR',
          this.chartShowSR ? 'true' : 'false',
        );
        localStorage.setItem(
          'derivShowBb',
          this.derivShowBb ? 'true' : 'false',
        );
      } catch {}
      this.$nextTick(() => {
        if (this.barData.length && this.signalTicker) {
          requestAnimationFrame(() => this.renderChart(this.signalTicker));
        }
        if (
          this.tab === 'market' &&
          (this.marketBarVni.length || this.marketBarVn30.length)
        ) {
          requestAnimationFrame(() => {
            if (this.marketBarVni.length) {
              this.renderMarketIndexPanel(this.marketBarVni, 'vni');
            }
            if (this.marketBarVn30.length) {
              this.renderMarketIndexPanel(this.marketBarVn30, 'vn30');
            }
          });
        }
        if (this.tab === 'derivatives' && this.derivBars.length) {
          requestAnimationFrame(() => this.renderDerivIntradayPanel());
        }
      });
    },

    updateChartTheme() {
      const dark = this.darkMode;
      const chartBg = dark ? '#09090b' : '#ffffff';
      const textColor = dark ? '#71717a' : '#64748b';
      const gridColor = dark ? '#27272a' : '#f1f5f9';
      const borderColor = dark ? '#3f3f46' : '#e2e8f0';
      const opts = {
        layout: { background: { color: chartBg }, textColor },
        grid: {
          vertLines: { color: gridColor },
          horzLines: { color: gridColor },
        },
        timeScale: { borderColor },
      };
      if (this.lwChart) this.lwChart.applyOptions(opts);
      if (this.rsiChart) this.rsiChart.applyOptions(opts);
      if (this.macdChart) this.macdChart.applyOptions(opts);
      ['vni', 'vn30'].forEach((slot) => {
        const k = this.marketCharts[slot];
        if (!k) return;
        [k.main, k.rsi, k.macd].forEach((c) => c?.applyOptions(opts));
      });
      const dk = this.derivCharts;
      if (dk) {
        [dk.main, dk.rsi, dk.macd].forEach((c) => c?.applyOptions(opts));
      }
    },

    async init() {
      this.applyAppColorScheme();
      this.restoreBacktestParamsFromCache();
      // Link ?tab=&ticker= đã áp vào state; lưu session cho lần sau
      if (urlTab) {
        try {
          sessionStorage.setItem('stockAnalysisTab', urlTab);
        } catch {}
      }
      if (urlTicker) {
        this.persistSignalTicker(urlTicker);
        this.persistPriceTicker(urlTicker);
      }
      // Verify stored token
      const token = localStorage.getItem('adminToken');
      if (token) {
        try {
          const res = await fetch('/auth/me', {
            headers: { Authorization: `Bearer ${token}` },
          });
          this.isAdmin = res.ok;
          if (!res.ok) localStorage.removeItem('adminToken');
        } catch {
          this.isAdmin = false;
        }
      }
      this.$watch('signalTicker', (v) => {
        this.persistSignalTicker(v);
        if (this.tab === 'signals') this.updateShareUrl();
      });
      this.$watch('priceTicker', (v) => {
        this.persistPriceTicker(v);
        if (this.tab === 'stocks') this.updateShareUrl();
      });
      try {
        const dr = localStorage.getItem('derivResolution');
        if (dr === '4H' || dr === '1D') {
          this.derivResolution = '1H';
          try {
            localStorage.setItem('derivResolution', '1H');
          } catch {}
        } else if (dr && ['5', '15', '1H'].includes(dr)) {
          this.derivResolution = dr;
        }
      } catch {}
      await this.refreshAll();
      await this.loadWatchlist();
      if (this.signalTicker) {
        window.dispatchEvent(
          new CustomEvent('signal-ticker-sync', {
            detail: { ticker: this.signalTicker },
          }),
        );
      }
      // Giữ hành vi như trước: vào tab Tín hiệu / Cổ phiếu (kể cả từ ?tab=&ticker=) là tải chart + khuyến nghị, không cần bấm thêm
      if (this.tab === 'signals' && this.signalTicker) {
        await this.loadSignals();
      } else if (this.tab === 'stocks' && this.priceTicker) {
        await this.loadStockData();
      } else if (this.tab === 'market') {
        await this.loadMarketCharts();
      } else if (this.tab === 'derivatives') {
        await Promise.all([
          this.loadDerivIntraday({ silent: true }),
          this.loadDerivativeDecisions(),
        ]);
      }
      this.$nextTick(() => {
        this.updateShareUrl();
        this.$dispatch('tab-changed', this.tab);
      });
      this.setupPwa();
      this.$watch('pwaMandatoryGate', (on) => {
        try {
          document.documentElement.classList.toggle('overflow-hidden', !!on);
          document.body.classList.toggle('overflow-hidden', !!on);
          document.documentElement.classList.toggle('pwa-gate-open', !!on);
        } catch {}
      });
      if (this.pwaMandatoryGate) {
        try {
          document.documentElement.classList.add('overflow-hidden');
          document.body.classList.add('overflow-hidden');
          document.documentElement.classList.add('pwa-gate-open');
        } catch {}
      }
      this.$watch('tab', (t) => {
        if (t === 'derivatives') this.startDerivativesSessionPoll();
        else this.stopDerivativesSessionPoll();
      });
      this.$watch('derivResolution', () => {
        if (this.tab === 'derivatives') this.startDerivativesSessionPoll();
      });
      if (this.tab === 'derivatives') this.startDerivativesSessionPoll();
    },

    /** T2–T6, phiên khớp lệnh: 9:30–11:30 và 13:00–14:45 (Asia/Ho_Chi_Minh) — khớp server `isVnCashMarketSessionOpen`. */
    _vnCashMarketSessionOpen() {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Ho_Chi_Minh',
        weekday: 'short',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
      });
      const parts = fmt.formatToParts(new Date());
      const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
      const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      const weekday = wdMap[get('weekday')] ?? 0;
      if (weekday === 0 || weekday === 6) return false;
      const hour = parseInt(get('hour'), 10);
      const minute = parseInt(get('minute'), 10);
      const h = Number.isFinite(hour) ? hour : 0;
      const m = Number.isFinite(minute) ? minute : 0;
      const inMorning =
        (h === 9 && m >= 30) || h === 10 || (h === 11 && m <= 30);
      const inAfternoon = h === 13 || (h === 14 && m <= 45);
      return inMorning || inAfternoon;
    },

    /** Chu kỳ làm mới trong phiên: 5m/15m nhanh; 1H nhẹ hơn. */
    derivativesPollIntervalMs() {
      const r = this.derivResolution;
      if (r === '5' || r === '15') return 25 * 1000;
      if (r === '1H') return 90 * 1000;
      return 15 * 60 * 1000;
    },

    stopDerivativesSessionPoll() {
      if (this._derivativesPollTimer) {
        clearInterval(this._derivativesPollTimer);
        this._derivativesPollTimer = null;
      }
      if (this._derivativesPollFirst) {
        clearTimeout(this._derivativesPollFirst);
        this._derivativesPollFirst = null;
      }
    },

    tickDerivativesSessionSync() {
      if (this.tab !== 'derivatives') return;
      void this.loadDerivativeDecisions({ silent: true, forceNetwork: true });
      // Quyết định/lệnh luôn đồng bộ realtime (kể cả ngoài phiên) để UI tự phản ánh OPEN/CLOSED.
      if (!this._vnCashMarketSessionOpen()) return;
      // Chart intraday chỉ kéo nhanh trong phiên để tránh tải mạng không cần thiết.
      void this.loadDerivIntraday({
        silent: true,
        reset: false,
        fast: true,
        forceNetwork: true,
      });
    },

    startDerivativesSessionPoll() {
      this.stopDerivativesSessionPoll();
      if (this.tab !== 'derivatives') return;
      const ms = this.derivativesPollIntervalMs();
      this._derivativesPollTimer = setInterval(
        () => this.tickDerivativesSessionSync(),
        ms,
      );
      if (this._vnCashMarketSessionOpen()) {
        this._derivativesPollFirst = setTimeout(
          () => this.tickDerivativesSessionSync(),
          5000,
        );
      }
    },

    refreshPwaMandatoryGate() {
      try {
        this.pwaGateSkipped =
          typeof localStorage !== 'undefined' &&
          localStorage.getItem(PWA_GATE_SKIP_KEY) === '1';
      } catch {
        this.pwaGateSkipped = false;
      }
      this.pwaMandatoryGate = computePwaMandatoryGate();
    },

    skipPwaMandatoryGate() {
      try {
        localStorage.setItem(PWA_GATE_SKIP_KEY, '1');
      } catch {}
      this.pwaGateSkipped = true;
      this.refreshPwaMandatoryGate();
      this.showToast(
        'Đang dùng trên trình duyệt. Hiện lại màn cài: menu ☰ → «Hiện lại màn cài app».',
        'info',
      );
    },

    clearPwaGateSkip() {
      try {
        localStorage.removeItem(PWA_GATE_SKIP_KEY);
      } catch {}
      this.pwaGateSkipped = false;
      this.refreshPwaMandatoryGate();
    },

    setupPwa() {
      if (typeof window === 'undefined') return;
      this.refreshPwaMandatoryGate();
      this.lockPortraitOrientation();
      const onViewportOrDisplayMode = () => this.refreshPwaMandatoryGate();
      window.addEventListener('resize', onViewportOrDisplayMode, {
        passive: true,
      });
      try {
        window
          .matchMedia('(display-mode: standalone)')
          .addEventListener('change', onViewportOrDisplayMode);
      } catch {}
      if ('Notification' in window) {
        this.notificationPermission = Notification.permission;
      }
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      }
      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        this.pwaDeferredInstall = e;
        if (this.pwaMandatoryGate) {
          this.showPwaInstallBanner = false;
          return;
        }
        try {
          if (sessionStorage.getItem('pwaInstallDismissed') === '1') return;
        } catch {}
        this.showPwaInstallBanner = true;
      });
      window.addEventListener('appinstalled', () => {
        this.showPwaInstallBanner = false;
        this.pwaDeferredInstall = null;
        this.refreshPwaMandatoryGate();
        this.lockPortraitOrientation();
        this.showToast('Đã cài app lên thiết bị', 'success');
      });
    },

    async lockPortraitOrientation() {
      if (typeof screen === 'undefined' || !isStandaloneDisplayMode()) return;
      const orientation = screen.orientation;
      if (!orientation || typeof orientation.lock !== 'function') return;
      try {
        await orientation.lock('portrait');
      } catch {}
    },

    dismissPwaBanner() {
      this.showPwaInstallBanner = false;
      try {
        sessionStorage.setItem('pwaInstallDismissed', '1');
      } catch {}
    },

    async installPwa() {
      const ev = this.pwaDeferredInstall;
      if (!ev || typeof ev.prompt !== 'function') {
        this.showToast(
          'Dùng menu trình duyệt: «Thêm vào màn hình chính» hoặc «Cài đặt app»',
          'info',
        );
        return;
      }
      ev.prompt();
      try {
        const { outcome } = await ev.userChoice;
        if (outcome === 'accepted') {
          this.showToast('Đã thêm vào màn hình chính', 'success');
        }
      } catch {}
      this.pwaDeferredInstall = null;
      this.showPwaInstallBanner = false;
      this.refreshPwaMandatoryGate();
    },

    pwaInstallInstructionHeading() {
      if (this.pwaIosUi) {
        return `Hướng dẫn — ${iosBrowserTitleVi(this.pwaIosBrowser)}`;
      }
      if (this.pwaAndroidUi)
        return 'Hướng dẫn — Android (Chrome, Samsung Internet, Edge, Brave…)';
      return 'Hướng dẫn — trình duyệt điện thoại';
    },

    async openPwaIosShareSheet() {
      if (
        typeof navigator === 'undefined' ||
        typeof navigator.share !== 'function'
      ) {
        this.showToast('Làm theo các bước trong khung dưới', 'info');
        return;
      }
      try {
        await navigator.share({
          title:
            typeof document !== 'undefined' ? document.title : 'Stock Analysis',
          text: 'Thêm Stock Analysis lên màn hình chính',
          url: typeof window !== 'undefined' ? window.location.href : '',
        });
      } catch (e) {
        if (!e || e.name !== 'AbortError') {
          this.showToast(
            'Không mở được bảng chia sẻ — làm theo bước bên dưới',
            'info',
          );
        }
      }
    },

    async toggleBrowserNotify() {
      if (!('Notification' in window)) {
        this.showToast('Trình duyệt không hỗ trợ thông báo', 'info');
        return;
      }
      this.notificationPermission = Notification.permission;
      if (Notification.permission === 'denied') {
        this.showToast(
          'Đã chặn thông báo — bật trong cài đặt trình duyệt / site',
          'info',
        );
        return;
      }
      if (Notification.permission === 'granted') {
        this.browserNotify = !this.browserNotify;
        try {
          if (this.browserNotify) localStorage.setItem('browserNotify', 'true');
          else localStorage.removeItem('browserNotify');
        } catch {}
        this.showToast(
          this.browserNotify
            ? 'Đã bật thông báo (khi tab ẩn)'
            : 'Đã tắt thông báo hệ thống',
          'success',
        );
        return;
      }
      const p = await Notification.requestPermission();
      this.notificationPermission = p;
      if (p === 'granted') {
        this.browserNotify = true;
        try {
          localStorage.setItem('browserNotify', 'true');
        } catch {}
        this.showToast(
          'Đã cấp quyền — thông báo khi bạn không mở tab',
          'success',
        );
        try {
          new Notification('Stock Analysis', {
            body: 'Thông báo đã bật.',
            icon: '/icons/icon-192.png',
          });
        } catch {}
      } else {
        this.browserNotify = false;
        try {
          localStorage.removeItem('browserNotify');
        } catch {}
      }
    },

    async refreshAll() {
      this.loading = true;
      await Promise.all([
        this.loadOpenPositions(),
        this.loadClosedPositions(),
        this.loadBacktestLeaderboard(),
      ]);
      this.loading = false;
    },

    async loadBacktestLeaderboard() {
      const r = await fetch('/signals/backtest/summary?limit=10')
        .then((res) => res.json())
        .catch(() => null);
      if (r && typeof r.total === 'number') {
        this.backtestLeaderboard = {
          good: Array.isArray(r.good) ? r.good : [],
          bad: Array.isArray(r.bad) ? r.bad : [],
          total: r.total,
        };
      } else {
        this.backtestLeaderboard = { good: [], bad: [], total: 0 };
      }
    },

    async loadOpenPositions() {
      const r = await fetch('/positions/open')
        .then((r) => r.json())
        .catch(() => []);
      this.openPositions = Array.isArray(r) ? r : [];
    },

    async loadClosedPositions() {
      const r = await fetch('/positions/closed')
        .then((r) => r.json())
        .catch(() => []);
      this.closedPositions = Array.isArray(r) ? r : [];
    },

    async loadWatchlist() {
      const r = await fetch('/scanner/watchlist')
        .then((res) => res.json())
        .catch(() => []);
      this.watchlist = Array.isArray(r) ? r : [];
      window.__watchlist__ = this.watchlist;
      await Promise.all([
        this.loadSignalSummary(),
        this.loadFormingSetups(),
        this.loadScannerLatestSignals(),
      ]);
      await this.loadTickerPickerUniverse();
    },

    async loadTickerPickerUniverse() {
      const r = await fetch('/watchlist/ticker-picker')
        .then((res) => res.json())
        .catch(() => []);
      window.__tickerPickerUniverse__ = Array.isArray(r) ? r : [];
    },

    async loadScannerLatestSignals() {
      const r = await fetch('/scanner/latest-signals?limit=50')
        .then((res) => res.json())
        .catch(() => ({}));
      this.scannerLatestSignals = Array.isArray(r?.signals) ? r.signals : [];
    },

    async loadFormingSetups() {
      this.formingLoading = true;
      try {
        const r = await fetch('/scanner/forming-setups')
          .then((res) => res.json())
          .catch(() => ({}));
        this.formingSetups = {
          tradingDate: r?.tradingDate || '',
          items: Array.isArray(r?.items) ? r.items : [],
        };
      } finally {
        this.formingLoading = false;
      }
    },

    async loadSignalSummary() {
      const r = await fetch('/scanner/signals-summary')
        .then((res) => res.json())
        .catch(() => ({}));
      const summary =
        r?.summary && typeof r.summary === 'object'
          ? r.summary
          : r && typeof r === 'object'
            ? r
            : {};
      const ordered = Array.isArray(r?.orderedTickers)
        ? r.orderedTickers
        : Object.keys(summary);
      this.signalSummary = summary;
      this.signalOrderTickers = ordered;
      window.__signalSummary__ = this.signalSummary;

      // Auto-select: ưu tiên blue-cap/thanh khoản (ordered), sau đó độ tin cậy, rồi |score|
      if (!this.signalTicker && Object.keys(this.signalSummary).length > 0) {
        const confVal = (c) => ({ HIGH: 3, MEDIUM: 2, LOW: 1 })[c] ?? 0;
        const ordIdx = (t) =>
          ordered.findIndex(
            (x) => String(x).toUpperCase() === String(t).toUpperCase(),
          );
        const candidates = ordered
          .map((t) => [
            t,
            this.signalSummary[t] ??
              this.signalSummary[String(t).toUpperCase()],
          ])
          .filter(([, s]) => s);
        candidates.sort((a, b) => {
          const [ta, sa] = a;
          const [tb, sb] = b;
          const ia = ordIdx(ta);
          const ib = ordIdx(tb);
          if (ia !== ib) return ia - ib;
          const dc = confVal(sb.confidence) - confVal(sa.confidence);
          if (dc !== 0) return dc;
          return Math.abs(sb.score) - Math.abs(sa.score);
        });
        const top = candidates[0];
        if (top) {
          this.signalTicker = top[0];
          window.dispatchEvent(
            new CustomEvent('signal-ticker-sync', {
              detail: { ticker: top[0] },
            }),
          );
          if (this.tab === 'signals') this.loadSignals();
        }
      }
    },

    async loadSignals() {
      if (!this.signalTicker) return;
      const t = this.signalTicker.toUpperCase();
      if (this._barDataTicker !== t) {
        this.chartViewport = null;
      }
      const MAX_CHART_BARS = 400;
      const MAX_MERGED = 900;
      const STORED_REQ = 400;
      const [sigs, rec, stored] = await Promise.all([
        fetch(`/signals/${t}`)
          .then((r) => r.json())
          .catch(() => []),
        fetch(`/signals/${t}/recommend`, { method: 'POST' })
          .then((r) => r.json())
          .catch(() => null),
        fetch(`/stocks/${t}/stored?limit=${STORED_REQ}`)
          .then((r) => r.json())
          .catch(() => []),
      ]);
      this.signals = Array.isArray(sigs) ? sigs.slice(0, 20) : [];
      this.currentRec = rec;
      let raw =
        Array.isArray(stored) && stored.length > 0
          ? stored
          : await fetch(`/stocks/${t}/history`)
              .then((r) => r.json())
              .catch(() => []);
      raw = Array.isArray(raw) ? raw : [];
      const sorted = [...raw].sort((a, b) =>
        String(a.tradingDate).localeCompare(String(b.tradingDate)),
      );
      const incoming = sorted.slice(-MAX_CHART_BARS);
      let merged = incoming;
      if (
        this._barDataTicker === t &&
        this.barData.length > 0 &&
        incoming.length > 0
      ) {
        const oldestIn = incoming[0].tradingDate;
        const oldestPrev = this.barData[0].tradingDate;
        if (String(oldestPrev) < String(oldestIn)) {
          const m = new Map(incoming.map((b) => [b.tradingDate, b]));
          for (const b of this.barData) {
            if (!m.has(b.tradingDate)) m.set(b.tradingDate, b);
          }
          merged = [...m.values()].sort((a, b) =>
            String(a.tradingDate).localeCompare(String(b.tradingDate)),
          );
          if (merged.length > MAX_MERGED) merged = merged.slice(-MAX_MERGED);
        }
      }
      this.barData = merged;
      this._barDataTicker = t;

      const from =
        this.barData.length > 0 ? this.barData[0].tradingDate : '2000-01-01';
      const chartSigs = await fetch(`/signals/${t}/chart?from=${from}`)
        .then((r) => r.json())
        .catch(() => []);
      this._applyChartSignalsPayload(chartSigs);

      await this.loadBacktestRuns();

      // Một lần vẽ sau khi có cả nến + marker (tránh destroy/recreate 2 lần → lag)
      this.$nextTick(() => requestAnimationFrame(() => this.renderChart(t)));
    },

    async loadBacktestRuns() {
      if (!this.signalTicker) {
        this.backtestRuns = [];
        this.backtestDetail = null;
        return;
      }
      const t = this.signalTicker.toUpperCase();
      const runs = await fetch(`/signals/${t}/backtest/runs?take=15`)
        .then((r) => r.json())
        .catch(() => []);
      this.backtestRuns = Array.isArray(runs) ? runs : [];
      if (this.backtestRuns.length > 0) {
        await this.loadBacktestDetail(this.backtestRuns[0].id);
      } else {
        this.backtestDetail = null;
      }
    },

    async loadBacktestDetail(runId) {
      if (!this.signalTicker || !runId) return;
      const t = this.signalTicker.toUpperCase();
      const d = await fetch(`/signals/${t}/backtest/runs/${runId}`)
        .then((r) => r.json())
        .catch(() => null);
      this.backtestDetail = d && d.id ? d : null;
    },

    async runBacktestSave() {
      if (!this.signalTicker || !this.isAdmin) return;
      this.actionLoading.backtest = true;
      const t = this.signalTicker.toUpperCase();
      try {
        await this.authFetch(`/signals/${t}/backtest/run`, { method: 'POST' });
        await this.loadBacktestRuns();
        this.showToast('Đã chạy backtest và lưu — ' + t, 'success');
      } catch (e) {
        if (e.message !== 'Unauthorized')
          this.showToast('Backtest lỗi: ' + (e.message || e), 'error');
      }
      this.actionLoading.backtest = false;
    },

    _applyChartSignalsPayload(sigs) {
      this.allChartSignals = Array.isArray(sigs) ? sigs : [];
      const bullish = this.allChartSignals.filter(
        (s) => s.direction === 'BULLISH',
      );
      const bearish = this.allChartSignals.filter(
        (s) => s.direction === 'BEARISH',
      );
      const typeCounts = {};
      this.allChartSignals.forEach((s) => {
        typeCounts[s.type] = (typeCounts[s.type] || 0) + 1;
      });
      const topTypes = Object.entries(typeCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      this.signalStats = {
        total: this.allChartSignals.length,
        bullish: bullish.length,
        bearish: bearish.length,
        tradingDays: new Set(this.allChartSignals.map((s) => s.tradingDate))
          .size,
        topTypes,
      };
    },

    async loadChartSignals(ticker) {
      const t = (ticker || this.signalTicker).toUpperCase();
      const from =
        this.barData.length > 0 ? this.barData[0].tradingDate : '2000-01-01';
      const sigs = await fetch(`/signals/${t}/chart?from=${from}`)
        .then((r) => r.json())
        .catch(() => []);
      this._applyChartSignalsPayload(sigs);
      if (this.barData.length)
        this.$nextTick(() => requestAnimationFrame(() => this.renderChart(t)));
    },

    /** Phân tích chỉ phiên mới nhất (nhanh) */
    async runAnalyze() {
      if (!this.signalTicker) return;
      this.actionLoading.analyze = true;
      const t = this.signalTicker.toUpperCase();
      try {
        await this.authFetch(`/signals/${t}/analyze`, { method: 'POST' });
        await this.loadSignals();
        this.showToast('Phân tích phiên hiện tại xong — ' + t, 'success');
      } catch (e) {
        if (e.message !== 'Unauthorized') this.log('error', `✗ ${e.message}`);
      }
      this.actionLoading.analyze = false;
    },

    /** Backfill tín hiệu quá khứ qua queue (toàn bộ lịch sử, mặc định từ đủ 130 nến) — một mã */
    async runAnalyzeHistory() {
      if (!this.signalTicker) return;
      this.actionLoading.analyzeHistory = true;
      const t = this.signalTicker.toUpperCase();
      this.log('info', `▶ Phân tích lịch sử ${t} (job)...`);
      try {
        const res = await this.authFetch(`/queue/analyze-history/${t}`, {
          method: 'POST',
        }).then((r) => r.json());
        if (res?.jobId) {
          await this.pollJob(res.jobId, `Lịch sử ${t}`, async () => {
            await this.loadSignals();
          });
        }
      } catch (e) {
        if (e.message !== 'Unauthorized') this.log('error', `✗ ${e.message}`);
      }
      this.actionLoading.analyzeHistory = false;
    },

    /** Toàn watchlist — job nặng */
    async runAnalyzeHistoryAll() {
      this.actionLoading.analyzeHistoryAll = true;
      this.log('info', '▶ Phân tích lịch sử toàn watchlist...');
      try {
        const res = await this.authFetch('/queue/analyze-history', {
          method: 'POST',
        }).then((r) => r.json());
        if (res?.jobId) {
          await this.pollJob(res.jobId, 'Phân tích lịch sử toàn watchlist');
          await this.loadSignalSummary();
        }
      } catch (e) {
        if (e.message !== 'Unauthorized') this.log('error', `✗ ${e.message}`);
      }
      this.actionLoading.analyzeHistoryAll = false;
    },

    /**
     * Marker mua/bán trên nến — dùng chung tab Tín hiệu và tab Thị trường (VNINDEX/VN30).
     */
    buildSignalMarkers(barData, sigSource) {
      if (!barData?.length || !sigSource?.length) return [];

      const SIG_WEIGHTS = {
        RESISTANCE_BREAKOUT: 5,
        EMA_GOLDEN_CROSS: 3.5,
        EMA_BOUNCE: 3,
        WASHOUT_BAR: 3.5,
        BASE_FORMING: 2,
        MACD_BULLISH_CROSS: 2,
        RSI_OVERSOLD: 2,
        BULLISH_ENGULFING: 1.5,
        HAMMER: 1.5,
        BB_BREAKOUT_DOWN: 1.5,
        EMA_BULLISH_STACK: 2.5,
        RSI_MOMENTUM_UP: 2.5,
        VOLUME_SURGE: 1,
      };
      const BUY_PRIORITY = [
        'RESISTANCE_BREAKOUT',
        'WASHOUT_BAR',
        'EMA_GOLDEN_CROSS',
        'EMA_BOUNCE',
        'BASE_FORMING',
        'MACD_BULLISH_CROSS',
        'RSI_OVERSOLD',
        'BB_BREAKOUT_DOWN',
      ];
      const SELL_PRIORITY = [
        'RSI_BEARISH_DIVERGENCE',
        'FAILED_BREAKOUT',
        'VOLUME_CLIMAX_TOP',
        'DISTRIBUTION_BAR',
        'MACD_BEARISH_DIVERGENCE',
        'EMA_DEATH_CROSS',
        'MA_DEATH_CROSS',
        'BB_BREAKOUT_UP',
        'SUPPORT_BREAKDOWN',
      ];
      const MIN_BUY_SCORE = 3.5;
      const BUY_COOLDOWN = 10;
      const SELL_COOLDOWN = 10;

      const chartDayKey = (raw) => {
        if (raw == null || raw === '' || raw === 'N/A') return '';
        const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(raw).trim());
        return m ? m[1] : '';
      };

      const sigMap = {};
      sigSource.forEach((s) => {
        const dk = chartDayKey(s.tradingDate);
        if (!dk) return;
        if (!sigMap[dk]) sigMap[dk] = { bull: new Set(), bear: new Set() };
        if (s.direction === 'BULLISH') sigMap[dk].bull.add(s.type);
        else if (s.direction === 'BEARISH') sigMap[dk].bear.add(s.type);
      });

      const sortedDates = Object.keys(sigMap).sort();
      const dateToIdx = {};
      barData.forEach((b, i) => {
        dateToIdx[b.tradingDate] = i;
      });

      const markers = [];
      let lastBuyBarIdx = -BUY_COOLDOWN;
      let lastSellBarIdx = -SELL_COOLDOWN;

      for (const date of sortedDates) {
        const bull = [...sigMap[date].bull];
        const bear = [...sigMap[date].bear];
        const barIdx = dateToIdx[date] ?? -1;

        if (bull.length) {
          const bullScore = bull.reduce((s, t) => s + (SIG_WEIGHTS[t] ?? 0), 0);
          const topBuy = BUY_PRIORITY.find((t) => bull.includes(t)) ?? bull[0];
          const topScore = SIG_WEIGHTS[topBuy] ?? 0;
          const sinceLastBuy =
            barIdx >= 0 ? barIdx - lastBuyBarIdx : BUY_COOLDOWN;

          if (
            (bullScore >= MIN_BUY_SCORE || topScore >= 3.5) &&
            sinceLastBuy >= BUY_COOLDOWN
          ) {
            const buyTxt = this.signalTypeLabelVi(topBuy);
            markers.push({
              time: date,
              position: 'belowBar',
              color: '#10b981',
              shape: 'arrowUp',
              text: this.chartSignalLabels ? buyTxt : '',
              size: 1.0,
            });
            if (barIdx >= 0) lastBuyBarIdx = barIdx;
          }
        }

        if (bear.length) {
          const topSell = SELL_PRIORITY.find((t) => bear.includes(t));
          if (topSell) {
            const sinceLastSell =
              barIdx >= 0 ? barIdx - lastSellBarIdx : SELL_COOLDOWN;
            if (sinceLastSell >= SELL_COOLDOWN) {
              const sellTxt = this.signalTypeLabelVi(topSell);
              markers.push({
                time: date,
                position: 'aboveBar',
                color: '#ef4444',
                shape: 'arrowDown',
                text: this.chartSignalLabels ? sellTxt : '',
                size: 1.0,
              });
              if (barIdx >= 0) lastSellBarIdx = barIdx;
            }
          }
        }
      }

      if (!markers.length) return [];
      const sorted = markers.sort((a, b) => (a.time > b.time ? 1 : -1));
      const seenKey = new Set();
      const deduped = [];
      for (const m of sorted) {
        const k = `${m.time}|${m.position}|${m.text}|${m.shape}`;
        if (seenKey.has(k)) continue;
        seenKey.add(k);
        deduped.push(m);
      }
      return deduped;
    },

    destroyMainCharts() {
      const rt = this._mainChartRuntime;
      if (rt) {
        if (rt.postTimer) clearTimeout(rt.postTimer);
        if (rt.panTimer) clearTimeout(rt.panTimer);
        if (rt.roTimer) clearTimeout(rt.roTimer);
        try {
          rt.ro?.disconnect();
        } catch {}
      }
      this._mainChartRuntime = null;
      if (this.lwChart) {
        try {
          this.lwChart.remove();
        } catch {}
        this.lwChart = null;
      }
      if (this.rsiChart) {
        try {
          this.rsiChart.remove();
        } catch {}
        this.rsiChart = null;
      }
      if (this.macdChart) {
        try {
          this.macdChart.remove();
        } catch {}
        this.macdChart = null;
      }
    },

    renderChart(ticker) {
      const container = this.$refs.chartContainer;
      const rsiContainer = this.$refs.rsiContainer;
      const macdContainer = this.$refs.macdContainer;
      if (!container || !this.barData.length) return;

      // Destroy existing charts + listeners/timers
      this.destroyMainCharts();

      // ── Shared chart options (respects dark mode) ────────────────────────
      const dark = this.darkMode;
      const baseLayout = {
        background: { color: dark ? '#09090b' : '#ffffff' },
        textColor: dark ? '#71717a' : '#64748b',
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 11,
      };
      const baseGrid = {
        vertLines: { color: dark ? '#27272a' : '#f1f5f9' },
        horzLines: { color: dark ? '#27272a' : '#f1f5f9' },
      };
      const baseTS = {
        borderColor: dark ? '#3f3f46' : '#e2e8f0',
        timeVisible: false,
        fixLeftEdge: false,
        fixRightEdge: false,
        rightOffset: 0,
      };
      // Cùng barSpacing trên cả 3 chart — nếu khác, RSI/MACD lệch pixel với giá
      const syncTs = {
        ...baseTS,
        timeVisible: true,
        barSpacing: 8,
        minBarSpacing: 4,
      };

      const n = (x) => {
        const v = typeof x === 'number' ? x : Number(x);
        return Number.isFinite(v) ? v : 0;
      };

      const indexChart = this.isMarketIndexTicker(ticker);

      // ── Main candlestick chart ────────────────────────────────────────────
      const chart = LightweightCharts.createChart(container, {
        width: container.clientWidth,
        height: 500,
        layout: { ...baseLayout, fontSize: 12 },
        grid: baseGrid,
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: {
          borderColor: '#e5e7eb',
          scaleMargins: { top: 0.08, bottom: 0.22 },
          minimumWidth: 70,
        },
        timeScale: syncTs,
        localization: {
          priceFormatter: (p) =>
            indexChart ? n(p).toFixed(2) : n(p).toFixed(1) + 'k',
        },
      });
      this.lwChart = chart;

      const candleSeries = chart.addCandlestickSeries({
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderVisible: false,
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
      });
      const candleData = this.barData.map((b) => ({
        time: b.tradingDate,
        open: +(n(b.open) / 1000).toFixed(2),
        high: +(n(b.high) / 1000).toFixed(2),
        low: +(n(b.low) / 1000).toFixed(2),
        close: +(n(b.close) / 1000).toFixed(2),
      }));
      candleSeries.setData(candleData);

      // Volume
      const volSeries = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
      });
      volSeries
        .priceScale()
        .applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volSeries.setData(
        this.barData.map((b) => ({
          time: b.tradingDate,
          value: n(b.volume),
          color: n(b.close) >= n(b.open) ? '#26a69a33' : '#ef535033',
        })),
      );

      // EMA20 / EMA50
      const closes = this.barData.map((b) => n(b.close) / 1000);
      const emaFn = (vals, p) => {
        const k = 2 / (p + 1);
        let e = null;
        return vals.map((v) => {
          e = e === null ? v : v * k + e * (1 - k);
          return +e.toFixed(3);
        });
      };
      const ema20 = emaFn(closes, 20);
      const ema50 = emaFn(closes, 50);
      const addEma = (values, warmup, color, title) => {
        const s = chart.addLineSeries({
          color,
          lineWidth: 1.5,
          title,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
        });
        s.setData(
          this.barData.slice(warmup).map((b, i) => ({
            time: b.tradingDate,
            value: values[i + warmup],
          })),
        );
      };
      if (this.chartShowEma) {
        addEma(ema20, 19, '#3b82f6', 'EMA20');
        addEma(ema50, 49, '#f97316', 'EMA50');
      }

      // Hỗ trợ / Kháng cự (đơn vị trục = nghìn đ, giống nến) — ưu tiên API recommend, không thì min(20L) / max(high)
      let supK = null;
      let resK = null;
      const pt = this.currentRec?.priceTarget;
      if (
        pt &&
        Number.isFinite(Number(pt.support)) &&
        Number.isFinite(Number(pt.resistance))
      ) {
        supK = +(n(pt.support) / 1000).toFixed(2);
        resK = +(n(pt.resistance) / 1000).toFixed(2);
      } else if (this.barData.length >= 20) {
        const recent20 = this.barData.slice(-20);
        supK = +(Math.min(...recent20.map((b) => n(b.low))) / 1000).toFixed(2);
        resK = +(
          Math.max(...this.barData.map((b) => n(b.high))) / 1000
        ).toFixed(2);
      }
      if (
        this.chartShowSR &&
        supK != null &&
        resK != null &&
        supK > 0 &&
        resK > 0
      ) {
        const dash = LightweightCharts.LineStyle.Dashed;
        const supCol = dark ? '#4ade80' : '#16a34a';
        const resCol = dark ? '#f87171' : '#dc2626';
        candleSeries.createPriceLine({
          price: supK,
          color: supCol,
          lineWidth: 1,
          lineStyle: dash,
          axisLabelVisible: true,
          title: 'Hỗ trợ',
        });
        candleSeries.createPriceLine({
          price: resK,
          color: resCol,
          lineWidth: 1,
          lineStyle: dash,
          axisLabelVisible: true,
          title: 'Kháng cự',
        });
      }

      const sigSource =
        this.allChartSignals.length > 0 ? this.allChartSignals : this.signals;
      const mk = this.buildSignalMarkers(this.barData, sigSource);
      if (mk.length) candleSeries.setMarkers(mk);

      // ── RSI chart ─────────────────────────────────────────────────────────
      const rsiValues = this.calcRSI(closes, 14);
      if (rsiContainer) {
        const rsiChart = LightweightCharts.createChart(rsiContainer, {
          width: rsiContainer.clientWidth,
          height: 120,
          layout: baseLayout,
          grid: baseGrid,
          crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
          rightPriceScale: {
            borderColor: '#e5e7eb',
            minimumWidth: 70,
            autoScale: false,
          },
          timeScale: syncTs,
        });
        this.rsiChart = rsiChart;
        rsiChart.priceScale('right').applyOptions({ minimum: 0, maximum: 100 });

        const rsiSeries = rsiChart.addLineSeries({
          color: '#8b5cf6',
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          title: 'RSI',
        });
        rsiSeries.setData(
          this.barData.map((b, i) => {
            const v = rsiValues[i];
            if (v == null || Number.isNaN(v)) return { time: b.tradingDate };
            return { time: b.tradingDate, value: v };
          }),
        );
        // Overbought / Oversold / Mid reference lines
        const lineStyle = LightweightCharts.LineStyle.Dashed;
        rsiSeries.createPriceLine({
          price: 70,
          color: '#ef4444',
          lineWidth: 1,
          lineStyle,
          axisLabelVisible: true,
          title: '70',
        });
        rsiSeries.createPriceLine({
          price: 30,
          color: '#10b981',
          lineWidth: 1,
          lineStyle,
          axisLabelVisible: true,
          title: '30',
        });
        rsiSeries.createPriceLine({
          price: 50,
          color: '#94a3b8',
          lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dotted,
          axisLabelVisible: false,
        });

        // Cập nhật giá trị hiện tại
        const lastRsi = rsiValues.filter((v) => v != null).at(-1);
        this.indicators = { ...this.indicators, rsi: lastRsi ?? null };
      }

      // ── MACD chart ────────────────────────────────────────────────────────
      const macdData = this.calcMACD(closes, 12, 26, 9);
      if (macdContainer) {
        const macdChart = LightweightCharts.createChart(macdContainer, {
          width: macdContainer.clientWidth,
          height: 120,
          layout: baseLayout,
          grid: baseGrid,
          crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
          rightPriceScale: { borderColor: '#e5e7eb', minimumWidth: 70 },
          timeScale: syncTs,
        });
        this.macdChart = macdChart;

        // MACD histogram — mỗi phiên một điểm (whitespace khi chưa có hist) để khớp chỉ số logic với chart giá
        const histSeries = macdChart.addHistogramSeries({
          priceScaleId: 'right',
          lastValueVisible: false,
        });
        histSeries.setData(
          macdData.map((d) => {
            if (d.hist == null || Number.isNaN(d.hist)) return { time: d.time };
            const h = d.hist;
            return {
              time: d.time,
              value: h,
              color: h >= 0 ? '#26a69a88' : '#ef535088',
            };
          }),
        );

        const macdLine = macdChart.addLineSeries({
          color: '#3b82f6',
          lineWidth: 1.5,
          priceLineVisible: false,
          lastValueVisible: true,
          title: 'MACD',
        });
        macdLine.setData(
          macdData.map((d) =>
            d.macd != null && !Number.isNaN(d.macd)
              ? { time: d.time, value: d.macd }
              : { time: d.time },
          ),
        );

        const sigLine = macdChart.addLineSeries({
          color: '#f97316',
          lineWidth: 1.5,
          priceLineVisible: false,
          lastValueVisible: true,
          title: 'Signal',
        });
        sigLine.setData(
          macdData.map((d) =>
            d.signal != null && !Number.isNaN(d.signal)
              ? { time: d.time, value: d.signal }
              : { time: d.time },
          ),
        );

        // Zero line
        histSeries.createPriceLine({
          price: 0,
          color: '#94a3b8',
          lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dotted,
          axisLabelVisible: false,
        });

        // Cập nhật giá trị hiện tại
        const lastMacd = macdData.filter((d) => d.signal != null).at(-1);
        if (lastMacd)
          this.indicators = {
            ...this.indicators,
            macd: lastMacd.macd,
            macdSignal: lastMacd.signal,
            macdHist: lastMacd.hist,
          };
      }

      // ── Sync time scales — ưu tiên: restore sau lazy-load → viewport đã lưu → fitContent ─
      const scrollRestore = this._chartScrollRestore;
      this._chartScrollRestore = null;
      const tkr = (ticker || this.signalTicker || '').toUpperCase();
      const nBars = this.barData.length;
      const mainRt = {
        ro: null,
        roTimer: null,
        panTimer: null,
        postTimer: null,
      };
      const applyMainRange = () => {
        if (scrollRestore && scrollRestore.added > 0) {
          const a = scrollRestore.added;
          chart.timeScale().setVisibleLogicalRange({
            from: scrollRestore.from + a,
            to: scrollRestore.to + a,
          });
          return;
        }
        const vp = this.chartViewport;
        if (
          vp &&
          vp.ticker === tkr &&
          Number.isFinite(vp.from) &&
          Number.isFinite(vp.to) &&
          nBars > 1
        ) {
          let from = Math.max(0, vp.from);
          let to = Math.max(from + 1, vp.to);
          from = Math.min(from, nBars - 1);
          to = Math.min(to, nBars - 1);
          if (to - from >= 2) {
            chart.timeScale().setVisibleLogicalRange({ from, to });
            return;
          }
        }
        chart.timeScale().fitContent();
      };
      applyMainRange();
      const isMainAlive = () => this.lwChart === chart;
      mainRt.postTimer = setTimeout(() => {
        if (!isMainAlive()) return;
        const range = this.lwChart.timeScale().getVisibleLogicalRange();
        const rightOffset = range
          ? Math.round((range.to - range.from) * 0.27)
          : 15;
        [this.lwChart, this.rsiChart, this.macdChart].forEach((c) => {
          if (c)
            try {
              c.timeScale().applyOptions({ rightOffset });
            } catch {}
        });
        const synced = this.lwChart.timeScale().getVisibleLogicalRange();
        if (synced && tkr) {
          this.chartViewport = {
            ticker: tkr,
            from: synced.from,
            to: synced.to,
          };
          this.rsiChart?.timeScale().setVisibleLogicalRange(synced);
          this.macdChart?.timeScale().setVisibleLogicalRange(synced);
        }
      }, 60);

      let syncing = false;
      const syncAll = (source, others) => {
        source.timeScale().subscribeVisibleLogicalRangeChange((range) => {
          if (!isMainAlive() || syncing || !range) return;
          syncing = true;
          others.forEach((c) => {
            if (c)
              try {
                c.timeScale().setVisibleLogicalRange(range);
              } catch {}
          });
          syncing = false;
        });
      };
      const sub = [this.rsiChart, this.macdChart];
      syncAll(chart, sub);
      if (this.rsiChart) syncAll(this.rsiChart, [chart, this.macdChart]);
      if (this.macdChart) syncAll(this.macdChart, [chart, this.rsiChart]);

      // Lazy load nến cũ chỉ khi đã zoom/pan (không kích hoạt khi fitContent hiển thị cả khối nến — tránh vòng lặp tải + render)
      const tSym = (ticker || this.signalTicker || '').toUpperCase();
      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (!isMainAlive()) return;
        if (!range || !tSym || !this.barData?.length) return;
        this.chartViewport = { ticker: tSym, from: range.from, to: range.to };
        if (this.chartOlderLoading) return;
        const barCount = this.barData.length;
        const span = range.to - range.from;
        if (span >= barCount * 0.92) return;
        if (range.from > 14) return;
        clearTimeout(mainRt.panTimer);
        mainRt.panTimer = setTimeout(
          () => this.maybeLoadOlderChartBars(tSym),
          500,
        );
      });

      // Responsive resize (debounce — tránh lag khi layout đổi)
      const ro = new ResizeObserver(() => {
        clearTimeout(mainRt.roTimer);
        mainRt.roTimer = setTimeout(() => {
          if (!isMainAlive()) return;
          if (this.lwChart)
            this.lwChart.applyOptions({ width: container.clientWidth });
          if (this.rsiChart)
            this.rsiChart.applyOptions({
              width: rsiContainer?.clientWidth ?? 0,
            });
          if (this.macdChart)
            this.macdChart.applyOptions({
              width: macdContainer?.clientWidth ?? 0,
            });
        }, 120);
      });
      ro.observe(container);
      mainRt.ro = ro;
      this._mainChartRuntime = mainRt;
    },

    // ── Indicator calculations ──────────────────────────────────────────────

    calcRSI(closes, period = 14) {
      if (closes.length < period + 1) return [];
      let avgGain = 0,
        avgLoss = 0;
      for (let i = 1; i <= period; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) avgGain += d;
        else avgLoss -= d;
      }
      avgGain /= period;
      avgLoss /= period;
      const rsi = new Array(period + 1).fill(null);
      rsi.push(
        avgLoss === 0 ? 100 : +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(2),
      );
      for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
        rsi.push(
          avgLoss === 0
            ? 100
            : +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(2),
        );
      }
      return rsi;
    },

    calcMACD(closes, fast = 12, slow = 26, signal = 9) {
      const emaFn = (vals, p) => {
        const k = 2 / (p + 1);
        let e = null;
        return vals.map((v) => {
          e = e === null ? v : v * k + e * (1 - k);
          return e;
        });
      };
      const ef = emaFn(closes, fast);
      const es = emaFn(closes, slow);
      const macdLine = closes.map((_, i) => ef[i] - es[i]);
      const sigLine = emaFn(macdLine.slice(slow - 1), signal);
      return closes.map((_, i) => {
        if (i < slow - 1)
          return {
            time: this.barData[i]?.tradingDate,
            macd: null,
            signal: null,
            hist: null,
          };
        const si = i - (slow - 1);
        const m = +macdLine[i].toFixed(4);
        const s =
          si >= signal - 1 ? +sigLine[si - (signal - 1)].toFixed(4) : null;
        return {
          time: this.barData[i]?.tradingDate,
          macd: m,
          signal: s,
          hist: s != null ? +(m - s).toFixed(4) : null,
        };
      });
    },

    /** MACD với chuỗi thời gian từ `bars` (tab Thị trường — không dùng `this.barData`). */
    calcMACDFromBars(closes, bars, fast = 12, slow = 26, signal = 9) {
      const emaFn = (vals, p) => {
        const k = 2 / (p + 1);
        let e = null;
        return vals.map((v) => {
          e = e === null ? v : v * k + e * (1 - k);
          return e;
        });
      };
      const ef = emaFn(closes, fast);
      const es = emaFn(closes, slow);
      const macdLine = closes.map((_, i) => ef[i] - es[i]);
      const sigLine = emaFn(macdLine.slice(slow - 1), signal);
      return closes.map((_, i) => {
        if (i < slow - 1)
          return {
            time: bars[i]?.tradingDate,
            macd: null,
            signal: null,
            hist: null,
          };
        const si = i - (slow - 1);
        const m = +macdLine[i].toFixed(4);
        const s =
          si >= signal - 1 ? +sigLine[si - (signal - 1)].toFixed(4) : null;
        return {
          time: bars[i]?.tradingDate,
          macd: m,
          signal: s,
          hist: s != null ? +(m - s).toFixed(4) : null,
        };
      });
    },

    /** MACD cho nến intraday — `bars[i].time` là Unix giây. */
    calcMACDFromIntradayBars(closes, bars, fast = 12, slow = 26, signal = 9) {
      const emaFn = (vals, p) => {
        const k = 2 / (p + 1);
        let e = null;
        return vals.map((v) => {
          e = e === null ? v : v * k + e * (1 - k);
          return e;
        });
      };
      const ef = emaFn(closes, fast);
      const es = emaFn(closes, slow);
      const macdLine = closes.map((_, i) => ef[i] - es[i]);
      const sigLine = emaFn(macdLine.slice(slow - 1), signal);
      return closes.map((_, i) => {
        if (i < slow - 1)
          return { time: bars[i]?.time, macd: null, signal: null, hist: null };
        const si = i - (slow - 1);
        const m = +macdLine[i].toFixed(4);
        const s =
          si >= signal - 1 ? +sigLine[si - (signal - 1)].toFixed(4) : null;
        return {
          time: bars[i]?.time,
          macd: m,
          signal: s,
          hist: s != null ? +(m - s).toFixed(4) : null,
        };
      });
    },

    calcATRFromIntradayBars(bars, period = 14) {
      const n = (x) => {
        const v = typeof x === 'number' ? x : Number(x);
        return Number.isFinite(v) ? v : 0;
      };
      if (bars.length < period + 1) return null;
      const trs = [];
      for (let i = 1; i < bars.length; i++) {
        const h = n(bars[i].high) / 1000;
        const l = n(bars[i].low) / 1000;
        const pc = n(bars[i - 1].close) / 1000;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
      }
      const slice = trs.slice(-period);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    },

    /**
     * Bollinger (SMA 20, 2σ) trên giá đóng — cùng ý `detectBollingerBands` server: bandwidth = (U−L)/mid.
     */
    calcBollingerIntraday(closes, period = 20, stdMult = 2) {
      const n = closes.length;
      const upper = new Array(n).fill(null);
      const middle = new Array(n).fill(null);
      const lower = new Array(n).fill(null);
      const bandwidth = new Array(n).fill(null);
      for (let i = period - 1; i < n; i++) {
        const slice = closes.slice(i - period + 1, i + 1);
        const mean = slice.reduce((a, b) => a + b, 0) / period;
        const variance =
          slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
        const std = Math.sqrt(variance);
        const u = mean + stdMult * std;
        const l = mean - stdMult * std;
        middle[i] = mean;
        upper[i] = u;
        lower[i] = l;
        if (mean !== 0) bandwidth[i] = (u - l) / mean;
      }
      return { upper, middle, lower, bandwidth };
    },

    /**
     * Gợi ý tham khảo (không phải tư vấn): RSI, MACD histogram, ATR → SL/TP đơn giản.
     */
    computeDerivAnalysis(bars) {
      const n = (x) => {
        const v = typeof x === 'number' ? x : Number(x);
        return Number.isFinite(v) ? v : 0;
      };
      const sorted = [...bars].sort((a, b) => Number(a.time) - Number(b.time));
      if (sorted.length < 30) {
        return { short: 'Chưa đủ nến để gợi ý (cần khoảng 30+ nến).' };
      }
      const closes = sorted.map((b) => n(b.close) / 1000);
      const lastClose = closes[closes.length - 1];
      const rsiVals = this.calcRSI(closes, 14);
      const rsiLast = rsiVals[rsiVals.length - 1];
      const macdRows = this.calcMACDFromIntradayBars(closes, sorted);
      const lastM = macdRows[macdRows.length - 1];
      const prevM = macdRows[macdRows.length - 2];
      let macdNote = '';
      if (lastM?.hist != null && prevM?.hist != null) {
        if (prevM.hist <= 0 && lastM.hist > 0) {
          macdNote =
            'MACD histogram vừa cắt lên 0 — có thể ưu tiên xem xét long.';
        } else if (prevM.hist >= 0 && lastM.hist < 0) {
          macdNote =
            'MACD histogram vừa cắt xuống 0 — có thể ưu tiên xem xét short / chốt long.';
        } else {
          macdNote =
            lastM.hist > 0
              ? 'Histogram đang dương (động lượng tăng).'
              : 'Histogram đang âm (động lượng giảm).';
        }
      }
      const atr = this.calcATRFromIntradayBars(sorted, 14);
      if (atr == null || atr <= 0) {
        return { short: 'Không tính được ATR — thử làm mới sau.' };
      }
      const mult = 2;
      const rr = 1.5;
      const slLong = lastClose - mult * atr;
      const tpLong = lastClose + rr * mult * atr;
      const slShort = lastClose + mult * atr;
      const tpShort = lastClose - rr * mult * atr;
      let rsiNote = '';
      if (rsiLast != null && !Number.isNaN(rsiLast)) {
        if (rsiLast < 30)
          rsiNote =
            'RSI dưới 30 — vùng quá bán (cân nhắc long nếu có xác nhận khác).';
        else if (rsiLast > 70)
          rsiNote =
            'RSI trên 70 — vùng quá mua (cân nhắc short hoặc chốt long).';
        else rsiNote = `RSI ~${Number(rsiLast).toFixed(1)} — trung tính.`;
      }
      const lb = sorted[sorted.length - 1];
      const o = n(lb.open) / 1000;
      const hi = n(lb.high) / 1000;
      const lo = n(lb.low) / 1000;
      const cl = n(lb.close) / 1000;
      const body = Math.abs(cl - o);
      const range = Math.max(1e-9, hi - lo);
      const bodyPct = body / range;
      const bull = cl >= o;
      let candleNote = '';
      if (bodyPct < 0.12) {
        candleNote =
          'Nến cuối: thân rất nhỏ / doji — do dự, nên chờ nến xác nhận.';
      } else if (bodyPct > 0.7) {
        candleNote = bull
          ? `Nến cuối: tăng mạnh, thân ~${body.toFixed(1)} điểm.`
          : `Nến cuối: giảm mạnh, thân ~${body.toFixed(1)} điểm.`;
      } else {
        candleNote = bull
          ? `Nến cuối: xanh nhẹ (thân ~${body.toFixed(1)} điểm).`
          : `Nến cuối: đỏ nhẹ (thân ~${body.toFixed(1)} điểm).`;
      }
      const upperW = hi - Math.max(o, cl);
      const lowerW = Math.min(o, cl) - lo;
      if (upperW > body * 1.15 && upperW > lowerW) {
        candleNote += ' Râu trên dài — áp lực chốt / kháng cự gần đỉnh.';
      } else if (lowerW > body * 1.15 && lowerW > upperW) {
        candleNote += ' Râu dưới dài — lực mua hồi / hỗ trợ gần đáy.';
      }

      /** Một hướng duy nhất: điểm long vs short từ RSI / MACD / nến cuối — không hiển thị hai kèo cùng lúc. */
      let longPts = 0;
      let shortPts = 0;
      if (rsiLast != null && !Number.isNaN(rsiLast)) {
        if (rsiLast < 35) longPts += 2;
        else if (rsiLast > 65) shortPts += 2;
        else if (rsiLast < 45) longPts += 1;
        else if (rsiLast > 55) shortPts += 1;
      }
      if (lastM?.hist != null && prevM?.hist != null) {
        if (prevM.hist <= 0 && lastM.hist > 0) longPts += 2;
        else if (prevM.hist >= 0 && lastM.hist < 0) shortPts += 2;
        if (lastM.hist > 0) longPts += 1;
        else if (lastM.hist < 0) shortPts += 1;
      }
      if (bull) longPts += 1;
      else shortPts += 1;

      let bias = 'neutral';
      if (longPts > shortPts) bias = 'long';
      else if (shortPts > longPts) bias = 'short';
      else if (lastM?.hist != null) {
        if (lastM.hist > 0) bias = 'long';
        else if (lastM.hist < 0) bias = 'short';
      }

      let biasLabelVi = 'Trung lập';
      let biasHint =
        'Điểm long/short cân bằng — hệ thống không ưu tiên một hướng; nên đứng ngoài hoặc chờ nến xác nhận.';
      if (bias === 'long') {
        biasLabelVi = 'LONG';
        biasHint = `Ưu tiên hướng mua (điểm +${longPts} vs ${shortPts}). SL/TP bên dưới là kèo long tham khảo.`;
      } else if (bias === 'short') {
        biasLabelVi = 'SHORT';
        biasHint = `Ưu tiên hướng bán (điểm +${shortPts} vs ${longPts}). SL/TP bên dưới là kèo short tham khảo.`;
      }

      const sl =
        bias === 'long'
          ? +slLong.toFixed(2)
          : bias === 'short'
            ? +slShort.toFixed(2)
            : null;
      const tp =
        bias === 'long'
          ? +tpLong.toFixed(2)
          : bias === 'short'
            ? +tpShort.toFixed(2)
            : null;

      return {
        lastClose: +lastClose.toFixed(2),
        rsiLast:
          rsiLast != null && !Number.isNaN(rsiLast)
            ? +Number(rsiLast).toFixed(1)
            : null,
        atr: +atr.toFixed(2),
        bias,
        biasLabelVi,
        biasHint,
        sl,
        tp,
        macdNote,
        rsiNote,
        candleNote,
      };
    },

    destroyDerivCharts() {
      const rt = this._derivChartRuntime;
      if (rt) {
        if (rt.postTimer) clearTimeout(rt.postTimer);
        if (rt.panTimer) clearTimeout(rt.panTimer);
        if (rt.roTimer) clearTimeout(rt.roTimer);
        try {
          rt.ro?.disconnect();
        } catch {}
      }
      this._derivChartRuntime = null;
      const prev = this.derivCharts;
      if (!prev) return;
      try {
        prev.main?.remove();
        prev.rsi?.remove();
        prev.macd?.remove();
      } catch {}
      this.derivCharts = null;
    },

    derivCacheKey() {
      return `derivIntradayCache:VN30:${this.derivResolution}`;
    },

    backtestCacheKey() {
      return 'vn30BacktestCache:VN30:v1';
    },

    readBacktestCache() {
      try {
        const raw = localStorage.getItem(this.backtestCacheKey());
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const result = parsed?.result;
        const series = Array.isArray(result?.series) ? result.series : [];
        if (!series.length) return null;
        return {
          result,
          params: parsed?.params || null,
          cachedAt: parsed?.cachedAt || null,
        };
      } catch {
        return null;
      }
    },

    writeBacktestCache(result) {
      try {
        if (!result?.series?.length) return;
        localStorage.setItem(
          this.backtestCacheKey(),
          JSON.stringify({
            params: {
              from: this.btFrom,
              to: this.btTo,
              trailing: this.btTrailing !== false,
              rsicap: this.btRsicap !== false,
            },
            result,
            cachedAt: new Date().toISOString(),
          }),
        );
      } catch {}
    },

    restoreBacktestParamsFromCache() {
      const cached = this.readBacktestCache();
      const p = cached?.params;
      if (!p) return;
      if (typeof p.from === 'string' && p.from) this.btFrom = p.from;
      if (typeof p.to === 'string' && p.to) this.btTo = p.to;
      if (typeof p.trailing === 'boolean') this.btTrailing = p.trailing;
      if (typeof p.rsicap === 'boolean') this.btRsicap = p.rsicap;
    },

    restoreBacktestResultFromCache() {
      const cached = this.readBacktestCache();
      if (!cached?.result?.series?.length) return false;
      this.btResult = cached.result;
      this.btError = '';
      this.$nextTick(() => this.renderBtEquityChart());
      return true;
    },

    readDerivBarsCache() {
      try {
        const raw = localStorage.getItem(this.derivCacheKey());
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const bars = Array.isArray(parsed?.bars) ? parsed.bars : [];
        if (!bars.length) return null;
        return {
          bars: bars
            .filter((b) => Number.isFinite(Number(b?.time)))
            .sort((a, b) => Number(a.time) - Number(b.time)),
          hasMoreOlder: parsed?.hasMoreOlder !== false,
        };
      } catch {
        return null;
      }
    },

    writeDerivBarsCache() {
      try {
        const bars = Array.isArray(this.derivBars) ? this.derivBars : [];
        if (!bars.length) return;
        localStorage.setItem(
          this.derivCacheKey(),
          JSON.stringify({
            bars,
            hasMoreOlder: this.derivHasMoreOlder !== false,
            cachedAt: new Date().toISOString(),
          }),
        );
      } catch {}
    },

    withNoCache(url) {
      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}_ts=${Date.now()}`;
    },

    derivResolutionSeconds() {
      const r = this.derivResolution;
      if (r === '5') return 5 * 60;
      if (r === '15') return 15 * 60;
      if (r === '1H') return 60 * 60;
      return 5 * 60;
    },

    async loadDerivIntraday(opts = {}) {
      const silent = opts.silent === true;
      const reset = opts.reset !== false;
      const forceNetwork = opts.forceNetwork === true;
      const fast = opts.fast === true;
      const noCacheParam = forceNetwork ? '&nocache=1' : '';
      if (!silent) this.derivLoading = true;
      try {
        this._derivScrollRestore = null;
        if (reset && !forceNetwork) {
          this.derivHasMoreOlder = true;
          const cached = this.readDerivBarsCache();
          if (cached?.bars?.length) {
            this.derivBars = cached.bars;
            this.derivBarsResolution = this.derivResolution;
            this.derivHasMoreOlder = cached.hasMoreOlder;
            this.applyDerivDecisionToAnalysis();
            await this.$nextTick();
            requestAnimationFrame(() => this.renderDerivIntradayPanel());
          }
        }
        const canFastRefresh =
          fast &&
          Array.isArray(this.derivBars) &&
          this.derivBars.length > 0 &&
          this.derivBarsResolution === this.derivResolution;
        if (canFastRefresh) {
          const lastSec = Number(
            this.derivBars[this.derivBars.length - 1]?.time,
          );
          const overlapSec = this.derivResolutionSeconds() * 24;
          const fromFast = new Date((lastSec - overlapSec) * 1000);
          const toFast = new Date();
          const res = `resolution=${encodeURIComponent(this.derivResolution)}`;
          const fastUrl = this.withNoCache(
            `/stocks/VN30/intraday-index?${res}&from=${encodeURIComponent(fromFast.toISOString())}&to=${encodeURIComponent(toFast.toISOString())}${noCacheParam}`,
          );
          const rawFast = await fetch(fastUrl, { cache: 'no-store' })
            .then((r) => r.json())
            .catch(() => []);
          const arrFast = Array.isArray(rawFast) ? rawFast : [];
          if (arrFast.length) {
            const byTime = new Map(
              this.derivBars.map((b) => [Number(b.time), b]),
            );
            for (const b of arrFast) {
              const t = Number(b?.time);
              if (Number.isFinite(t)) byTime.set(t, b);
            }
            const targetFromSec =
              (Date.now() - this.derivChartWindowMs()) / 1000;
            const merged = [...byTime.values()]
              .filter((b) => Number(b.time) >= targetFromSec)
              .sort((a, b) => Number(a.time) - Number(b.time));
            this.derivBars = merged;
            this.derivBarsResolution = this.derivResolution;
            this.writeDerivBarsCache();
          }
          this.applyDerivDecisionToAnalysis();
          await this.$nextTick();
          requestAnimationFrame(() => this.renderDerivIntradayPanel());
          return;
        }
        /** ~31 ngày lịch lùi từ hiện tại; API Entrade thường giới hạn ~50 nến/request — lặp lùi theo `to` cho tới khi đủ cửa sổ hoặc hết dữ liệu. */
        const to = new Date();
        const targetFrom = new Date(to.getTime() - this.derivChartWindowMs());
        const res = `resolution=${encodeURIComponent(this.derivResolution)}`;
        const byTime = new Map();
        let reqTo = to;
        let guard = 0;
        while (guard++ < 200) {
          const prevSize = byTime.size;
          const url = this.withNoCache(
            `/stocks/VN30/intraday-index?${res}&from=${encodeURIComponent(targetFrom.toISOString())}&to=${encodeURIComponent(reqTo.toISOString())}${noCacheParam}`,
          );
          const raw = await fetch(url, { cache: 'no-store' })
            .then((r) => r.json())
            .catch(() => []);
          const arr = Array.isArray(raw) ? raw : [];
          if (!arr.length) break;
          let batchMin = Infinity;
          for (const b of arr) {
            const t = Number(b.time);
            if (!Number.isFinite(t)) continue;
            byTime.set(t, b);
            if (t < batchMin) batchMin = t;
          }
          if (byTime.size === prevSize) break;
          if (batchMin === Infinity) break;
          const targetFromSec = targetFrom.getTime() / 1000;
          if (batchMin <= targetFromSec) break;
          reqTo = new Date(batchMin * 1000 - 1000);
          if (reqTo.getTime() < targetFrom.getTime()) break;
        }
        const fetchedBars = [...byTime.values()].sort(
          (a, b) => Number(a.time) - Number(b.time),
        );
        if (!fetchedBars.length && !this.derivBars.length) {
          this.derivBarsResolution = null;
          this.derivHasMoreOlder = false;
          this.derivAnalysis = {
            short:
              'Không có nến trong khoảng này (thử khung khác hoặc làm mới).',
          };
          this.destroyDerivCharts();
          await this.$nextTick();
        } else if (fetchedBars.length) {
          this.derivBars = fetchedBars;
          this.derivBarsResolution = this.derivResolution;
          this.derivHasMoreOlder = true;
          this.writeDerivBarsCache();
          this.applyDerivDecisionToAnalysis();
          await this.$nextTick();
          requestAnimationFrame(() => this.renderDerivIntradayPanel());
        } else {
          // Không lấy được thêm dữ liệu mạng, giữ snapshot cache đang hiển thị.
          this.derivBarsResolution = this.derivResolution;
          this.derivHasMoreOlder = true;
          this.applyDerivDecisionToAnalysis();
          await this.$nextTick();
          requestAnimationFrame(() => this.renderDerivIntradayPanel());
        }
      } finally {
        if (!silent) this.derivLoading = false;
      }
    },

    async maybeLoadOlderDerivBars() {
      if (
        !this.derivBars?.length ||
        this.derivOlderLoading ||
        !this.derivHasMoreOlder
      )
        return;
      const oldestSec = Number(this.derivBars[0].time);
      if (!Number.isFinite(oldestSec)) return;
      const toD = new Date(oldestSec * 1000);
      const fromD = new Date(toD.getTime() - this.derivOlderChunkMs());
      if (fromD.getTime() >= toD.getTime()) {
        this.derivHasMoreOlder = false;
        return;
      }

      let scrollSnap = null;
      const dc = this.derivCharts;
      if (dc?.main) {
        const r = dc.main.timeScale().getVisibleLogicalRange();
        if (r && Number.isFinite(r.from) && Number.isFinite(r.to)) {
          scrollSnap = { from: r.from, to: r.to };
        }
      }
      const prevLen = this.derivBars.length;
      this.derivOlderLoading = true;
      try {
        const res = `resolution=${encodeURIComponent(this.derivResolution)}`;
        const raw = await fetch(
          `/stocks/VN30/intraday-index?${res}&from=${encodeURIComponent(fromD.toISOString())}&to=${encodeURIComponent(toD.toISOString())}`,
        )
          .then((r) => r.json())
          .catch(() => []);
        const arr = Array.isArray(raw) ? raw : [];
        if (!arr.length) {
          this.derivHasMoreOlder = false;
          return;
        }
        const byTime = new Map(this.derivBars.map((b) => [Number(b.time), b]));
        for (const b of arr) {
          const t = Number(b.time);
          if (Number.isFinite(t)) byTime.set(t, b);
        }
        const merged = [...byTime.values()].sort(
          (a, b) => Number(a.time) - Number(b.time),
        );
        const added = merged.length - prevLen;
        if (added <= 0) {
          this.derivHasMoreOlder = false;
          return;
        }
        this.derivBars = merged;
        this.derivHasMoreOlder = true;
        this.writeDerivBarsCache();
        this.applyDerivDecisionToAnalysis();
        if (scrollSnap && added > 0) {
          this._derivScrollRestore = {
            from: scrollSnap.from,
            to: scrollSnap.to,
            added,
          };
        } else {
          this._derivScrollRestore = null;
        }
        await this.$nextTick();
        requestAnimationFrame(() => this.renderDerivIntradayPanel());
      } finally {
        this.derivOlderLoading = false;
      }
    },

    /** Biểu đồ intraday VN30: nến + vol + EMA + RSI + MACD (cùng lớp vẽ tab Phái sinh). */
    renderDerivIntradayPanel() {
      const barData = this.derivBars;
      const mainEl = this.$refs.derivChartMain;
      const rsiEl = this.$refs.derivRsi;
      const macdEl = this.$refs.derivMacd;
      if (!mainEl || !barData?.length) {
        this.destroyDerivCharts();
        return;
      }

      this.destroyDerivCharts();

      const mainH = Math.max(280, Math.round(mainEl.clientHeight) || 420);
      const dark = this.darkMode;
      const baseLayout = {
        background: { color: dark ? '#09090b' : '#ffffff' },
        textColor: dark ? '#71717a' : '#64748b',
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 11,
      };
      const baseGrid = {
        vertLines: { color: dark ? '#27272a' : '#f1f5f9' },
        horzLines: { color: dark ? '#27272a' : '#f1f5f9' },
      };
      /** Trục thời gian + crosshair theo giờ VN (API trả Unix UTC). */
      const dr = this.derivResolution;
      const derivTimeLabel = (time) => {
        if (typeof time !== 'number') return '';
        const d = new Date(time * 1000);
        return d.toLocaleString('vi-VN', {
          timeZone: 'Asia/Ho_Chi_Minh',
          hour: '2-digit',
          minute: '2-digit',
          day: '2-digit',
          month: '2-digit',
        });
      };
      const baseTS = {
        borderColor: dark ? '#3f3f46' : '#e2e8f0',
        timeVisible: true,
        secondsVisible: false,
        fixLeftEdge: false,
        fixRightEdge: false,
        rightOffset: 0,
        tickMarkFormatter: (time) => derivTimeLabel(time),
      };
      const barSp = 6;
      const minBarSp = 2;
      const syncTs = { ...baseTS, barSpacing: barSp, minBarSpacing: minBarSp };

      const n = (x) => {
        const v = typeof x === 'number' ? x : Number(x);
        return Number.isFinite(v) ? v : 0;
      };

      const chart = LightweightCharts.createChart(mainEl, {
        width: mainEl.clientWidth,
        height: mainH,
        layout: { ...baseLayout, fontSize: 12 },
        grid: baseGrid,
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: {
          borderColor: '#e5e7eb',
          scaleMargins: { top: 0.08, bottom: 0.22 },
          minimumWidth: 64,
        },
        timeScale: syncTs,
        localization: {
          priceFormatter: (p) => n(p).toFixed(2),
          timeFormatter: (time) => derivTimeLabel(time),
        },
      });

      const candleSeries = chart.addCandlestickSeries({
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderVisible: false,
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
      });
      candleSeries.setData(
        barData.map((b) => ({
          time: n(b.time),
          open: +(n(b.open) / 1000).toFixed(2),
          high: +(n(b.high) / 1000).toFixed(2),
          low: +(n(b.low) / 1000).toFixed(2),
          close: +(n(b.close) / 1000).toFixed(2),
        })),
      );

      const volSeries = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
      });
      volSeries
        .priceScale()
        .applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volSeries.setData(
        barData.map((b) => ({
          time: n(b.time),
          value: n(b.volume),
          color: n(b.close) >= n(b.open) ? '#26a69a33' : '#ef535033',
        })),
      );

      const closes = barData.map((b) => n(b.close) / 1000);
      const emaFn = (vals, p) => {
        const k = 2 / (p + 1);
        let e = null;
        return vals.map((v) => {
          e = e === null ? v : v * k + e * (1 - k);
          return +e.toFixed(3);
        });
      };
      const ema20 = emaFn(closes, 20);
      const ema50 = emaFn(closes, 50);
      const addEma = (values, warmup, color, title) => {
        const s = chart.addLineSeries({
          color,
          lineWidth: 1.5,
          title,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
        });
        s.setData(
          barData
            .slice(warmup)
            .map((b, i) => ({ time: n(b.time), value: values[i + warmup] })),
        );
      };
      if (this.chartShowEma) {
        addEma(ema20, 19, '#3b82f6', 'EMA20');
        addEma(ema50, 49, '#f97316', 'EMA50');
      }

      /** BB + đánh dấu nén (BW &lt; 8%) — chỉ 5m/15m; tín hiệu DB vẫn là nến ngày. */
      if (
        this.derivShowBb &&
        (dr === '5' || dr === '15') &&
        barData.length >= 20
      ) {
        const bb = this.calcBollingerIntraday(closes);
        const lineBb = (vals, color, title) => {
          const s = chart.addLineSeries({
            color,
            lineWidth: 1,
            title,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          s.setData(
            barData.map((b, i) => {
              const v = vals[i];
              if (v == null || Number.isNaN(v)) return { time: n(b.time) };
              return { time: n(b.time), value: +Number(v).toFixed(4) };
            }),
          );
        };
        lineBb(bb.upper, dark ? '#94a3b8cc' : '#64748bcc', 'BB↑');
        lineBb(bb.middle, dark ? '#71717a' : '#94a3b8', 'BB mid');
        lineBb(bb.lower, dark ? '#94a3b8cc' : '#64748bcc', 'BB↓');
        let inSq = false;
        const sqMarkers = [];
        for (let i = 0; i < barData.length; i++) {
          const bw = bb.bandwidth[i];
          const isSq = bw != null && bw < 0.08;
          if (isSq && !inSq) {
            sqMarkers.push({
              time: n(barData[i].time),
              position: 'belowBar',
              color: '#a855f7',
              shape: 'circle',
              text: this.chartSignalLabels ? 'Nén' : '',
              size: 0.85,
            });
            inSq = true;
          } else if (!isSq) {
            inSq = false;
          }
        }
        if (sqMarkers.length) {
          candleSeries.setMarkers(sqMarkers);
        }
      }

      let supK = null;
      let resK = null;
      if (barData.length >= 20) {
        const recent20 = barData.slice(-20);
        supK = +(Math.min(...recent20.map((b) => n(b.low))) / 1000).toFixed(2);
        resK = +(Math.max(...recent20.map((b) => n(b.high))) / 1000).toFixed(2);
      }
      if (
        this.chartShowSR &&
        supK != null &&
        resK != null &&
        supK > 0 &&
        resK > 0
      ) {
        const dash = LightweightCharts.LineStyle.Dashed;
        const supCol = dark ? '#4ade80' : '#16a34a';
        const resCol = dark ? '#f87171' : '#dc2626';
        candleSeries.createPriceLine({
          price: supK,
          color: supCol,
          lineWidth: 1,
          lineStyle: dash,
          axisLabelVisible: true,
          title: 'Hỗ trợ',
        });
        candleSeries.createPriceLine({
          price: resK,
          color: resCol,
          lineWidth: 1,
          lineStyle: dash,
          axisLabelVisible: true,
          title: 'Kháng cự',
        });
      }

      const da = this.derivAnalysis;
      if (da && !da.short && typeof da.lastClose === 'number') {
        const dash = LightweightCharts.LineStyle.Dashed;
        const dot = LightweightCharts.LineStyle.Dotted;
        const yl = dark ? '#facc15' : '#ca8a04';
        candleSeries.createPriceLine({
          price: da.lastClose,
          color: yl,
          lineWidth: 2,
          lineStyle: LightweightCharts.LineStyle.Solid,
          axisLabelVisible: true,
          title: 'Giá cuối',
        });
        if (da.bias === 'long' && da.sl != null && da.tp != null) {
          candleSeries.createPriceLine({
            price: da.sl,
            color: dark ? '#22c55e' : '#15803d',
            lineWidth: 1,
            lineStyle: dash,
            axisLabelVisible: true,
            title: 'SL',
          });
          candleSeries.createPriceLine({
            price: da.tp,
            color: dark ? '#86efac' : '#16a34a',
            lineWidth: 1,
            lineStyle: dot,
            axisLabelVisible: true,
            title: 'TP',
          });
        } else if (da.bias === 'short' && da.sl != null && da.tp != null) {
          candleSeries.createPriceLine({
            price: da.sl,
            color: dark ? '#f87171' : '#b91c1c',
            lineWidth: 1,
            lineStyle: dash,
            axisLabelVisible: true,
            title: 'SL',
          });
          candleSeries.createPriceLine({
            price: da.tp,
            color: dark ? '#fca5a5' : '#dc2626',
            lineWidth: 1,
            lineStyle: dot,
            axisLabelVisible: true,
            title: 'TP',
          });
        }
      }

      const rsiValues = this.calcRSI(closes, 14);
      let rsiChart = null;
      const rsiPaneH = rsiEl
        ? Math.max(96, Math.round(rsiEl.clientHeight) || 120)
        : 96;
      const macdPaneH = macdEl
        ? Math.max(96, Math.round(macdEl.clientHeight) || 120)
        : 96;
      if (rsiEl) {
        rsiChart = LightweightCharts.createChart(rsiEl, {
          width: rsiEl.clientWidth,
          height: rsiPaneH,
          layout: baseLayout,
          grid: baseGrid,
          crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
          rightPriceScale: {
            borderColor: '#e5e7eb',
            minimumWidth: 64,
            autoScale: false,
          },
          timeScale: syncTs,
          localization: { timeFormatter: (time) => derivTimeLabel(time) },
        });
        rsiChart.priceScale('right').applyOptions({ minimum: 0, maximum: 100 });
        const rsiSeries = rsiChart.addLineSeries({
          color: '#8b5cf6',
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          title: 'RSI',
        });
        rsiSeries.setData(
          barData.map((b, i) => {
            const v = rsiValues[i];
            if (v == null || Number.isNaN(v)) return { time: n(b.time) };
            return { time: n(b.time), value: v };
          }),
        );
        const lineStyle = LightweightCharts.LineStyle.Dashed;
        rsiSeries.createPriceLine({
          price: 70,
          color: '#ef4444',
          lineWidth: 1,
          lineStyle,
          axisLabelVisible: false,
          title: '',
        });
        rsiSeries.createPriceLine({
          price: 30,
          color: '#10b981',
          lineWidth: 1,
          lineStyle,
          axisLabelVisible: false,
          title: '',
        });
      }

      const macdData = this.calcMACDFromIntradayBars(closes, barData);
      let macdChart = null;
      if (macdEl) {
        macdChart = LightweightCharts.createChart(macdEl, {
          width: macdEl.clientWidth,
          height: macdPaneH,
          layout: baseLayout,
          grid: baseGrid,
          crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
          rightPriceScale: { borderColor: '#e5e7eb', minimumWidth: 64 },
          timeScale: syncTs,
          localization: { timeFormatter: (time) => derivTimeLabel(time) },
        });
        const histSeries = macdChart.addHistogramSeries({
          priceScaleId: 'right',
          lastValueVisible: false,
        });
        histSeries.setData(
          macdData.map((d) => {
            if (d.hist == null || Number.isNaN(d.hist)) return { time: d.time };
            const h = d.hist;
            return {
              time: d.time,
              value: h,
              color: h >= 0 ? '#26a69a88' : '#ef535088',
            };
          }),
        );
        const macdLine = macdChart.addLineSeries({
          color: '#3b82f6',
          lineWidth: 1.5,
          priceLineVisible: false,
          lastValueVisible: true,
          title: 'MACD',
        });
        macdLine.setData(
          macdData.map((d) =>
            d.macd != null && !Number.isNaN(d.macd)
              ? { time: d.time, value: d.macd }
              : { time: d.time },
          ),
        );
        const sigLine = macdChart.addLineSeries({
          color: '#f97316',
          lineWidth: 1.5,
          priceLineVisible: false,
          lastValueVisible: true,
          title: 'Signal',
        });
        sigLine.setData(
          macdData.map((d) =>
            d.signal != null && !Number.isNaN(d.signal)
              ? { time: d.time, value: d.signal }
              : { time: d.time },
          ),
        );
        histSeries.createPriceLine({
          price: 0,
          color: '#94a3b8',
          lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dotted,
          axisLabelVisible: false,
        });
      }

      const dRestore = this._derivScrollRestore;
      if (dRestore) this._derivScrollRestore = null;
      const derivRt = {
        ro: null,
        roTimer: null,
        panTimer: null,
        postTimer: null,
      };
      this.derivCharts = { main: chart, rsi: rsiChart, macd: macdChart };
      this._derivChartRuntime = derivRt;
      const isDerivAlive = () => this.derivCharts?.main === chart;
      const applyDerivDefaultViewport = () => {
        const nBars = barData.length;
        if (!nBars) return;
        const last = nBars - 1;
        // Nến hiện tại nằm khoảng 2/3 chart: rightPad ~= 1/3 total span.
        const coreBars = Math.min(140, Math.max(70, Math.round(nBars * 0.42)));
        const rightPad = Math.max(24, Math.round(coreBars * 0.5));
        const totalSpan = coreBars + rightPad;
        const to = last + rightPad;
        const from = to - totalSpan;
        chart.timeScale().setVisibleLogicalRange({ from, to });
      };
      if (dRestore && dRestore.added > 0) {
        chart.timeScale().setVisibleLogicalRange({
          from: dRestore.from + dRestore.added,
          to: dRestore.to + dRestore.added,
        });
      } else {
        applyDerivDefaultViewport();
      }
      derivRt.postTimer = setTimeout(() => {
        if (!isDerivAlive()) return;
        const range = chart.timeScale().getVisibleLogicalRange();
        const rightOffset = range
          ? Math.max(20, Math.round((range.to - range.from) * 0.24))
          : 24;
        [chart, rsiChart, macdChart].forEach((c) => {
          if (c)
            try {
              c.timeScale().applyOptions({ rightOffset });
            } catch {}
        });
        if (!dRestore) {
          try {
            applyDerivDefaultViewport();
          } catch {}
        }
        const synced = chart.timeScale().getVisibleLogicalRange();
        if (synced && rsiChart)
          try {
            rsiChart.timeScale().setVisibleLogicalRange(synced);
          } catch {}
        if (synced && macdChart)
          try {
            macdChart.timeScale().setVisibleLogicalRange(synced);
          } catch {}
      }, 50);

      let syncing = false;
      const syncAll = (source, others) => {
        source.timeScale().subscribeVisibleLogicalRangeChange((range) => {
          if (!isDerivAlive() || syncing || !range) return;
          syncing = true;
          others.forEach((c) => {
            if (c)
              try {
                c.timeScale().setVisibleLogicalRange(range);
              } catch {}
          });
          syncing = false;
        });
      };
      const sub = [rsiChart, macdChart];
      syncAll(chart, sub);
      if (rsiChart) syncAll(rsiChart, [chart, macdChart]);
      if (macdChart) syncAll(macdChart, [chart, rsiChart]);

      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (!isDerivAlive()) return;
        if (!range || !barData?.length) return;
        if (this.derivOlderLoading || !this.derivHasMoreOlder) return;
        const barCount = barData.length;
        const span = range.to - range.from;
        if (span >= barCount * 0.92) return;
        if (range.from > 14) return;
        clearTimeout(derivRt.panTimer);
        derivRt.panTimer = setTimeout(
          () => this.maybeLoadOlderDerivBars(),
          500,
        );
      });

      const ro = new ResizeObserver(() => {
        clearTimeout(derivRt.roTimer);
        derivRt.roTimer = setTimeout(() => {
          if (!isDerivAlive()) return;
          const nh = Math.max(280, Math.round(mainEl.clientHeight) || 420);
          const rh = rsiEl
            ? Math.max(96, Math.round(rsiEl.clientHeight) || 120)
            : 0;
          const mh = macdEl
            ? Math.max(96, Math.round(macdEl.clientHeight) || 120)
            : 0;
          chart.applyOptions({ width: mainEl.clientWidth, height: nh });
          if (rsiChart)
            rsiChart.applyOptions({
              width: rsiEl?.clientWidth ?? 0,
              height: rh,
            });
          if (macdChart)
            macdChart.applyOptions({
              width: macdEl?.clientWidth ?? 0,
              height: mh,
            });
        }, 120);
      });
      ro.observe(mainEl);
      derivRt.ro = ro;
    },

    destroyMarketSlot(slot) {
      const rt = this._marketChartRuntime?.[slot];
      if (rt) {
        if (rt.postTimer) clearTimeout(rt.postTimer);
        if (rt.panTimer) clearTimeout(rt.panTimer);
        if (rt.roTimer) clearTimeout(rt.roTimer);
        try {
          rt.ro?.disconnect();
        } catch {}
        this._marketChartRuntime[slot] = null;
      }
      const prev = this.marketCharts[slot];
      if (!prev) return;
      try {
        prev.main?.remove();
        prev.rsi?.remove();
        prev.macd?.remove();
      } catch {}
      this.marketCharts[slot] = null;
    },

    onMarketTabFocus() {
      if (this.marketLoading) return;
      this.$nextTick(() => {
        if (!this.marketBarVni.length && !this.marketBarVn30.length) {
          this.loadMarketCharts();
        } else {
          requestAnimationFrame(() => {
            if (this.marketBarVni.length) {
              this.renderMarketIndexPanel(this.marketBarVni, 'vni');
            }
            if (this.marketBarVn30.length) {
              this.renderMarketIndexPanel(this.marketBarVn30, 'vn30');
            }
          });
        }
      });
    },

    /** Cửa sổ thời gian chart phái sinh (mọi khung): ~1 tháng lịch — đồng bộ với ý «đủ ~31 ngày» như đồng bộ DB. */
    derivChartWindowMs() {
      return 31 * 24 * 60 * 60 * 1000;
    },

    derivOlderChunkMs() {
      const r = this.derivResolution;
      if (r === '5' || r === '15') return 5 * 24 * 60 * 60 * 1000;
      if (r === '1H') return 40 * 24 * 60 * 60 * 1000;
      return 5 * 24 * 60 * 60 * 1000;
    },

    setDerivResolution(r) {
      if (this.derivResolution === r) return;
      this.derivResolution = r;
      try {
        localStorage.setItem('derivResolution', r);
      } catch {}
      void this.loadDerivIntraday({ reset: true });
    },

    derivActionLabel(action) {
      if (action === 'LONG') return 'LONG';
      if (action === 'SHORT') return 'SHORT';
      return 'KHÔNG VÀO';
    },

    derivActionTone(action) {
      if (action === 'LONG')
        return 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300';
      if (action === 'SHORT')
        return 'bg-rose-500/10 text-rose-700 border-rose-500/30 dark:text-rose-300';
      return 'bg-slate-500/10 text-slate-600 border-slate-400/30 dark:text-zinc-300 dark:border-zinc-600';
    },

    derivOutcomeTone(outcome, pnl) {
      if (outcome === 'WIN' || Number(pnl) > 0)
        return 'text-emerald-700 dark:text-emerald-300';
      if (outcome === 'LOSS' || Number(pnl) < 0)
        return 'text-rose-700 dark:text-rose-300';
      return 'text-gray-500 dark:text-zinc-400';
    },

    fmtDerivPoints(v, digits = 2) {
      const n = Number(v);
      if (!Number.isFinite(n)) return '—';
      return n.toFixed(digits).replace(/\.?0+$/, '');
    },

    derivCurrentPoints(decision) {
      const d = decision || null;
      if (!d || d.status !== 'OPEN') return null;
      const entry = Number(d.entryPrice);
      const pnl = Number(d.pnlPoints);
      if (!Number.isFinite(entry) || !Number.isFinite(pnl)) return null;
      if (d.action === 'LONG') return entry + pnl;
      if (d.action === 'SHORT') return entry - pnl;
      return null;
    },

    fmtPct(v, digits = 1) {
      const n = Number(v);
      if (!Number.isFinite(n)) return '—';
      return `${n.toFixed(digits).replace(/\.0+$/, '')}%`;
    },

    fmtDerivDateTime(v) {
      if (!v) return '—';
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return '—';
      return d.toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    },

    normalizeViText(v) {
      if (v == null) return '';
      const s = String(v);
      // Heuristic: chuỗi bị decode sai UTF-8 thường chứa các cụm này.
      const likelyMojibake = /(Ã.|Æ.|Ä.|áº|á»|â€|Â.)/.test(s);
      if (!likelyMojibake) return s;
      try {
        const bytes = Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
        const fixed = new TextDecoder('utf-8').decode(bytes);
        return fixed || s;
      } catch {
        return s;
      }
    },

    fmtDerivMonth(v) {
      if (!v) return '—';
      const [y, m] = String(v).split('-');
      if (!y || !m) return String(v);
      return `${m}/${y}`;
    },

    vnYmdNow() {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
    },

    derivDecisionDateKey(v) {
      if (!v) return '';
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return '';
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(d);
    },

    derivDecisionMonthKey(v) {
      const day = this.derivDecisionDateKey(v);
      return day ? day.slice(0, 7) : '';
    },

    ensureDerivDefaultFilterDate() {
      const latest = this.derivDecisionHistory?.[0];
      const latestDay = this.derivDecisionDateKey(latest?.decidedAt);
      if (!latestDay) return;
      if (!this.derivFilterDate) {
        this.derivFilterDate = latestDay;
      }
      if (!this.derivFilterMonth) {
        this.derivFilterMonth = latestDay.slice(0, 7);
      }
    },

    derivEffectiveMonthFilter() {
      const explicitMonth = (this.derivFilterMonth || '').trim();
      if (explicitMonth) return explicitMonth;
      const day = (this.derivFilterDate || '').trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.slice(0, 7) : '';
    },

    derivFilteredHistory() {
      const day = (this.derivFilterDate || '').trim();
      const month = this.derivEffectiveMonthFilter();
      return (this.derivDecisionHistory || []).filter((d) => {
        const dDay = this.derivDecisionDateKey(d?.decidedAt);
        if (!dDay) return false;
        if (day && dDay !== day) return false;
        if (!day && month && !dDay.startsWith(month)) return false;
        return true;
      });
    },

    derivPnlBreakdown(items) {
      const out = {
        totalCount: Array.isArray(items) ? items.length : 0,
        pnlCount: 0,
        winCount: 0,
        lossCount: 0,
        flatCount: 0,
        winPoints: 0,
        lossPoints: 0,
        netPoints: 0,
        winRatePct: 0,
        lossRatePct: 0,
        profitSharePct: 0,
        lossSharePct: 0,
        netPct: 0,
      };
      for (const d of items || []) {
        const pnl = Number(d?.pnlPoints);
        if (!Number.isFinite(pnl)) continue;
        out.pnlCount += 1;
        out.netPoints += pnl;
        if (pnl > 0) {
          out.winCount += 1;
          out.winPoints += pnl;
        } else if (pnl < 0) {
          out.lossCount += 1;
          out.lossPoints += Math.abs(pnl);
        } else {
          out.flatCount += 1;
        }
      }
      if (out.pnlCount > 0) {
        out.winRatePct = (out.winCount / out.pnlCount) * 100;
        out.lossRatePct = (out.lossCount / out.pnlCount) * 100;
      }
      const volume = out.winPoints + out.lossPoints;
      if (volume > 0) {
        out.profitSharePct = (out.winPoints / volume) * 100;
        out.lossSharePct = (out.lossPoints / volume) * 100;
        out.netPct = (out.netPoints / volume) * 100;
      }
      return out;
    },

    derivDayWinPoints() {
      const day = (this.derivFilterDate || this.vnYmdNow()).trim();
      return (this.derivDecisionHistory || []).reduce((sum, d) => {
        if (this.derivDecisionDateKey(d?.decidedAt) !== day) return sum;
        const pnl = Number(d?.pnlPoints);
        return Number.isFinite(pnl) && pnl > 0 ? sum + pnl : sum;
      }, 0);
    },

    derivDaySummary() {
      const day = (this.derivFilterDate || this.vnYmdNow()).trim();
      const rows = (this.derivDecisionHistory || []).filter(
        (d) => this.derivDecisionDateKey(d?.decidedAt) === day,
      );
      return { day, ...this.derivPnlBreakdown(rows) };
    },

    derivMonthSummary() {
      const month =
        this.derivEffectiveMonthFilter() || this.vnYmdNow().slice(0, 7);
      const rows = (this.derivDecisionHistory || []).filter(
        (d) => this.derivDecisionMonthKey(d?.decidedAt) === month,
      );
      return { month, ...this.derivPnlBreakdown(rows) };
    },

    applyDerivDecisionToAnalysis() {
      const d = this.derivDecisionLatest;
      if (!d) {
        this.derivAnalysis = {
          short:
            'Chưa có quyết định phái sinh từ server. Chờ cron 5 phút hoặc bấm Quét ngay.',
        };
        return;
      }
      const action = d.action;
      const bias =
        action === 'LONG' ? 'long' : action === 'SHORT' ? 'short' : 'neutral';
      const metrics = d.metadata?.metrics || {};
      this.derivAnalysis = {
        lastClose: Number(d.entryPrice ?? metrics.close ?? 0),
        atr:
          metrics.atr14 == null || Number.isNaN(Number(metrics.atr14))
            ? null
            : Number(metrics.atr14),
        bias,
        biasLabelVi: this.derivActionLabel(action),
        biasHint: d.reason || '',
        sl: d.stopLoss == null ? null : Number(d.stopLoss),
        tp: d.takeProfit == null ? null : Number(d.takeProfit),
        score: d.score,
        confidence: d.confidence,
        decidedAt: d.decidedAt,
        outcome: d.outcome,
        pnlPoints: d.pnlPoints,
      };
    },

    async loadDerivativeDecisions(opts = {}) {
      const silent = opts.silent === true;
      const forceNetwork = opts.forceNetwork === true;
      if (!silent) this.derivDecisionLoading = true;
      try {
        const latestUrl = forceNetwork
          ? this.withNoCache('/derivatives/vn30/decision/latest')
          : '/derivatives/vn30/decision/latest';
        const historyUrl = forceNetwork
          ? this.withNoCache('/derivatives/vn30/decisions?limit=200')
          : '/derivatives/vn30/decisions?limit=200';
        const [latest, history] = await Promise.all([
          fetch(latestUrl, { cache: 'no-store' })
            .then((r) => r.json())
            .catch(() => null),
          fetch(historyUrl, { cache: 'no-store' })
            .then((r) => r.json())
            .catch(() => []),
        ]);
        this.derivDecisionLatest = latest && latest.id ? latest : null;
        this.derivDecisionHistory = Array.isArray(history) ? history : [];
        this.ensureDerivDefaultFilterDate();
        this.applyDerivDecisionToAnalysis();
        if (this.tab === 'derivatives' && this.derivBars.length) {
          requestAnimationFrame(() => this.renderDerivIntradayPanel());
        }
      } finally {
        if (!silent) this.derivDecisionLoading = false;
      }
    },

    async runDerivManualScan() {
      if (!this.isAdmin) {
        this.showToast('Cần đăng nhập admin', 'error');
        return;
      }
      if (this.derivDecisionScanLoading) return;
      this.derivDecisionScanLoading = true;
      try {
        const res = await this.authFetch('/derivatives/vn30/scan?notify=1', {
          method: 'POST',
        }).then((r) => r.json());
        if (!res?.decision) throw new Error('scan_failed');
        await Promise.all([
          this.loadDerivativeDecisions({ silent: true, forceNetwork: true }),
          this.loadDerivIntraday({
            silent: true,
            reset: false,
            fast: true,
            forceNetwork: true,
          }),
        ]);
        this.showToast('Đã quét phái sinh VN30', 'success');
      } catch {
        this.showToast('Không quét được phái sinh VN30', 'error');
      } finally {
        this.derivDecisionScanLoading = false;
      }
    },

    /** Tab Phái sinh: intraday VN30. */
    onDerivativesTabFocus() {
      void this.loadDerivativeDecisions({ silent: true });
      if (!this.btResult?.series?.length) {
        if (!this.restoreBacktestResultFromCache()) {
          void this.runVn30Backtest();
        }
      } else if (!this._btChart) {
        this.$nextTick(() => this.renderBtEquityChart());
      }
      this.$nextTick(() => {
        requestAnimationFrame(() => {
          if (
            !this.derivBars.length ||
            this.derivBarsResolution !== this.derivResolution
          ) {
            void this.loadDerivIntraday({ silent: true });
          } else {
            this.renderDerivIntradayPanel();
          }
        });
      });
    },

    async loadDerivSignalsLatest() {
      const raw = await fetch('/signals/VN30')
        .then((r) => r.json())
        .catch(() => []);
      this.derivSignalsLatest = Array.isArray(raw) ? raw.slice(0, 40) : [];
    },

    /**
     * Admin: đồng bộ nến **ngày** VNINDEX + VN30 trong ~31 ngày lịch + phân tích tín hiệu (cùng pipeline tab Thị trường).
     * Chart intraday 5m/15m/1H vẫn lấy từ API Entrade khi làm mới chart.
     */
    async syncIndicesOneMonthAndReload() {
      if (!this.isAdmin) {
        this.showToast('Cần đăng nhập admin', 'error');
        return;
      }
      this.derivSyncMonthLoading = true;
      try {
        const tickers = ['VNINDEX', 'VN30'];
        for (const t of tickers) {
          const res = await this.authFetch(`/queue/sync/${t}?windowDays=31`, {
            method: 'POST',
          })
            .then((r) => r.json())
            .catch(() => null);
          if (!res?.jobId) {
            this.showToast(`Không tạo job đồng bộ ${t}`, 'error');
            return;
          }
          await this.pollJob(res.jobId, `Đồng bộ ${t} ~1 tháng`, null, {
            silentToast: true,
          });
        }
        await Promise.all([
          this.loadDerivativeDecisions({ silent: true }),
          this.loadMarketCharts({ silent: true }),
        ]);
        if (this.tab === 'derivatives') {
          await this.loadDerivIntraday({ silent: true, reset: true });
        }
        this.showToast(
          'Đã đồng bộ ~1 tháng (VNINDEX + VN30) và phân tích tín hiệu',
          'success',
        );
      } catch (e) {
        if (e.message !== 'Unauthorized') {
          this.showToast('Lỗi đồng bộ', 'error');
        }
      } finally {
        this.derivSyncMonthLoading = false;
      }
    },

    async runVn30Backtest() {
      if (this.btLoading) return;
      this.btLoading = true;
      this.btError = '';
      this.btResult = null;
      if (this._btChart) {
        this._btChart.remove();
        this._btChart = null;
      }
      try {
        const params = new URLSearchParams({
          from: this.btFrom,
          to: this.btTo,
        });
        if (!this.btTrailing) params.set('trailing', 'off');
        if (!this.btRsicap) params.set('rsicap', 'off');
        const res = await fetch(
          '/derivatives/vn30/backtest?' + params.toString(),
          {
            cache: 'no-store',
          },
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message || 'Lỗi API ' + res.status);
        if (!data?.series?.length)
          throw new Error(
            'Không có dữ liệu — DNSE không trả nến 5m cho khoảng thời gian này',
          );
        this.btResult = data;
        this.writeBacktestCache(data);
        await this.$nextTick();
        this.renderBtEquityChart();
      } catch (e) {
        this.btError = e.message || 'Lỗi backtest';
      } finally {
        this.btLoading = false;
      }
    },

    renderBtEquityChart() {
      const el = this.$refs.btEquityChart;
      if (!el || !this.btResult?.series?.length) return;
      if (this._btChart) {
        this._btChart.remove();
        this._btChart = null;
      }
      const dark = this.darkMode;
      const chart = LightweightCharts.createChart(el, {
        width: el.clientWidth,
        height: 200,
        layout: {
          background: { color: dark ? '#09090b' : '#ffffff' },
          textColor: dark ? '#71717a' : '#64748b',
          fontFamily: 'Inter, system-ui, sans-serif',
          fontSize: 11,
        },
        grid: {
          vertLines: { color: dark ? '#27272a' : '#f1f5f9' },
          horzLines: { color: dark ? '#27272a' : '#f1f5f9' },
        },
        rightPriceScale: { visible: true, minimumWidth: 56 },
        timeScale: {
          borderColor: dark ? '#3f3f46' : '#e2e8f0',
          fixRightEdge: true,
        },
        localization: {
          priceFormatter: (p) => (p >= 0 ? '+' : '') + p.toFixed(2),
        },
        handleScroll: true,
        handleScale: true,
      });
      for (const s of this.btResult.series) {
        const line = chart.addLineSeries({
          color: s.color,
          lineWidth: 2,
          title: s.label,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: true,
        });
        const equityData = (Array.isArray(s.equity) ? s.equity : [])
          .map((e) => ({
            time: typeof e?.date === 'string' ? e.date : String(e?.date ?? ''),
            value: Number(e?.value),
          }))
          .filter(
            (p) =>
              p.time &&
              p.time !== 'null' &&
              p.time !== 'undefined' &&
              Number.isFinite(p.value),
          );
        line.setData(equityData);
      }
      chart.timeScale().fitContent();
      this._btChart = chart;
    },

    async loadMarketCharts(opts = {}) {
      const silent = opts.silent === true;
      if (!silent) this.marketLoading = true;
      /** Lần đầu ~N phiên gần nhất; kéo trái → nạp thêm theo chunk tới khi hết nến trên server. */
      const INITIAL = 400;
      try {
        this._marketScrollRestore = null;
        const [rawVni, rawV30] = await Promise.all([
          fetch(`/stocks/VNINDEX/stored?limit=${INITIAL}`)
            .then((r) => r.json())
            .catch(() => []),
          fetch(`/stocks/VN30/stored?limit=${INITIAL}`)
            .then((r) => r.json())
            .catch(() => []),
        ]);
        const norm = (arr) => {
          const a = Array.isArray(arr) ? arr : [];
          return [...a].sort((x, y) =>
            String(x.tradingDate).localeCompare(String(y.tradingDate)),
          );
        };
        const vni = norm(rawVni);
        const v30 = norm(rawV30);
        this.marketHasMoreVni = vni.length >= INITIAL;
        this.marketHasMoreVn30 = v30.length >= INITIAL;
        const from =
          !vni.length && !v30.length
            ? '2000-01-01'
            : !vni.length
              ? v30[0].tradingDate
              : !v30.length
                ? vni[0].tradingDate
                : String(vni[0].tradingDate) < String(v30[0].tradingDate)
                  ? vni[0].tradingDate
                  : v30[0].tradingDate;
        const q = `from=${encodeURIComponent(from)}`;
        const [chartVni, chartV30, latestVni, latestV30] = await Promise.all([
          fetch(`/signals/VNINDEX/chart?${q}`)
            .then((r) => r.json())
            .catch(() => []),
          fetch(`/signals/VN30/chart?${q}`)
            .then((r) => r.json())
            .catch(() => []),
          fetch('/signals/VNINDEX')
            .then((r) => r.json())
            .catch(() => []),
          fetch('/signals/VN30')
            .then((r) => r.json())
            .catch(() => []),
        ]);
        this.marketBarVni = vni;
        this.marketBarVn30 = v30;
        this.marketSignalsVni = Array.isArray(chartVni) ? chartVni : [];
        this.marketSignalsVn30 = Array.isArray(chartV30) ? chartV30 : [];
        this.marketLatestVni = Array.isArray(latestVni) ? latestVni : [];
        this.marketLatestVn30 = Array.isArray(latestV30) ? latestV30 : [];
        await this.$nextTick();
        requestAnimationFrame(() => {
          if (this.marketBarVni.length) {
            this.renderMarketIndexPanel(this.marketBarVni, 'vni');
          } else {
            this.destroyMarketSlot('vni');
          }
          if (this.marketBarVn30.length) {
            this.renderMarketIndexPanel(this.marketBarVn30, 'vn30');
          } else {
            this.destroyMarketSlot('vn30');
          }
        });
      } finally {
        if (!silent) this.marketLoading = false;
      }
    },

    /**
     * Kéo chart chỉ số sang trái (gần mép dữ liệu) → tải thêm nến cũ theo chunk (5000/request, trần API), lặp tới khi hết.
     */
    async maybeLoadOlderMarketBars(slot) {
      /** Mỗi request tối đa 5000 bản ghi (trần API); lặp tới khi trả về ít hơn chunk hoặc rỗng. */
      const CHUNK = 5000;
      const ticker = slot === 'vni' ? 'VNINDEX' : 'VN30';
      const arrKey = slot === 'vni' ? 'marketBarVni' : 'marketBarVn30';
      const sigKey = slot === 'vni' ? 'marketSignalsVni' : 'marketSignalsVn30';
      const hasKey = slot === 'vni' ? 'marketHasMoreVni' : 'marketHasMoreVn30';
      const loadKey =
        slot === 'vni' ? 'marketOlderLoadingVni' : 'marketOlderLoadingVn30';

      const bars = this[arrKey];
      if (!Array.isArray(bars) || !bars.length || this[loadKey]) return;
      if (!this[hasKey]) return;

      const oldest = bars[0].tradingDate;
      const prevLen = bars.length;
      let scrollSnap = null;
      const mc = this.marketCharts[slot];
      if (mc?.main) {
        const r = mc.main.timeScale().getVisibleLogicalRange();
        if (r && Number.isFinite(r.from) && Number.isFinite(r.to)) {
          scrollSnap = { from: r.from, to: r.to };
        }
      }

      this[loadKey] = true;
      try {
        const more = await fetch(
          `/stocks/${ticker}/stored?before=${encodeURIComponent(oldest)}&limit=${CHUNK}`,
        )
          .then((r) => r.json())
          .catch(() => []);
        if (!Array.isArray(more) || !more.length) {
          this[hasKey] = false;
          return;
        }
        const byDate = new Map(bars.map((b) => [b.tradingDate, b]));
        for (const b of more) byDate.set(b.tradingDate, b);
        const merged = [...byDate.values()].sort((a, b) =>
          String(a.tradingDate).localeCompare(String(b.tradingDate)),
        );
        this[arrKey] = merged;
        this[hasKey] = more.length >= CHUNK;

        const from = merged[0].tradingDate;
        const chartSigs = await fetch(
          `/signals/${ticker}/chart?from=${encodeURIComponent(from)}`,
        )
          .then((r) => r.json())
          .catch(() => []);
        this[sigKey] = Array.isArray(chartSigs) ? chartSigs : [];

        const added = merged.length - prevLen;
        if (scrollSnap && added > 0) {
          this._marketScrollRestore = {
            slot,
            from: scrollSnap.from,
            to: scrollSnap.to,
            added,
          };
        } else {
          this._marketScrollRestore = null;
        }

        await this.$nextTick();
        requestAnimationFrame(() => this.renderMarketIndexPanel(merged, slot));
      } finally {
        this[loadKey] = false;
      }
    },

    /** Admin: đồng bộ full IPO VNINDEX + VN30 (full=1), phân tích nến sau sync, rồi làm mới chart. */
    async syncMarketIndicesAndReload() {
      if (!this.isAdmin) {
        this.showToast('Cần đăng nhập admin', 'error');
        return;
      }
      this.marketSyncLoading = true;
      try {
        const tickers = ['VNINDEX', 'VN30'];
        for (const t of tickers) {
          const res = await this.authFetch(`/queue/sync/${t}?full=1`, {
            method: 'POST',
          })
            .then((r) => r.json())
            .catch(() => null);
          if (!res?.jobId) {
            this.showToast(`Không tạo job đồng bộ ${t}`, 'error');
            return;
          }
          this.log(
            'info',
            `⏳ Đồng bộ full IPO + phân tích ${t} (job #${res.jobId})...`,
          );
          await this.pollJob(res.jobId, `Đồng bộ ${t}`, null, {
            silentToast: true,
          });
        }
        await this.loadMarketCharts({ silent: true });
        this.showToast(
          'Đã đồng bộ full IPO và phân tích nến VNINDEX / VN30',
          'success',
        );
      } catch (e) {
        if (e.message !== 'Unauthorized') {
          this.showToast('Lỗi đồng bộ chỉ số', 'error');
        }
      } finally {
        this.marketSyncLoading = false;
      }
    },

    /**
     * Chart chỉ số: nến + volume + EMA + Hỗ trợ/KC + marker tín hiệu (cùng logic tab Tín hiệu).
     * `slot`: 'vni' | 'vn30' — khớp x-ref.
     */
    renderMarketIndexPanel(barData, slot) {
      const mainEl =
        slot === 'vni' ? this.$refs.marketChartVni : this.$refs.marketChartVn30;
      const rsiEl =
        slot === 'vni' ? this.$refs.marketRsiVni : this.$refs.marketRsiVn30;
      const macdEl =
        slot === 'vni' ? this.$refs.marketMacdVni : this.$refs.marketMacdVn30;
      if (!mainEl || !barData?.length) return;

      this.destroyMarketSlot(slot);

      const mainH = Math.max(280, Math.round(mainEl.clientHeight) || 420);

      const dark = this.darkMode;
      const baseLayout = {
        background: { color: dark ? '#09090b' : '#ffffff' },
        textColor: dark ? '#71717a' : '#64748b',
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 11,
      };
      const baseGrid = {
        vertLines: { color: dark ? '#27272a' : '#f1f5f9' },
        horzLines: { color: dark ? '#27272a' : '#f1f5f9' },
      };
      const baseTS = {
        borderColor: dark ? '#3f3f46' : '#e2e8f0',
        timeVisible: false,
        fixLeftEdge: false,
        fixRightEdge: false,
        rightOffset: 0,
      };
      const syncTs = {
        ...baseTS,
        timeVisible: true,
        barSpacing: 7,
        minBarSpacing: 3,
      };

      const n = (x) => {
        const v = typeof x === 'number' ? x : Number(x);
        return Number.isFinite(v) ? v : 0;
      };

      const chart = LightweightCharts.createChart(mainEl, {
        width: mainEl.clientWidth,
        height: mainH,
        layout: { ...baseLayout, fontSize: 12 },
        grid: baseGrid,
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: {
          borderColor: '#e5e7eb',
          scaleMargins: { top: 0.08, bottom: 0.22 },
          minimumWidth: 64,
        },
        timeScale: syncTs,
        localization: { priceFormatter: (p) => n(p).toFixed(2) },
      });

      const candleSeries = chart.addCandlestickSeries({
        upColor: '#26a69a',
        downColor: '#ef5350',
        borderVisible: false,
        wickUpColor: '#26a69a',
        wickDownColor: '#ef5350',
      });
      candleSeries.setData(
        barData.map((b) => ({
          time: b.tradingDate,
          open: +(n(b.open) / 1000).toFixed(2),
          high: +(n(b.high) / 1000).toFixed(2),
          low: +(n(b.low) / 1000).toFixed(2),
          close: +(n(b.close) / 1000).toFixed(2),
        })),
      );

      const sigForMarkers =
        slot === 'vni' ? this.marketSignalsVni : this.marketSignalsVn30;
      const mk = this.buildSignalMarkers(barData, sigForMarkers);
      if (mk.length) candleSeries.setMarkers(mk);

      const volSeries = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
      });
      volSeries
        .priceScale()
        .applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volSeries.setData(
        barData.map((b) => ({
          time: b.tradingDate,
          value: n(b.volume),
          color: n(b.close) >= n(b.open) ? '#26a69a33' : '#ef535033',
        })),
      );

      const closes = barData.map((b) => n(b.close) / 1000);
      const emaFn = (vals, p) => {
        const k = 2 / (p + 1);
        let e = null;
        return vals.map((v) => {
          e = e === null ? v : v * k + e * (1 - k);
          return +e.toFixed(3);
        });
      };
      const ema20 = emaFn(closes, 20);
      const ema50 = emaFn(closes, 50);
      const addEma = (values, warmup, color, title) => {
        const s = chart.addLineSeries({
          color,
          lineWidth: 1.5,
          title,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
        });
        s.setData(
          barData.slice(warmup).map((b, i) => ({
            time: b.tradingDate,
            value: values[i + warmup],
          })),
        );
      };
      if (this.chartShowEma) {
        addEma(ema20, 19, '#3b82f6', 'EMA20');
        addEma(ema50, 49, '#f97316', 'EMA50');
      }

      let supK = null;
      let resK = null;
      if (barData.length >= 20) {
        const recent20 = barData.slice(-20);
        supK = +(Math.min(...recent20.map((b) => n(b.low))) / 1000).toFixed(2);
        resK = +(Math.max(...recent20.map((b) => n(b.high))) / 1000).toFixed(2);
      }
      if (
        this.chartShowSR &&
        supK != null &&
        resK != null &&
        supK > 0 &&
        resK > 0
      ) {
        const dash = LightweightCharts.LineStyle.Dashed;
        const supCol = dark ? '#4ade80' : '#16a34a';
        const resCol = dark ? '#f87171' : '#dc2626';
        candleSeries.createPriceLine({
          price: supK,
          color: supCol,
          lineWidth: 1,
          lineStyle: dash,
          axisLabelVisible: true,
          title: 'Hỗ trợ',
        });
        candleSeries.createPriceLine({
          price: resK,
          color: resCol,
          lineWidth: 1,
          lineStyle: dash,
          axisLabelVisible: true,
          title: 'Kháng cự',
        });
      }

      const rsiValues = this.calcRSI(closes, 14);
      let rsiChart = null;
      if (rsiEl) {
        rsiChart = LightweightCharts.createChart(rsiEl, {
          width: rsiEl.clientWidth,
          height: 96,
          layout: baseLayout,
          grid: baseGrid,
          crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
          rightPriceScale: {
            borderColor: '#e5e7eb',
            minimumWidth: 64,
            autoScale: false,
          },
          timeScale: syncTs,
        });
        rsiChart.priceScale('right').applyOptions({ minimum: 0, maximum: 100 });
        const rsiSeries = rsiChart.addLineSeries({
          color: '#8b5cf6',
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          title: 'RSI',
        });
        rsiSeries.setData(
          barData.map((b, i) => {
            const v = rsiValues[i];
            if (v == null || Number.isNaN(v)) return { time: b.tradingDate };
            return { time: b.tradingDate, value: v };
          }),
        );
        const lineStyle = LightweightCharts.LineStyle.Dashed;
        rsiSeries.createPriceLine({
          price: 70,
          color: '#ef4444',
          lineWidth: 1,
          lineStyle,
          axisLabelVisible: false,
          title: '',
        });
        rsiSeries.createPriceLine({
          price: 30,
          color: '#10b981',
          lineWidth: 1,
          lineStyle,
          axisLabelVisible: false,
          title: '',
        });
      }

      const macdData = this.calcMACDFromBars(closes, barData);
      let macdChart = null;
      if (macdEl) {
        macdChart = LightweightCharts.createChart(macdEl, {
          width: macdEl.clientWidth,
          height: 96,
          layout: baseLayout,
          grid: baseGrid,
          crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
          rightPriceScale: { borderColor: '#e5e7eb', minimumWidth: 64 },
          timeScale: syncTs,
        });
        const histSeries = macdChart.addHistogramSeries({
          priceScaleId: 'right',
          lastValueVisible: false,
        });
        histSeries.setData(
          macdData.map((d) => {
            if (d.hist == null || Number.isNaN(d.hist)) return { time: d.time };
            const h = d.hist;
            return {
              time: d.time,
              value: h,
              color: h >= 0 ? '#26a69a88' : '#ef535088',
            };
          }),
        );
        const macdLine = macdChart.addLineSeries({
          color: '#3b82f6',
          lineWidth: 1.5,
          priceLineVisible: false,
          lastValueVisible: true,
          title: 'MACD',
        });
        macdLine.setData(
          macdData.map((d) =>
            d.macd != null && !Number.isNaN(d.macd)
              ? { time: d.time, value: d.macd }
              : { time: d.time },
          ),
        );
        const sigLine = macdChart.addLineSeries({
          color: '#f97316',
          lineWidth: 1.5,
          priceLineVisible: false,
          lastValueVisible: true,
          title: 'Signal',
        });
        sigLine.setData(
          macdData.map((d) =>
            d.signal != null && !Number.isNaN(d.signal)
              ? { time: d.time, value: d.signal }
              : { time: d.time },
          ),
        );
        histSeries.createPriceLine({
          price: 0,
          color: '#94a3b8',
          lineWidth: 1,
          lineStyle: LightweightCharts.LineStyle.Dotted,
          axisLabelVisible: false,
        });
      }

      const mktRestore =
        this._marketScrollRestore?.slot === slot
          ? this._marketScrollRestore
          : null;
      if (mktRestore) this._marketScrollRestore = null;
      const marketRt = {
        ro: null,
        roTimer: null,
        panTimer: null,
        postTimer: null,
      };
      this.marketCharts[slot] = { main: chart, rsi: rsiChart, macd: macdChart };
      this._marketChartRuntime[slot] = marketRt;
      const isMarketAlive = () => this.marketCharts?.[slot]?.main === chart;
      if (mktRestore && mktRestore.added > 0) {
        chart.timeScale().setVisibleLogicalRange({
          from: mktRestore.from + mktRestore.added,
          to: mktRestore.to + mktRestore.added,
        });
      } else {
        chart.timeScale().fitContent();
      }
      marketRt.postTimer = setTimeout(() => {
        if (!isMarketAlive()) return;
        const range = chart.timeScale().getVisibleLogicalRange();
        const rightOffset = range
          ? Math.round((range.to - range.from) * 0.22)
          : 12;
        [chart, rsiChart, macdChart].forEach((c) => {
          if (c)
            try {
              c.timeScale().applyOptions({ rightOffset });
            } catch {}
        });
        const synced = chart.timeScale().getVisibleLogicalRange();
        if (synced && rsiChart)
          try {
            rsiChart.timeScale().setVisibleLogicalRange(synced);
          } catch {}
        if (synced && macdChart)
          try {
            macdChart.timeScale().setVisibleLogicalRange(synced);
          } catch {}
      }, 50);

      let syncing = false;
      const syncAll = (source, others) => {
        source.timeScale().subscribeVisibleLogicalRangeChange((range) => {
          if (!isMarketAlive() || syncing || !range) return;
          syncing = true;
          others.forEach((c) => {
            if (c)
              try {
                c.timeScale().setVisibleLogicalRange(range);
              } catch {}
          });
          syncing = false;
        });
      };
      const sub = [rsiChart, macdChart];
      syncAll(chart, sub);
      if (rsiChart) syncAll(rsiChart, [chart, macdChart]);
      if (macdChart) syncAll(macdChart, [chart, rsiChart]);

      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (!isMarketAlive()) return;
        if (!range || !barData?.length) return;
        const loading =
          slot === 'vni'
            ? this.marketOlderLoadingVni
            : this.marketOlderLoadingVn30;
        const hasMore =
          slot === 'vni' ? this.marketHasMoreVni : this.marketHasMoreVn30;
        if (loading || !hasMore) return;
        const barCount = barData.length;
        const span = range.to - range.from;
        if (span >= barCount * 0.92) return;
        if (range.from > 14) return;
        clearTimeout(marketRt.panTimer);
        marketRt.panTimer = setTimeout(
          () => this.maybeLoadOlderMarketBars(slot),
          500,
        );
      });

      const ro = new ResizeObserver(() => {
        clearTimeout(marketRt.roTimer);
        marketRt.roTimer = setTimeout(() => {
          if (!isMarketAlive()) return;
          const nh = Math.max(280, Math.round(mainEl.clientHeight) || 420);
          chart.applyOptions({ width: mainEl.clientWidth, height: nh });
          if (rsiChart)
            rsiChart.applyOptions({ width: rsiEl?.clientWidth ?? 0 });
          if (macdChart)
            macdChart.applyOptions({ width: macdEl?.clientWidth ?? 0 });
        }, 120);
      });
      ro.observe(mainEl);
      marketRt.ro = ro;
    },

    viewSignals(ticker) {
      this.signalTicker = ticker;
      window.dispatchEvent(
        new CustomEvent('signal-ticker-sync', { detail: { ticker } }),
      );
      this.setTab('signals');
      this.loadSignals();
    },

    /** Tên công ty từ watchlist (nếu có) — dùng tab Cổ phiếu. */
    priceTickerDisplayName() {
      const t = (this.priceTicker || '').toUpperCase();
      if (!t) return '';
      const s = this.watchlist.find((x) => x.ticker === t);
      return s?.name ? String(s.name) : '';
    },

    async loadStockData() {
      if (!this.priceTicker) return;
      const t = this.priceTicker.toUpperCase();
      const PAGE = 60;
      const [history, latest] = await Promise.all([
        fetch(`/stocks/${t}/stored?limit=${PAGE}`)
          .then((r) => r.json())
          .catch(() => []),
        fetch(`/stocks/${t}/latest`)
          .then((r) => r.json())
          .catch(() => null),
      ]);
      this.priceHistory = Array.isArray(history) ? history : [];
      this.priceHistoryHasMore = this.priceHistory.length >= PAGE;
      this.latestBar = latest;
    },

    async loadMorePriceHistory() {
      if (
        !this.priceTicker ||
        !this.priceHistory.length ||
        this.priceHistoryLoadingMore
      )
        return;
      const t = this.priceTicker.toUpperCase();
      const PAGE = 60;
      const oldest =
        this.priceHistory[this.priceHistory.length - 1].tradingDate;
      this.priceHistoryLoadingMore = true;
      try {
        const more = await fetch(
          `/stocks/${t}/stored?before=${encodeURIComponent(oldest)}&limit=${PAGE}`,
        )
          .then((r) => r.json())
          .catch(() => []);
        if (!Array.isArray(more) || !more.length) {
          this.priceHistoryHasMore = false;
          return;
        }
        this.priceHistory = [...this.priceHistory, ...more];
        this.priceHistoryHasMore = more.length >= PAGE;
      } finally {
        this.priceHistoryLoadingMore = false;
      }
    },

    /** Kéo chart sang trái gần mép dữ liệu → tải thêm nến cũ (tối đa ~900 nến). */
    async maybeLoadOlderChartBars(ticker) {
      const MAX = 900;
      const CHUNK = 200;
      const t = (ticker || this.signalTicker || '').toUpperCase();
      if (!t || !this.barData.length || this.chartOlderLoading) return;
      if (this.barData.length >= MAX) return;

      const prevLen = this.barData.length;
      let scrollSnap = null;
      if (this.lwChart) {
        const r = this.lwChart.timeScale().getVisibleLogicalRange();
        if (r && Number.isFinite(r.from) && Number.isFinite(r.to)) {
          scrollSnap = { from: r.from, to: r.to };
        }
      }

      const oldest = this.barData[0].tradingDate;
      this.chartOlderLoading = true;
      try {
        const more = await fetch(
          `/stocks/${t}/stored?before=${encodeURIComponent(oldest)}&limit=${CHUNK}`,
        )
          .then((r) => r.json())
          .catch(() => []);
        if (!Array.isArray(more) || !more.length) return;
        const byDate = new Map(this.barData.map((b) => [b.tradingDate, b]));
        for (const b of more) byDate.set(b.tradingDate, b);
        let merged = [...byDate.values()].sort((a, b) =>
          String(a.tradingDate).localeCompare(String(b.tradingDate)),
        );
        if (merged.length > MAX) merged = merged.slice(-MAX);
        const added = merged.length - prevLen;
        this.barData = merged;

        const from = this.barData[0].tradingDate;
        const chartSigs = await fetch(`/signals/${t}/chart?from=${from}`)
          .then((r) => r.json())
          .catch(() => []);
        this._applyChartSignalsPayload(chartSigs);

        if (scrollSnap && added > 0) {
          this._chartScrollRestore = {
            from: scrollSnap.from,
            to: scrollSnap.to,
            added,
          };
          this.chartViewport = {
            ticker: t,
            from: scrollSnap.from + added,
            to: scrollSnap.to + added,
          };
        } else {
          this._chartScrollRestore = null;
        }

        this.$nextTick(() => {
          requestAnimationFrame(() => this.renderChart(t));
        });
      } finally {
        this.chartOlderLoading = false;
      }
    },

    async syncTicker(fullIpo) {
      if (!this.priceTicker) return;
      const full = !!fullIpo;
      if (full) this.actionLoading.syncOneFull = true;
      else this.actionLoading.syncOne = true;
      const t = this.priceTicker.toUpperCase();
      const label = full ? `Full IPO ${t}` : `Đồng bộ ~1 năm / tăng dần ${t}`;
      const q = full ? '?full=1' : '';
      const res = await this.authFetch(`/queue/sync/${t}${q}`, {
        method: 'POST',
      })
        .then((r) => r.json())
        .catch(() => null);
      if (res?.jobId) {
        this.log('info', `⏳ ${label} job #${res.jobId}...`);
        await this.pollJob(res.jobId, label, async () => {
          await this.loadStockData();
          await this.loadSignalSummary();
        });
      }
      this.actionLoading.syncOne = false;
      this.actionLoading.syncOneFull = false;
    },

    async trackPositions() {
      this.scanning = true;
      await this.authFetch('/positions/track', { method: 'POST' });
      await this.loadOpenPositions();
      this.scanning = false;
      this.showToast('Cập nhật vị thế xong', 'success');
    },

    async runAction(action) {
      this.actionLoading[action] = true;
      const endpointMap = {
        sync: '/queue/sync',
        syncFull: '/queue/sync?full=1',
        scan: '/queue/scan',
        recommend: '/scanner/recommend', // nhẹ, giữ đồng bộ
      };
      const labelMap = {
        sync: 'Đồng bộ ~1 năm / tăng dần (watchlist)',
        syncFull: 'Đồng bộ full IPO (watchlist)',
        scan: 'Quét tín hiệu',
        recommend: 'Khuyến nghị + Telegram',
      };
      try {
        this.log('info', `▶ ${labelMap[action]}...`);
        const res = await this.authFetch(endpointMap[action], {
          method: 'POST',
        }).then((r) => r.json());

        if (res?.jobId) {
          // Tác vụ nặng → poll tiến độ từ queue
          this.log(
            'info',
            `⏳ Job #${res.jobId} đã vào hàng chờ, đang xử lý...`,
          );
          await this.pollJob(res.jobId, labelMap[action]);
          if (action === 'scan') await this.loadSignalSummary();
          if (action === 'sync' || action === 'syncFull')
            await this.loadSignalSummary();
        } else {
          // Tác vụ nhẹ (recommend) → chờ trực tiếp
          this.log('success', `✓ ${labelMap[action]} xong`);
          this.showToast(`${labelMap[action]} xong!`, 'success');
          if (action === 'recommend') await this.refreshAll();
          if (action === 'scan' || action === 'recommend')
            await this.loadSignalSummary();
        }
      } catch (e) {
        if (e.message !== 'Unauthorized') {
          this.log('error', `✗ Lỗi: ${e.message}`);
          this.showToast('Có lỗi xảy ra', 'error');
        }
      }
      this.actionLoading[action] = false;
    },

    // Poll job cho đến khi completed/failed, cập nhật log mỗi 2s
    async pollJob(jobId, label, onDone, options = {}) {
      const silentToast = options.silentToast === true;
      let lastPercent = -1;
      while (true) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const job = await fetch(`/queue/jobs/${jobId}`).then((r) => r.json());
          if (!job) break;

          const p = job.progress || {};
          const pct = p.percent ?? 0;
          if (pct !== lastPercent) {
            const ticker = p.current ? ` [${p.current}]` : '';
            this.log(
              'info',
              `  ${pct}%${ticker} (${p.done ?? 0}/${p.total ?? '?'})`,
            );
            lastPercent = pct;
          }

          if (job.state === 'completed') {
            const r = job.result || {};
            const summary = Object.entries(r)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ');
            this.log('success', `✓ ${label} hoàn thành — ${summary}`);
            if (!silentToast) {
              this.showToast(`${label} xong!`, 'success');
            }
            if (onDone) onDone(job);
            break;
          }
          if (job.state === 'failed') {
            this.log('error', `✗ ${label} thất bại: ${job.failReason}`);
            this.showToast(`${label} lỗi`, 'error');
            break;
          }
        } catch {
          break;
        }
      }
    },

    // ── Watchlist management ─────────────────────────────────────────────
    async loadWlItems() {
      const r = await fetch('/watchlist')
        .then((r) => r.json())
        .catch(() => []);
      this.wlItems = Array.isArray(r) ? r : [];
    },

    get filteredWlItems() {
      return this.wlItems.filter((i) => {
        const matchFilter =
          this.wlFilter === 'all'
            ? true
            : this.wlFilter === 'active'
              ? i.active
              : !i.active;
        const q = this.wlSearch.toLowerCase();
        const matchSearch =
          !q ||
          i.ticker.toLowerCase().includes(q) ||
          i.name.toLowerCase().includes(q) ||
          i.sector.toLowerCase().includes(q);
        return matchFilter && matchSearch;
      });
    },

    async wlAdd() {
      const { ticker, name, sector } = this.wlAddForm;
      if (!ticker || this.wlAddSubmitting) return;
      this.wlAddSubmitting = true;
      try {
        const res = await this.authFetch('/watchlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticker, name, sector }),
        });
        const data = await res.json().catch(() => ({}));
        this.wlAddForm = { show: false, ticker: '', name: '', sector: '' };
        await this.loadWlItems();
        await this.loadWatchlist();
        const sym = String(data.ticker || ticker).toUpperCase();
        const sync = data._sync;
        let msg = `Đã thêm ${sym}`;
        if (sync) {
          if (sync.error) msg += ` — đồng bộ giá lỗi: ${sync.error}`;
          else
            msg += ` — đồng bộ ${sync.barsInserted ?? 0} dòng giá mới, đã phân tích`;
        }
        this.showToast(msg, sync?.error ? 'info' : 'success');
      } finally {
        this.wlAddSubmitting = false;
      }
    },

    async wlActivate(ticker) {
      await this.authFetch(`/watchlist/${ticker}/activate`, { method: 'PUT' });
      await this.loadWlItems();
      await this.loadTickerPickerUniverse();
      this.showToast(`Đã bật lại ${ticker}`, 'success');
    },

    async wlDeactivate(ticker) {
      await this.authFetch(`/watchlist/${ticker}/deactivate`, {
        method: 'PUT',
      });
      await this.loadWlItems();
      await this.loadTickerPickerUniverse();
      this.showToast(`Đã tắt ${ticker}`, 'info');
    },

    async wlDelete(id, ticker) {
      if (!confirm(`Xoá hẳn ${ticker} khỏi watchlist?`)) return;
      await this.authFetch(`/watchlist/${id}`, { method: 'DELETE' });
      await this.loadWlItems();
      await this.loadTickerPickerUniverse();
      this.showToast(`Đã xoá ${ticker}`, 'success');
    },

    async wlLoadLiquidityCandidates() {
      if (!this.isAdmin) return;
      this.wlLiquidityLoading = true;
      try {
        const q = this.wlLiquidityExcludeDb ? '?excludeDb=1' : '';
        const res = await this.authFetch(`/watchlist/liquidity-candidates${q}`);
        const data = await res.json().catch(() => ({}));
        this.wlLiquidityCandidates = Array.isArray(data.tickers)
          ? data.tickers
          : [];
        this.wlLiquidityMeta = data;
        this.wlLiquidityPanel = true;
      } catch {
        this.showToast('Không tải danh sách ứng viên thanh khoản', 'error');
      } finally {
        this.wlLiquidityLoading = false;
      }
    },

    async wlCheckLiquidity() {
      this.wlCheckingLiquidity = true;
      this.log('info', '▶ Đồng bộ danh sách chuẩn + kiểm tra thanh khoản...');
      try {
        const r = await this.authFetch('/watchlist/check-liquidity', {
          method: 'POST',
        }).then((res) => res.json());
        await this.loadWlItems();
        await this.loadTickerPickerUniverse();
        await this.loadSignalSummary();
        const liq = r.liquidity ?? r;
        const sync = r.sync;
        const checked = liq.checked ?? 0;
        const parts = [
          sync
            ? `+${sync.inserted ?? 0} mã mới, ${sync.updated ?? 0} cập nhật tên/ngành`
            : null,
          `quét ${checked} mã: tắt ${(liq.deactivated ?? []).length}, bật lại ${(liq.reactivated ?? []).length}`,
        ].filter(Boolean);
        const msg = `✓ ${parts.join(' — ')}`;
        this.log('success', msg);
        this.showToast(msg, 'success');
      } catch (e) {
        if (e.message !== 'Unauthorized') this.log('error', `✗ ${e.message}`);
      }
      this.wlCheckingLiquidity = false;
    },

    log(type, msg) {
      const time = new Date().toLocaleTimeString('vi-VN');
      this.actionLog.unshift({ time, type, msg });
      if (this.actionLog.length > 30) this.actionLog.pop();
    },

    showToast(msg, type = 'success') {
      this.toast = { show: true, msg, type };
      setTimeout(() => {
        this.toast.show = false;
      }, 3000);
      if (!this.browserNotify) return;
      if (
        typeof Notification === 'undefined' ||
        Notification.permission !== 'granted'
      )
        return;
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible'
      )
        return;
      try {
        const opts = {
          body: msg,
          icon: '/icons/icon-192.png',
          badge: '/icons/icon-192.png',
          tag: 'stock-analysis-toast',
          renotify: true,
        };
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.ready
            .then((reg) => reg.showNotification('Stock Analysis', opts))
            .catch(() => {
              new Notification('Stock Analysis', opts);
            });
        } else {
          new Notification('Stock Analysis', opts);
        }
      } catch {}
    },

    // ── Computed ─────────────────────────────────────────────────

    get avgPnl() {
      if (!this.openPositions.length) return 0;
      const sum = this.openPositions.reduce(
        (s, p) => s + Number(p.pnlPercent || 0),
        0,
      );
      return sum / this.openPositions.length;
    },

    get bestPos() {
      if (!this.openPositions.length) return null;
      return this.openPositions.reduce((best, p) =>
        Number(p.pnlPercent) > Number(best.pnlPercent) ? p : best,
      );
    },

    get filteredWatchlist() {
      let list = this.watchlist;
      // Scanner grid chỉ hiển thị cổ phiếu, ẩn 2 chỉ số tham chiếu.
      list = list.filter((s) => {
        const t = String(s?.ticker || '').toUpperCase();
        return t !== 'VNINDEX' && t !== 'VN30';
      });
      if (this.searchTicker) {
        const q = this.searchTicker.toUpperCase();
        list = list.filter(
          (s) => s.ticker.includes(q) || s.name.toUpperCase().includes(q),
        );
      }
      const order = this.signalOrderTickers?.length
        ? this.signalOrderTickers
        : this.watchlist.map((s) => s.ticker);
      const rank = (t) => {
        const i = order.findIndex(
          (x) => String(x).toUpperCase() === String(t).toUpperCase(),
        );
        return i === -1 ? 9999 : i;
      };
      const confVal = (s) =>
        ({ HIGH: 3, MEDIUM: 2, LOW: 1 })[s?.confidence] ?? 0;
      const scoreVal = (s) => {
        const n = Number(s?.score);
        return Number.isFinite(n) ? n : -999;
      };
      return [...list].sort((a, b) => {
        const sa = this.signalSummaryByTicker(a.ticker);
        const sb = this.signalSummaryByTicker(b.ticker);
        // Tốt -> xấu: điểm cao đứng trước.
        const ds = scoreVal(sb) - scoreVal(sa);
        if (ds !== 0) return ds;
        const ca = confVal(sa);
        const cb = confVal(sb);
        if (ca !== cb) return cb - ca;
        const starsA = Number(sa?.stars ?? 0);
        const starsB = Number(sb?.stars ?? 0);
        if (starsA !== starsB) return starsB - starsA;
        // Cùng chất lượng tín hiệu thì giữ thứ tự watchlist gốc.
        const ra = rank(a.ticker);
        const rb = rank(b.ticker);
        return ra - rb;
      });
    },

    signalSummaryByTicker(ticker) {
      if (!ticker) return null;
      const t = String(ticker).toUpperCase();
      return this.signalSummary?.[t] ?? this.signalSummary?.[ticker] ?? null;
    },

    fmtSignalScore(score, withScale = true) {
      const n = Number(score);
      if (!Number.isFinite(n)) return '—';
      const v = n.toFixed(1);
      const text = `${n > 0 ? '+' : ''}${v}`;
      return withScale ? `${text}/10` : text;
    },

    signalScoreClass(score) {
      const n = Number(score);
      if (!Number.isFinite(n) || Math.abs(n) < 0.01) {
        return 'text-gray-500 dark:text-zinc-400';
      }
      return n > 0
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-red-600 dark:text-red-400';
    },

    progressPct(pos) {
      const entry = Number(pos.entryPrice);
      const target = Number(pos.targetPrice);
      const current = Number(pos.lastPrice || entry);
      if (target <= entry) return 0;
      return Math.max(
        0,
        Math.round(((current - entry) / (target - entry)) * 100),
      );
    },

    // ── Formatters ────────────────────────────────────────────────

    /** VNINDEX / VN30 — giá trong DB vẫn ×1000 như cổ; hiển thị điểm chỉ số, không «k». */
    isMarketIndexTicker(t) {
      const u = String(t || '').toUpperCase();
      return u === 'VNINDEX' || u === 'VN30';
    },

    fmt(n) {
      if (!n) return '—';
      const v = Number(n);
      const t = this.signalTicker || this.priceTicker || '';
      if (this.isMarketIndexTicker(t)) {
        return (v / 1000).toFixed(2) + ' điểm';
      }
      return (v / 1000).toFixed(1) + 'k';
    },

    backtestStrengthLabel(s) {
      if (!s) return '—';
      return { STRONG: 'Mạnh', MODERATE: 'Vừa' }[s] || s;
    },

    truncateText(s, max) {
      if (s == null || s === '') return '—';
      const t = String(s);
      const m = max || 100;
      return t.length <= m ? t : t.slice(0, m) + '…';
    },

    fmtK(n) {
      if (!n) return '—';
      return (Number(n) / 1000).toFixed(1) + 'k';
    },

    recEmoji(r) {
      return (
        {
          STRONG_BUY: '🚀',
          BUY: '📈',
          HOLD: '⏸️',
          SELL: '📉',
          STRONG_SELL: '🔥',
        }[r] || '—'
      );
    },

    recLabel(r) {
      return (
        {
          STRONG_BUY: 'Mua breakout Minervini',
          BUY: 'Theo dõi mua / Chờ breakout',
          HOLD: 'Giữ',
          SELL: 'Bán',
          STRONG_SELL: 'Bán tích cực',
        }[r] || r
      );
    },

    /** Giá phiên (entry) = đóng cửa; “vùng mua” = không đuổi xa so với limit gợi ý + trên hỗ trợ. */
    priceTargetPullbackDiffers(pt) {
      if (!pt) return false;
      const e = Number(pt.entryPrice);
      const p = Number(pt.suggestedPullbackPrice);
      if (!e || e <= 0 || p == null || Number.isNaN(p)) return false;
      return Math.abs(e - p) / e > 0.005;
    },

    suggestedBuyCardLabel(mode) {
      return (
        {
          support_base: 'Nền tham chiếu (mua lại)',
          wait_base: 'Chờ về nền',
          breakout_entry: 'Giá mua (theo break)',
          wait_retest_break: 'Chờ retest sau break',
          pullback: 'Mua limit gợi ý',
        }[mode] || 'Mua limit gợi ý'
      );
    },

    /** Tiêu đề ô giá mua — ưu tiên «vùng nền» khi giá đang quanh đáy 20p. */
    suggestedBuyCardTitle(pt) {
      if (!pt) return '';
      if (pt.priceAtBase) return 'Vùng nền (giá mua)';
      return this.suggestedBuyCardLabel(pt.suggestedPullbackMode);
    },

    /** Giá hiển thị chính: dải nền hoặc một mức gợi ý. */
    suggestedBuyCardMainValue(pt) {
      if (!pt) return '';
      if (pt.priceAtBase && pt.baseZoneLow != null && pt.baseZoneHigh != null) {
        return `${this.fmtK(pt.baseZoneLow)} – ${this.fmtK(pt.baseZoneHigh)} đ`;
      }
      return `${this.fmtK(pt.suggestedPullbackPrice ?? pt.entryPrice)} đ`;
    },

    suggestedBuyNoteTitle(mode) {
      return (
        {
          support_base: 'Lý do mức «Nền tham chiếu»',
          wait_base: 'Lý do mức «Chờ về nền»',
          breakout_entry: 'Lý do mức «Giá mua theo break»',
          wait_retest_break: 'Lý do mức «Chờ retest»',
          pullback: 'Lý do mức «Mua limit gợi ý»',
        }[mode] || 'Lý do mức «Mua limit gợi ý»'
      );
    },

    suggestedBuyShortLabel(mode) {
      return (
        {
          support_base: 'Nền tham chiếu',
          wait_base: 'Chờ về nền',
          breakout_entry: 'Giá mua (theo break)',
          wait_retest_break: 'Chờ retest cản',
          pullback: 'Limit / chờ hồi gợi ý',
        }[mode] || 'Giá mua gợi ý'
      );
    },

    inBuyZone(rec) {
      if (!rec?.priceTarget) return false;
      if (rec.recommendation !== 'STRONG_BUY') return false;
      const pt = rec.priceTarget;
      const cur = Number(pt.currentPrice);
      const sup = Number(pt.support);
      const pull = Number(pt.suggestedPullbackPrice ?? pt.entryPrice);
      if (!cur || cur <= 0) return false;
      if (cur < sup * 0.985) return false;
      if (!pull || pull <= 0) return false;
      const m = pt.suggestedPullbackMode;
      if (m === 'wait_base') {
        return cur >= sup * 0.995 && cur <= sup * 1.03;
      }
      if (m === 'wait_retest_break') {
        return cur >= pull * 0.985 && cur <= pull * 1.025;
      }
      return cur <= pull * 1.03;
    },

    confidenceClass(c) {
      return (
        { HIGH: 'badge-green', MEDIUM: 'badge-yellow', LOW: 'badge-gray' }[c] ||
        'badge-gray'
      );
    },

    closeReasonLabel(r) {
      return (
        {
          TARGET_HIT: '🎯 Chốt TP',
          STOP_LOSS: '🛑 Cắt lỗ',
          PROFIT_FLOOR_20: '🔒 Chặn lãi',
          DISTRIBUTION: '🔄 Đảo chiều',
          MANUAL: '🤚 Thủ công',
        }[r] || r
      );
    },

    closeReasonClass(r) {
      return (
        {
          TARGET_HIT: 'badge-green',
          STOP_LOSS: 'badge-red',
          PROFIT_FLOOR_20: 'badge-green',
          DISTRIBUTION: 'badge-yellow',
          MANUAL: 'badge-gray',
        }[r] || 'badge-gray'
      );
    },
  };
}
