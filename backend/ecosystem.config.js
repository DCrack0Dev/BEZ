module.exports = {
  apps: [{
    name: 'liquibot-backend',
    script: 'dist/boot.js',
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'development',
      PORT: 5000
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 8080
    }
  }]
};
