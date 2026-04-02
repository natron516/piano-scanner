#!/usr/bin/env bash
# Run this once to initialize the git repo
set -e
cd "$(dirname "$0")"
git init
git add -A
git commit -m "Initial commit: Piano Scanner web app"
echo "✅ Git repo initialized."
echo ""
echo "To open the app:"
echo "  python3 -m http.server 8080"
echo "  then open http://localhost:8080 in Chrome or Edge"
