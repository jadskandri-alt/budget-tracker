#!/bin/bash
# Script pour lancer Budget Tracker
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="/Users/skandrijad/.nvm/versions/node/v24.14.0/bin/node"
ELECTRON="$DIR/node_modules/.bin/electron"

cd "$DIR"
"$NODE" "$ELECTRON" . &
