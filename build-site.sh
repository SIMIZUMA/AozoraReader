#!/usr/bin/env bash
# 公開用のファイルを dist/ に作る(GitHub Pages / Cloudflare Pages 共通)。
#   1. アプリ本体のファイルを dist/ へコピー
#   2. 本文リポジトリのファイル一覧を取り、青空文庫の公式CSVと突き合わせて data/catalog.json を作る
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist/data
cp index.html sw.js manifest.webmanifest icon.svg icon-*.png dist/
TMP="$(mktemp -d)"
git clone -q --depth 1 --filter=blob:none --no-checkout https://github.com/aozorahack/aozorabunko_text.git "$TMP/text"
git -C "$TMP/text" ls-tree -r --name-only HEAD | grep '\.txt$' > "$TMP/tree.txt"
node scripts/build-catalog.mjs ${AOZORA_CSV:+--csv="$AOZORA_CSV"} --tree="$TMP/tree.txt" --out=dist/data/catalog.json
