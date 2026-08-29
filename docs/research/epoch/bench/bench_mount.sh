#!/bin/zsh
# Bench 1: mount timing + same-state-dir concurrency + concurrent separate-state mounts.
# Throwaway research harness for docs/research/epoch/EPOCH.md — not production code.
#
# Measured 2026-08-30: cold mount to first successful read 0.25s (resumed delta);
# second mount on the SAME state dir: Error: DatabaseAlreadyOpen, exit 1;
# concurrent mount with separate state: 0.31s, both live, independent views.
set -u
BIN=/Users/simplychris/projects/simply/epoch/target/release/epoch-fuse
B="$(cd "$(dirname "$0")" && pwd)"   # run from a scratch dir; state dirs land here
cd "$B"
mkdir -p mnt state1 repo-copy # repo-copy: rsync of the repo, excludes .jj/.workspaces

# --- 1. mount timing (unmount existing, remount, measure to readiness) ------
umount mnt 2>/dev/null; sleep 1
t0=$(python3 -c 'import time; print(time.time())')
"$BIN" cas "$B/mnt" --state "$B/state1" "$B/repo-copy" > epoch-mount.log 2>&1 &
MP=$!
while ! mount | grep -q " $B/mnt "; do sleep 0.05; done
# readiness: first successful read
until head -1 mnt/AGENTS.md >/dev/null 2>&1; do sleep 0.02; done
t1=$(python3 -c 'import time; print(time.time())')
python3 -c "print(f'cold mount to first successful read: {$t1-$t0:.2f}s')"

# --- 2. second mount on the SAME state dir (expect redb lock failure) -------
sleep 1
"$BIN" cas "$B/mnt2" --state "$B/state1" "$B/repo-copy" > same-state.log 2>&1
echo "same-state second mount exit: $? (log below)"
tail -3 same-state.log
mount | grep -q " $B/mnt2 " && { echo "MOUNT2 UNEXPECTEDLY UP"; umount "$B/mnt2"; }

# --- 3. concurrent mount, separate state dir -------------------------------
mkdir -p mnt2 state2
t0=$(python3 -c 'import time; print(time.time())')
"$BIN" cas "$B/mnt2" --state "$B/state2" "$B/repo-copy" >> epoch-mount.log 2>&1 &
while ! mount | grep -q " $B/mnt2 "; do sleep 0.05; done
until head -1 mnt2/AGENTS.md >/dev/null 2>&1; do sleep 0.02; done
t1=$(python3 -c 'import time; print(time.time())')
python3 -c "print(f'second concurrent mount (separate state): {$t1-$t0:.2f}s')"
echo "both mounts live:"; mount | grep -c epoch-research
umount mnt2; echo "mnt2 unmounted"
