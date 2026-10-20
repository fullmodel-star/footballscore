"""下載 Microsoft Fluent Emoji 的 3D 圖（MIT），縮成 128px PNG → vendor/fluent-3d/<key>.png

    python _tools/build_fluent3d.py
    （需要 Pillow：pip install pillow）

2026-10-20 首頁視覺改版「開賽日球場」建立，做法照 605 的 _tools/build_fluent3d.py：
首屏主視覺（獎盃＋足球）、首頁四格入口、首頁卡片標題、推估冠軍橫幅用 3D 立體圖。
- 來源：https://github.com/microsoft/fluentui-emoji （MIT，全文寫到 vendor/fluent-3d/LICENSE.txt）。
- 顯示最大 96px（主視覺獎盃），存 128px／主視覺 192px 給高解析螢幕。
- 下載後檢查是 PNG 檔頭（不是錯誤頁），不合格就停。
- 新增圖＝加進 ICONS 後重跑，並把檔名加進 sw.js 的 ASSETS。
"""
import io
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "vendor" / "fluent-3d"
BASE = "https://raw.githubusercontent.com/microsoft/fluentui-emoji/main"

# key → (Fluent 資料夾名（大小寫要完全一樣）, 輸出邊長)
ICONS = {
    "trophy": ("Trophy", 192),          # 主視覺、推估冠軍
    "ball": ("Soccer ball", 128),       # 主視覺
    "fire": ("Fire", 128),              # 四強焦點
    "calendar": ("Spiral calendar", 128),  # 近期賽事
    "dividers": ("Card index dividers", 128),  # 對陣圖
    "check": ("Check mark button", 128),   # 賽果記錄進度
}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for key, (folder, size) in ICONS.items():
        fname = folder.lower().replace(" ", "_") + "_3d.png"
        url = f"{BASE}/assets/{urllib.parse.quote(folder)}/3D/{urllib.parse.quote(fname)}"
        raw = fetch(url)
        if not raw.startswith(b"\x89PNG"):
            print(f"[FAIL] {key}：{url} 不是 PNG"); sys.exit(1)
        im = Image.open(io.BytesIO(raw)).convert("RGBA")
        im = im.resize((size, size), Image.LANCZOS)
        dst = OUT / f"{key}.png"
        im.save(dst, optimize=True)
        print(f"OK {key:10s} {dst.stat().st_size // 1024} KB  ← {folder}")
    (OUT / "LICENSE.txt").write_bytes(fetch(f"{BASE}/LICENSE"))
    print("OK LICENSE.txt")


if __name__ == "__main__":
    main()
