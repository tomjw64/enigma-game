#!/usr/bin/env bash
# trap 'kill $(jobs -p) && exit 0' SIGINT SIGTERM EXIT

npm run build
node ./build/backend/index.js --enable-source-maps &
NODE_PID=$!
inotifywait -e close_write,moved_to,create -m -r ./src |
while read -r directory events filename; do
  kill $NODE_PID
  npm run build
  node ./build/backend/index.js --enable-source-maps &
  NODE_PID=$!
done
