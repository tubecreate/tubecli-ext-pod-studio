"""Scene Panorama = bảng thiết kế sản xuất vẽ MỘT lượt (khuôn Pod Studio): nhân vật + hero product, bối cảnh, dải
storyboard N cut, sơ đồ mặt bằng/máy quay, ánh sáng. Một lượt vẽ để mọi ô nhất quán — ba ảnh vẽ riêng rồi dán cạnh
nhau KHÔNG phải panorama (user 2/10/2026).

Ba việc ở đây, cho pipe «Video từ ảnh tham chiếu» (ref_video_pipeline.py) và dùng lại được từ route:
  build_board_prompt(...)   → chữ, theo đúng template panorama của autopilot/generate-panorama
  draw_board(prompt, refs, out_png, engines, …) → thử lần lượt: chatgpt (trình duyệt, có ảnh tham chiếu) → muse
                              (trình duyệt, có ảnh tham chiếu) → 9router (gpt-image-2 API, CHỈ chữ; 1024², quality low
                              vì tunnel Cloudflare cắt ở 100 s)
  split_cuts(board_png, n, layout) → ảnh từng cut (bỏ dải nhãn/chú thích để chữ không lọt vào video)
"""
from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
import time
from typing import Callable, Dict, List, Optional

logger = logging.getLogger("PodStudio.Panorama")

ENGINES = ("chatgpt", "muse", "9router")
NR_IMAGE_MODEL = "cx/gpt-image-2"

# Vùng dải storyboard trên bảng — chỉ là DỰ PHÒNG khi bộ dò ô (detect_cut_boxes) không tìm đủ ô: mỗi bảng gpt-image
# bố cục khác nhau (ô chữ chen giữa các ô ảnh, bảng #157 ngày 2/10 cắt ra toàn chữ), tỉ lệ cố định không tin được.
#   chatgpt  : board_splitter của Pod Studio (dải 0.51–0.69, chia đều cột)
#   gptimage : bảng gpt-image-2 theo prompt 3 cut (2/10/2026): dải 0.52–0.76, cột đo trên một bảng
LAYOUTS = {
    "chatgpt": {"rows": (0.51, 0.69), "cols": None},
    "gptimage": {"rows": (0.522, 0.762), "cols": [(0.014, 0.209), (0.216, 0.410), (0.438, 0.605)]},
}


