# xmit-mail

SMTP & IMAP server for [Transmit](https://xmit.sh). Send and receive emails using your Transmit API key.

## Why?

Some tools (Cronicle, WordPress, legacy apps, email clients) need SMTP/IMAP. This server:
- **SMTP**: Accepts outgoing emails and forwards through Transmit's REST API
- **IMAP**: Provides access to your mailbox (inbound emails) via standard email clients

```
Your App ──SMTP──▶ xmit-mail ──HTTP──▶ api.xmit.sh
Email Client ──IMAP──▶ xmit-mail ──HTTP──▶ api.xmit.sh
```

## Quick Start

### Hosted (Recommended)

Use our hosted mail server:

**Outgoing Mail (SMTP)**
```
Host: mail.xmit.sh
Port: 587
User: api
Pass: <your Transmit API key>
TLS:  STARTTLS
```

**Incoming Mail (IMAP)**
```
Host: mail.xmit.sh
Port: 993
User: <sender email> (e.g., support@acme.com)
Pass: <your Transmit API key>
TLS:  SSL/TLS
```

### Self-Hosted

1. Clone and install:
   ```bash
   git clone https://github.com/Transmit-Xmit/xmit-mail.git
   cd xmit-mail
   pnpm install
   ```

2. Configure environment:
   ```bash
   cp .env.example .env
   # Edit .env with your settings
   ```

3. Run:
   ```bash
   # Development (no TLS required)
   NODE_ENV=development npm run dev

   # Production
   npm run build
   npm start
   ```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_PORT` | `587` | SMTP server port |
| `IMAP_PORT` | `993` | IMAP server port |
| `API_BASE` | `https://api.xmit.sh` | Transmit API URL |
| `TLS_KEY_PATH` | `/etc/letsencrypt/.../privkey.pem` | TLS private key |
| `TLS_CERT_PATH` | `/etc/letsencrypt/.../fullchain.pem` | TLS certificate |
| `IMAP_IDLE_TIMEOUT` | `1800000` | IMAP idle timeout in ms (30 min) |
| `NODE_ENV` | `production` | Set to `development` to disable TLS |

## Usage Examples

### Cronicle

```json
{
  "smtp_hostname": "smtp.xmit.sh",
  "smtp_port": 587,
  "mail_options": {
    "secure": false,
    "auth": {
      "user": "api",
      "pass": "pm_live_xxxxx"
    }
  }
}
```

### Nodemailer

```javascript
const transporter = nodemailer.createTransport({
  host: "smtp.xmit.sh",
  port: 587,
  secure: false,
  auth: {
    user: "api",
    pass: "pm_live_xxxxx"
  }
});
```

### Python (smtplib)

```python
import smtplib
from email.message import EmailMessage

msg = EmailMessage()
msg["From"] = "you@yourdomain.com"
msg["To"] = "recipient@example.com"
msg["Subject"] = "Hello"
msg.set_content("Hello from Python!")

with smtplib.SMTP("smtp.xmit.sh", 587) as server:
    server.starttls()
    server.login("api", "pm_live_xxxxx")
    server.send_message(msg)
```

### WordPress

In `wp-config.php` or using a plugin like WP Mail SMTP:

```
SMTP Host: smtp.xmit.sh
SMTP Port: 587
Encryption: TLS
Username: api
Password: pm_live_xxxxx
```

### Command Line (swaks)

```bash
swaks --to recipient@example.com \
      --from you@yourdomain.com \
      --server smtp.xmit.sh:587 \
      --auth LOGIN \
      --auth-user api \
      --auth-password pm_live_xxxxx \
      --tls \
      --body "Test email"
```

## Features

- **SMTP Relay**: Send emails via SMTP, forwarded through Transmit API
- **IMAP Access**: Read your mailbox with any email client
- **API Key Auth**: Use your Transmit API key as password
- **Full Email Support**: HTML, plain text, attachments, CC, BCC, Reply-To
- **TLS Encryption**: STARTTLS for SMTP, SSL/TLS for IMAP
- **IMAP Extensions**: IDLE (push notifications), UIDPLUS, MOVE, SPECIAL-USE

## Deployment

### One-Line Deploy (Recommended)

On a fresh Ubuntu 22.04 server (Lightsail, EC2, etc.):

```bash
curl -sSL https://raw.githubusercontent.com/Transmit-Xmit/xmit-mail/main/deploy.sh | sudo bash
```

This will:
- Install Node.js, pnpm, and PM2
- Clone and build the application
- Obtain TLS certificate via Let's Encrypt
- Configure firewall (ports 587, 993, 80)
- Start the service with PM2

### Manual Deployment

1. Create Ubuntu 22.04 instance ($5/mo)
2. Open ports 587 (SMTP), 993 (IMAP), and 22 (SSH)
3. Point `mail.yourdomain.com` to the instance IP
4. Run the deploy script or follow manual steps in `deploy.sh`

### Docker

```bash
docker build -t xmit-mail .
docker run -d \
  -p 587:587 \
  -p 993:993 \
  -e API_BASE=https://api.xmit.sh \
  -v /etc/letsencrypt:/etc/letsencrypt:ro \
  xmit-mail
```

## Limits

Inherits limits from your Transmit plan:
- Max 50 recipients per email (to + cc + bcc)
- Max 5MB per attachment
- Max 7MB total attachments

## Security

- API keys are validated against Transmit on each connection
- All traffic to Transmit API uses HTTPS
- TLS required for SMTP connections (production mode)

## License

MIT
