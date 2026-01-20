/**
 * PM2 Ecosystem Configuration
 *
 * Used by PM2 to manage the xmit-smtp process.
 * Environment variables are loaded via dotenv/config in the app.
 */
module.exports = {
    apps: [
        {
            name: "xmit-smtp",
            script: "dist/index.js",
            cwd: "/opt/xmit-smtp",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "256M",
            env: {
                NODE_ENV: "production",
            },
            // Graceful shutdown
            kill_timeout: 10000,
            wait_ready: false,
            // Logging
            error_file: "/var/log/xmit-smtp/error.log",
            out_file: "/var/log/xmit-smtp/out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
            merge_logs: true,
        },
    ],
};
