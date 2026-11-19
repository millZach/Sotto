#!/usr/bin/env bash
# step.sh : reads step code on stdin, prepends lib.cjs, runs it in Sotto's main process through ev.sh.
here=$(cd "$(dirname "$0")" && pwd)
{ cat "$here/lib.cjs"; cat; } | "$here/ev.sh" -
