# epoch for simply-pi — subagent fencing and fast lane workspaces

**Status:** Research answer, 2026-08-30 · lane `epoch-research`
**Question (Chris):** how could `epoch` (`../../epoch`, i.e. `~/projects/simply/epoch`) be used in the simply-pi project — for subagent fencing, or for quicker workspace spin-up?

## Verdicts, up front

| Use | Verdict | Confidence |
|---|---|---|
| **Fencing** — spawn child agents with cwd = an epoch mount so all writes land in a per-lane overlay | **Not viable as *the* fence today; genuinely valuable as a complement** (consequence-free scratch lanes + a write-audit record no other layer gives). Blocked by two hard bugs on this machine (rename(2), symlink), no read-deny story, no landing tooling, and a silent-success failure mode that fights the workflow's loud-fail calibration. | **High** on every claim — all load-bearing findings below are measured on this machine, not inferred from docs |
| **Fast spin-up** — epoch mounts as a cheap replacement for jj workspaces | **Structurally sound, practically blocked.** Mount-to-ready is 0.25 s regardless of tree size, but lanes must *commit via jj*, and jj cannot run inside a mount on this machine today. Cannot replace jj workspaces until epoch fixes rename/symlink; could then still only replace the *tree copy*, not the landing contract. | **Medium** — the 0.25 s is measured; "regardless of tree size" is inferred from the lazy-hydration design (untested at GB scale) |

The one-sentence version: **epoch today is a beautiful recording device with a broken playback path** — everything it captures is safe, addressable, and auditable, but the two POSIX operations that real toolchains lean on (rename, symlink) are broken or missing in the macOS mount, so a lane cannot do real work inside one yet.

---

## 1. Method and environment

All measurements were made on this machine, 2026-08-30, with epoch's own binary
(`epoch/target/release/epoch-fuse`, built Aug 26 — the working copy at epoch HEAD
has an empty diff, so binary == HEAD) over a **copy** of this repo (93 files,
1.3 MB) made with `rsync -a --exclude .jj --exclude .workspaces`. The real repo and
the epoch tree were never mounted or written. macFUSE 5.3.1's kext was already
loaded (verified via `kextstat`); **nothing was installed** — mounting only needed
the existing binary and the already-enabled kext, and worked without sudo.

epoch ships **no benchmarks of its own** (checked: no `benches/`, no throughput
tests; `docs/INITIAL.md` mentions "high-throughput" roles but measures nothing).
Every number below is mine. The harnesses are preserved in `docs/research/epoch/bench/`.

