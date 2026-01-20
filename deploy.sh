#!/bin/bash
#
# xmit-smtp Deployment Script
#
# Idempotent setup for Ubuntu 22.04+ (Lightsail, EC2, etc.)
# Re-running repairs/updates existing installation.
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/xmit-co/xmit-smtp/main/deploy.sh | sudo bash
#   # or
#   sudo ./deploy.sh
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Defaults
DEFAULT_DOMAIN="smtp.xmit.sh"
DEFAULT_PORT="587"
DEFAULT_API_BASE="https://api.xmit.sh"
INSTALL_DIR="/opt/xmit-smtp"
SERVICE_USER="xmit"

#------------------------------------------------------------------------------
# Logging helpers
#------------------------------------------------------------------------------
log() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info() { echo -e "${BLUE}[i]${NC} $1"; }

#------------------------------------------------------------------------------
# Prompt helper (with default)
#------------------------------------------------------------------------------
prompt() {
    local var_name="$1"
    local prompt_text="$2"
    local default="$3"
    local value

    if [ -n "$default" ]; then
        read -p "$prompt_text [$default]: " value
        value="${value:-$default}"
    else
        read -p "$prompt_text: " value
    fi

    eval "$var_name=\"$value\""
}

#------------------------------------------------------------------------------
# Check if running as root
#------------------------------------------------------------------------------
check_root() {
    if [ "$EUID" -ne 0 ]; then
        error "Please run as root: sudo $0"
    fi
}

#------------------------------------------------------------------------------
# Detect OS
#------------------------------------------------------------------------------
detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS=$NAME
        VER=$VERSION_ID
    else
        error "Cannot detect OS. This script supports Ubuntu 22.04+"
    fi

    if [[ "$OS" != *"Ubuntu"* ]] && [[ "$OS" != *"Debian"* ]]; then
        warn "This script is designed for Ubuntu/Debian. Proceeding anyway..."
    fi

    log "Detected: $OS $VER"
}

#------------------------------------------------------------------------------
# Install system dependencies
#------------------------------------------------------------------------------
install_dependencies() {
    info "Updating package lists..."
    apt-get update -qq

    info "Installing dependencies..."
    apt-get install -y -qq \
        curl \
        git \
        certbot \
        ufw \
        acl \
        libcap2-bin \
        > /dev/null 2>&1

    log "System dependencies installed"
}

#------------------------------------------------------------------------------
# Install Node.js (via NodeSource)
#------------------------------------------------------------------------------
install_node() {
    if command -v node &> /dev/null; then
        NODE_VER=$(node -v)
        log "Node.js already installed: $NODE_VER"

        # Check if it's v20+
        MAJOR_VER=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
        if [ "$MAJOR_VER" -lt 20 ]; then
            warn "Node.js $NODE_VER is old, upgrading to v20..."
        else
            return 0
        fi
    fi

    info "Installing Node.js 20.x..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs > /dev/null 2>&1

    log "Node.js $(node -v) installed"
}

#------------------------------------------------------------------------------
# Install pnpm
#------------------------------------------------------------------------------
install_pnpm() {
    if command -v pnpm &> /dev/null; then
        log "pnpm already installed: $(pnpm -v)"
        return 0
    fi

    info "Installing pnpm..."
    npm install -g pnpm > /dev/null 2>&1

    log "pnpm $(pnpm -v) installed"
}

#------------------------------------------------------------------------------
# Install PM2
#------------------------------------------------------------------------------
install_pm2() {
    if command -v pm2 &> /dev/null; then
        log "PM2 already installed: $(pm2 -v)"
        return 0
    fi

    info "Installing PM2..."
    npm install -g pm2 > /dev/null 2>&1

    log "PM2 $(pm2 -v) installed"
}

#------------------------------------------------------------------------------
# Create service user
#------------------------------------------------------------------------------
create_user() {
    if id "$SERVICE_USER" &>/dev/null; then
        log "User '$SERVICE_USER' already exists"
        return 0
    fi

    info "Creating service user '$SERVICE_USER'..."
    # Don't use -m since git clone will create the home directory
    useradd -r -s /bin/bash -d "$INSTALL_DIR" "$SERVICE_USER"

    log "User '$SERVICE_USER' created"
}

