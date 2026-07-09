#!/usr/bin/env bash
set -e
FF="${1:?Usage: make-test-video.sh <path-to-ffmpeg-binary>}"
OUT_DIR="$(dirname "$0")"
TMP="$OUT_DIR/.tmp-video-build"
mkdir -p "$TMP"

make_segment() {
  local color="$1" text="$2" out="$3"
  "$FF" -y -f lavfi -i "color=c=${color}:s=640x480:d=2:r=30" \
    -vf "drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='${text}':fontsize=200:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2" \
    -pix_fmt yuv420p "$out"
}

make_segment blue  701 "$TMP/seg1.mp4"
make_segment green 702 "$TMP/seg2.mp4"
make_segment red   703 "$TMP/seg3.mp4"

printf "file 'seg1.mp4'\nfile 'seg2.mp4'\nfile 'seg3.mp4'\n" > "$TMP/concat.txt"
"$FF" -y -f concat -safe 0 -i "$TMP/concat.txt" -c copy "$OUT_DIR/test-video.mp4"

echo "Wrote $OUT_DIR/test-video.mp4"
"$FF" -i "$OUT_DIR/test-video.mp4" 2>&1 | grep Duration