def build_board_prompt(*, title: str, fmt: str, characters: List[Dict], products: List[Dict], environment: str,
                       shots: List[Dict], aspect: str = "16:9", style: str = "Photorealistic") -> str:
    """Prompt bảng theo khuôn Pod Studio (zone 1–5), N cut = số clip; mọi câu tiếng Anh (prompt AI luôn tiếng Anh)."""
    n = max(1, len(shots))
    char_lines = "\n".join(f"  - {c.get('name') or 'Character'}: {(c.get('appearance') or c.get('description') or '')[:700]}"
                           for c in characters[:3]) or "  (none)"
    prod_lines = "\n".join(f"  - {p.get('name') or 'Product'}: {(p.get('appearance') or p.get('description') or '')[:300]}"
                           for p in products[:2])
    cut_lines = "\n".join(f"  Cut {i+1} ({(s.get('camera') or 'shot').upper()}): {s.get('scene') or s.get('action') or ''}"
                          for i, s in enumerate(shots))
    kind = {"ad": "fashion / product ad", "short": "short-form social video", "drama": "short drama"}.get(fmt, "video")
    return (
        f'Create a professional cinematic PRODUCTION DESIGN BOARD for the {kind} "{title}" — a single comprehensive '
        "reference sheet image with ALL zones on a dark navy background (#0a1628) with subtle grid lines and cyan/teal "
        "accent borders.\n"
        f"IMAGE ASPECT RATIO: {aspect} (LANDSCAPE / HORIZONTAL). Arrange zones in a structured HORIZONTAL GRID:\n"
        "  TOP ROW: Zone 1 (left ~40%) + Zone 2 (right ~60%)\n  MIDDLE ROW: Zone 3 (full width)\n"
        "  BOTTOM ROW: Zone 5 (left ~60%) + Zone 4 (right ~40%)\n\n"
        "ZONE 1 — CHARACTER + HERO OBJECT REFERENCE\nTitle label: \"1. CHARACTER + HERO OBJECT REFERENCE\"\n"
        "Show the main character(s) from 4 angles in a HORIZONTAL STRIP: FRONT | SIDE | BACK | FACE CLOSE-UP.\n"
        f"Character details (identical in EVERY zone — use the attached reference images when given):\n{char_lines}\n"
        + (f"HERO PRODUCT (clean product shots):\n{prod_lines}\n" if prod_lines else "")
        + "Below: SHARED PALETTE (4-5 color swatches) + REFERENCE NOTES.\n\n"
        "ZONE 2 — ENVIRONMENT / SET DESIGN\nTitle label: \"2. ENVIRONMENT / SET DESIGN\"\n"
        f"MAIN ENVIRONMENT STILL: {environment}\n3 SUPPLEMENTARY VIEWS: wide angle, detail/texture, character-in-environment.\n\n"
        "ZONE 3 — STORYBOARD\nTitle label: \"3. STORYBOARD\"\n"
        f"{n} sequential cinematic CUTS arranged horizontally (Cut 1 … Cut {n}), each a portrait 9:16 frame of the SAME "
        f"character(s) in the SAME outfit:\n{cut_lines}\n\n"
        "ZONE 4 — FLOOR PLAN + CAMERA PLAN (TOP-DOWN)\nA TOP-DOWN plan of the location: walls, windows, furniture as simple "
        f"shapes; camera positions as numbered icons (Cut 1 … Cut {n}) with angle arrows and dotted movement paths; the "
        "character(s) marked with figure icons.\n\n"
        "ZONE 5 — LIGHTING / MOOD / STYLE NOTES\nTitle label: \"4. LIGHTING / MOOD / STYLE NOTES\"\n"
        f"Lighting refs + MOOD for: {environment}\n\n"
        f"VISUAL STYLE: dark navy bg (#0a1628), white text labels, cyan accents. {style} for every still. "
        "8K ultra-detailed, no watermarks."
    )


# ── vẽ ────────────────────────────────────────────────────────────────────────

def _draw_chatgpt(prompt: str, refs: List[str], out_png: str, profile: str, ext_dir: str, say: Callable) -> bool:
    """Engine ChatGPT trình duyệt của Pod Studio (engines/chatgpt_image.js) — nhận ảnh tham chiếu."""
    if not profile:
        return False
    import sys
    eng = os.path.join(ext_dir, "engines")
    if eng not in sys.path:
        sys.path.insert(0, eng)
    from chatgpt_image_engine import batch_generate
    say(f"ChatGPT (browser profile {profile}) is drawing the board with {len(refs)} reference image(s)…")
    results = asyncio.run(batch_generate(shots=[{"id": "board", "image_prompt": prompt, "ref_images": refs}],
                                         profile_name=profile, episode_id=0, headless=False, overwrite=True))
    for r in results or []:
        if r.get("status") == "success" and r.get("path") and os.path.isfile(r["path"]):
            if r["path"] != out_png:
                import shutil
                shutil.copyfile(r["path"], out_png)
            return True
    return False


def _draw_muse(prompt: str, refs: List[str], out_png: str, say: Callable) -> bool:
    from tubecli.core import muse
    if not muse.settings()["profile"]:
        return False
    say("Muse is drawing the board with the reference images…")
    data = muse.generate_image_bytes(prompt + "\nUse the attached photos as the exact reference for the character(s) and "
                                     "the product.", "16:9", refs[:3], timeout=400)
    with open(out_png, "wb") as f:
        f.write(data)
    return True