#------------------------------------------------------------------------------
# Clone or update repository
#------------------------------------------------------------------------------
setup_repo() {
    if [ -d "$INSTALL_DIR/.git" ]; then
        info "Updating existing installation..."
        cd "$INSTALL_DIR"
        git fetch origin
        git reset --hard origin/main
        log "Repository updated"
    else
        if [ -d "$INSTALL_DIR" ]; then
            warn "Directory exists but not a git repo, removing..."
            rm -rf "$INSTALL_DIR"
        fi

        info "Cloning repository..."
        git clone https://github.com/Transmit-Xmit/xmit-smtp-proxy.git "$INSTALL_DIR"
        log "Repository cloned to $INSTALL_DIR"
    fi

    cd "$INSTALL_DIR"
}

#------------------------------------------------------------------------------
# Install app dependencies and build
#------------------------------------------------------------------------------
build_app() {
    cd "$INSTALL_DIR"

    info "Installing dependencies..."
    pnpm install --frozen-lockfile > /dev/null 2>&1 || pnpm install > /dev/null 2>&1

    info "Building application..."
    pnpm build

    log "Application built successfully"
}

#------------------------------------------------------------------------------
# Setup TLS certificate
#------------------------------------------------------------------------------
setup_tls() {
    local domain="$1"
    local cert_dir="/etc/letsencrypt/live/$domain"

    if [ -d "$cert_dir" ]; then
        log "TLS certificate already exists for $domain"

        # Check expiry
        EXPIRY=$(openssl x509 -enddate -noout -in "$cert_dir/fullchain.pem" | cut -d= -f2)
        info "Certificate expires: $EXPIRY"
        return 0
    fi

    info "Obtaining TLS certificate for $domain..."
    info "Make sure port 80 is open and DNS points to this server!"

    read -p "Press Enter to continue or Ctrl+C to abort..."

    # Stop anything on port 80
    systemctl stop nginx 2>/dev/null || true
    fuser -k 80/tcp 2>/dev/null || true

    certbot certonly \
        --standalone \
        --non-interactive \
        --agree-tos \
        --email "admin@$domain" \
        -d "$domain" \
        || error "Failed to obtain certificate. Is DNS configured?"

    log "TLS certificate obtained for $domain"

    # Setup auto-renewal hook to restart service
    cat > /etc/letsencrypt/renewal-hooks/post/xmit-smtp.sh << 'EOF'
#!/bin/bash
pm2 restart xmit-smtp 2>/dev/null || true
EOF
    chmod +x /etc/letsencrypt/renewal-hooks/post/xmit-smtp.sh
}

#------------------------------------------------------------------------------
# Configure firewall
#------------------------------------------------------------------------------
setup_firewall() {
    local port="$1"

    info "Configuring firewall..."

    ufw --force enable > /dev/null 2>&1
    ufw allow ssh > /dev/null 2>&1
    ufw allow "$port/tcp" > /dev/null 2>&1
    ufw allow 80/tcp > /dev/null 2>&1  # For cert renewals

    log "Firewall configured (SSH, port $port, port 80)"
}

#------------------------------------------------------------------------------
# Create environment file
#------------------------------------------------------------------------------
create_env() {
    local domain="$1"
    local port="$2"
    local api_base="$3"
    local env_file="$INSTALL_DIR/.env"

    info "Creating environment file..."

    cat > "$env_file" << EOF
# xmit-smtp configuration
PORT=$port
API_BASE=$api_base
TLS_KEY_PATH=/etc/letsencrypt/live/$domain/privkey.pem
TLS_CERT_PATH=/etc/letsencrypt/live/$domain/fullchain.pem
NODE_ENV=production
EOF

    chmod 600 "$env_file"
    chown "$SERVICE_USER":"$SERVICE_USER" "$env_file"

    log "Environment file created: $env_file"
}

