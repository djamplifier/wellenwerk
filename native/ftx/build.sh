#!/bin/sh
# FT8/FT4-Dekoder (ft8_lib, MIT) nach WebAssembly uebersetzen -> static/vendor/ftx.js (eine Datei, WASM eingebettet)
# Voraussetzung: emscripten (emcc) im Pfad.
set -e
cd "$(dirname "$0")"
SRC="ww_ftx.c ft8_lib/ft8/*.c ft8_lib/common/monitor.c ft8_lib/fft/kiss_fft.c ft8_lib/fft/kiss_fftr.c"
mkdir -p ../../static/vendor
emcc -O3 -I ft8_lib $SRC -o ../../static/vendor/ftx.js -lm \
  -s MODULARIZE=1 -s EXPORT_NAME=createFtx -s SINGLE_FILE=1 -s ENVIRONMENT=web,worker,node -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORTED_FUNCTIONS='["_ww_ftx_decode","_malloc","_free"]' -s EXPORTED_RUNTIME_METHODS='["HEAPF32","UTF8ToString"]'
ls -la ../../static/vendor/ftx.js
