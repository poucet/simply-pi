#!/bin/zsh
# Bench 2 (first attempt): does jj work inside an epoch mount?
# KEPT DESPITE ITS BUG — the bug is the finding. `jj git init --git-repo=internal`
# was the wrong flag, so no .jj was created inside the mount, and every
# subsequent jj command walked UP out of the mount and found the enclosing real
# repo (the researcher's own workspace), committing junk there. Lesson
# recorded in EPOCH.md §4.2.3: a mount without .jj fences nothing from jj —
# jj escapes to the nearest outer repo and writes are host writes.
# See bench_jj2.sh for the corrected attempt.
set -u
export JJ_EDITOR=true
BIN=/Users/simplychris/projects/simply/epoch/target/release/epoch-fuse
B="$(cd "$(dirname "$0")" && pwd)"
cd "$B"
echo "(this harness is kept as a record of the jj-escape accident; see header)"
