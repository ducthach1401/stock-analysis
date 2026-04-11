export interface WatchlistStock {
  ticker: string;
  name: string;
  sector: string;
}

// Top 100 cổ phiếu VNIndex theo vốn hoá + thanh khoản
export const WATCHLIST: WatchlistStock[] = [
  // ── Ngân hàng ──────────────────────────────────────────────────────────
  { ticker: 'VCB', name: 'Vietcombank', sector: 'Ngân hàng' },
  { ticker: 'BID', name: 'BIDV', sector: 'Ngân hàng' },
  { ticker: 'CTG', name: 'VietinBank', sector: 'Ngân hàng' },
  { ticker: 'MBB', name: 'MB Bank', sector: 'Ngân hàng' },
  { ticker: 'VPB', name: 'VPBank', sector: 'Ngân hàng' },
  { ticker: 'TCB', name: 'Techcombank', sector: 'Ngân hàng' },
  { ticker: 'ACB', name: 'ACB', sector: 'Ngân hàng' },
  { ticker: 'HDB', name: 'HDBank', sector: 'Ngân hàng' },
  { ticker: 'SHB', name: 'SHB', sector: 'Ngân hàng' },
  { ticker: 'STB', name: 'Sacombank', sector: 'Ngân hàng' },
  { ticker: 'EIB', name: 'Eximbank', sector: 'Ngân hàng' },
  { ticker: 'LPB', name: 'LienVietPostBank', sector: 'Ngân hàng' },
  { ticker: 'TPB', name: 'TPBank', sector: 'Ngân hàng' },
  { ticker: 'MSB', name: 'Maritime Bank', sector: 'Ngân hàng' },
  { ticker: 'OCB', name: 'Orient Commercial Bank', sector: 'Ngân hàng' },

  // ── Bất động sản ───────────────────────────────────────────────────────
  { ticker: 'VIC', name: 'Vingroup', sector: 'Bất động sản' },
  { ticker: 'VHM', name: 'Vinhomes', sector: 'Bất động sản' },
  { ticker: 'VRE', name: 'Vincom Retail', sector: 'Bất động sản' },
  { ticker: 'NVL', name: 'Novaland', sector: 'Bất động sản' },
  { ticker: 'KDH', name: 'Khang Điền', sector: 'Bất động sản' },
  { ticker: 'PDR', name: 'Phát Đạt', sector: 'Bất động sản' },
  { ticker: 'DXG', name: 'Đất Xanh', sector: 'Bất động sản' },
  { ticker: 'NLG', name: 'Nam Long', sector: 'Bất động sản' },
  { ticker: 'DIG', name: 'DIC Corp', sector: 'Bất động sản' },
  { ticker: 'CEO', name: 'C.E.O Group', sector: 'Bất động sản' },
  { ticker: 'HDG', name: 'Hà Đô Group', sector: 'Bất động sản' },
  { ticker: 'CII', name: 'C.I.I Infrastructure', sector: 'Bất động sản' },
  { ticker: 'IDC', name: 'Idico', sector: 'Bất động sản KCN' },
  { ticker: 'KBC', name: 'Kinh Bắc City', sector: 'Bất động sản KCN' },

  // ── Hàng tiêu dùng / Thực phẩm ────────────────────────────────────────
  { ticker: 'VNM', name: 'Vinamilk', sector: 'Hàng tiêu dùng' },
  { ticker: 'SAB', name: 'Sabeco', sector: 'Hàng tiêu dùng' },
  { ticker: 'MSN', name: 'Masan Group', sector: 'Hàng tiêu dùng' },
  { ticker: 'MCH', name: 'Masan Consumer', sector: 'Hàng tiêu dùng' },
  { ticker: 'QNS', name: 'Đường Quảng Ngãi', sector: 'Hàng tiêu dùng' },
  { ticker: 'SBT', name: 'Thành Thành Công Sugar', sector: 'Hàng tiêu dùng' },
  { ticker: 'KDC', name: 'Kido Group', sector: 'Hàng tiêu dùng' },
  { ticker: 'DBC', name: 'Dabaco', sector: 'Nông nghiệp' },

  // ── Bán lẻ ─────────────────────────────────────────────────────────────
  { ticker: 'PNJ', name: 'PNJ', sector: 'Bán lẻ' },
  { ticker: 'MWG', name: 'Mobile World', sector: 'Bán lẻ' },
  { ticker: 'FRT', name: 'FPT Retail', sector: 'Bán lẻ' },
  { ticker: 'DGW', name: 'Digiworld', sector: 'Bán lẻ' },

  // ── Thép ───────────────────────────────────────────────────────────────
  { ticker: 'HPG', name: 'Hoà Phát', sector: 'Thép' },
  { ticker: 'HSG', name: 'Hoa Sen', sector: 'Thép' },
  { ticker: 'NKG', name: 'Nam Kim', sector: 'Thép' },
  { ticker: 'TLH', name: 'Thép Tiến Lên', sector: 'Thép' },

  // ── Dầu khí ────────────────────────────────────────────────────────────
  { ticker: 'GAS', name: 'PV GAS', sector: 'Dầu khí' },
  { ticker: 'PLX', name: 'Petrolimex', sector: 'Dầu khí' },
  { ticker: 'PVD', name: 'PV Drilling', sector: 'Dầu khí' },
  { ticker: 'PVS', name: 'PV Technical Services', sector: 'Dầu khí' },
  { ticker: 'OIL', name: 'PV Oil', sector: 'Dầu khí' },
  { ticker: 'BSR', name: 'Bình Sơn Refinery', sector: 'Dầu khí' },
  { ticker: 'CNG', name: 'CNG Việt Nam', sector: 'Dầu khí' },

  // ── Điện / Năng lượng ──────────────────────────────────────────────────
  { ticker: 'POW', name: 'PV Power', sector: 'Điện' },
  { ticker: 'NT2', name: 'Điện Nhơn Trạch 2', sector: 'Điện' },
  { ticker: 'REE', name: 'REE Corporation', sector: 'Điện' },
  { ticker: 'PC1', name: 'PC1 Group', sector: 'Điện' },
  { ticker: 'GEX', name: 'Gelex Group', sector: 'Điện - Công nghiệp' },
  { ticker: 'VSH', name: 'Thuỷ điện Vĩnh Sơn', sector: 'Điện' },
  { ticker: 'TBC', name: 'Thuỷ điện Thác Bà', sector: 'Điện' },

  // ── Công nghệ / Viễn thông ─────────────────────────────────────────────
  { ticker: 'FPT', name: 'FPT Corporation', sector: 'Công nghệ' },
  { ticker: 'CMG', name: 'CMC Corporation', sector: 'Công nghệ' },
  { ticker: 'VGI', name: 'Viettel Global', sector: 'Viễn thông' },

  // ── Chứng khoán ────────────────────────────────────────────────────────
  { ticker: 'SSI', name: 'SSI Securities', sector: 'Chứng khoán' },
  { ticker: 'VND', name: 'VNDirect', sector: 'Chứng khoán' },
  { ticker: 'HCM', name: 'HSC', sector: 'Chứng khoán' },
  { ticker: 'VCI', name: 'Vietcap Securities', sector: 'Chứng khoán' },
  { ticker: 'MBS', name: 'MB Securities', sector: 'Chứng khoán' },
  { ticker: 'CTS', name: 'Agribank Securities', sector: 'Chứng khoán' },

  // ── Phân bón / Hóa chất ────────────────────────────────────────────────
  { ticker: 'DPM', name: 'Đạm Phú Mỹ', sector: 'Phân bón' },
  { ticker: 'DCM', name: 'Đạm Cà Mau', sector: 'Phân bón' },
  { ticker: 'DGC', name: 'Hoá chất Đức Giang', sector: 'Hóa chất' },
  { ticker: 'CSV', name: 'Hoá chất cơ bản miền Nam', sector: 'Hóa chất' },

  // ── Hàng không / Logistics / Cảng ──────────────────────────────────────
  { ticker: 'VJC', name: 'Vietjet Air', sector: 'Hàng không' },
  { ticker: 'HVN', name: 'Vietnam Airlines', sector: 'Hàng không' },
  { ticker: 'ACV', name: 'Cảng hàng không VN', sector: 'Hàng không' },
  { ticker: 'GMD', name: 'Gemadept', sector: 'Logistics' },
  { ticker: 'HAH', name: 'Vận tải Hải An', sector: 'Logistics' },
  { ticker: 'SCS', name: 'Dịch vụ hàng hoá Sài Gòn', sector: 'Logistics' },
  { ticker: 'PHP', name: 'Cảng Hải Phòng', sector: 'Cảng biển' },
  { ticker: 'VSC', name: 'Container Việt An', sector: 'Cảng biển' },

  // ── Xây dựng ───────────────────────────────────────────────────────────
  { ticker: 'CTD', name: 'Coteccons', sector: 'Xây dựng' },
  { ticker: 'VCG', name: 'Vinaconex', sector: 'Xây dựng' },
  { ticker: 'HBC', name: 'Xây dựng Hoà Bình', sector: 'Xây dựng' },
  { ticker: 'FCN', name: 'Fecon', sector: 'Xây dựng' },

  // ── Vật liệu xây dựng ──────────────────────────────────────────────────
  { ticker: 'VGC', name: 'Viglacera', sector: 'Vật liệu' },
  { ticker: 'HT1', name: 'Xi măng Hà Tiên 1', sector: 'Vật liệu' },
  { ticker: 'BCC', name: 'Xi măng Bỉm Sơn', sector: 'Vật liệu' },
  { ticker: 'VCS', name: 'Vicostone', sector: 'Vật liệu' },
  { ticker: 'BMP', name: 'Nhựa Bình Minh', sector: 'Nhựa' },

  // ── Bảo hiểm ───────────────────────────────────────────────────────────
  { ticker: 'BVH', name: 'Bảo Việt', sector: 'Bảo hiểm' },
  { ticker: 'PVI', name: 'PVI Holdings', sector: 'Bảo hiểm' },

  // ── Dược phẩm / Y tế ───────────────────────────────────────────────────
  { ticker: 'DHG', name: 'Dược Hậu Giang', sector: 'Dược phẩm' },
  { ticker: 'IMP', name: 'Imexpharm', sector: 'Dược phẩm' },
  { ticker: 'TRA', name: 'Traphaco', sector: 'Dược phẩm' },
  { ticker: 'DBD', name: 'Dược Bình Định', sector: 'Dược phẩm' },

  // ── Cao su ─────────────────────────────────────────────────────────────
  { ticker: 'GVR', name: 'Cao su VN', sector: 'Cao su' },
  { ticker: 'PHR', name: 'Cao su Phước Hoà', sector: 'Cao su' },

  // ── Nông nghiệp ────────────────────────────────────────────────────────
  { ticker: 'LTG', name: 'Lộc Trời Group', sector: 'Nông nghiệp' },
  { ticker: 'HAG', name: 'Hoàng Anh Gia Lai', sector: 'Nông nghiệp' },
  { ticker: 'PAN', name: 'PAN Group', sector: 'Nông nghiệp' },

  // ── Dệt may ────────────────────────────────────────────────────────────
  { ticker: 'MSH', name: 'May Sông Hồng', sector: 'Dệt may' },
  { ticker: 'TCM', name: 'Dệt may Thành Công', sector: 'Dệt may' },
  { ticker: 'TNG', name: 'TNG Investment', sector: 'Dệt may' },

  // ── Thuỷ sản ───────────────────────────────────────────────────────────
  { ticker: 'VHC', name: 'Vĩnh Hoàn', sector: 'Thuỷ sản' },
  { ticker: 'ANV', name: 'Nam Việt', sector: 'Thuỷ sản' },
  { ticker: 'MPC', name: 'Minh Phú Seafood', sector: 'Thuỷ sản' },
];

export const TICKERS = WATCHLIST.map((s) => s.ticker);
