#!/bin/bash
cd /Users/YOUR_USERNAME/Documents/GitHub/secondbrain
set -a
source .env
set +a
exec /opt/homebrew/bin/node dist/index.js