#------------------------------------------------------------------------------
# Setup PM2 service
#------------------------------------------------------------------------------
setup_pm2() {
    local port="$1"
    cd "$INSTALL_DIR"

    # Create log directory
    mkdir -p /var/log/xmit-smtp
    chown "$SERVICE_USER":"$SERVICE_USER" /var/log/xmit-smtp

    # Give xmit user access to letsencrypt certs
    if [ -d /etc/letsencrypt/live ]; then
        setfacl -R -m u:$SERVICE_USER:rx /etc/letsencrypt/live 2>/dev/null || true
        setfacl -R -m u:$SERVICE_USER:rx /etc/letsencrypt/archive 2>/dev/null || true
    fi

    # Allow Node.js to bind to privileged ports (< 1024) without root
    if [ "$port" -lt 1024 ]; then
        info "Allowing Node.js to bind to port $port..."
        NODE_PATH=$(which node)
        setcap 'cap_net_bind_service=+ep' "$NODE_PATH" 2>/dev/null || {
            warn "Could not set capabilities on node. Port $port may not work."
            warn "Consider using a port > 1024 or running as root."
        }
    fi

    # Ownership
    chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"

    # Stop existing if running (as root, then as user)
    pm2 delete xmit-smtp 2>/dev/null || true
    sudo -u "$SERVICE_USER" pm2 delete xmit-smtp 2>/dev/null || true

    info "Starting application with PM2..."

    # Start using ecosystem config
    sudo -u "$SERVICE_USER" bash -c "cd $INSTALL_DIR && pm2 start ecosystem.config.cjs"

    # Save PM2 state
    sudo -u "$SERVICE_USER" pm2 save

    # Setup PM2 startup on boot
    info "Configuring PM2 startup..."
    PM2_STARTUP_CMD=$(pm2 startup systemd -u "$SERVICE_USER" --hp "$INSTALL_DIR" 2>/dev/null | grep "sudo" | head -1) || true
    if [ -n "$PM2_STARTUP_CMD" ]; then
        eval "$PM2_STARTUP_CMD" > /dev/null 2>&1 || true
    fi

    log "PM2 service configured"
}

#------------------------------------------------------------------------------
# Print status
#------------------------------------------------------------------------------
print_status() {
    local domain="$1"
    local port="$2"

    echo ""
    echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  xmit-smtp deployment complete!${NC}"
    echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  SMTP Server: $domain:$port"
    echo "  Install Dir: $INSTALL_DIR"
    echo "  Service:     pm2 (running as $SERVICE_USER)"
    echo ""
    echo "  Useful commands:"
    echo "    pm2 status              # Check service status"
    echo "    pm2 logs xmit-smtp      # View logs"
    echo "    pm2 restart xmit-smtp   # Restart service"
    echo ""
    echo "  Configure your email client:"
    echo "    Host: $domain"
    echo "    Port: $port"
    echo "    User: api"
    echo "    Pass: <your Transmit API key>"
    echo "    TLS:  STARTTLS"
    echo ""
}

#------------------------------------------------------------------------------
# Main
#------------------------------------------------------------------------------
main() {
    echo ""
    echo -e "${BLUE}╔═══════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║                                                   ║${NC}"
    echo -e "${BLUE}║   xmit-smtp Deployment Script                     ║${NC}"
    echo -e "${BLUE}║                                                   ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════════════════╝${NC}"
    echo ""

    check_root
    detect_os

    echo ""
    info "Configuration"
    echo "  Leave blank for defaults, or enter custom values."
    echo ""

    prompt DOMAIN "SMTP domain" "$DEFAULT_DOMAIN"
    prompt PORT "SMTP port" "$DEFAULT_PORT"
    prompt API_BASE "Transmit API URL" "$DEFAULT_API_BASE"

    echo ""
    info "Will deploy with:"
    echo "  Domain:   $DOMAIN"
    echo "  Port:     $PORT"
    echo "  API:      $API_BASE"
    echo ""

    read -p "Continue? [Y/n] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Nn]$ ]]; then
        error "Aborted by user"
    fi

    echo ""
    install_dependencies
    install_node
    install_pnpm
    install_pm2
    create_user
    setup_repo
    build_app
    setup_tls "$DOMAIN"
    setup_firewall "$PORT"
    create_env "$DOMAIN" "$PORT" "$API_BASE"
    setup_pm2 "$PORT"

    print_status "$DOMAIN" "$PORT"
}

# Run main
main "$@"
