/** Hằng số, đọc URL/session, PWA, nhãn tín hiệu — load trước app.js */
const STOCK_APP_TAB_IDS = [
  'dashboard',
  'market',
  'derivatives',
  'scanner',
  'signals',
  'stocks',
  'guide',
  'watchlist',
];
const STOCK_SIGNAL_TICKER_KEY = 'stockAnalysisSignalTicker';
const STOCK_PRICE_TICKER_KEY = 'stockAnalysisPriceTicker';

/** Tab từ ?tab= — dùng link chia sẻ */
function readTabFromUrl() {
  try {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (!t) return null;
    // Tab đã gỡ: chuyển về dashboard (deep link cũ / bookmark)
    if (t === 'extended' || t === 'settings') return 'dashboard';
    if (STOCK_APP_TAB_IDS.includes(t)) return t;
  } catch {}
  return null;
}

/** Mã từ ?ticker= — kết hợp tab Tín hiệu / Cổ phiếu */
function readTickerFromUrl() {
  try {
    const raw = new URLSearchParams(window.location.search).get('ticker');
    if (!raw) return null;
    const u = String(raw).trim().toUpperCase();
    if (u.length < 1 || u.length > 20) return null;
    if (!/^[A-Z0-9]+$/.test(u)) return null;
    return u;
  } catch {}
  return null;
}

function readSavedTab() {
  try {
    const s = sessionStorage.getItem('stockAnalysisTab');
    if (!s) return 'dashboard';
    if (s === 'extended' || s === 'settings') return 'dashboard';
    if (STOCK_APP_TAB_IDS.includes(s)) return s;
  } catch {}
  return 'dashboard';
}

function readSavedTicker(key) {
  try {
    const s = sessionStorage.getItem(key);
    if (!s) return '';
    const t = String(s).trim().toUpperCase();
    if (t.length < 1 || t.length > 20) return '';
    if (!/^[A-Z0-9]+$/.test(t)) return '';
    return t;
  } catch {}
  return '';
}

const PWA_GATE_SKIP_KEY = 'pwaMandatoryGateSkip';

/** Điện thoại (viewport ≤640px) và chưa mở như PWA — màn hướng dẫn cài (trừ khi người dùng bỏ qua). */
function computePwaMandatoryGate() {
  if (typeof window === 'undefined') return false;
  try {
    if (localStorage.getItem(PWA_GATE_SKIP_KEY) === '1') return false;
  } catch {}
  try {
    if (!window.matchMedia('(max-width: 640px)').matches) return false;
  } catch {
    return false;
  }
  try {
    if (window.matchMedia('(display-mode: standalone)').matches) return false;
    if (window.matchMedia('(display-mode: fullscreen)').matches) return false;
  } catch {}
  try {
    if (window.navigator.standalone === true) return false;
  } catch {}
  return true;
}

function isIosTouchDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

function isAndroidUi() {
  if (typeof navigator === 'undefined') return false;
  return /Android/i.test(navigator.userAgent || '');
}

/** iOS: shell trình duyệt (đều dùng WebKit). Dùng cho hướng dẫn «Thêm vào Màn hình chính». */
function getIosBrowserKind() {
  if (typeof navigator === 'undefined') return 'other';
  if (!isIosTouchDevice()) return 'other';
  const ua = navigator.userAgent || '';
  if (/CriOS\//i.test(ua)) return 'chrome';
  if (/FxiOS\//i.test(ua)) return 'firefox';
  if (/EdgiOS\//i.test(ua)) return 'edge';
  if (/OPiOS\//i.test(ua)) return 'opera';
  return 'safari';
}

function iosBrowserTitleVi(kind) {
  const m = {
    safari: 'Safari',
    chrome: 'Chrome (iOS)',
    firefox: 'Firefox (iOS)',
    edge: 'Edge (iOS)',
    opera: 'Opera (iOS)',
    other: 'Trình duyệt iOS',
  };
  return m[kind] || m.other;
}

/** Nhãn hiển thị tiếng Việt — BB: enum UP/DOWN theo giá vs dải, không phải hướng tín hiệu */
const SIGNAL_LABELS_VI = {
  RSI_OVERSOLD: 'RSI quá bán',
  RSI_OVERBOUGHT: 'RSI quá mua',
  RSI_MOMENTUM_UP: 'RSI momentum tăng',
  RSI_MOMENTUM_DOWN: 'RSI momentum giảm',
  EMA_GOLDEN_CROSS: 'EMA golden cross',
  EMA_DEATH_CROSS: 'EMA death cross',
  EMA_BULLISH_STACK: 'Nền tăng (EMA)',
  EMA_BEARISH_STACK: 'Nền giảm (EMA)',
  EMA_BOUNCE: 'Nảy EMA',
  BASE_FORMING: 'Nền tích lũy',
  RESISTANCE_BREAKOUT: 'Break kháng cự',
  SUPPORT_BREAKDOWN: 'Thủng hỗ trợ',
  MINERVINI_TREND_TEMPLATE: 'Minervini trend template',
  MINERVINI_VCP_BASE: 'Minervini nền/VCP',
  MINERVINI_PIVOT_BREAKOUT: 'Minervini breakout pivot',
  MINERVINI_VOLUME_CONFIRM: 'Minervini volume xác nhận',
  MINERVINI_BUY_ZONE: 'Minervini buy zone',
  MINERVINI_EXTENDED: 'Minervini quá xa MA50',
  MACD_BULLISH_CROSS: 'MACD cắt tăng',
  MACD_BEARISH_CROSS: 'MACD cắt giảm',
  BB_BREAKOUT_DOWN: 'Chạm BB dưới (oversold)',
  BB_BREAKOUT_UP: 'Vượt BB trên (overbought)',
  BB_SQUEEZE: 'BB squeeze',
  HAMMER: 'Hammer',
  SHOOTING_STAR: 'Shooting star',
  BULLISH_ENGULFING: 'Nến xanh nuốt',
  BEARISH_ENGULFING: 'Nến đỏ nuốt',
  DOJI: 'Doji',
  VOLUME_SURGE: 'KL đột biến',
  RSI_BEARISH_DIVERGENCE: 'Phân kỳ RSI giảm',
  MACD_BEARISH_DIVERGENCE: 'Phân kỳ MACD giảm',
  VOLUME_CLIMAX_TOP: 'Climax đỉnh',
  DISTRIBUTION_BAR: 'Phân phối',
  WASHOUT_BAR: 'Washout (đáy)',
  FAILED_BREAKOUT: 'Bull trap',
  MA_GOLDEN_CROSS: 'MA golden (legacy)',
  MA_DEATH_CROSS: 'MA death (legacy)',
};
