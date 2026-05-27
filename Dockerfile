#
# Multi-stage Dockerfile for Pentest Agent
# Uses Chainguard Wolfi for minimal attack surface and supply chain security

# Builder stage - Install tools and dependencies
FROM cgr.dev/chainguard/wolfi-base:latest AS builder

# Install system dependencies available in Wolfi
RUN apk update && apk add --no-cache \
    # Core build tools
    build-base \
    git \
    curl \
    wget \
    ca-certificates \
    # Network libraries for Go tools
    libpcap-dev \
    linux-headers \
    # Language runtimes
    go \
    nodejs-22 \
    npm \
    python3 \
    py3-pip \
    python3-dev \
    libffi-dev \
    openssl-dev \
    # Rust toolchain — required to build NetExec's `aardwolf` RDP dependency.
    # Builder-only; the runtime image doesn't need it. Wolfi bundles cargo
    # inside the rust package (no separate `cargo` apk available).
    rust \
    ruby \
    ruby-dev \
    # Security tools available in Wolfi
    nmap \
    samba-common-tools \
    openldap-clients \
    bind-tools \
    nfs-utils \
    net-snmp-tools \
    # NOTE: masscan, arp-scan, hashcat, john are not in Wolfi's stable feed
    # as of PR 1. They are not required for the PR 1 scaffolding (discovery,
    # enumeration, auth-mapper, report). PR 2 (services) may add masscan from
    # source if rustscan/naabu prove insufficient for /16+ scope; PR 5 (creds)
    # adds hashcat from source for CPU cracking. Until then, network-discovery
    # uses nmap + naabu (Go binary, installed below), which covers MVP scope.
    # Additional utilities
    bash

# Set environment variables for Go
ENV GOPATH=/go
ENV PATH=$GOPATH/bin:/usr/local/go/bin:$PATH
ENV CGO_ENABLED=1

# Create directories
RUN mkdir -p $GOPATH/bin

# Install Go-based security tools
RUN go install -v github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest && \
    go install -v github.com/projectdiscovery/naabu/v2/cmd/naabu@latest && \
    go install -v github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest && \
    GO111MODULE=on go install -v github.com/ropnop/kerbrute@latest

# Install WhatWeb from GitHub (Ruby-based tool)
RUN git clone --depth 1 https://github.com/urbanadventurer/WhatWeb.git /opt/whatweb && \
    chmod +x /opt/whatweb/whatweb && \
    gem install addressable && \
    echo '#!/bin/bash' > /usr/local/bin/whatweb && \
    echo 'cd /opt/whatweb && exec ./whatweb "$@"' >> /usr/local/bin/whatweb && \
    chmod +x /usr/local/bin/whatweb

# Install Python-based tools
# - schemathesis (existing, for API tier)
# - impacket: AD/SMB/Kerberos exploitation suite (secretsdump, GetUserSPNs, GetNPUsers, psexec, wmiexec, etc.)
# - certipy-ad: ADCS abuse (ESC1-ESC11+)
# - bloodhound: AD attack-path collection (the bloodhound-python CLI)
RUN pip3 install --no-cache-dir --break-system-packages \
    schemathesis \
    impacket \
    certipy-ad \
    bloodhound

# NetExec is not on PyPI — install from upstream git. Per NetExec's official
# install docs (https://www.netexec.wiki/getting-started/installation).
# The `[full]` extras pull optional dependencies (kerberos, dpapi, etc.).
RUN pip3 install --no-cache-dir --break-system-packages \
    "git+https://github.com/Pennyw0rth/NetExec"

# Runtime stage - Minimal production image
FROM cgr.dev/chainguard/wolfi-base:latest AS runtime

# Install only runtime dependencies
USER root
RUN apk update && apk add --no-cache \
    # Core utilities
    git \
    bash \
    curl \
    jq \
    ca-certificates \
    # Network libraries (runtime)
    libpcap \
    # Security tools — web/api shared
    nmap \
    # Security tools — network tier (PR 1 baseline; masscan/arp-scan/hashcat/john
    # added from source in subsequent PRs when actually needed by vuln/exploit
    # agents)
    samba-common-tools \
    openldap-clients \
    bind-tools \
    nfs-utils \
    net-snmp-tools \
    # Language runtimes (minimal)
    nodejs-22 \
    npm \
    python3 \
    ruby \
    # Chromium browser and dependencies for Playwright
    chromium \
    # Additional libraries Chromium needs
    nss \
    freetype \
    harfbuzz \
    # X11 libraries for headless browser
    libx11 \
    libxcomposite \
    libxdamage \
    libxext \
    libxfixes \
    libxrandr \
    mesa-gbm \
    # Font rendering
    fontconfig

