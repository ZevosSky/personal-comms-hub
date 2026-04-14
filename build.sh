#!/usr/bin/env sh
set -eu

print_usage() {
  cat <<'EOF'
Comms Hub build helper

Usage:
  ./build.sh install      - Install dependencies
  ./build.sh dev          - Run Vite + Electron in development mode
  ./build.sh build        - Build the renderer only
  ./build.sh start        - Launch the built app locally
  ./build.sh smoke        - Run the smoke check
  ./build.sh dist         - Build the default packaged app output
  ./build.sh dist:win     - Build the Windows installer
  ./build.sh dist:linux   - Build the Linux AppImage

Common launch commands after building:
  npm start              - Launch the built desktop app
  npm run dev            - Launch the live development version
EOF
}

command_name="${1:-}"

case "$command_name" in
  ""|"help"|"-h"|"--help")
    print_usage
    exit 0
    ;;
  install)
    npm install
    ;;
  dev)
    npm run dev
    ;;
  build)
    npm run build
    ;;
  start)
    npm start
    ;;
  smoke)
    npm run smoke
    ;;
  dist)
    npm run dist
    ;;
  dist:win)
    npm run dist:win
    ;;
  dist:linux)
    npm run dist:linux
    ;;
  *)
    echo "Unknown command: $command_name"
    echo
    print_usage
    exit 1
    ;;
esac
