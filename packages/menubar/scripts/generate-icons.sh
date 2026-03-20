#!/usr/bin/env bash
# Generates all required Tauri icon sizes from a source image.
# Requires: ImageMagick (brew install imagemagick)
# Usage: bash scripts/generate-icons.sh [source-image.png]
#
# If no source image is provided, creates a computer glyph icon.

set -euo pipefail

ICONS_DIR="$(dirname "$0")/../src-tauri/icons"
mkdir -p "$ICONS_DIR"

SOURCE="${1:-}"

if [[ -z "$SOURCE" ]]; then
  echo "No source image provided — generating computer icon source..."
  SOURCE="$ICONS_DIR/_source.png"

  convert -size 1024x1024 xc:none \
    \( -size 1024x1024 radial-gradient:'#72ffff-#1291b3' \) \
    \( -size 1024x1024 xc:none -fill white -draw 'circle 512,512 512,60' \) \
    -compose copyopacity -composite \
    -stroke '#f3feff' -strokewidth 52 -fill none -draw 'roundrectangle 276,286 748,610 80,80' \
    -fill '#f3feff' -stroke none -draw 'circle 444,449 444,425' \
    -fill '#f3feff' -stroke none -draw 'circle 582,449 582,425' \
    -stroke '#f3feff' -strokewidth 52 -fill none -draw 'line 512,615 512,744' \
    -stroke '#f3feff' -strokewidth 52 -fill none -draw 'line 372,748 652,748' \
    "$SOURCE"
fi

echo "Generating icons from: $SOURCE"

# Standard sizes for Tauri bundle
convert "$SOURCE" -resize 32x32     "$ICONS_DIR/32x32.png"
convert "$SOURCE" -resize 128x128   "$ICONS_DIR/128x128.png"
convert "$SOURCE" -resize 256x256   "$ICONS_DIR/128x128@2x.png"
convert "$SOURCE" -resize 512x512   "$ICONS_DIR/icon.png"

# Tray icon
convert "$SOURCE" -resize 22x22 "$ICONS_DIR/tray-icon.png"

# macOS .icns (requires iconutil or ImageMagick with icns support)
if command -v iconutil &>/dev/null; then
  ICONSET="$ICONS_DIR/icon.iconset"
  mkdir -p "$ICONSET"
  convert "$SOURCE" -resize 16x16    "$ICONSET/icon_16x16.png"
  convert "$SOURCE" -resize 32x32    "$ICONSET/icon_16x16@2x.png"
  convert "$SOURCE" -resize 32x32    "$ICONSET/icon_32x32.png"
  convert "$SOURCE" -resize 64x64    "$ICONSET/icon_32x32@2x.png"
  convert "$SOURCE" -resize 128x128  "$ICONSET/icon_128x128.png"
  convert "$SOURCE" -resize 256x256  "$ICONSET/icon_128x128@2x.png"
  convert "$SOURCE" -resize 256x256  "$ICONSET/icon_256x256.png"
  convert "$SOURCE" -resize 512x512  "$ICONSET/icon_256x256@2x.png"
  convert "$SOURCE" -resize 512x512  "$ICONSET/icon_512x512.png"
  convert "$SOURCE" -resize 1024x1024 "$ICONSET/icon_512x512@2x.png"
  iconutil -c icns "$ICONSET" -o "$ICONS_DIR/icon.icns"
  rm -rf "$ICONSET"
  echo "Generated icon.icns via iconutil"
else
  echo "iconutil not found — skipping .icns (not required for dev builds)"
  # Create a minimal placeholder .icns so Tauri doesn't error
  cp "$ICONS_DIR/icon.png" "$ICONS_DIR/icon.icns" 2>/dev/null || true
fi

# Windows .ico (multi-size)
convert "$SOURCE" \
  \( -clone 0 -resize 16x16  \) \
  \( -clone 0 -resize 32x32  \) \
  \( -clone 0 -resize 48x48  \) \
  \( -clone 0 -resize 64x64  \) \
  \( -clone 0 -resize 128x128 \) \
  -delete 0 \
  "$ICONS_DIR/icon.ico"

echo "Done. Icons written to $ICONS_DIR/"
ls -lh "$ICONS_DIR/"
