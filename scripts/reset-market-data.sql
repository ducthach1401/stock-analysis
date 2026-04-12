-- Dọn dữ liệu thị trường để sync lại từ đầu (giữ watchlist, users nếu có).
-- Thứ tự: con trước cha (hoặc tắt FK tạm).

SET FOREIGN_KEY_CHECKS = 0;

TRUNCATE TABLE simulated_trades;
TRUNCATE TABLE backtest_runs;
TRUNCATE TABLE signals;
TRUNCATE TABLE stock_prices;

-- Bảng meta sync full IPO đã bỏ; xóa nếu DB cũ còn sót.
DROP TABLE IF EXISTS stock_price_sync_meta;

SET FOREIGN_KEY_CHECKS = 1;
