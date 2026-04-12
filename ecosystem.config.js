module.exports = {
  apps: [
    {
      name: 'stock-analysis',
      script: 'dist/main.js',
      instances: 'max',
      exec_mode: 'cluster',
      watch: false,
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
        // Đồng bộ schema DB theo entity (cột/enum mới). Có thể ghi đè bằng .env.
        DB_SYNCHRONIZE: 'true',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
      max_memory_restart: '512M',
    },
  ],
};
