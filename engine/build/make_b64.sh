#!/bin/sh
# Inline the .wasm as base64 into a JS file.
#
# Needed because the game must run from a double-clicked index.html: under
# file:// Chrome/Edge block fetch() and XHR, so pikafish-hce.wasm cannot be
# fetched by URL. (The emscripten glue ignores Module.wasmBinary — see
# instantiateArrayBuffer, which re-reads the file by name — so the only load
# path is Module.instantiateWasm fed from this blob.)
#
#   sh make_b64.sh [WASM] [OUT]
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
SRC=${1:-$HERE/../pikafish-hce.wasm}
OUT=${2:-$HERE/../wasm64.js}

[ -f "$SRC" ] || { echo "no wasm at $SRC"; exit 1; }

{
  echo "/* 生成物,不要手改:engine/build/make_b64.sh 从 pikafish-hce.wasm 编出来。 */"
  printf 'window.XQ_WASM_B64 = "'
  base64 -w 0 "$SRC"
  printf '";\n'
} > "$OUT"

echo "OK: $OUT  $(wc -c < "$OUT") B  (wasm $(wc -c < "$SRC") B)"