def _draw_9router(prompt: str, out_png: str, say: Callable, attempts: int = 2) -> bool:
    """gpt-image-2 qua 9Router: KHÔNG nhận ảnh tham chiếu (/images/edits 500), 1024² + quality low để về kịp 100 s
    của tunnel Cloudflare (1536×1024 LUÔN 524; 1024² về ~1/2 lượt)."""
    import requests
    from tubecli.core import ninerouter as nr
    for i in range(attempts):
        say(f"gpt-image-2 (9Router API, text only) attempt {i+1}/{attempts}…")
        try:
            r = requests.post(nr.base_url() + "/images/generations",
                              headers={**nr.auth_headers(), "Content-Type": "application/json"},
                              json={"model": NR_IMAGE_MODEL, "prompt": prompt, "n": 1, "size": "1024x1024", "quality": "low"},
                              timeout=420)
        except Exception as e:      # noqa: BLE001
            logger.warning("9router board: %s", e)
            continue
        if r.status_code != 200:
            logger.warning("9router board: HTTP %s", r.status_code)
            continue
        try:
            with open(out_png, "wb") as f:
                f.write(base64.b64decode(r.json()["data"][0]["b64_json"]))
            return True
        except Exception as e:      # noqa: BLE001
            logger.warning("9router board: bad body %s", e)
    return False


def draw_board(prompt: str, refs: List[str], out_png: str, *, engines: List[str], chatgpt_profile: str = "",
               ext_dir: str = "", say: Callable = lambda m: None) -> Dict:
    """Thử từng engine theo thứ tự; {ok, engine, path, layout, tried: [...]}."""
    tried = []
    for eng in engines or ENGINES:
        if eng not in ENGINES:
            continue
        t0 = time.time()
        try:
            if eng == "chatgpt":
                done = _draw_chatgpt(prompt, refs, out_png, chatgpt_profile, ext_dir, say)
            elif eng == "muse":
                done = _draw_muse(prompt, refs, out_png, say)
            else:
                done = _draw_9router(prompt, out_png, say)
        except Exception as e:      # noqa: BLE001
            logger.warning("board engine %s failed: %s", eng, e)
            tried.append(f"{eng}: {str(e)[:120]}")
            continue
        if done and os.path.isfile(out_png) and os.path.getsize(out_png) > 5000:
            return {"ok": True, "engine": eng, "path": out_png, "layout": "chatgpt" if eng == "chatgpt" else "gptimage",
                    "seconds": round(time.time() - t0, 1), "tried": tried}
        tried.append(f"{eng}: no image")
    return {"ok": False, "tried": tried}


# ── cắt ───────────────────────────────────────────────────────────────────────

