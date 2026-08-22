// PM2 Ecosystem Configuration
// Usage: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'achichiz-api',
      script: 'dist/server.js',
      node_args: '--env-file=.env',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
