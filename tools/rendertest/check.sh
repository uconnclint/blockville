#!/bin/bash
# Syntax-check every game module as an ES module. Run after EVERY edit.
# Exit 1 + the offending file/line if anything fails to parse.
cd "$(dirname "$0")/../.." || exit 2
T=$(mktemp -d); bad=0
for f in src/*.js src/render/*.js src/models/*.js tools/demo-city.js; do
  cp "$f" "$T/x.mjs"
  out=$(node --check "$T/x.mjs" 2>&1) || { echo "SYNTAX ERROR in $f:"; echo "$out" | sed -n '1,4p' | sed "s|$T/x.mjs|$f|"; bad=1; }
done
rm -rf "$T"; [ $bad = 0 ] && echo "all modules parse"; exit $bad
