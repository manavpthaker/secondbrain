#!/bin/bash
set -e

CLI="node dist/cli.js"

echo "=== Smoke Test ==="

echo -n "version... "
$CLI --version
echo "ok"

echo -n "help... "
$CLI --help > /dev/null
echo "ok"

echo ""
echo "Smoke test passed."
