#!/usr/bin/env python3
"""Comment inventory for web-lair (repo-external tooling).

Counts, per file, the comment lines that Phase A / Phase B must handle:
  markers  - plan/ledger/review markers inside comments
  cjk      - Chinese comment lines (UI quotes are whitelisted)
  blocks   - lines inside comment blocks >= 15 lines

Usage:
  python scan.py --repo <repo> [--out baseline.json]

Only reads; writes the JSON report to --out.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter

# Files that must never be scanned (false-positive sources).
EXCLUDE_FILES = {
    "pnpm-lock.yaml",  # integrity hashes contain C1-style tokens
    # CommonMark/GFM conformance fixtures: spec: '§1' is an external standard id
    "src/lib/components/markdown/testing/conformance-cases.ts",
}
EXCLUDE_DIRS = ("storybook-static/", "node_modules/", ".svelte-kit/", "build/")

COMMENT_TOKENS = ("//", "/*", "*", "<!--", "#", "--")

MARKER_RE = re.compile(
    r"(?<!\w)(ledger|台账|plan|design doc|spec)\s*§"
    r"|§\s?\d"
    r"|(?<!\w)(M|P|R|W|J|Q|T|C)[\s-]?\d+(?:\.\d+)*\b"
    r"|ST-\d|UX-\d{2,}|三审|二审|review round|批\s?\d|批次|洞[①②③④⑤]"
)

# References that stay legal (standards doc 6.4 whitelist).
ALLOW_RE = re.compile(
    r"\bRFC\b|WCAG|CommonMark|\bGFM\b|WHATWG|ISO/IEC|"
    r"\bRUNBOOK\b|\bSECRETS\b|\bEDGE\b|README|CONTRIBUTING",
    re.I,
)
# Tokens that are never legal, even next to a standard reference.
BAD_RE = re.compile(
    r"(?<!\w)(ledger|台账|plan|design doc)\s*§|三审|二审|review round|批次|批\s?\d|洞[①②③④⑤]"
)

CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def tracked_files(repo: str) -> list[str]:
    out = subprocess.run(
        ["git", "-C", repo, "ls-files", "-z"], capture_output=True, check=True
    ).stdout.decode("utf-8", "replace")
    return [f for f in out.split("\0") if f]


def is_comment_prefix(line: str) -> str | None:
    s = line.lstrip()
    for tok in COMMENT_TOKENS:
        if s.startswith(tok):
            return tok
    m = re.search(r"//", line)
    # `://` is a URL; `'//`, `"//`, `` `// `` start inside a string literal
    if m and (m.start() == 0 or line[m.start() - 1] not in (":", "'", '"', "`")):
        return "//"
    m = re.search(r"<!--", line)
    if m:
        return "<!--"
    return None


def comment_text(line: str) -> str | None:
    tok = is_comment_prefix(line)
    if tok is None:
        return None
    idx = line.find(tok)
    return line[idx + len(tok) :]


# Quoted spans whose Chinese content is UI copy / route / language names and
# stays per comment-standards §"是 UI 文案、路由名或语言名？→ 保留中文".
_QUOTE_SPANS = (
    re.compile(r'"[^"]*"'),
    re.compile(r"'[^']*'"),
    re.compile(r"`[^`]*`"),
    re.compile(r"「[^」]*」"),
    re.compile(r"（[^）]*）"),
    re.compile(r"\([^()]*\)"),
)


def strip_quoted(text: str) -> str:
    """Remove quoted/bracketed spans so only unquoted Chinese remains."""
    for pat in _QUOTE_SPANS:
        text = pat.sub(" ", text)
    return text


def block_runs(lines: list[str], min_len: int = 15) -> set[int]:
    """Line numbers (1-based) that sit inside a comment run >= min_len."""
    runs: set[int] = set()
    cur: list[int] = []
    for i, line in enumerate(lines, 1):
        if line.strip() and is_comment_prefix(line):
            cur.append(i)
        else:
            if len(cur) >= min_len:
                runs.update(cur)
            cur = []
    if len(cur) >= min_len:
        runs.update(cur)
    return runs


def comment_runs(lines: list[str]) -> list[tuple[int, int]]:
    """Contiguous comment-line runs as (start, end) 1-based inclusive."""
    runs: list[tuple[int, int]] = []
    cur: list[int] | None = None
    for i, line in enumerate(lines, 1):
        if line.strip() and is_comment_prefix(line):
            if cur is None:
                cur = [i, i]
            else:
                cur[1] = i
        elif cur is not None:
            runs.append((cur[0], cur[1]))
            cur = None
    if cur is not None:
        runs.append((cur[0], cur[1]))
    return runs


def classify_runs(lines: list[str]) -> tuple[list[int], list[int]]:
    """Marker lines and CJK lines, whitelisting per comment run.

    Decision per marker match:
      - plan/ledger/review tokens (`plan §`, 三审, 批次, ...) always flag;
      - a `§N` reference is legal when its own line names a standard or an
        in-repo doc (RFC 9309 §2.2.1), or when the whole comment run names one
        (RFC 9309 spans several comment lines, only the first says "RFC");
      - plan/ledger tokens in the run void the run-level `§` allowance.
    """
    markers: list[int] = []
    cjk: list[int] = []
    for start, end in comment_runs(lines):
        run_lines = lines[start - 1 : end]
        run_text = "\n".join(run_lines)
        run_bad = bool(BAD_RE.search(run_text))
        run_allow = bool(ALLOW_RE.search(run_text))
        for offset, line in enumerate(run_lines):
            i = start + offset
            ct = comment_text(line)
            if ct is None:
                continue
            if CJK_RE.search(ct) and CJK_RE.search(strip_quoted(ct)):
                cjk.append(i)
            flagged = False
            for m in MARKER_RE.finditer(ct):
                g = m.group(0)
                if BAD_RE.search(g):
                    flagged = True
                    break
                if "§" in g:
                    # RFC 9309 §2.2.1 / README §4 stay; plan § never does.
                    if ALLOW_RE.search(ct) or (run_allow and not run_bad):
                        continue
                    flagged = True
                    break
                flagged = True  # M6 / W7.4 / Q19 / 三审 ... never legal
                break
            if flagged:
                markers.append(i)
    return markers, cjk


def scan(repo: str) -> dict[str, dict]:
    result: dict[str, dict] = {}
    for rel in tracked_files(repo):
        if not rel.endswith((".ts", ".js", ".svelte", ".sh", ".yaml", ".yml")):
            continue
        if rel in EXCLUDE_FILES or any(rel.startswith(p) for p in EXCLUDE_DIRS):
            continue
        path = os.path.join(repo, rel)
        try:
            text = open(path, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        lines = text.splitlines()
        markers, cjk = classify_runs(lines)
        blocks = block_runs(lines)
        if markers or cjk or blocks:
            result[rel] = {
                "lines": len(lines),
                "markers": markers,
                "cjk": cjk,
                "blocks": sorted(blocks),
            }
    return result


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--paths", nargs="*", default=None,
                    help="restrict to files under these prefixes; exit 1 if any marker remains")
    ap.add_argument("--ci", action="store_true",
                    help="CI gate: exit 1 unless markers=0, cjk=0 and "
                         "block_lines<=300 (comment-standards baseline)")
    args = ap.parse_args()

    data = scan(args.repo)
    if args.paths is not None:
        prefixes = tuple(args.paths)
        scoped = {k: v for k, v in data.items() if k.startswith(prefixes)}
        remaining = 0
        for rel in sorted(scoped):
            for ln in scoped[rel]["markers"]:
                remaining += 1
                print(f"{rel}:{ln}")
        print(f"-- {len(scoped)} file(s) in scope, {remaining} marker line(s) remain")
        return 1 if remaining else 0

    counts = Counter()
    for v in data.values():
        counts["files"] += 1
        counts["markers"] += len(v["markers"])
        counts["cjk"] += len(v["cjk"])
        counts["block_lines"] += len(v["blocks"])
        counts["block_files"] += 1 if v["blocks"] else 0
    print(f"files={counts['files']} markers={counts['markers']} "
          f"cjk={counts['cjk']} block_lines={counts['block_lines']} "
          f"block_files={counts['block_files']}")
    top = sorted(data.items(), key=lambda kv: -(len(kv[1]["markers"]) + len(kv[1]["cjk"])))[:25]
    for rel, v in top:
        print(f"  m{len(v['markers']):3d} cjk{len(v['cjk']):3d} blk{len(v['blocks']):4d}  {rel}")
    if args.out:
        with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
        print(f"wrote {args.out}")
    if args.ci:
        ok = (counts["markers"] == 0 and counts["cjk"] == 0
              and counts["block_lines"] <= 300)
        print(f"ci comment gate: {'PASS' if ok else 'FAIL'} "
              f"(markers={counts['markers']}, cjk={counts['cjk']}, "
              f"block_lines={counts['block_lines']} / max 300)")
        return 0 if ok else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
