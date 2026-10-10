#!/bin/sh
# Build Pikafish-HCE as a single-threaded WASM module.
# Bypasses the upstream Makefile (its arch whitelist has no wasm entry).
#
#   sh build_wasm.sh [SOURCE_ROOT] [DIST_DIR]
#
# SOURCE_ROOT defaults to ~/wasm/hce, DIST_DIR to the engine/ folder this
# script's parent. emsdk is taken from $EMSDK, else ~/wasm/emsdk.
set -e

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=${1:-$HOME/wasm/hce}
DIST=${2:-$HERE/../}
EMSDK=${EMSDK:-$HOME/wasm/emsdk}

. $EMSDK/emsdk_env.sh >/dev/null 2>&1
SRC=$ROOT/src
OUT=$ROOT/wasm_build
EM=$EMSDK/upstream/emscripten
CXX=$EM/em++

[ -d $SRC ] || { echo "no source tree at $SRC"; exit 1; }
mkdir -p $OUT

# Our two files, not upstream's. Copy them in every run so a fresh clone works.
mkdir -p $SRC/emscripten $ROOT/emscripten
cp $HERE/utils.h $SRC/emscripten/utils.h
cp $HERE/preamble.js $ROOT/emscripten/preamble.js

for p in patch.py patch2.py patch3.py patch4.py; do python3 $HERE/$p $ROOT; done

CXXFLAGS="-O3 -std=c++17 -DNDEBUG -fno-exceptions -fno-rtti -DIS_64BIT -DNO_PREFETCH"

LDFLAGS="-O3 \
  -s MODULARIZE=1 -s EXPORT_NAME=PikafishHCE -s ENVIRONMENT=web,worker,node \
  -s ASYNCIFY=1 -s ASYNCIFY_IMPORTS=[emscripten_utils_getline_impl] \
  -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=268435456 -s MAXIMUM_MEMORY=2147483648 \
  -s STACK_SIZE=16777216 \
  -s FILESYSTEM=0 \
  --pre-js $ROOT/emscripten/preamble.js"

SRCS="benchmark bitboard evaluate main material misc movegen movepick position psqt endgame search thread timeman tt uci ucioption tune"

for f in $SRCS; do
  # Any header change invalidates every object, so compare against all of them.
  if [ -f $OUT/$f.o ] && [ -z "$(find $SRC -name '*.h' -o -name '*.cpp' -newer $OUT/$f.o -print -quit)" ]; then
    continue
  fi
  echo "-- $f.cpp"
  $CXX $CXXFLAGS -I$SRC -c $SRC/$f.cpp -o $OUT/$f.o
done

echo "-- link"
$CXX $CXXFLAGS $OUT/*.o $LDFLAGS -o $OUT/pikafish-hce.js

cp $OUT/pikafish-hce.js $OUT/pikafish-hce.wasm $DIST
echo "OK: $DIST$(basename $OUT)/pikafish-hce.js"
