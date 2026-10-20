"""把 jf open 粉圓 裁成「只含本 App 介面文字＋隊名」的小字型 → vendor/round-ui/wc-round.woff2

    python _tools/build_round_font.py <jf-openhuninn-2.1.ttf 的路徑>
    （需要 fonttools＋brotli：pip install fonttools brotli）

2026-10-20 首頁視覺改版「開賽日球場」建立，做法照 605 的 _tools/build_round_font.py。
- 來源：https://github.com/justfont/open-huninn-font  v2.1（SIL OFL-1.1，全文在 vendor/round-ui/LICENSE.txt）。
  原始 TTF 4.9MB 不進版控。**改介面文字或 世界盃資料.js 隊名後要重跑**（缺的字會退回系統字，不會變豆腐，但字型會混）。
- 收字範圍：index.html 全部文字＋世界盃資料.js 全部文字（隊名、場館、四強焦點）＋可列印 ASCII。
  只用在標題、App 名、按鈕、分頁、卡片標題；說明、表格、長文字仍用系統字。
- ⚠ OFL 保留字型名稱：「open huninn」「huninn」與「Varela」「Varela Round」。裁子集＝修改版，
  字型內部名稱改成「WC Round」，版權（nameID 0）與授權（13、14）原樣保留；CSS 用 font-family WCRound。
"""
import re
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "vendor" / "round-ui" / "wc-round.woff2"
FAMILY = "WC Round"
PS = "WCRound-Regular"
RESERVED = re.compile(r"huninn|varela", re.I)
NAME_FIELDS = {1, 3, 4, 6, 16, 17, 18, 20, 21, 22}


def wanted(ch: str) -> bool:
    cp = ord(ch)
    return (0x3000 <= cp <= 0x303F or 0x3400 <= cp <= 0x9FFF or 0xFF00 <= cp <= 0xFFEF
            or 0x2010 <= cp <= 0x2027 or ch in "·×→←↑↓…｜")


def chars_needed() -> str:
    keep = {chr(c) for c in range(0x20, 0x7F)}
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    data = (ROOT / "世界盃資料.js").read_text(encoding="utf-8")
    if "TEAMS" not in data:
        print("[FAIL] 世界盃資料.js 找不到 TEAMS，格式可能變了"); sys.exit(1)
    keep |= {ch for ch in html + data if wanted(ch)}
    return "".join(sorted(keep))


def main() -> None:
    if len(sys.argv) != 2:
        print(__doc__); sys.exit(2)
    text = chars_needed()
    font = TTFont(sys.argv[1])
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    sub = subset.Subsetter(options=opts)
    sub.populate(text=text)
    sub.subset(font)
    name = font["name"]
    for rec in list(name.names):
        if rec.nameID in (1, 16, 21):
            rec.string = FAMILY
        elif rec.nameID in (2, 17, 22):
            rec.string = "Regular"
        elif rec.nameID == 4:
            rec.string = FAMILY + " Regular"
        elif rec.nameID == 6:
            rec.string = PS
        elif rec.nameID == 3:
            rec.string = PS + ";subset-800"
    left = [(r.nameID, r.toUnicode()) for r in name.names
            if r.nameID in NAME_FIELDS and RESERVED.search(r.toUnicode())]
    if left:
        print("[FAIL] name 表仍含保留字型名稱：", left[:5]); sys.exit(1)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    font.flavor = "woff2"
    font.save(OUT)
    cjk = sum(1 for c in text if ord(c) > 0x7F)
    print(f"[OK] {OUT.relative_to(ROOT)}：{OUT.stat().st_size / 1024:.0f} KB，收 {cjk} 個非 ASCII 字＋ASCII")


if __name__ == "__main__":
    main()