Versions: fuser 0.17.0, redb 2.6.3, macFUSE 5.3.1 (kext `io.macfuse.filesystems.macfuse.25`),
jj 0.44 (the repo's), macOS 26.

## 2. What epoch is — verified against the tree

The README's description checks out, with the corrections in §6. Architecture in
brief (all verified in code):

- A FUSE overlay over a lower directory: reads fall through; writes/deletes are
  copied up into a content-addressed store (BLAKE3 + zstd; chunks 1 MiB, inline
  ≤ 64 KiB — `epoch-file-cas`). Thirteen crates, cleanly layered
  (`docs/ARCHITECTURE.md` crate map is accurate as of HEAD).
- Checkpoints are debounced (5 ms, capped at 500 ms, 64 MiB dirty backstop —
  `docs/TIMELINE.md:98-99`), sealed into a Merkle tree root, promoted to a redb
  store, and appended to an append-only event DAG with **named heads**
  (`epoch-timeline/src/store.rs:61-67`).
- `.vfs/` control plane: time travel (`.vfs/history/<millis>`, `<N>-ago`, `head`,
  `latest`, `id/<hex>`), CAS browsing (`.vfs/cas/<hash>`), and live stats
  (`.vfs/debug/{near-objects,dirty-files,overlay}` — `epoch-vfs/src/debug_dir.rs:27`).
- `.epochignore` (gitignore syntax, read once at mount) routes subtrees to a
  **writable** passthrough to the host (`epoch-fuse/src/main.rs:241` `route_ignored`,
  `PassthroughVfs::writable` at `epoch-vfs/src/passthrough.rs:89`) — reads *and*
  writes bypass the overlay entirely.
- The binary has exactly three verbs (`epoch-fuse/src/main.rs:14-20`): read-only
  probe, in-memory `cas`, and durable `cas <mnt> --state <dir> --head <name>`.
  There is **no CLI for anything else** — no export, no diff, no fork, no head
  management. `epoch-cli` is on the deferred list (`docs/TASKS.md` §4).

## 3. Measurements

Every number: method beside it. Baseline = the same operation on the plain copy
(the lower), same volume.

| Measurement | Result | Method |
|---|---|---|
| Project gate, bare copy | 23.13 / 23.13 / 23.84 s | `node extensions/subagents/tests/run.mjs` ×3, `/usr/bin/time -p`; 604 pass each |
| Project gate, inside overlay | 23.12 / 23.97 s | same, cwd = mount. **Indistinguishable from baseline** — but see the caveat below |
| Gate CPU time (either side) | ~2.9 s user + ~0.7 s sys of ~23 s wall | `/usr/bin/time` — the gate is ~85% sleeps, so it cannot see I/O overhead; read overhead was measured with `bench_io.py` instead |
| Full-file reads, 94 files (1.3 MB) | lower **1.2 ms**/round vs overlay **10.5–10.9 ms**/round — **~9×** | `bench_io.py <root> 100`, reads every file fully per round |
| stat walk (lstat every entry) | lower **0.5 ms**/round vs overlay **30.4–31.8 ms**/round — **~60×** | same harness, second phase |
| Write + fsync, 4 KiB files | lower **0.09 ms**/file vs overlay **0.65–0.85 ms**/file — **~7–9×**, sub-ms absolute | `bench_write.py <root> 200` |
| Cold mount → first successful read | **0.25 s** (with a delta to resume) | `bench_mount.sh`: background mount, poll `mount` + read AGENTS.md |
| Second concurrent mount (separate state dir) | **0.31 s**, both mounts live, independent views | `bench_mount.sh` |
| Unmount (final checkpoint + teardown) | **0.02 s** | timed `umount` |
| Second mount, **same** state dir | **fails**: `Error: DatabaseAlreadyOpen`, exit 1 | `bench_mount.sh` — confirms redb single-writer (`docs/TIMELINE.md:131`) |
| Wrong-write containment | lower byte-identical after overlay write + delete; delete = tombstone | `bench/` fencing demo: `echo > mnt/docs/ops/CHANGELOG.md`, `rm mnt/docs/ops/BOARD.md` |
| Audit surface | `.vfs/debug/overlay` listed every touched path, tombstones marked | same demo — readable by the parent from outside the mount |
| Time travel | exact-millis, `N-ago`, `latest` all resolve correctly; fall-through to lower works inside snapshots; timestamps older than the first checkpoint → ENOENT | same demo, probed each form |
| Overlay writes captured by a full gate run | **zero files** — the gate writes only to host `/tmp` | ran gate inside mount, then `cat mnt/.vfs/debug/overlay` |
| State store size | ~1.5 MB floor for a nearly-empty overlay; 6.3 MB after 2 gate runs + 2×200-file write benches | `ls -la state*/epoch.redb` |
| `jj git init` inside a mount | **fails** — "Failed to read index … No such file or directory" | `bench_jj2.sh` |
| `mv` / `os.rename` inside a mount | **fail** — "Invalid argument" / ENOENT | direct, multiple forms |
| `cat` a symlink (SYSTEM.md) inside a mount | **fails** — ENOSYS "Function not implemented", `ls -la` of the root errors too | direct; also fails when the symlink is `.epochignore`-routed |
| Hardlink (`link(2)`) | EPERM | python `os.link` |
| append, pwrite-at-offset, truncate, O_EXCL create, flock, mkdir/rmdir | all work | python probe, one op each |

Caveat on the gate number: identical-in-noise is *not* evidence of zero overhead
— the gate sleeps most of its wall clock. The honest read of the microbenchmarks:
a lane inside an epoch mount pays **~9× on file reads and ~60× on directory
walks**. For this repo (94 small files) that is 1.5 ms→10.9 ms per full-tree read
— imperceptible. It would matter for repos with 10⁴-file trees or hot build
directories (which is exactly what `.epochignore` passthrough is for — it bypasses
the overlay entirely).

## 4. Use 1 — fencing

### 4.1 What works, and works well

**Writes under the mountpoint are contained by construction.** Verified: an
overlay write to `docs/ops/CHANGELOG.md` and a delete of `docs/ops/BOARD.md`
left the lower tree byte-identical, while the mount showed both effects. No
grammar, no interpreter exemptions — a wrong write from a Python heredoc, a
`node -e`, or a stray `jj` command cannot touch the real tree *as long as its
path is under the mount*. This is the property the authority design
(`docs/design/ROLE-WRITE-AUTHORITY.md`, in the authority workspace) reaches for
at the syscall layer, obtained structurally.

**The audit record is better than denial — genuinely.** `.vfs/debug/overlay`
lists every path the child touched, tombstones marked (`debug_dir.rs:27,71-74`),
and every checkpoint is browsable (`.vfs/history/<millis>`, `N-ago`, `latest`,
`id/<hex>`). The parent can read all of it *from outside the mount*, live:
`cat mnt/.vfs/debug/overlay` while the lane runs. A deny-based fence tells you
what it blocked; an overlay fence tells you everything the child *tried*,
including writes a deny-fence would have blocked before recording them. As a
review surface this is a real upgrade.

**Reads fall through** to the whole lower tree — which matches the workflow's
reads-open default exactly (ROLE-WRITE-AUTHORITY §1).

### 4.2 What breaks it, today, on this machine

1. **rename(2) is broken in the macOS mount.** The kernel's rename arrives at
   epoch with *empty name buffers* (FUSE log: `rename parent=46 name=""
   newparent=46 newname=""` → epoch answers ENOENT; `mv` gets EINVAL). epoch's
   own adapter logs the names it was handed (`epoch-fuse/src/fuser_adapter.rs:315-326`),
   so the decode is lost between macFUSE 5.3.1 and fuser 0.17's hardcoded
   `macfuse-4-compat` protocol. Consequence, measured: **`jj git init` dies**
   writing its index segment (jj writes a `.tmp*` file then renames it into
   place); `mv` fails; any editor doing an atomic save fails. epoch's docs claim
   rename works end-to-end (`docs/TASKS.md` §2, commit `kwzmwxzttqxk`) — that was
   evidently proven on the Linux/Docker parity path, not on this macFUSE
   version. **Until this is fixed, no real toolchain runs inside a mount.**
2. **Symlinks are ENOSYS, everywhere.** `VfsService` has no symlink/readlink
   operation (deferred: `docs/TASKS.md:69`), so `cat SYSTEM.md` inside a mount
   fails, `ls -la` of the repo root errors, and routing the symlink through
   `.epochignore` does not help (passthrough inherits the same trait — measured).
   This repo has exactly two symlinks and both are load-bearing: `SYSTEM.md`
   (every lane's brief mandates reading it) and `.pi/agents` (personas). jj
   snapshot would also fail hashing a tracked symlink.
3. **The mount is not a sandbox — it fences only paths under the mountpoint.**
   Reads of `~/Documents`, writes to host `/tmp`, `cd` out of the mount: all
   ordinary host operations, unrestricted. Measured trivially: the full gate
   ran inside the mount and its overlay captured *zero* writes because the
   suite writes to `/tmp`. There is **no read-deny mechanism at all** —
   `.epochignore` passthrough is the opposite of deny (it grants host access);
   the sensitive-read list of ROLE-WRITE-AUTHORITY §4 cannot be served by
   epoch and still needs the syscall layer. Equally: a child that doesn't find
   `.jj` in the mount walks *up out of it* — my harness accidentally proved this
   by running `jj` in a mount without `.jj`, which found the enclosing real
   repo and committed junk into it (recovered; but note the fence covered
   nothing there).
4. **Landing is the make-or-break, and it does not exist.** There is no export,
   diff-apply, merge, or CLI in epoch (all deferred: `epoch-cli`, merge events
   "nothing writes a merge yet" — `docs/TIMELINE.md` §4). What exists is
   *enough raw material to build landing in this repo*: while the mount is up,
   the parent can read `.vfs/history/latest/` (the merged snapshot) and
   `.vfs/debug/overlay` (the changed-path list), so a ~50-line exporter
   (copy changed files out, honor tombstones, then review-apply) is
   straightforward — but it is ours to build, and it changes "landing" from
   *jj commit* to *export + apply*, which reshapes the whole lane lifecycle.
5. **Silent success into the void.** A wrong write *succeeds* from the child's
   perspective; it just never reaches the tree. No loud failure, no
   in-the-moment correction, no appeal — the child keeps building on a belief
   ("I fixed the bug") that is false outside its mount. Chris's calibration
   frame cuts exactly here: a deny-fence fails loud and teaches the child; an
   overlay-fence records and never teaches. Detection is *possible* (better
   than denial, §4.1) but it is a parent-side, after-the-fact activity. A fence
   built on epoch needs a compensating habit: the parent diffs every lane's
   overlay at every report.

### 4.3 Composition with jj — the semantics, spelled out

- **`.jj` overlayed (the default, no `.epochignore`):** the child's jj commits,
  bookmarks, and workspace state live only in the overlay. Trunk is safe —
  *too* safe: the child's work is unreachable without export, and (measured)
  jj cannot even initialize inside a mount today because of rename.
- **`.jj` epochignored (routed to host):** the child's `jj` reads and writes the
  **real** `.jj` through the passthrough. Bookmarks it moves are the *real*
  bookmarks — the fence does not cover `.jj`, so a lane can move `main` through
  the overlay; that hole is exactly ROLE-WRITE-AUTHORITY's PATH-shim territory,
  and the two mechanisms would compose (`jj bookmark` shim + epoch overlay).
  Working-copy files stay in the overlay while `.jj` is real: a `jj commit`
  inside the mount would snapshot overlay files into the real store — this is
  actually the natural *sanctioned landing path* (commits leave through `.jj`;
  everything else stays contained), *if* jj worked in a mount. Sharp edge: a
  workspace whose working copy lives at the mount path is registered in the
  real `.jj`; after unmount that path is empty and jj's auto-snapshot can
  record a mass deletion. That edge is manageable (forget the workspace before
  unmounting) but it is a new operational rule the workflow would have to carry.
- **Can epoch replace jj workspaces as the isolation mechanism?** No — for this
  workflow the two isolate different things: workspaces give each lane a
  *committable, mergeable, rebasable* working copy under one shared repo; an
  epoch mount gives a *contained, checkpointed, unmergeable* one. Epoch could
  wrap a workspace (mount over a workspace's working copy) but not replace it,
  because the landing contract (jj commits the integrator can rebase with
  `-s`) is the workflow's spine, and epoch has no merge story at all (§ TIMELINE
  §4).

### 4.4 Where it fits *now*

Two honest fits, neither of them "the fence":

- **Scratch/benchmark lanes.** Research lanes whose deliverable is a document
  and whose danger is a stray script writing into the tree get a mount, a
  throwaway `--state` dir, and an explicit export of anything worth keeping.
  Fence by construction, audit for free, cleanup = `umount` + `rm -rf state`.
  The rename/symlink bugs don't bite a lane that runs `python3` one-liners and
  writes Markdown — everything else here (append, write, truncate, mkdir) works.
- **An audit tier under a future strict mode.** If epoch fixes rename and
  symlink, an epoch mount is the natural "consequence-free playground" the
  authority design's strict mode lacks: writes fail *soft* (contained) rather
  than *hard* (EPERM in a cryptic place), and the overlay listing is the review
  artifact. But per ROLE-WRITE-AUTHORITY §7.1's own logic, containment is not
  authority — it changes failure semantics, it doesn't enforce the role table.

## 5. Use 2 — fast lane workspace spin-up

**The structural claim holds.** A mount is a lazy overlay: the lower tree is
never copied (reads fall through; the overlay delta starts empty), so spin-up
is mount handshake + nothing — measured **0.25 s to first successful read**,
with a delta to resume. A jj workspace by contrast materializes a full working
copy (trivial here — 93 files; the workflow's scars are about multi-GB build
caches, where the epoch advantage is structural). What I could *not* measure:
spin-up at GB scale (no big tree here — inferred from the lazy-hydration design,
`epoch-worktree`'s `DirChildren::Sealed`), and dedup across lanes — see below.

**But the README's "parallel agents can fork from a shared base" is not true of
concurrent practice today.** Verified twice — in code and on the machine:

- The store is single-writer: a second mount on the same `--state` dir dies with
  `Error: DatabaseAlreadyOpen` (`docs/TIMELINE.md:131`: "N mounts can't just
  share one `--state` dir today: redb is single-writer-per-process"). So N
  concurrent lanes = N state dirs, **zero shared dedup** — each lane's store
  holds its own copy of its captured writes.
- Forking (pointing a new head at an existing event) exists only at the library
  level (`epoch-timeline/src/store.rs:50`: "forking is
  `set_head("other", existing_id)`"). The binary can resume a head or start
  fresh — there is **no CLI verb to create a fork** (`main.rs:14-20`,
  `mount_durable:164`). The multi-mount daemon that fixes all of this (shared
  staging, one cache, `fork` as a control verb) is designed but **not built**
  — it is epoch's own next task (`docs/TIMELINE.md` §3, `docs/TASKS.md` §3.1).

A poor-man's fork exists — copy the `epoch.redb` file per lane before mounting
(each copy is a self-contained CAS + timeline; the lower supplies the base
tree for free) — but that is my inference, untested, and it forfeits dedup
anyway.

**Workspace recycling** (a real workflow pain point) maps cleanly: teardown =
`umount` (0.02 s, final checkpoint) + delete the state dir. But epoch has **no
GC** (retention GC is deferred, `docs/TASKS.md` §4), so state dirs grow
monotonically with checkpoint history — a lane that writes heavily accrues
multiple MB (measured 6.3 MB after modest bench traffic), and recycling means
deleting state, not trimming it.

**Does the subagents extension need changes?** No — confirmed in code. `spawn`
takes a `cwd` (manager.ts:660), resolved by `resolveCwd` (manager.ts:1826-1834)
as absolute-or-joined-with-parent, requiring only that the directory exists —
a mountpoint qualifies. The extension knows nothing about filesystems; the
workflow would name a mount helper in AGENTS.md the way it names `jj workspace
add` today. The brief's claim is exactly right.

**But the blocker is the same as for fencing:** a lane's work ends in a jj
commit, and jj cannot run inside a mount on this machine (rename, §4.2.1).
Until that is fixed, an epoch "lane" is a fenced editor, not a lane — the lane
would still need a real workspace (or an export step) to land anything.

## 6. Where the brief (and epoch's README) turned out wrong

1. **"Parallel agents can fork from a shared base"** (README) — true in the
   timeline *design* (events + heads), false for *concurrent* mounts today:
   single-writer redb, no daemon, no fork CLI verb. Measured: `DatabaseAlreadyOpen`.
2. **"~23 s gate"** — accurate, but ~85% of it is test-suite sleeps (CPU ≈ 3.5 s),
   so the gate cannot detect overlay I/O overhead. The brief's own plan
   ("time the gate in the overlay") would have produced a false "no overhead";
   the microbenchmarks (9× reads, 60× walks) were needed.
3. **"`.jj` would presumably be epochignored-passthrough"** — possible, but the
   default is the opposite (nothing is routed unless the lower has a
   `.epochignore`; epoch's docs merely *suggest* ignoring `.jj`). And the
   question of which side `.jj` should be on is currently academic: jj breaks
   inside a mount on this machine regardless (rename bug), and the symlink gap
   breaks working-copy snapshots on this repo regardless (SYSTEM.md).
4. **"epoch's README: rename supported end to end"** — false on this machine's
   native mount (macFUSE 5.3.1 + fuser 0.17): renames arrive with empty names
   and fail. Evidently Linux-parity tested only.
5. **"The single most valuable number is overlay overhead on real work"** — the
   valuable numbers turned out to be the *brokenness* numbers (rename/symlink)
   and the *spin-up* number (0.25 s); the gate comparison was a no-op.

## 7. Calibration ledger — Chris's fear, per use

| Question | Fencing | Spin-up |
|---|---|---|
| Friction per lane-week | Zero in-lane friction *if* the toolchain worked (reads 9×/walks 60× slower, sub-ms absolute here); today it's a wall (jj/editors broken inside mounts) | Mount 0.25 s vs workspace copy — a win at GB scale, a wash here; but landing gains a manual export step (real friction) |
| Failure mode | **Silent** — wrong writes succeed into the void; detectable only by parent-side overlay diffs. Loud only when a tool *checks* (rename → hard error) | Loud-ish: mount failure is immediate; stale-workspace auto-snapshot is the silent hazard |
| What would delete the idea | rename+symlink not fixed in epoch (both are on its deferred list, not its next task — the daemon is); or Chris judging silent-success semantics unacceptable for lanes | jj-in-mount staying broken; or landing tooling (export) judged too costly to own in this repo |

## 8. What I'd tell epoch's author (Chris wears both hats)

If the goal is to make epoch load-bearing for this workflow, the order is:
(1) fix rename on macFUSE 5.x (possibly fuser needs a fork/upgrade — their own
MOUNTING.md already flags the fuser/macFUSE coupling), (2) ship symlink support
in `VfsService` (it blocks *this* repo specifically: SYSTEM.md, .pi/agents),
(3) the daemon (it's already their next task) — that unlocks shared state,
real forking, and dedup, (4) a `diff`/`export` CLI verb so landing doesn't have
to be built by consumers. None of (1)–(4) are large by the look of the codebase;
(1) is the only one whose difficulty I can't judge from outside.

## 9. Proved / inferred / assumed

- **Proved (measured on this machine):** every number in §3; rename/symlink/
  hardlink breakage; containment + tombstones + audit listing + time travel;
  single-writer state; mount/umount timings; gate-in-overlay equivalence; jj's
  escape from a mount without `.jj`; `VfsService` gap list vs working ops.
- **Proved (read in code, cited):** fork-is-`set_head` at library level; no
  export/merge/CLI; daemon designed-not-built; `.epochignore` = writable
  passthrough, loads once; subagents `cwd` resolution semantics.
- **Inferred:** mount cost independent of tree size (lazy hydration; untested
  at GB scale); epoch as scratch-lane wrapper would work for pure-doc lanes
  (the specific op mix of such a lane is untested); the `.jj`-routed landing
  path (commits out through real `.jj`) — reasoned from the passthrough
  semantics, not exercised, because jj cannot run in a mount today.
- **Assumed:** epoch HEAD == the Aug 26 binary (working-copy diff is empty);
  the redb-copy fork trick (untested).

## 10. Where the harnesses are

`docs/research/epoch/bench/` (committed with this doc, as the record behind the
numbers): `bench_io.py`, `bench_write.py`, `bench_mount.sh`, `bench_jj.sh`
(first, buggy jj attempt — kept because its bug *is* the jj-escape finding),
`bench_jj2.sh`. They expect a copy of the repo and write state dirs beside
themselves; run them from a scratch directory, never against the real repo.
The 34 MB FUSE op log from the debug session was deleted; the rename
empty-name evidence is quoted in §4.2.
