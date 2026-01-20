# xmit-smtp

SMTP relay proxy for [Transmit](https://xmit.sh). Send emails via SMTP using your Transmit API key.

## Why?

Some tools (Cronicle, WordPress, legacy apps) only support SMTP for sending email. This proxy accepts SMTP connections and forwards emails through Transmit's REST API.

```
Your App ──SMTP──▶ xmit-smtp ──HTTP──▶ api.xmit.sh
```

## Quick Start

### Hosted (Recommended)

Use our hosted SMTP relay:

```
Host: smtp.xmit.sh
Port: 587
User: api
Pass: <your Transmit API key>
TLS:  STARTTLS
```

### Self-Hosted

1. Clone and install:
   ```bash
   git clone https://github.com/xmit-co/xmit-smtp.git
   cd xmit-smtp
   npm install
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
| `PORT` | `587` | SMTP server port |
| `API_BASE` | `https://api.xmit.sh` | Transmit API URL |
| `TLS_KEY_PATH` | `/etc/letsencrypt/.../privkey.pem` | TLS private key |
| `TLS_CERT_PATH` | `/etc/letsencrypt/.../fullchain.pem` | TLS certificate |
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

- **API Key Auth**: Use your Transmit API key as the SMTP password
- **Full Email Support**: HTML, plain text, attachments, CC, BCC, Reply-To
- **TLS**: STARTTLS encryption
- **Validation**: API key validated against Transmit
- **Forwarding**: All emails sent through Transmit's API (billing, limits, tracking all work)

## Deployment

### AWS Lightsail

1. Create Ubuntu 22.04 instance ($5/mo)
2. Open ports 587 (SMTP) and 22 (SSH)
3. Point `smtp.xmit.sh` to the instance IP
4. Install Node.js and certbot:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs certbot
   npm install -g pm2
   ```
5. Get TLS certificate:
   ```bash
   sudo certbot certonly --standalone -d smtp.xmit.sh
   ```
6. Deploy:
   ```bash
   git clone https://github.com/xmit-co/xmit-smtp.git /opt/xmit-smtp
   cd /opt/xmit-smtp
   npm install
   npm run build
   pm2 start dist/index.js --name xmit-smtp
   pm2 save && pm2 startup
   ```

### Docker

```bash
docker build -t xmit-smtp .
docker run -d \
  -p 587:587 \
  -e API_BASE=https://api.xmit.sh \
  -v /etc/letsencrypt:/etc/letsencrypt:ro \
  xmit-smtp
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
