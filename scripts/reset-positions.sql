-- Xóa vị thế mở/đóng (chạy riêng nếu cần: yarn db:reset-positions)

SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE positions;
SET FOREIGN_KEY_CHECKS = 1;
