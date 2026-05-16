#!/bin/bash
set -e

cd "$(dirname "$0")"

if ! command -v node &> /dev/null; then
    echo "Node.js not found. Install it manually:"
    echo "  - Ubuntu/Debian: sudo apt install nodejs npm"
    echo "  - Arch:           sudo pacman -S nodejs npm"
    echo "  - macOS:          brew install node"
    echo "  - Windows:        https://nodejs.org"
    echo ""
    read -p "Or auto-install using nvm? (y/n): " ans
    if [ "$ans" = "y" ]; then
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
        nvm install node
        nvm use node
    else
        exit 1
    fi
fi

if [ ! -f id ]; then
    echo ""
    echo "=== First Time Setup ==="
    read -p "Enter your Discord User ID: " uid
    while [ -z "$uid" ]; do
        read -p "User ID cannot be empty: " uid
    done
    echo "$uid" > id
    echo ""
    echo "Setup complete!"
fi

if [ ! -d node_modules ]; then
    npm install
fi

echo "Starting in background..."
nohup node src/index.js > /dev/null 2>&1 &
echo "Started (PID: $!) — right-click the tray icon and select Exit to stop."
