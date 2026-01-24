#!/bin/bash
#
# xmit-mail Deployment Script (SMTP + IMAP)
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
DEFAULT_DOMAIN="mail.xmit.sh"
DEFAULT_SMTP_PORT="587"
DEFAULT_IMAP_PORT="993"
DEFAULT_API_BASE="https://api.xmit.sh"
INSTALL_DIR="/opt/xmit-smtp"
SERVICE_USER="xmit"
SERVICE_NAME="xmit-mail"

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
        build-essential \
        python3 \
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
        git clone https://github.com/Transmit-Xmit/xmit-mail.git "$INSTALL_DIR"
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

    # Rebuild native modules for this system (better-sqlite3 requires compilation)
    # pnpm may download pre-built binaries that don't match Node version
    info "Rebuilding native modules..."
    if pnpm rebuild better-sqlite3 2>&1; then
        log "Native modules rebuilt"
    else
        warn "pnpm rebuild failed, trying manual build..."

        # Fallback: build manually
        SQLITE_DIR=$(find node_modules/.pnpm -type d -name "better-sqlite3" -path "*/node_modules/better-sqlite3" 2>/dev/null | head -1)
        if [ -n "$SQLITE_DIR" ] && [ -f "$SQLITE_DIR/binding.gyp" ]; then
            info "Building better-sqlite3 from source..."
            cd "$SQLITE_DIR"

            if npm run build-release; then
                if [ -f "build/Release/better_sqlite3.node" ]; then
                    log "Native module built successfully"
                else
                    warn "Build reported success but binary not found"
                fi
            else
                warn "Native module build failed - caching may not work"
                warn "Ensure build-essential and python3 are installed"
            fi
            cd "$INSTALL_DIR"
        else
            warn "better-sqlite3 not found - caching will not work"
        fi
    fi

    # Verify native module exists
    SQLITE_NODE=$(find node_modules/.pnpm -name "better_sqlite3.node" 2>/dev/null | head -1)
    if [ -n "$SQLITE_NODE" ]; then
        log "Native module verified: $SQLITE_NODE"
    else
        warn "WARNING: Native module not found - SQLite caching disabled"
    fi

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
    cat > /etc/letsencrypt/renewal-hooks/post/$SERVICE_NAME.sh << EOF
#!/bin/bash
pm2 restart $SERVICE_NAME 2>/dev/null || true
EOF
    chmod +x /etc/letsencrypt/renewal-hooks/post/$SERVICE_NAME.sh
}

#------------------------------------------------------------------------------
# Configure firewall
#------------------------------------------------------------------------------
setup_firewall() {
    local smtp_port="$1"
    local imap_port="$2"

    info "Configuring firewall..."

    ufw --force enable > /dev/null 2>&1
    ufw allow ssh > /dev/null 2>&1
    ufw allow "$smtp_port/tcp" > /dev/null 2>&1
    ufw allow "$imap_port/tcp" > /dev/null 2>&1
    ufw allow 80/tcp > /dev/null 2>&1  # For cert renewals

    log "Firewall configured (SSH, SMTP:$smtp_port, IMAP:$imap_port, HTTP:80)"
}

