#!/bin/bash
cd /Users/YOUR_USERNAME/Documents/GitHub/brown-man-money/server
set -a
source .env
set +a
exec /opt/homebrew/bin/node server.js
