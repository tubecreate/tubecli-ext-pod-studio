"""Scene Panorama = bảng thiết kế sản xuất vẽ MỘT lượt (khuôn Pod Studio): nhân vật + hero product, bối cảnh, dải
storyboard N cut, sơ đồ mặt bằng/máy quay, ánh sáng. Một lượt vẽ để mọi ô nhất quán — ba ảnh vẽ riêng rồi dán cạnh
nhau KHÔNG phải panorama (user 2/10/2026).

Hai việc ở đây, cho pipe «Video từ ảnh tham chiếu» (ref_video_pipeline.py) và dùng lại được từ route:
  build_board_prompt(...)   → chữ, theo đúng template panorama của autopilot/generate-panorama
  draw_board(prompt, refs, out_png, engines, …) → thử lần lượt: chatgpt (trình duyệt, có ảnh tham chiếu) → muse
                              (trình duyệt, có ảnh tham chiếu) → 9router (gpt-image-2 API, CHỈ chữ; 1024², quality low
                              vì tunnel Cloudflare cắt ở 100 s)
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

def build_board_prompt(*, title: str, fmt: str, characters: List[Dict], products: List[Dict], environment: str,
                       shots: List[Dict], aspect: str = "16:9", style: str = "Photorealistic", camera_style: str = "") -> str:
    """Prompt bảng theo khuôn Pod Studio (zone 1–5), N cut = số clip; mọi câu tiếng Anh (prompt AI luôn tiếng Anh)."""
    n = max(1, len(shots))
    char_lines = "\n".join(f"  - {c.get('name') or 'Character'}: {(c.get('appearance') or c.get('description') or '')[:700]}"
                           for c in characters[:3]) or "  (none)"
    prod_lines = "\n".join(f"  - {p.get('name') or 'Product'}: {(p.get('appearance') or p.get('description') or '')[:300]}"
                           for p in products[:2])
    # mỗi cut ghi rõ bắt đầu → kết thúc (10 s): bảng là dòng thời gian cho Muse, cuối cut k = đầu cut k+1
    cut_lines = "\n".join(f"  Cut {i+1} ({(s.get('camera') or 'shot').upper()}): {s.get('scene') or s.get('action') or ''}"
                          + (f" — ACTION: {s['action']}" if s.get("action") else "")
                          + (f" — STARTS: {s['start']}" if s.get("start") else "") + (f"; ENDS: {s['end']}" if s.get("end") else "")
                          for i, s in enumerate(shots))
    # Camera plan phải ĐỌC được kiểu quay (user 3/10/2026): nhãn từng máy = cỡ cảnh · ống kính · chuyển động
    cam_lines = "\n".join(f"  Camera {i+1}: {s.get('camera') or 'medium shot'}" for i, s in enumerate(shots))
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
        f"shapes; camera positions as numbered icons (Cut 1 … Cut {n}) with a field-of-view cone (wide lens = wide cone, "
        "long lens = narrow cone) and a dotted arrow for the move; the character(s) marked with figure icons and their "
        "walking path. NEXT TO EACH CAMERA a short readable LABEL: \"CUT k · SHOT SIZE · LENS · MOVE\" — use these:\n"
        f"{cam_lines}\n"
        + (f"Header line of this zone: \"CAMERA STYLE: {camera_style[:120]}\"\n" if camera_style else "")
        + "Small legend: shot sizes (WIDE / MEDIUM / CLOSE-UP) and moves (DOLLY, TRACKING, ORBIT, CRANE, PUSH-IN, HANDHELD).\n\n"
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
