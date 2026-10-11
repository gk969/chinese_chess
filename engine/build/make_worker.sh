#!/bin/sh
# Pack the emscripten glue plus worker-shim.js into one JS string, so the page can
# start the engine in a Worker from a double-clicked index.html.
#
# Under file:// Chrome refuses `new Worker('engine/pikafish-hce.js')` (script cannot be
# accessed from origin 'null') and refuses importScripts inside a blob worker. The only
# worker that can start is one whose entire source is already a string in the page.
#
# Needs node (only for JSON escaping).
#
#   sh make_worker.sh [GLUE] [SHIM] [OUT]
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
GLUE=${1:-$HERE/../pikafish-hce.js}
SHIM=${2:-$HERE/worker-shim.js}
OUT=${3:-$HERE/../worker64.js}

[ -f "$GLUE" ] || { echo "no glue at $GLUE"; exit 1; }
[ -f "$SHIM" ] || { echo "no shim at $SHIM"; exit 1; }

{
  echo "/* 生成物,不要手改:engine/build/make_worker.sh 从 pikafish-hce.js + worker-shim.js 编出来。 */"
  printf 'window.XQ_WORKER_JS = '
  node -e 'const f=require("fs");const[a,b]=process.argv.slice(1);process.stdout.write(JSON.stringify(f.readFileSync(a,"utf8")+"\n"+f.readFileSync(b,"utf8")))' "$GLUE" "$SHIM"
  printf ';\n'
} > "$OUT"

echo "OK: $OUT  $(wc -c < "$OUT") B  (glue $(wc -c < "$GLUE") B)"
