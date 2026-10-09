#!/usr/bin/env python3
"""Generate banner.svg at the repo root (deterministic, stdlib only).

    python scripts/make_banner.py          write banner.svg
    python scripts/make_banner.py --check  exit 1 if the committed file differs
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "banner.svg"

BG, CARD, INK, MUTED = "#1b2733", "#243445", "#f2f5f8", "#9fb0c0"
ACCENT, OK = "#4fb3a6", "#8bd17c"
FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

CREW = ["explorer", "builder", "reviewer", "finalizer"]
LEDGER = ["scope agreed", "change built", "review passed", "checks green"]


def build_svg() -> str:
    o = []
    a = o.append
    a('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 300" width="1100" height="300" '
      'role="img" aria-labelledby="t d">')
    a('<title id="t">pi-foreman</title>')
    a('<desc id="d">A foreman node connected to explorer, builder, reviewer and finalizer nodes, '
      'next to a checklist with ticks.</desc>')
    a(f'<rect width="1100" height="300" rx="16" fill="{BG}"/>')
    a(f'<text x="48" y="130" font-family="{FONT}" font-size="64" font-weight="700" fill="{INK}">'
      f'pi-<tspan fill="{ACCENT}">foreman</tspan></text>')
    a(f'<text x="50" y="176" font-family="{FONT}" font-size="19" fill="{MUTED}">'
      'one foreman, a crew of focused agents,</text>')
    a(f'<text x="50" y="203" font-family="{FONT}" font-size="19" fill="{MUTED}">'
      'a checklist before done</text>')
    # flow diagram: foreman node, lines fanning out to the crew column
    fx, fw, fh, fcy = 440, 110, 44, 150
    nx, nw, nh = 620, 120, 40
    cys = [48 + i * 68 for i in range(len(CREW))]
    for cy in cys:
        a(f'<line x1="{fx + fw}" y1="{fcy}" x2="{nx}" y2="{cy}" stroke="{MUTED}" '
          f'stroke-width="2" stroke-linecap="round"/>')
    a(f'<rect x="{fx}" y="{fcy - fh // 2}" width="{fw}" height="{fh}" rx="10" fill="{ACCENT}"/>')
    a(f'<text x="{fx + fw // 2}" y="{fcy + 6}" text-anchor="middle" font-family="{FONT}" '
      f'font-size="18" font-weight="700" fill="{BG}">foreman</text>')
    for name, cy in zip(CREW, cys):
        a(f'<rect x="{nx}" y="{cy - nh // 2}" width="{nw}" height="{nh}" rx="10" fill="{BG}" '
          f'stroke="{ACCENT}" stroke-width="2"/>')
        a(f'<text x="{nx + nw // 2}" y="{cy + 6}" text-anchor="middle" font-family="{FONT}" '
          f'font-size="16" fill="{INK}">{name}</text>')
    # ledger checklist card
    lx, ly, lw, lh = 800, 36, 252, 228
    a(f'<rect x="{lx}" y="{ly}" width="{lw}" height="{lh}" rx="14" fill="{CARD}" '
      f'stroke="{MUTED}" stroke-opacity="0.35"/>')
    a(f'<text x="{lx + 24}" y="{ly + 40}" font-family="{MONO}" font-size="16" '
      f'letter-spacing="1" fill="{MUTED}">LEDGER</text>')
    for i, item in enumerate(LEDGER):
        y = ly + 82 + i * 38
        a(f'<rect x="{lx + 24}" y="{y - 17}" width="24" height="24" rx="6" fill="none" '
          f'stroke="{OK}" stroke-width="2"/>')
        a(f'<path d="M{lx + 30} {y - 5} l5 5 l9 -11" fill="none" stroke="{OK}" stroke-width="3" '
          f'stroke-linecap="round" stroke-linejoin="round"/>')
        a(f'<text x="{lx + 62}" y="{y + 1}" font-family="{FONT}" font-size="18" fill="{INK}">{item}</text>')
    a('</svg>')
    return "\n".join(o) + "\n"


def main(argv) -> int:
    svg = build_svg().encode("utf-8")
    if "--check" in argv:
        if OUT.exists() and OUT.read_bytes() == svg:
            return 0
        print("banner.svg is stale; run: python scripts/make_banner.py", file=sys.stderr)
        return 1
    OUT.write_bytes(svg)
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
