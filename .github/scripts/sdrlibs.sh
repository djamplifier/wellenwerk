#!/usr/bin/env bash
# SDR-Treiberbibliotheken fuer den direkten USB-Anschluss bauen bzw. holen und nach packaging/sdrlibs legen:
#   librtlsdr (Fassung von RTL-SDR Blog: unterstuetzt auch den V4) und libhackrf (Great Scott Gadgets).
# Laeuft im CI unter Windows (Git-Bash), macOS und Linux.
set -euo pipefail
RTL_VER=V1.4.0
HRF_VER=v2026.01.3
OUT="$PWD/packaging/sdrlibs"; mkdir -p "$OUT"
W="${RUNNER_TEMP:-/tmp}/sdrbuild"; rm -rf "$W"; mkdir -p "$W"; cd "$W"
curl -sSLo hackrf.zip "https://github.com/greatscottgadgets/hackrf/releases/download/$HRF_VER/hackrf-${HRF_VER#v}.zip"
unzip -q hackrf.zip; HRF_SRC="$W/hackrf-${HRF_VER#v}/host"
case "${RUNNER_OS:-$(uname)}" in
  Windows)
    curl -sSLo rtl.zip "https://github.com/rtlsdrblog/rtl-sdr-blog/releases/download/$RTL_VER/Release.zip"; unzip -q rtl.zip -d rtl
    cp rtl/x64/rtlsdr.dll rtl/x64/pthreadVC2.dll rtl/x64/msvcr100.dll "$OUT/"
    VC="${VCPKG_INSTALLATION_ROOT:-C:/vcpkg}"; "$VC/vcpkg" install libusb:x64-windows pthreads:x64-windows >/dev/null
    I="$VC/installed/x64-windows"
    PT=$(ls "$I/lib" | grep -i '^pthreadVC.*\.lib$' | head -1)
    cmake -S "$HRF_SRC" -B hb -A x64 -DCMAKE_TOOLCHAIN_FILE="$VC/scripts/buildsystems/vcpkg.cmake" \
      -DLIBUSB_INCLUDE_DIR="$I/include/libusb-1.0" -DLIBUSB_LIBRARIES="$I/lib/libusb-1.0.lib" \
      -DTHREADS_PTHREADS_INCLUDE_DIR="$I/include" -DTHREADS_PTHREADS_WIN32_LIBRARY="$I/lib/$PT" >/dev/null
    cmake --build hb --config Release --target hackrf >/dev/null
    find hb -iname 'hackrf.dll' -exec cp {} "$OUT/" \;
    cp "$I/bin/libusb-1.0.dll" "$OUT/"; cp "$I/bin/"pthreadVC3*.dll "$OUT/" 2>/dev/null || true
    ;;
  macOS|Darwin)
    brew list libusb >/dev/null 2>&1 || brew install libusb >/dev/null
    git clone -q --depth 1 -b "$RTL_VER" https://github.com/rtlsdrblog/rtl-sdr-blog rtl
    UL="$(brew --prefix libusb)/lib"; LF="-DCMAKE_SHARED_LINKER_FLAGS=-L$UL"
    cmake -S rtl -B rb -DCMAKE_BUILD_TYPE=Release -DINSTALL_UDEV_RULES=OFF "$LF" >/dev/null
    cmake --build rb --target rtlsdr -j4 >/dev/null
    cmake -S "$HRF_SRC" -B hb -DCMAKE_BUILD_TYPE=Release "$LF" >/dev/null
    cmake --build hb --target hackrf -j4 >/dev/null
    U="$UL/libusb-1.0.0.dylib"; chmod u+w "$OUT/libusb-1.0.0.dylib" 2>/dev/null || true; cp -fL "$U" "$OUT/libusb-1.0.0.dylib"; chmod u+w "$OUT/libusb-1.0.0.dylib"
    cp -L "$(find rb -name 'librtlsdr*.dylib' -type f | head -1)" "$OUT/librtlsdr.dylib"
    cp -L "$(find hb -name 'libhackrf*.dylib' -type f | head -1)" "$OUT/libhackrf.dylib"
    for f in librtlsdr.dylib libhackrf.dylib libusb-1.0.0.dylib; do
      install_name_tool -id "@loader_path/$f" "$OUT/$f"
      for dep in $(otool -L "$OUT/$f" | awk '/libusb-1.0/ {print $1}'); do [ "$dep" = "@loader_path/libusb-1.0.0.dylib" ] || install_name_tool -change "$dep" "@loader_path/libusb-1.0.0.dylib" "$OUT/$f"; done
      codesign -f -s - "$OUT/$f" >/dev/null 2>&1 || true
    done
    ;;
  *)
    sudo apt-get install -y -qq libusb-1.0-0-dev cmake pkg-config >/dev/null
    git clone -q --depth 1 -b "$RTL_VER" https://github.com/rtlsdrblog/rtl-sdr-blog rtl
    cmake -S rtl -B rb -DCMAKE_BUILD_TYPE=Release -DINSTALL_UDEV_RULES=OFF >/dev/null
    cmake --build rb --target rtlsdr -j4 >/dev/null
    cmake -S "$HRF_SRC" -B hb -DCMAKE_BUILD_TYPE=Release >/dev/null
    cmake --build hb --target hackrf -j4 >/dev/null
    cp -L "$(find rb -name 'librtlsdr.so*' -type f | head -1)" "$OUT/librtlsdr.so"
    cp -L "$(find hb -name 'libhackrf.so*' -type f | head -1)" "$OUT/libhackrf.so"
    ;;
esac
ls -la "$OUT"