# Copy Go binaries from builder
COPY --from=builder /go/bin/subfinder /usr/local/bin/
COPY --from=builder /go/bin/naabu /usr/local/bin/
COPY --from=builder /go/bin/nuclei /usr/local/bin/
COPY --from=builder /go/bin/kerbrute /usr/local/bin/

# Copy WhatWeb from builder
COPY --from=builder /opt/whatweb /opt/whatweb
COPY --from=builder /usr/local/bin/whatweb /usr/local/bin/whatweb

# Install WhatWeb Ruby dependencies in runtime stage
RUN gem install addressable

# Copy Python packages from builder. Wolfi's Python ships with /usr/lib/python3.12/
# as the canonical site-packages location. The wildcard handles minor-version
# drift if the base image bumps to 3.13. Includes:
# - schemathesis (api tier)
# - impacket, certipy-ad, bloodhound, netexec (network tier)
COPY --from=builder /usr/lib/python3.*/site-packages /usr/lib/python3.12/site-packages
COPY --from=builder /usr/bin/schemathesis /usr/bin/

# Network-tier Python CLI entrypoints. impacket installs ~30 scripts; copy the
# ones the network agents actually use. (Full set is available via /usr/lib/python.../site-packages
# even when the entrypoint isn't in /usr/bin — agents can call `python3 -m impacket.examples.<name>`.)
COPY --from=builder /usr/bin/GetUserSPNs.py /usr/bin/
COPY --from=builder /usr/bin/GetNPUsers.py /usr/bin/
COPY --from=builder /usr/bin/secretsdump.py /usr/bin/
COPY --from=builder /usr/bin/psexec.py /usr/bin/
COPY --from=builder /usr/bin/wmiexec.py /usr/bin/
COPY --from=builder /usr/bin/atexec.py /usr/bin/
COPY --from=builder /usr/bin/mssqlclient.py /usr/bin/
COPY --from=builder /usr/bin/getST.py /usr/bin/
COPY --from=builder /usr/bin/ticketer.py /usr/bin/
COPY --from=builder /usr/bin/lookupsid.py /usr/bin/
COPY --from=builder /usr/bin/GetADUsers.py /usr/bin/
COPY --from=builder /usr/bin/ntlmrelayx.py /usr/bin/
COPY --from=builder /usr/bin/certipy /usr/bin/
COPY --from=builder /usr/bin/bloodhound-python /usr/bin/
COPY --from=builder /usr/bin/nxc /usr/bin/
COPY --from=builder /usr/bin/netexec /usr/bin/

# Create non-root user for security
RUN addgroup -g 1001 pentest && \
    adduser -u 1001 -G pentest -s /bin/bash -D pentest

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./
COPY mcp-server/package*.json ./mcp-server/

# Install Node.js dependencies (including devDependencies for TypeScript build)
RUN npm ci && \
    cd mcp-server && npm ci && cd .. && \
    npm cache clean --force

# Copy application source code
COPY . .

# Build TypeScript (mcp-server first, then main project)
RUN cd mcp-server && npm run build && cd .. && npm run build

# Remove devDependencies after build to reduce image size
RUN npm prune --production && \
    cd mcp-server && npm prune --production

RUN npm install -g @anthropic-ai/claude-code

# Create directories for session data and ensure proper permissions
RUN mkdir -p /app/sessions /app/deliverables /app/repos /app/configs && \
    mkdir -p /tmp/.cache /tmp/.config /tmp/.npm && \
    chmod 777 /app && \
    chmod 777 /tmp/.cache && \
    chmod 777 /tmp/.config && \
    chmod 777 /tmp/.npm && \
    chown -R pentest:pentest /app

# Switch to non-root user
USER pentest

# Set environment variables
ENV NODE_ENV=production
ENV PATH="/usr/local/bin:$PATH"
ENV GANDALF_DOCKER=true
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV npm_config_cache=/tmp/.npm
ENV HOME=/tmp
ENV XDG_CACHE_HOME=/tmp/.cache
ENV XDG_CONFIG_HOME=/tmp/.config

# Configure Git identity and trust all directories
RUN git config --global user.email "agent@localhost" && \
    git config --global user.name "Pentest Agent" && \
    git config --global --add safe.directory '*'

# Set entrypoint
ENTRYPOINT ["node", "dist/gandalf.js"]
