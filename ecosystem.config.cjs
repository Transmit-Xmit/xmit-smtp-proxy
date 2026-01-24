/**
 * PM2 Ecosystem Configuration
 *
 * Used by PM2 to manage the xmit-mail process (SMTP + IMAP).
 * Environment variables are loaded via dotenv/config in the app.
 */
module.exports = {
    apps: [
        {
            name: "xmit-mail",
            script: "dist/index.js",
            cwd: "/opt/xmit-smtp",
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "512M",
            env: {
                NODE_ENV: "production",
            },
            // Graceful shutdown
            kill_timeout: 10000,
            wait_ready: false,
            // Logging
            error_file: "/var/log/xmit-mail/error.log",
            out_file: "/var/log/xmit-mail/out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
            merge_logs: true,
        },
    ],
};
