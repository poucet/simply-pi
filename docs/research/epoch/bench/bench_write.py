"""Write-overhead microbench for the epoch FUSE overlay.

Usage: python3 bench_write.py <root> [n]
Writes n files (4 KiB each) into <root>/_bench_tmp/, closing each (which arms
the 5ms-debounced checkpoint). Reports wall seconds for the write loop and for
a settle wait (checkpoint max-wait cap is 500ms). Cleans up afterward (rm -rf
on the lower; on the mount the delete is captured as a tombstone).

(Measured 2026-08-30, n=200: lower 0.09 ms/file vs overlay 0.65–0.85 ms/file
(~7–9x, sub-ms absolute).)
"""
import os, shutil, sys, time

root = sys.argv[1]
n = int(sys.argv[2]) if len(sys.argv) > 2 else 200
target = os.path.join(root, "_bench_tmp")
shutil.rmtree(target, ignore_errors=True)
os.makedirs(target, exist_ok=True)
payload = b"x" * 4096

t0 = time.perf_counter()
for i in range(n):
    with open(os.path.join(target, f"f{i:04}.txt"), "wb") as fh:
        fh.write(payload)
        fh.flush()
        os.fsync(fh.fileno())
t_write = time.perf_counter() - t0

t0 = time.perf_counter()
time.sleep(0.7)  # let the debounced checkpoint (5ms debounce, 500ms cap) land
t_settle = time.perf_counter() - t0

shutil.rmtree(target, ignore_errors=True)
print(f"n={n} write+fsync: {t_write:.3f}s ({t_write/n*1000:.2f} ms/file), settle 0.7s")
