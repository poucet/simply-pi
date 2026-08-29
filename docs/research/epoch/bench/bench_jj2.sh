#!/bin/zsh
# Bench 2 (redo): jj inside an epoch mount, done right.
# A: plain tree — jj git init in the mount (RESULT: fails; index segment write
#    uses a temp-file rename, and rename arrives at epoch with empty names on
#    this machine's macFUSE 5.3.1 + fuser 0.17 — see EPOCH.md §4.2.1).
# B: tree with a symlink (RESULT: same rename failure; symlink itself is
#    ENOSYS everywhere in the mount).
# Throwaway research harness — not production code.
set -u
export JJ_EDITOR=true
BIN=/Users/simplychris/projects/simply/epoch/target/release/epoch-fuse
B="$(cd "$(dirname "$0")" && pwd)"
cd "$B"

rm -rf lowerA mntA stateA; mkdir -p lowerA mntA stateA; echo "hello" > lowerA/a.txt
"$BIN" cas "$B/mntA" --state "$B/stateA" "$B/lowerA" > epoch-mount.log 2>&1 &
while ! head -1 mntA/a.txt >/dev/null 2>&1; do sleep 0.05; done

cd mntA
echo "=== A: jj git init in mount (expect failure at index segment rename)"
jj git init 2>&1 | head -6
echo "lane edit" > b.txt
echo "--- jj st (will walk OUT of the mount once init failed — see bench_jj.sh):"
jj st 2>&1 | grep -v '^$' | head -8
cd "$B"; umount mntA; sleep 0.5

echo "=== B: tree with a symlink"
rm -rf lowerB mntB stateB; mkdir -p lowerB mntB stateB
echo "hello" > lowerB/a.txt; ln -s a.txt lowerB/SYSTEM.md
"$BIN" cas "$B/mntB" --state "$B/stateB" "$B/lowerB" >> epoch-mount.log 2>&1 &
while ! head -1 mntB/a.txt >/dev/null 2>&1; do sleep 0.05; done
cd mntB
echo "--- cat the symlink (expect ENOSYS):"
cat SYSTEM.md 2>&1 | head -2
echo "--- jj git init with symlink in tree:"
jj git init 2>&1 | head -6
cd "$B"; umount mntB
echo done

# NOTE on running this yourself: the moment a jj command inside the mount
# cannot find .jj (init failed), jj walks up and hits whatever real repo
# encloses the scratch dir. Run the whole thing in a scratch dir OUTSIDE any
# jj repo, or accept junk commits in your own workspace (what happened to the
# researcher — recovered with `jj abandon 'main..@'`).