def _runs(mask, min_len: int, gap: int = 0) -> List[tuple]:
    """Các đoạn True liên tiếp trong mask 1 chiều (gộp khe ≤ gap), dài ≥ min_len → [(start, end)]."""
    out: List[tuple] = []
    start = None
    for i, v in enumerate(list(mask) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if out and start - out[-1][1] <= gap:
                out[-1] = (out[-1][0], i)
            else:
                out.append((start, i))
            start = None
    return [(s, e) for s, e in out if e - s >= min_len]


def detect_cut_boxes(im, n: int, rows_hint=(0.40, 0.88)) -> Optional[List[tuple]]:
    """Tìm n ô ảnh của dải storyboard trên bảng: nền = màu phổ biến nhất (navy); điểm "khác nền" = lệch màu hoặc có
    kết cấu (gradient). Dải = cụm hàng dày điểm khác nền nhất trong cửa sổ rows_hint; ô ảnh = cụm cột dày (ô chữ trắng
    trên navy thì thưa → bị loại; sơ đồ mặt bằng hẹp hơn → bỏ khi dư). Đo đúng trên 3 bảng thật 2/10/2026.
    Trả [(x0, y0, x1, y1)] theo thứ tự trái→phải, hoặc None khi không tìm đủ n ô (gọi nơi dùng lùi về LAYOUTS)."""
    try:
        import numpy as np
    except ImportError:
        return None
    a = np.asarray(im.convert("RGB"), dtype=np.int16)
    H, W = a.shape[:2]
    q = (a // 16).reshape(-1, 3)
    keys = q[:, 0] * 256 + q[:, 1] * 16 + q[:, 2]
    vals, counts = np.unique(keys, return_counts=True)
    k = int(vals[counts.argmax()])
    bg = np.array([k // 256, (k // 16) % 16, k % 16]) * 16 + 8
    gray = a.mean(axis=2)
    gx = np.abs(np.diff(gray, axis=1, prepend=gray[:, :1]))
    gy = np.abs(np.diff(gray, axis=0, prepend=gray[:1]))
    fg = (np.abs(a - bg).sum(axis=2) > 45) | ((gx + gy) > 24)
    y_lo, y_hi = int(H * rows_hint[0]), int(H * rows_hint[1])
    rruns = _runs(fg[y_lo:y_hi].mean(axis=1) > 0.42, min_len=int(H * 0.07), gap=int(H * 0.004))
    if not rruns:
        return None
    y0, y1 = max(rruns, key=lambda r: r[1] - r[0])
    y0, y1 = y0 + y_lo, y1 + y_lo
    # Ngưỡng cột THẤP (0,35): cảnh tối xanh đen (#159) chỉ ~0,45–0,6 "khác nền", ngang ô chữ có thumbnail; thứ phân biệt
    # là KHE giữa các ô (≤0,16) và bề rộng — ô chữ lọt vào sẽ bị luật «n ô rộng nhất» loại. Đo trên 4 bảng thật 2/10/2026.
    cruns = _runs(fg[y0:y1].mean(axis=0) > 0.35, min_len=int(W * 0.05), gap=int(W * 0.004))
    if len(cruns) < n:
        return None
    if len(cruns) > n:                      # dư ô (ô chữ, sơ đồ, ảnh phụ) → giữ n ô rộng nhất, xếp lại trái→phải
        cruns = sorted(sorted(cruns, key=lambda r: r[0] - r[1])[:n])
    return [(x0 + 2, y0 + 2, x1 - 2, y1 - 2) for x0, x1 in cruns]


def split_cuts(board_png: str, n: int, layout: str, out_dir: str) -> List[str]:
    """Ảnh từng cut của dải storyboard: dò ô ảnh trên bảng thật; không dò được thì cắt theo LAYOUTS (chia đều khi
    không vừa khuôn). Luôn trả ≤ n đường dẫn (có thể rỗng)."""
    from PIL import Image
    try:
        im = Image.open(board_png).convert("RGB")
    except Exception as e:      # noqa: BLE001
        logger.warning("split_cuts: %s", e)
        return []
    W, H = im.size
    boxes = None
    try:
        boxes = detect_cut_boxes(im, n)
    except Exception as e:      # noqa: BLE001
        logger.warning("detect_cut_boxes: %s", e)
    if not boxes:
        lay = LAYOUTS.get(layout) or LAYOUTS["chatgpt"]
        y0, y1 = int(H * lay["rows"][0]), int(H * lay["rows"][1])
        cols = lay["cols"] if lay["cols"] and len(lay["cols"]) >= n else [(i / n, (i + 1) / n) for i in range(n)]
        boxes = [(int(W * cols[i][0]) + 2, y0, int(W * cols[i][1]) - 2, y1) for i in range(n)]
        logger.info("split_cuts: no boxes detected, using the %s layout", layout)
    os.makedirs(out_dir, exist_ok=True)
    out = []
    for i, box in enumerate(boxes[:n]):
        p = os.path.join(out_dir, f"cut_{i+1:02d}.jpg")
        im.crop(box).save(p, quality=94)
        out.append(p)
    return out
