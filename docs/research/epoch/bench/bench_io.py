"""Read-overhead microbench for the epoch FUSE overlay.

Usage: python3 bench_io.py <root> [rounds]
Walks the tree, reads every file fully, stats every entry — repeated `rounds`
times. Prints wall seconds per phase. Run against the lower dir and the mount
and compare.

(Measured 2026-08-30 against a copy of this repo, 94 files / 1.3 MB, 100
rounds: reads 1.2 ms/round lower vs 10.5–10.9 ms/round overlay (~9x);
stat walks 0.5 ms vs 30.4–31.8 ms (~60x). Symlinks are skipped — readlink is
ENOSYS in the mount, which is itself a recorded finding.)
"""
import os, sys, time

root = sys.argv[1]
rounds = int(sys.argv[2]) if len(sys.argv) > 2 else 20

# collect file list once (from the same root both times)
files = []
for dirpath, dirnames, filenames in os.walk(root):
    if "/.vfs" in dirpath or dirpath.endswith("/.vfs"):
        continue
    for f in filenames:
        p = os.path.join(dirpath, f)
        if not os.path.islink(p):  # epoch mount: readlink is ENOSYS
            files.append(p)

t_read = t_stat = 0.0
for r in range(rounds):
    t0 = time.perf_counter()
    for p in files:
        with open(p, "rb") as fh:
            while fh.read(1 << 20):
                pass
    t_read += time.perf_counter() - t0
    t0 = time.perf_counter()
    for dirpath, dirnames, filenames in os.walk(root):
        if "/.vfs" in dirpath or dirpath.endswith("/.vfs"):
            continue
        for name in dirnames + filenames:
            p = os.path.join(dirpath, name)
            if not os.path.islink(p):  # epoch mount: stat of a symlink needs readlink (ENOSYS)
                os.stat(p)
    t_stat += time.perf_counter() - t0

print(f"files={len(files)} rounds={rounds}")
print(f"read:  {t_read:.3f}s total ({t_read/rounds*1000:.1f} ms/round)")
print(f"stat:  {t_stat:.3f}s total ({t_stat/rounds*1000:.1f} ms/round)")