#------------------------------------------------------------------------------
# Create environment file
#------------------------------------------------------------------------------
create_env() {
    local domain="$1"
    local smtp_port="$2"
    local imap_port="$3"
    local api_base="$4"
    local env_file="$INSTALL_DIR/.env"

    info "Creating environment file..."

    cat > "$env_file" << EOF
# xmit-mail configuration (SMTP + IMAP)
SMTP_PORT=$smtp_port
IMAP_PORT=$imap_port
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
    local smtp_port="$1"
    local imap_port="$2"
    cd "$INSTALL_DIR"

    # Create log directory
    mkdir -p /var/log/$SERVICE_NAME
    chown "$SERVICE_USER":"$SERVICE_USER" /var/log/$SERVICE_NAME

    # Give xmit user access to letsencrypt certs
    if [ -d /etc/letsencrypt/live ]; then
        setfacl -R -m u:$SERVICE_USER:rx /etc/letsencrypt/live 2>/dev/null || true
        setfacl -R -m u:$SERVICE_USER:rx /etc/letsencrypt/archive 2>/dev/null || true
    fi

    # Allow Node.js to bind to privileged ports (< 1024) without root
    NODE_PATH=$(which node)
    if [ "$smtp_port" -lt 1024 ] || [ "$imap_port" -lt 1024 ]; then
        info "Allowing Node.js to bind to privileged ports..."
        setcap 'cap_net_bind_service=+ep' "$NODE_PATH" 2>/dev/null || {
            warn "Could not set capabilities on node. Privileged ports may not work."
            warn "Consider using ports > 1024 or running as root."
        }
    fi

    # Ownership
    chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"

    # Stop existing if running (try both old and new names)
    pm2 delete xmit-smtp 2>/dev/null || true
    pm2 delete $SERVICE_NAME 2>/dev/null || true
    sudo -u "$SERVICE_USER" pm2 delete xmit-smtp 2>/dev/null || true
    sudo -u "$SERVICE_USER" pm2 delete $SERVICE_NAME 2>/dev/null || true

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
# Setup convenience aliases for other users
#------------------------------------------------------------------------------
setup_aliases() {
    local alias_line="alias pm2='sudo -u $SERVICE_USER pm2'"

    # Add alias for all users with a home directory
    for user_home in /home/*; do
        if [ -d "$user_home" ]; then
            local bashrc="$user_home/.bashrc"
            local username=$(basename "$user_home")

            # Skip the service user
            if [ "$username" = "$SERVICE_USER" ]; then
                continue
            fi

            # Add alias if not already present
            if [ -f "$bashrc" ] && ! grep -q "alias pm2=" "$bashrc" 2>/dev/null; then
                echo "" >> "$bashrc"
                echo "# PM2 alias to run as $SERVICE_USER (added by xmit-mail deploy)" >> "$bashrc"
                echo "$alias_line" >> "$bashrc"
                info "Added pm2 alias for user: $username"
            fi
        fi
    done

    log "PM2 aliases configured (run 'source ~/.bashrc' or reconnect)"
}

#------------------------------------------------------------------------------
# Print status
#------------------------------------------------------------------------------
print_status() {
    local domain="$1"
    local smtp_port="$2"
    local imap_port="$3"

    echo ""
    echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  xmit-mail deployment complete!${NC}"
    echo -e "${GREEN}════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  SMTP Server: $domain:$smtp_port"
    echo "  IMAP Server: $domain:$imap_port"
    echo "  Install Dir: $INSTALL_DIR"
    echo "  Service:     pm2 (running as $SERVICE_USER)"
    echo ""
    echo "  Useful commands:"
    echo "    pm2 status              # Check service status"
    echo "    pm2 logs $SERVICE_NAME  # View logs"
    echo "    pm2 restart $SERVICE_NAME  # Restart service"
    echo ""
    echo "  ┌─────────────────────────────────────────────────────────┐"
    echo "  │  Email Client Configuration                            │"
    echo "  ├─────────────────────────────────────────────────────────┤"
    echo "  │                                                         │"
    echo "  │  Incoming Mail (IMAP):                                  │"
    echo "  │    Host:     $domain"
    echo "  │    Port:     $imap_port"
    echo "  │    Security: SSL/TLS"
    echo "  │    Username: <sender email> (e.g. support@acme.com)"
    echo "  │    Password: <your Transmit API key>"
    echo "  │                                                         │"
    echo "  │  Outgoing Mail (SMTP):                                  │"
    echo "  │    Host:     $domain"
    echo "  │    Port:     $smtp_port"
    echo "  │    Security: STARTTLS"
    echo "  │    Username: api"
    echo "  │    Password: <your Transmit API key>"
    echo "  │                                                         │"
    echo "  └─────────────────────────────────────────────────────────┘"
    echo ""
}

#------------------------------------------------------------------------------
# Main
#------------------------------------------------------------------------------
main() {
    echo ""
    echo -e "${BLUE}╔═══════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║                                                       ║${NC}"
    echo -e "${BLUE}║   xmit-mail Deployment Script (SMTP + IMAP)           ║${NC}"
    echo -e "${BLUE}║                                                       ║${NC}"
    echo -e "${BLUE}╚═══════════════════════════════════════════════════════╝${NC}"
    echo ""

    check_root
    detect_os

    echo ""
    info "Configuration"
    echo "  Leave blank for defaults, or enter custom values."
    echo ""

    prompt DOMAIN "Mail domain" "$DEFAULT_DOMAIN"
    prompt SMTP_PORT "SMTP port" "$DEFAULT_SMTP_PORT"
    prompt IMAP_PORT "IMAP port" "$DEFAULT_IMAP_PORT"
    prompt API_BASE "Transmit API URL" "$DEFAULT_API_BASE"

    echo ""
    info "Will deploy with:"
    echo "  Domain:    $DOMAIN"
    echo "  SMTP Port: $SMTP_PORT"
    echo "  IMAP Port: $IMAP_PORT"
    echo "  API:       $API_BASE"
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
    setup_firewall "$SMTP_PORT" "$IMAP_PORT"
    create_env "$DOMAIN" "$SMTP_PORT" "$IMAP_PORT" "$API_BASE"
    setup_pm2 "$SMTP_PORT" "$IMAP_PORT"
    setup_aliases

    print_status "$DOMAIN" "$SMTP_PORT" "$IMAP_PORT"
}

# Run main
main "$@"
