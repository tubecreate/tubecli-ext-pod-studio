"""Pipe «Video từ ảnh tham chiếu» cho Bảng việc (Codex) — kind `pod_studio.video`.

Đầu vào (form do Codex vẽ từ task_kind_spec): ảnh người mẫu/nhân vật, ảnh sản phẩm, yêu cầu (nội dung + thoại cần
nói), thể loại (quảng cáo · video ngắn · drama), số clip, khung hình, hồ sơ ChatGPT, phụ đề.
Luồng — đúng cách user và tôi làm tay ngày 2/10/2026 với Lin Zhian / Cố Bào Bào:
  intake    → lưu ảnh, tạo campaign + nhân vật/sản phẩm + tập trong Pod Studio (xem được ở /pod-studio)
  character → bảng nhân vật 10 chiều (schema `appearance` của extractor) từ ảnh: Muse (có ảnh) → Gemini → chỉ chữ
  shots     → chia N cảnh 10 s + đặt thoại (LLM, JSON; hỏng thì khuôn mẫu theo thể loại)
  board     → Scene Panorama MỘT lượt vẽ (panorama.draw_board: chatgpt → muse → 9router), rồi ĐỌC NGƯỢC bảng (read_board):
              bối cảnh, ánh sáng, sơ đồ không gian, góc máy/vị trí từng cut → khối SCENE & CONTINUITY trong mọi prompt
              (user 2/10/2026: "cái tôi cần trong panorama là lấy bối cảnh, góc quay, timeline")
  clips     → chuỗi clip Muse 10 s: khung đầu clip 1 vẽ từ chân dung; KHUNG CUỐI clip trước CHÍNH LÀ khung đầu clip sau
              (không vẽ lại); chân dung + khoá kiểu vẽ đính vào MỌI clip (neo danh tính = ảnh/mô tả người dùng đưa vào);
              bảng panorama đính NGUYÊN làm ảnh thứ 3 + câu "làm clip từ CUT i" (không cắt cut); nhân vật TỰ NÓI thoại
  render    → ffmpeg ghép (+ phụ đề nếu bật) → /api/v1/pod_studio/export-video/<file>
Mỗi bước ghi checkpoint (state.json trong thư mục dự án): Chạy lại là tiếp từ bước dở, không vẽ lại clip đã có.
Hàm chạy ĐỒNG BỘ trong thread của worker (như content_video); lời gọi async bên trong dùng asyncio.run.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import time
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("PodStudio.RefVideo")

KIND = "pod_studio.video"
EXT_NAME = "pod_studio"
ACTOR = "pod_studio"
FORMATS = ("ad", "short", "drama")
CLIP_SECONDS = 10
MAX_CLIPS = 12
MAX_MODELS = 3
MAX_PRODUCTS = 2
ASPECTS = ("9:16", "16:9", "1:1")
RETRY_WAIT = 20          # giây nghỉ trước khi gọi lại Muse một lần (test đặt 0)
# Các ô của form mà MẪU quản (kho mẫu chung của lõi, phần "ref_video") — ảnh, yêu cầu, thoại, tiêu đề luôn nhập theo task.
TEMPLATE_KEYS = ("format", "clips", "aspect", "style", "style_custom", "subtitles")
STEPS = [
    ("intake", "Nhận ảnh & yêu cầu"), ("character", "Bảng nhân vật"), ("shots", "Chia cảnh & thoại"),
    ("board", "Scene Panorama"), ("clips", "Clip Muse"), ("render", "Ghép video"),
]
STEP_EXT = {name: EXT_NAME for name, _ in STEPS}
_EXT_DIR = os.path.dirname(os.path.abspath(__file__))


class Cancelled(Exception):
    pass


# ── đường dẫn ──────────────────────────────────────────────────────────────────

def _data_dir() -> str:
    from tubecli.config import DATA_DIR
    return os.path.join(str(DATA_DIR), "pod_studio")


def _project_dir(task_id: str) -> str:
    d = os.path.join(_data_dir(), "ref_video", re.sub(r"[^\w.-]", "_", str(task_id)))
    os.makedirs(d, exist_ok=True)
    return d


def _videos_dir() -> str:
    """Thư mục mà route /api/v1/pod_studio/grok-video/{file} phát — clip hiện được trong giao diện Pod Studio."""
    d = os.path.join(_data_dir(), "grok_videos")
    os.makedirs(d, exist_ok=True)
    return d


def _exports_dir() -> str:
    d = os.path.join(_data_dir(), "outputs", "exports")
    os.makedirs(d, exist_ok=True)
    return d


def _gallery_dir() -> str:
    d = os.path.join(_data_dir(), "gallery")
    os.makedirs(d, exist_ok=True)
    return d


def _resolve_image(item: Any) -> str:
    """{url, filepath} | đường dẫn | URL gallery → đường dẫn file có thật, "" nếu không."""
    if isinstance(item, dict):
        fp = str(item.get("filepath") or "")
        if fp and os.path.isfile(fp):
            return fp
        item = item.get("url") or item.get("path") or ""
    s = str(item or "").strip()
    if not s:
        return ""
    if os.path.isfile(s):
        return s
    for prefix, folder in (("/api/v1/pod_studio/gallery/image/", _gallery_dir()),
                           ("/api/v1/pod_studio/references/", os.path.join(_data_dir(), "references"))):
        if s.startswith(prefix):
            p = os.path.join(folder, s[len(prefix):].split("?")[0])
            if os.path.isfile(p):
                return p
    return ""


def _db():
    import sys
    if _EXT_DIR not in sys.path:
        sys.path.insert(0, _EXT_DIR)
    from pod_db.json_store import JsonStore
    return JsonStore.get_instance(_data_dir())


# ── checkpoint ────────────────────────────────────────────────────────────────

def _state_path(task_id: str) -> str:
    return os.path.join(_project_dir(task_id), "state.json")


def load_state(task_id: str) -> Dict[str, Any]:
    try:
        with open(_state_path(task_id), "r", encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def save_state(task_id: str, st: Dict[str, Any]) -> None:
    p = _state_path(task_id)
    tmp = p + ".part"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


# ── bảng nhân vật (schema `appearance` của extractor Pod Studio) ───────────────

APPEARANCE_PROMPT = (
    "Write an ULTRA-DETAILED CHARACTER DESIGN SHEET of the person in the attached image(s), in English, 400-800 "
    "characters, as ONE paragraph with numbered items. Cover ALL of: 1. FACE STRUCTURE (face shape, skin tone & "
    "texture); 2. EYES (shape, exact color, lashes, makeup); 3. EYEBROWS & NOSE & LIPS; 4. EXPRESSION & MOOD; "
    "5. HAIR (exact color — say if light/dark —, length, texture, style, bangs); 6. HAIR ACCESSORIES; 7. EARRINGS & "
    "JEWELRY; 8. CLOTHING - TOP (neckline, sleeves, fabric, color, pattern, decorations); 9. CLOTHING - BOTTOM "
    "(style, fabric, color) + shoes/socks; 10. OVERALL AESTHETIC; 11. ART STYLE (exactly one of: real photograph / "
    "semi-realistic 3D CG render / 2D anime illustration / painting — choose 3D CG render when the image has volumetric "
    "3D shading and individually rendered hair strands, EVEN IF the face is anime-styled; 2D anime only for flat "
    "cel-shaded line art). Describe ONLY what is visible; estimate age and height. Reply with the paragraph only — no "
    "title, no markdown."
)
# Kiểu hình: khoá → tên (chen vào câu "A single <tên> frame") + câu tả (khối RENDERING STYLE). «3d» tách khỏi «anime»
# vì nhân vật tóc xanh 3/10/2026 là 3D CG bán thực mặt kiểu anime — Muse gọi là «anime illustration» → video ra 2D.
STYLE_PRESETS: Dict[str, Dict[str, Any]] = {
    "3d": {"name": "semi-realistic 3D CG render", "label": {"en": "3D CG (semi-realistic)", "vi": "3D CG (bán thực)"},
           "desc": "game-cinematic quality 3D character render: volumetric soft shading, subsurface-scattered skin, "
                   "individually rendered hair strands, physically based materials and lighting, depth of field — NOT flat "
                   "2D anime line art, NOT a real photograph"},
    "anime": {"name": "2D anime illustration", "label": {"en": "2D anime", "vi": "Anime 2D"},
              "desc": "clean line art, cel shading, flat color areas, anime proportions — NOT a 3D render, NOT a photograph"},
    "photo": {"name": "photorealistic", "label": {"en": "Real photo", "vi": "Ảnh thật"},
              "desc": "a real photograph of a real human: natural skin texture, real camera optics and lighting"},
    "painting": {"name": "painted illustration", "label": {"en": "Painting", "vi": "Tranh vẽ"},
                 "desc": "a painted illustration with visible brush strokes and painterly color — NOT a photograph"},
}
_STYLE_PATTERNS = (     # thứ tự quan trọng: «anime-styled 3D render» phải ra 3d
    ("3d", r"\b3d\b|\bcg\b|cgi|render|video game|game[- ](?:style|cinematic|character)|unreal|octane"),
    ("anime", r"anime|manga|cel[- ]shad|2d|cartoon|line art|illustrat|drawn"),
    ("painting", r"painting|painted|watercolou?r|oil on|ink wash|brush ?stroke"),
    ("photo", r"photo|real|camera"),
)


def art_style(appearance: str) -> str:
    """Khoá kiểu hình (3d | anime | photo | painting) từ bảng nhân vật: mục 11 trước, không có thì dò cả đoạn; mặc
    định ảnh thật. Nhân vật 3D/anime phải giữ đúng kiểu, không ép thành người thật (#158, 2/10/2026)."""
    text = str(appearance or "")
    m = re.search(r"ART STYLE\s*[:\-–]\s*([^.;\n]{3,80})", text, re.I)
    for chunk in ((m.group(1) if m else ""), text):
        if not chunk:
            continue
        for key, pat in _STYLE_PATTERNS:
            if key == "photo" and chunk is text:
                continue        # cả đoạn hay có chữ "realistic" → chỉ tin «photo/real» khi nằm trong mục 11
            if re.search(pat, chunk, re.I):
                return key
    return "photo"


def resolve_style(chosen: str, detected: str) -> str:
    """Kiểu người dùng chọn trong form thắng; «auto»/rỗng/lạ → kiểu dò được từ ảnh."""
    c = str(chosen or "").strip().lower()
    return c if c in STYLE_PRESETS else (detected if detected in STYLE_PRESETS else "photo")


def guess_gender(appearance: str) -> str:
    """Giới tính từ bảng nhân vật → chọn giọng trong speak_block. «heroine» (#159: "cyberpunk techwear anime heroine")
    không khớp woman/girl nên từng ra giọng trung tính — bắt thêm các từ hay gặp."""
    text = str(appearance or "")
    if re.search(r"\b(woman|girl|female|she|her|heroine|lady|feminine|actress|schoolgirl)\b", text, re.I):
        return "female"
    if re.search(r"\b(man|boy|male|he|his|gentleman|masculine|actor|schoolboy|guy)\b", text, re.I):
        return "male"
    return ""


def style_name(style: str, custom: str = "") -> str:
    """Tên kiểu hình chen vào "A single <tên> frame"; mẫu có câu tả riêng (vd «Japanese Edo Watercolor») thì dùng câu ấy."""
    return custom.strip() if custom and custom.strip() else STYLE_PRESETS.get(style, STYLE_PRESETS["photo"])["name"]


def style_block(style: str, custom: str = "") -> str:
    """Câu ghim kiểu hình vào prompt ảnh/video — giữ NGUYÊN một kiểu từ khung đầu tới khung cuối."""
    p = STYLE_PRESETS.get(style, STYLE_PRESETS["photo"])
    keep = ("Keep exactly this rendering style, the same as the attached reference portrait, in every frame from the "
            "first to the last.")
    if custom and custom.strip():
        return f"RENDERING STYLE: {custom.strip()} ({p['name']} — {p['desc']}). {keep}"
    return f"RENDERING STYLE: {p['name']} — {p['desc']}. {keep}"
PRODUCT_PROMPT = (
    "Describe the product in the attached image(s) in English, 150-300 characters, one paragraph: type, color, shape, "
    "material & texture, label/logo text and position, design/print details, packaging. Reply with the paragraph only."
)


def _muse_describe(images: List[str], prompt: str) -> str:
    from tubecli.core import muse
    if not muse.settings()["profile"] or not images:
        return ""
    res = muse.ask(prompt, files=images[:3], timeout=180)
    return str(res.get("text") or "").strip()


def _gemini_describe(images: List[str], prompt: str) -> str:
    """Gemini vision qua khoá trong Cloud API Keys (cùng cách server_job_pipeline._gemini_analyze)."""
    import base64
    try:
        from tubecli.extensions.cloud_api.extension import key_manager
        key = key_manager.get_active_key("gemini") or ""
    except Exception:
        key = ""
    if not key or not images:
        return ""
    import requests
    parts = [{"text": prompt}]
    for p in images[:3]:
        with open(p, "rb") as f:
            raw = f.read()
        mime = "image/png" if raw[:4] == b"\x89PNG" else "image/webp" if raw[:4] == b"RIFF" else "image/jpeg"
        parts.append({"inline_data": {"mime_type": mime, "data": base64.b64encode(raw).decode()}})
    r = requests.post(f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={key}",
                      json={"contents": [{"parts": parts}], "generationConfig": {"temperature": 0.2, "maxOutputTokens": 1024}},
                      timeout=60)
    if r.status_code != 200:
        raise RuntimeError(f"Gemini {r.status_code}: {r.text[:120]}")
    cands = r.json().get("candidates") or [{}]
    text = " ".join(p.get("text", "") for p in cands[0].get("content", {}).get("parts", []) if p.get("text"))
    return re.sub(r"\s+", " ", text).strip()


def describe(images: List[str], prompt: str, say: Callable[[str], None], max_len: int = 900) -> str:
    """Mô tả từ ảnh — Muse (nhìn ảnh, không cần khoá) → Gemini → "" (chỉ dùng chữ người dùng gõ).
    max_len: bảng nhân vật 900 là đủ; đọc bảng panorama trả JSON dài hơn (#160: cắt ở 900 → không parse được)."""
    for name, fn in (("Muse", _muse_describe), ("Gemini", _gemini_describe)):
        try:
            text = fn(images, prompt)
        except Exception as e:      # noqa: BLE001
            say(f"{name} could not describe the image: {str(e)[:120]}")
            continue
        if len(text) >= 80:
            return text[:max_len]
    return ""


def identity_block(name: str, appearance: str, extra: str = "") -> str:
    """Khối IDENTITY LOCK chèn NGUYÊN VĂN vào mọi prompt ảnh/video (cách Pod Studio chèn `appearance`)."""
    body = (appearance or "").strip() or extra.strip() or "the person shown in the attached reference images"
    return (f"IDENTITY LOCK — {name}: {body} The outfit must be IDENTICAL to the attached reference images in every "
            "frame. Maintain strict 100% visual consistency of the face, hair color/style and clothing with the attached "
            "reference portrait in every frame.")


BOARD_READ_PROMPT = (
    "You are reading a PRODUCTION DESIGN BOARD (scene panorama) for a short AI video: zone 1 character reference, zone 2 "
    "environment / set design, zone 3 storyboard with numbered CUTS, zone 4 lighting/mood notes, zone 5 top-down floor plan "
    "+ camera plan. Extract what a director needs to keep EVERY shot in the same space, in English. Reply with ONLY a JSON "
    "object: {\"environment\": str (the set as drawn: place, architecture, props, colors — 40-80 words), \"lighting\": str "
    "(key light direction, color temperature, mood — 15-40 words), \"spatial_map\": str (where the character stands and "
    "moves, what is behind/left/right, where the cameras are, from the floor plan — 30-70 words), \"cuts\": [{\"cut\": int, "
    "\"camera\": str (angle + movement as labeled), \"position\": str (where the character is in the set and body "
    "orientation), \"background\": str (what is visible behind the character)}]}. Describe ONLY what is on the board."
)


def read_board(board_png: str, n: int, say: Callable[[str], None]) -> Dict[str, Any]:
    """Đọc ngược bảng đã vẽ → bối cảnh, ánh sáng, sơ đồ không gian, góc máy/vị trí từng cut. Vision: Muse (nhìn ảnh) →
    Gemini; trả chữ không phải JSON thì giữ nguyên văn ({"raw"}); không đọc được → {}."""
    text = describe([board_png], BOARD_READ_PROMPT, say, max_len=4000)
    data = _parse_json(text) if text else None
    if not isinstance(data, dict):
        return {"raw": text[:900]} if text else {}
    cuts = []
    for c in list(data.get("cuts") or [])[:n]:
        if isinstance(c, dict):
            cuts.append({"cut": c.get("cut"), "camera": str(c.get("camera") or "")[:160],
                         "position": str(c.get("position") or "")[:220], "background": str(c.get("background") or "")[:220]})
    return {"environment": str(data.get("environment") or "")[:600], "lighting": str(data.get("lighting") or "")[:300],
            "spatial_map": str(data.get("spatial_map") or "")[:500], "cuts": cuts}


def shrink_image(src: str, dst: str, max_w: int = 1600, quality: int = 85) -> str:
    """Bản nhẹ để đính kèm: bảng PNG 2,5 MB tải lên Muse lâu, khoá ô soạn tin quá 30 s (#160, 2/10/2026). Lỗi → trả nguyên bản."""
    try:
        from PIL import Image
        im = Image.open(src).convert("RGB")
        if im.width > max_w:
            im = im.resize((max_w, max(1, int(im.height * max_w / im.width))))
        im.save(dst, "JPEG", quality=quality)
        return dst
    except Exception as e:      # noqa: BLE001
        logger.warning("shrink_image: %s", e)
        return src


def board_block(i: int, aspect: str) -> str:
    """Câu chỉ cho Muse dùng bảng panorama đính kèm: bối cảnh từ zone 2, làm clip này từ CUT i của zone 3, không vẽ lại bảng."""
    return (f"PRODUCTION DESIGN BOARD: the attached board image is the visual reference for the SET (zone 2 — environment) "
            f"and the STORYBOARD (zone 3). Make this shot from CUT {i} of the storyboard: its composition, camera angle and "
            f"where the character stands in the set. Do NOT render the board itself, its panels, labels or text — output one "
            f"clean {aspect} shot.\n")


def scene_block(plan: Dict[str, Any], notes: Dict[str, Any], i: int, n: int) -> str:
    """Khối SCENE & CONTINUITY cho clip i: bối cảnh/ánh sáng/sơ đồ từ bảng (không có bảng thì từ kế hoạch), góc máy + vị trí
    của cut i, và dòng thời gian (cảnh trước → cảnh này → cảnh sau; clip > 1 bắt đầu ĐÚNG khung cuối clip trước)."""
    shots = plan.get("shots") or []
    shot = shots[i - 1] if i - 1 < len(shots) else {}
    notes = notes or {}
    cut = next((c for c in notes.get("cuts") or [] if str(c.get("cut")) == str(i)), None) or {}
    lines = ["SCENE & CONTINUITY" + (" (read from the production design board):" if notes.get("environment") else ":"),
             f"ENVIRONMENT: {notes.get('environment') or plan.get('environment') or ''}"]
    if notes.get("lighting"):
        lines.append(f"LIGHTING: {notes['lighting']}")
    if notes.get("spatial_map"):
        lines.append(f"SPATIAL MAP: {notes['spatial_map']}")
    if notes.get("raw"):
        lines.append(f"BOARD NOTES: {notes['raw'][:500]}")
    cam = cut.get("camera") or shot.get("camera") or ""
    lines.append(f"CAMERA FOR THIS SHOT: {cam}" + (f" · CHARACTER POSITION: {cut['position']}" if cut.get("position") else "")
                 + (f" · BACKGROUND: {cut['background']}" if cut.get("background") else ""))
    prev_t = shots[i - 2].get("title") if 2 <= i <= len(shots) else ""
    next_t = shots[i].get("title") if i < len(shots) else ""
    tl = (f"TIMELINE: shot {i} of {n}" + (f" · previous: «{prev_t}»" if prev_t else " · opening shot")
          + f" · THIS SHOT: «{shot.get('title', '')}»" + (f" · next: «{next_t}»" if next_t else " · final shot"))
    if i > 1:
        tl += (". This clip starts EXACTLY on the attached first image — the final frame of the previous shot: same place, "
               "same pose, same camera position — and continues the motion from there with no cut or jump.")
    lines.append(tl)
    # Bắt đầu / kết thúc của 10 s này (user 2/10/2026: "phân tích cho Muse biết bắt đầu, kết thúc của mỗi 10 s")
    start, end = shot.get("start") or "", shot.get("end") or ""
    if start or i > 1:
        lines.append(f"START (0 s): {start or 'exactly the attached first image'}")
    if end:
        lines.append(f"END ({CLIP_SECONDS} s): {end}"
                     + (" — hold exactly this state on the final frame; the next clip continues from it." if i < n else ""))
    return "\n".join(lines)


# ── chia cảnh + thoại ─────────────────────────────────────────────────────────

FORMAT_RULES = {
    "ad": ("Follow the proven ad rhythm: HOOK (close-up of an intriguing moment or the product, camera already moving) → "
           "REVEAL (model + product in context) → INTERACTION (the model uses/touches/shows the product) → PAYOFF "
           "(beauty shot + reaction, slight slow-motion feel). Same location family, same lighting direction."),
    "short": ("One short story beat for social media: setup → turn → payoff, each shot continues the previous one; "
              "keep the same place and time of day; end on an expressive close-up."),
    "drama": ("A short drama scene: each shot is ONE moment of the script in order, characters stay in one connected "
              "space (spatial zones linked by doors/hallways), the camera end position of shot N connects to the start "
              "of shot N+1; at most ONE character speaks per shot."),
}


def _llm(messages: List[Dict], max_tokens: int = 1800) -> str:
    from tubecli.core.brain import AgentBrain
    return AgentBrain._call_llm({"model": "", "cloud_api_keys": {}}, messages, temperature=0.4, max_tokens=max_tokens)


def _parse_json(text: str):
    """JSON trong câu trả lời của model (trần, trong ```json, hay lẫn chữ) → object; không có → None.
    ai_generator.extract_json của lõi có bản trả CHUỖI JSON chứ không phải object (đo 2/10/2026) — nên tự xử."""
    s = str(text or "").strip()
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", s)
    if m:
        s = m.group(1).strip()
    for cand in (s, s[s.find("{"): s.rfind("}") + 1] if "{" in s and "}" in s else ""):
        if not cand:
            continue
        try:
            obj = json.loads(cand)
            return obj
        except ValueError:
            continue
    return None


# Trang phục do bước viết cảnh TỰ CHẾ (việc thuê #164, 3/10/2026: «đi trên đường làng việt nam» → «wearing an elegant
# flowing áo dài» trong khi ảnh người mẫu mặc đồ khác) → khung vẽ mang HAI bộ đồ, Muse không chịu vẽ. Luật WARDROBE
# trong câu lệnh là lớp một; đây là lớp hai, chắc ăn: khách KHÔNG nhắc tới trang phục thì lột cụm «wearing …» khỏi
# kịch bản cảnh — trang phục chỉ còn đến từ ảnh tham chiếu (khoá nhận dạng). Cụm nói tới sản phẩm thì giữ.
_GARMENT = (r"(?:áo dài|ao dai|dress|gown|outfit|suit|skirt|shirt|blouse|top|jacket|coat|kimono|hanbok|qipao|"
            r"cheongsam|uniform|clothes|clothing|attire|robe|sari|saree|hoodie|sweater|jeans|pants|trousers|shorts|"
            r"bikini|swimsuit|costume|tunic|vest|áo|váy|boots?|shoes?|heels|sneakers|sandals|hat|scarf|gloves|"
            r"stockings|socks|belt|headband|veil|necklace|earrings)")
# «wearing a red dress and black boots, with a gold necklace» — cả chuỗi món nối bằng and/with/dấu phẩy
_WEAR_RE = re.compile(r",?\s*\b(?:wearing|dressed in|clad in)\s+(?:[\w'’-]+\s+){0,6}?" + _GARMENT
                      + r"\b(?:\s*(?:,\s*)?(?:with|and)\s+(?:[\w'’-]+\s+){0,4}?" + _GARMENT + r"\b){0,4}", re.I)
_ASKS_WARDROBE_RE = re.compile(r"\b(?:wear|wears|wearing|outfit|dress|clothes|costume|áo|váy|quần|mặc|trang phục)\b", re.I)


def strip_wardrobe(text: str, request: str = "") -> str:
    """Lột trang phục tự chế khỏi một câu tả cảnh — trừ khi khách tự nói về trang phục."""
    if not text or _ASKS_WARDROBE_RE.search(request or ""):
        return text

    def cut(m):
        return m.group(0) if re.search(r"\b(?:product|attached)\b", m.group(0), re.I) else ""
    return re.sub(r"\s{2,}", " ", _WEAR_RE.sub(cut, text)).strip()


def plan_shots(*, fmt: str, request: str, characters: List[Dict], products: List[Dict], n: int,
               say: Callable[[str], None]) -> Dict[str, Any]:
    """{"title", "environment", "shots": [{title, scene, camera, action, speaker, dialogue}]} — LLM, lùi về khuôn mẫu."""
    names = [c["name"] for c in characters] or ["the character"]
    prod = ", ".join(p["name"] for p in products) or "none"
    sys_prompt = (
        "You are a cinematic storyboard planner for AI-generated video. Each shot becomes ONE 10-second AI video clip, "
        "so every shot must be simple, continuous and filmable: one location, one clear action, slow camera movement. "
        f"{FORMAT_RULES.get(fmt, FORMAT_RULES['ad'])}\n"
        "DIALOGUE RULES: the user's request may contain lines the character must say — use those lines VERBATIM (same "
        "language, same words), spread them across the shots, at most ONE speaker and ONE line (≤ 25 words) per shot; "
        "shots without a line have dialogue \"\". Never invent brand claims.\n"
        # Việc thuê #164 (3/10/2026): khách chỉ gõ «đi trên đường làng việt nam», bước này tự cho người mẫu mặc «áo dài»
        # trong khi ảnh người mẫu mặc đồ khác → khung vẽ mang HAI bộ đồ, Muse từ chối vẽ cả việc.
        "WARDROBE RULE: the characters' look (face, hair, outfit, shoes, accessories) comes ONLY from their reference "
        "photos. Never describe, add or change clothing, hair or accessories in any field — call them by name (e.g. "
        "\"the model\") — unless the user's request explicitly asks for a different outfit.\n"
        "CONTINUITY RULES: each clip is generated from the LAST FRAME of the previous clip, so for every shot write its START "
        "state (frame 0: where the character is in the set, body pose, facing direction, camera position/angle) and its END "
        f"state (frame {CLIP_SECONDS} s: the same four things). The END of shot k MUST be exactly the START of shot k+1 (same "
        "place, pose, camera) — write them with the same words. Movement inside a shot must be achievable in 10 seconds.\n"
        "Reply with ONLY a JSON object: {\"title\": str, \"environment\": str (one sentence, the single location and light), "
        "\"shots\": [{\"title\": str, \"scene\": str (what we see, English, 25-45 words), \"camera\": str (e.g. "
        "\"wide, slow push-in\"), \"action\": str, \"start\": str (15-30 words), \"end\": str (15-30 words), "
        "\"speaker\": str (character name or \"\"), \"dialogue\": str}]}"
    )
    user = (f"Format: {fmt}. Number of shots: EXACTLY {n}.\nCharacters: {', '.join(names)}.\nProducts: {prod}.\n"
            f"Request from the user (may include the lines to say):\n{request.strip()}")
    plan = None
    try:
        text = _llm([{"role": "system", "content": sys_prompt}, {"role": "user", "content": user}])
        data = _parse_json(text)
        if isinstance(data, dict) and isinstance(data.get("shots"), list) and data["shots"]:
            plan = data
        else:
            # Brain trả lỗi bằng CHUỖI ("[Gemini Error] …") hay chữ không phải JSON — nói ra, đừng lặng lẽ dùng khuôn mẫu.
            say(f"The AI's shot plan was not usable ({' '.join(str(text or '').split())[:140]}) — using the template.")
    except Exception as e:      # noqa: BLE001
        say(f"The AI could not plan the shots ({str(e)[:100]}) — using the template.")
    if not plan:
        plan = template_shots(fmt, request, names[0], prod, n)
    shots = []
    for s in list(plan.get("shots") or [])[:n]:
        shots.append({"title": str(s.get("title") or f"Shot {len(shots)+1}")[:80],
                      "scene": str(s.get("scene") or s.get("action") or "")[:600],
                      "camera": str(s.get("camera") or "medium shot, slow push-in")[:120],
                      "action": str(s.get("action") or "")[:300],
                      "start": str(s.get("start") or "")[:300], "end": str(s.get("end") or "")[:300],
                      "speaker": str(s.get("speaker") or "")[:60],
                      "dialogue": str(s.get("dialogue") or "")[:220]})
    while len(shots) < n:                     # LLM trả thiếu → bù bằng cảnh cuối lặp lại nhẹ (đứng yên ở trạng thái cuối)
        last = shots[-1] if shots else {"title": "Shot", "scene": request[:300], "camera": "medium shot", "action": "", "start": "", "end": "", "speaker": "", "dialogue": ""}
        shots.append({**last, "title": f"Shot {len(shots)+1}", "start": last.get("end", ""), "dialogue": "", "speaker": ""})
    # Dòng thời gian: END cảnh k = START cảnh k+1 (clip sau dựng từ khung cuối clip trước) — LLM bỏ trống bên nào thì chép bên kia.
    for k in range(1, len(shots)):
        if not shots[k]["start"] and shots[k - 1]["end"]:
            shots[k]["start"] = shots[k - 1]["end"]
        elif not shots[k - 1]["end"] and shots[k]["start"]:
            shots[k - 1]["end"] = shots[k]["start"]
    for sh in shots:
        for k in ("scene", "action", "start", "end"):
            sh[k] = strip_wardrobe(sh[k], request)
    plan["shots"] = shots
    plan["title"] = str(plan.get("title") or request.strip().split("\n")[0][:60] or "Video")[:80]
    # LLM quên bối cảnh → lấy từ chính yêu cầu (câu đầu thường tả địa điểm), đừng rơi về câu chung chung.
    plan["environment"] = str(plan.get("environment") or request.strip().split("\n")[0][:200]
                              or "a bright, clean location with soft natural light")[:300]
    return plan


def extract_lines(request: str) -> List[str]:
    """Câu thoại trong yêu cầu: dòng trong «…» / "…" hoặc sau 'thoại:' / 'say:'."""
    lines = re.findall(r"[«\"“]([^»\"”]{3,220})[»\"”]", request or "")
    if not lines:
        m = re.search(r"(?:thoại|lời thoại|dialogue|say|says|nói)\s*[:：]\s*(.+)", request or "", re.I | re.S)
        if m:
            lines = [l.strip(" -•\t") for l in m.group(1).strip().split("\n") if l.strip(" -•\t")]
    return [l.strip() for l in lines if l.strip()][:MAX_CLIPS]


def template_shots(fmt: str, request: str, who: str, prod: str, n: int) -> Dict[str, Any]:
    lines = extract_lines(request)
    base = {
        "ad": [("Hook", f"close-up of {who} with the product ({prod}) in a bright setting, camera already moving", "close-up, slow dolly"),
               ("Reveal", f"{who} in the full outfit/product in context, turns toward the camera with a soft smile", "wide to medium, slow push-in"),
               ("Interaction", f"{who} uses or touches the product, details clearly visible", "medium close-up, gentle drift"),
               ("Payoff", f"{who} steps toward the camera and smiles warmly, full outfit visible", "low angle, slow orbit")],
        "short": [("Setup", f"{who} in the location, something catches their attention", "wide, static then slow push-in"),
                  ("Turn", f"{who} reacts and moves closer to the camera", "medium, handheld-smooth"),
                  ("Payoff", f"expressive close-up of {who}, warm light", "close-up, slow push-in")],
        "drama": [("Beat", f"{who} in the scene described by the request", "medium, slow dolly")],
    }[fmt if fmt in FORMAT_RULES else "ad"]
    shots = []
    for i in range(n):
        t, scene, cam = base[min(i, len(base) - 1)]
        line = lines[i] if i < len(lines) else ""        # mỗi câu một cảnh theo thứ tự; thiếu thì cảnh sau im
        start = shots[-1]["end"] if shots else f"{who} at the opening position of '{t}', camera at the start of its move"
        end = f"{who} holding the final pose of '{t}', camera settled at the end of its move"
        shots.append({"title": t, "scene": scene, "camera": cam, "action": "", "start": start, "end": end,
                      "speaker": who if line else "", "dialogue": line})
    return {"title": request.strip().split("\n")[0][:60] or "Video", "environment": "a bright, clean location with soft natural light", "shots": shots}


# ── Muse clip ─────────────────────────────────────────────────────────────────

def speak_block(line: str, gender_hint: str = "") -> str:
    voice = "her own natural young female voice" if gender_hint == "female" else \
            "his own natural young male voice" if gender_hint == "male" else "their own natural voice"
    return (f"The character looks at the camera and SPEAKS this line in its original language, in {voice} with "
            f"accurate lip-sync — the audio must contain exactly: \"{line}\". No narrator, no voice-over, no background "
            "music, only gentle ambient sound.")


SILENT_BLOCK = "Nobody speaks in this shot. No narrator, no voice-over, no background music, only gentle ambient sound."


def _ffmpeg(cmd: List[str]) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode:
        raise RuntimeError(f"ffmpeg failed: {r.stderr[-500:]}")


def last_frame(video: str, out_jpg: str) -> str:
    _ffmpeg(["ffmpeg", "-v", "error", "-y", "-sseof", "-0.1", "-i", video, "-frames:v", "1", "-q:v", "2", "-update", "1", out_jpg])
    return out_jpg


WATERMARK_TEXT = "AI · tubecli.app"


def concat(paths: List[str], out: str, subtitles: Optional[List[str]] = None, workdir: str = "",
           watermark: str = "") -> str:
    """Ghép các clip (scale/pad về cỡ clip 1, 24 fps, thiếu tiếng thì chèn im lặng); phụ đề .srt đốt cứng nếu có.

    watermark: nhãn nhỏ góc trên phải suốt video — BẮT BUỘC với việc thuê trên Town (khách được gửi ảnh người thật,
    3/10/2026): đốt nhãn hỏng thì NÉM lỗi (việc báo hỏng, khách được hoàn) chứ không giao video thiếu nhãn.
    Phụ đề hỏng thì vẫn giữ bản không phụ đề như trước."""
    probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", paths[0]],
                                      capture_output=True, text=True).stdout)
    vs = next(s for s in probe["streams"] if s["codec_type"] == "video")
    W, H = int(vs["width"]), int(vs["height"])
    inputs, fc, maps = [], [], ""
    for k, p in enumerate(paths):
        streams = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", p],
                                            capture_output=True, text=True).stdout)["streams"]
        has_audio = any(s["codec_type"] == "audio" for s in streams)
        inputs += ["-i", p]
        fc.append(f"[{k}:v]scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p[v{k}]")
        fc.append(f"[{k}:a]aformat=sample_rates=48000:channel_layouts=stereo[a{k}]" if has_audio
                  else f"anullsrc=r=48000:cl=stereo,atrim=0:{CLIP_SECONDS}[a{k}]")
        maps += f"[v{k}][a{k}]"
    fc.append(f"{maps}concat=n={len(paths)}:v=1:a=1[v][a]")
    subs = [s for s in (subtitles or [])] if subtitles and any(subtitles) else []
    tmp = out + ".concat.mp4" if (subs or watermark) else out
    _ffmpeg(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(fc), "-map", "[v]", "-map", "[a]",
             "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", tmp])
    if not (subs or watermark):
        return out
    # subtitles= cần đường dẫn không có "C:" → chạy trong thư mục dự án với tên tương đối
    wd = workdir or os.path.dirname(out)

    def burn(vf: str) -> subprocess.CompletedProcess:
        return subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", tmp, "-vf", vf,
                               "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-c:a", "copy", "-movflags", "+faststart", out],
                              cwd=wd, capture_output=True, text=True, encoding="utf-8", errors="replace")

    vf_subs = vf_wm = ""
    if subs:
        with open(os.path.join(wd, "subs.srt"), "w", encoding="utf-8") as f:
            for i, line in enumerate(subs):
                if not line:
                    continue
                t0, t1 = i * CLIP_SECONDS + 0.2, (i + 1) * CLIP_SECONDS - 0.2
                f.write(f"{i+1}\n{_ts(t0)} --> {_ts(t1)}\n{line}\n\n")
        vf_subs = "subtitles=subs.srt:force_style='FontName=Segoe UI,FontSize=20,Bold=1,Outline=1.5,MarginV=60'"
    if watermark:
        with open(os.path.join(wd, "wm.srt"), "w", encoding="utf-8") as f:
            f.write(f"1\n{_ts(0)} --> {_ts(len(paths) * CLIP_SECONDS + 5)}\n{watermark}\n\n")
        # Alignment theo bảng SSA CŨ (libass dùng cho force_style của .srt): 7 = góc trên phải — 9 là GIỮA-TRÁI
        # (đo điểm ảnh 3/10/2026, đặt 9 theo bàn phím số ASS là nhãn nằm giữa khung). Chữ trắng mờ ~75 %, viền mảnh.
        vf_wm = ("subtitles=wm.srt:force_style='FontName=Segoe UI,FontSize=11,Bold=1,PrimaryColour=&H40FFFFFF,"
                 "OutlineColour=&H80000000,Outline=1,Shadow=0,Alignment=7,MarginR=16,MarginV=14'")
    r = burn(",".join(x for x in (vf_subs, vf_wm) if x))
    if r.returncode and vf_subs and vf_wm:
        logger.warning("subtitles failed (%s) — retrying with the AI label only", r.stderr[-200:])
        r = burn(vf_wm)
    if r.returncode:
        if watermark:
            raise RuntimeError(f"Could not burn the AI label into the video: {r.stderr[-300:]}")
        logger.warning("subtitles failed (%s) — keeping the version without subtitles", r.stderr[-200:])
        shutil.move(tmp, out)
    else:
        os.remove(tmp)
    return out


def _ts(s: float) -> str:
    return "%02d:%02d:%02d,%03d" % (s // 3600, (s % 3600) // 60, s % 60, int((s * 1000) % 1000))


# ── pipe ──────────────────────────────────────────────────────────────────────

def run_kind(kind: str, payload: Dict[str, Any], report=None, is_cancelled=None) -> str:
    if kind != KIND:
        raise RuntimeError(f"Unknown pod_studio kind {kind!r}")
    return run(payload, report, is_cancelled)


def run(payload: Dict[str, Any], report=None, is_cancelled=None) -> str:
    report = report or (lambda *a, **k: None)
    is_cancelled = is_cancelled or (lambda: False)
    task_id = str(payload.get("task_id") or int(time.time()))
    labels = dict(STEPS)
    log: List[str] = []

    def say(step: str, msg: str, status: str = "running", progress=None):
        log.append(f"[{step}] {msg}")
        report(step, status, msg, label=labels.get(step, step), progress=progress)

    def check():
        if is_cancelled():
            raise Cancelled()

    st = load_state(task_id)
    proj = _project_dir(task_id)
    fmt = str(payload.get("format") or "ad").lower()
    fmt = fmt if fmt in FORMATS else "ad"
    n = max(1, min(MAX_CLIPS, int(payload.get("clips") or 3)))
    aspect = str(payload.get("aspect") or "9:16")
    aspect = aspect if aspect in ASPECTS else "9:16"
    request = str(payload.get("request") or "").strip()
    style_custom = str(payload.get("style_custom") or "").strip()[:300]     # câu tả kiểu hình riêng (thường từ mẫu)
    try:
        # ── intake ──
        check()
        if not st.get("intake"):
            say("intake", "Saving the reference images and creating the Pod Studio project…")
            models = [p for p in (_resolve_image(x) for x in (payload.get("model_images") or [])) if p][:MAX_MODELS]
            products = [p for p in (_resolve_image(x) for x in (payload.get("product_images") or [])) if p][:MAX_PRODUCTS]
            if not models:
                raise RuntimeError("No model/character image was received — the pipeline needs at least one.")
            if not request:
                raise RuntimeError("The request is empty — say what the video is about (and the lines to say).")
            db = _db()
            title = str(payload.get("title") or request.split("\n")[0][:60] or "Video").strip()
            camp = db.create_campaign({"title": title, "description": request[:500], "genre": fmt, "language": str(payload.get("language") or "vi"),
                                       "metadata": {"source": "ref_video", "task_id": task_id, "format": fmt, "aspect": aspect, "clips": n}})
            ep = db.create_episode(camp["id"], {"title": title, "episode_number": 1, "content": request, "script_content": request})
            chars = []
            # Quảng cáo / video ngắn: MỌI ảnh người mẫu là MỘT người (nhiều góc: chân dung, toàn thân…) — ảnh đầu làm
            # chân dung đính vào clip, các ảnh còn lại bổ sung khi mô tả. Drama: mỗi ảnh một nhân vật.
            groups = [[p] for p in models] if fmt == "drama" else [models]
            for i, imgs in enumerate(groups, 1):
                c = db.create_character(camp["id"], {"name": f"Character {i}" if len(groups) > 1 else "Model", "role": "presenter",
                                                     "image_url": imgs[0], "reference_images": json.dumps(imgs)})
                chars.append({"id": c["id"], "name": c["name"], "image": imgs[0], "images": imgs, "role": "presenter"})
            prods = []
            for i, p in enumerate(products, 1):
                c = db.create_character(camp["id"], {"name": f"Product {i}" if len(products) > 1 else "Product", "role": "product",
                                                     "image_url": p, "reference_images": json.dumps([p])})
                prods.append({"id": c["id"], "name": c["name"], "image": p, "role": "product"})
            st.update({"intake": True, "campaign_id": camp["id"], "episode_id": ep["id"], "title": title,
                       "models": chars, "products": prods})
            save_state(task_id, st)
            say("intake", f"{len(models)} model image(s), {len(products)} product image(s) → Pod Studio campaign #{camp['id']}", "success")
        models, products = st["models"], st["products"]

        # ── character ──
        check()
        if not st.get("character"):
            db = _db()
            for c in models:
                say("character", f"Describing {c['name']} from the image (10-point character sheet)…")
                c["appearance"] = describe(c.get("images") or [c["image"]], APPEARANCE_PROMPT, lambda m: say("character", m))
                c["gender"] = guess_gender(c["appearance"])
                c["style"] = art_style(c["appearance"])
                db.update_character(c["id"], {"appearance": c["appearance"]})
            for p in products:
                say("character", f"Describing {p['name']}…")
                p["appearance"] = describe([p["image"]], PRODUCT_PROMPT, lambda m: say("character", m))
                db.update_character(p["id"], {"appearance": p["appearance"]})
            st["character"] = True
            save_state(task_id, st)
            got = sum(1 for c in models if c.get("appearance"))
            say("character", f"Character sheet written for {got}/{len(models)} model(s)"
                + ("" if got else " — no vision model available, the prompts use your text only"), "success")

        # ── shots ──
        check()
        if not st.get("plan"):
            say("shots", f"Planning {n} shots ({fmt}) and placing the lines…")
            plan = plan_shots(fmt=fmt, request=request, characters=models, products=products, n=n, say=lambda m: say("shots", m))
            st["plan"] = plan
            save_state(task_id, st)
            db = _db()
            db.save_storyboards_bulk(st["episode_id"], [{
                "title": s["title"], "shot_type": s["camera"], "action": s["action"], "description": s["scene"],
                "video_prompt": s["scene"] + (" " + speak_block(s["dialogue"]) if s["dialogue"] else ""),
                "dialogue": (f"{s['speaker']}: " if s["speaker"] else "") + s["dialogue"], "duration": CLIP_SECONDS,
            } for s in plan["shots"]], append=False)
            spoken = sum(1 for s in plan["shots"] if s["dialogue"])
            say("shots", f"{len(plan['shots'])} shots, {spoken} with a spoken line · {plan['environment'][:80]}", "success")
        plan = st["plan"]

        # ── board ──
        check()
        if not st.get("board_done"):
            import sys
            if _EXT_DIR not in sys.path:
                sys.path.insert(0, _EXT_DIR)
            import panorama
            style = resolve_style(payload.get("style"), models[0].get("style") if models else "")
            prompt = panorama.build_board_prompt(title=plan["title"], fmt=fmt, characters=models, products=products,
                                                 environment=plan["environment"], shots=plan["shots"],
                                                 style="Photorealistic" if style == "photo" and not style_custom
                                                 else f"{style_name(style, style_custom)} (same rendering style as the character reference)")
            refs = [c["image"] for c in models] + [p["image"] for p in products]
            engines = [e for e in str(payload.get("board_engines") or "chatgpt,muse,9router").split(",") if e.strip()]
            res = panorama.draw_board(prompt, refs, os.path.join(proj, "board.png"), engines=engines,
                                      chatgpt_profile=str(payload.get("chatgpt_profile") or ""), ext_dir=_EXT_DIR,
                                      say=lambda m: say("board", m))
            st["board_done"] = True
            st["board"] = res
            save_state(task_id, st)
            if res.get("ok"):
                try:
                    db = _db()
                    ref_dir = os.path.join(_data_dir(), "references")
                    os.makedirs(ref_dir, exist_ok=True)
                    fname = f"panorama_ep{st['episode_id']}_refvideo.png"
                    shutil.copyfile(res["path"], os.path.join(ref_dir, fname))
                    db.update_episode(st["episode_id"], {"metadata": json.dumps({
                        "panorama_image_url": f"/api/v1/pod_studio/references/{fname}", "panorama_image_path": res["path"],
                        "panorama_prompt": prompt, "scene_mode": True})})
                except Exception as e:      # noqa: BLE001
                    logger.warning("could not attach the board to the episode: %s", e)
                say("board", f"Scene Panorama drawn by {res['engine']} in {res.get('seconds', 0)} s", "success")
            else:
                say("board", "No engine could draw the board (" + "; ".join(res.get("tried") or []) [:300]
                    + ") — the clips use the reference images only", "skipped")

        # ── đọc bảng: bối cảnh · ánh sáng · sơ đồ không gian · góc máy/vị trí từng cut (vào prompt mọi clip) ──
        if (st.get("board") or {}).get("ok") and "board_notes" not in st:
            check()
            say("board", "Reading the board: environment, lighting, camera angles and timeline…")
            try:
                st["board_notes"] = read_board(st["board"]["path"], n, lambda m: say("board", m))
            except Exception as e:      # noqa: BLE001
                say("board", f"Could not read the board ({str(e)[:100]}) — the clips use the written plan")
                st["board_notes"] = {}
            save_state(task_id, st)
            if st["board_notes"].get("environment"):
                say("board", f"Board read — set: {st['board_notes']['environment'][:100]}…", "success")

        # ── clips ──
        check()
        from tubecli.core import muse
        if not muse.settings()["profile"]:
            raise RuntimeError("Muse is not set up: pick the browser profile signed in to muse.ai in Cloud API Keys → Muse.")
        clips = st.setdefault("clips", {})
        main = models[0]
        style = resolve_style(payload.get("style"), main.get("style"))
        # Nhận dạng = ảnh + mô tả NGƯỜI DÙNG đưa vào (bảng nhân vật rút từ chính ảnh đó); bảng panorama không dính tới nhận dạng.
        ident = "\n\n".join(identity_block(c["name"], c.get("appearance", ""), request) for c in models[:2]) + "\n" + style_block(style, style_custom)
        # Bảng panorama gửi NGUYÊN cho Muse làm tham chiếu bối cảnh + storyboard, chỉ cần nói làm clip từ CUT nào — không cắt
        # (user 2/10/2026: "bản thân cái panorama là tham chiếu rồi, chỉ là Muse chưa biết làm video từ đoạn nào").
        board = ""
        if (st.get("board") or {}).get("ok") and os.path.isfile(str(st["board"].get("path") or "")):
            board = shrink_image(st["board"]["path"], os.path.join(proj, "board_ref.jpg"))
        thread = st.get("thread") or "new"
        for i, shot in enumerate(plan["shots"], 1):
            check()
            if str(i) in clips and os.path.isfile(clips[str(i)]["path"]):
                continue
            # nhân vật có mặt trong cảnh: người nói trước, rồi nhân vật chính — tối đa 2 chân dung (Muse nhận 3 ảnh)
            cast = [c for c in models if shot.get("speaker") and c["name"].lower() == shot["speaker"].lower()] or [main]
            cast = (cast + [c for c in models if c not in cast])[:2]
            # Nối clip: KHUNG CUỐI clip trước CHÍNH LÀ khung đầu clip sau (không vẽ lại — user 2/10/2026); chân dung đính vào
            # mọi clip (neo danh tính + kiểu vẽ); ảnh thứ 3 = nhân vật 2 (nếu có trong cảnh) hoặc BẢNG hoặc sản phẩm.
            scene = (board_block(i, aspect) if board else "") + scene_block(plan, st.get("board_notes") or {}, i, n)
            third = [cast[1]["image"]] if len(cast) > 1 else ([board] if board else ([products[0]["image"]] if products else []))
            if i == 1:
                startf = os.path.join(proj, "clip1_start.jpg")
                if not os.path.isfile(startf):
                    say("clips", "Muse is drawing the first frame from the reference images…", progress=0)
                    refs = [cast[0]["image"]] + ([products[0]["image"]] if products else []) + ([board] if board else [])
                    try:
                        data = muse.generate_image_bytes(
                            f"A single {style_name(style, style_custom)} {aspect} frame: {shot['scene']} The person must be the SAME individual as in the "
                            "attached reference portrait (same face, hair and outfit)" + (", with the attached product." if products else ".")
                            + " The portrait wins for identity.\n\n" + scene + "\n\n" + ident, aspect, refs[:3])
                    except Exception as e:      # noqa: BLE001
                        if getattr(e, "kind", "") in ("config", "auth", "busy", "browser"):
                            raise
                        # Tự sửa (việc #164): Muse trả CHỮ thay ảnh — thường vì câu lệnh mang chi tiết đá nhau (trang phục
                        # trong cảnh ≠ ảnh người mẫu, bảng panorama vẽ khác). Thử lại MỘT lần: chỉ bối cảnh + tư thế đầu +
                        # đúng ảnh người mẫu, KHÔNG bảng. Lần hai vẫn hỏng thì lời của Muse đi tới khách (public_hire).
                        say("clips", f"Muse did not draw the first frame ({' '.join(str(e).split())[:140]}) — retrying once "
                                     "with a simpler prompt: only the set, the start pose and the person exactly as in the photo")
                        data = muse.generate_image_bytes(
                            f"A single {style_name(style, style_custom)} {aspect} frame. Setting: {plan.get('environment', '')} "
                            f"{shot.get('start') or ''} The person is EXACTLY the individual in the attached reference portrait: "
                            "same face, hair, outfit and accessories as in the photo — do not change or add clothing."
                            + (" They hold or show the attached product." if products else "") + "\n\n" + ident,
                            aspect, ([cast[0]["image"]] + ([products[0]["image"]] if products else []))[:3])
                        say("clips", "First frame drawn on the second try")
                    with open(startf, "wb") as f:
                        f.write(data)
                refs = [startf, cast[0]["image"]] + third
            else:
                refs = [last_frame(clips[str(i - 1)]["path"], os.path.join(proj, f"clip{i-1}_last.jpg")), cast[0]["image"]] + third
            say("clips", f"Clip {i}/{n}: {shot['title']}" + (f" — says «{shot['dialogue'][:60]}»" if shot["dialogue"] else ""),
                progress=int((i - 1) / n * 100))
            prompt = (f"{shot['scene']} Camera: {shot['camera']}. "
                      + (speak_block(shot["dialogue"], cast[0].get("gender", "")) if shot["dialogue"] else SILENT_BLOCK)
                      + "\n\n" + scene + "\n\n" + ident)
            t0 = time.time()
            for attempt in (1, 2):
                try:
                    v = muse.generate_video_clip(prompt, os.path.join(proj, f"clip{i}"), refs[:3], aspect, continue_from=True, thread_id=thread)
                    break
                except Exception as e:      # noqa: BLE001
                    if attempt == 2 or getattr(e, "kind", "") in ("refused", "config", "auth"):
                        raise
                    # #160 (2/10): ngay sau khi clip 1 xong, ô soạn tin của thread chưa hiện trong 30 s → nghỉ rồi thử lại MỘT lần
                    say("clips", f"Clip {i}: Muse did not answer ({str(e)[:90]}) — retrying once in 20 s")
                    time.sleep(RETRY_WAIT)
            thread = v.get("thread_id") or thread
            name = f"rv_{re.sub(r'[^0-9A-Za-z]', '', task_id)[:12]}_clip{i}.mp4"
            dst = os.path.join(_videos_dir(), name)
            shutil.copyfile(v["path"], dst)
            clips[str(i)] = {"path": dst, "url": f"/api/v1/pod_studio/grok-video/{name}", "seconds": round(time.time() - t0)}
            st["thread"] = thread
            save_state(task_id, st)
            try:
                db = _db()
                sbs = db.list_storyboards(st["episode_id"])
                if i - 1 < len(sbs):
                    db.update_storyboard(sbs[i - 1]["id"], {"video_url": clips[str(i)]["url"], "status": "done"})
            except Exception as e:      # noqa: BLE001
                logger.warning("storyboard video_url: %s", e)
            say("clips", f"Clip {i}/{n} done in {clips[str(i)]['seconds']} s", progress=int(i / n * 100))
        say("clips", f"{n} clip(s) ready", "success", progress=100)

        # ── render ──
        check()
        if not st.get("final"):
            say("render", "Joining the clips with ffmpeg…")
            paths = [clips[str(i)]["path"] for i in range(1, n + 1)]
            fname = f"refvideo_{re.sub(r'[^0-9A-Za-z]', '', task_id)[:12]}_{int(time.time())}.mp4"
            out = os.path.join(_exports_dir(), fname)
            subs = [s["dialogue"] for s in plan["shots"]] if payload.get("subtitles") else None
            concat(paths, out, subs, workdir=proj, watermark=WATERMARK_TEXT if payload.get("watermark") else "")
            st["final"] = {"path": out, "url": f"/api/v1/pod_studio/export-video/{fname}"}
            save_state(task_id, st)
            try:
                db = _db()
                db.update_episode(st["episode_id"], {"video_url": st["final"]["url"], "status": "done"})
                db.update_campaign(st["campaign_id"], {"status": "done"})
            except Exception as e:      # noqa: BLE001
                logger.warning("episode video_url: %s", e)
            say("render", f"{n * CLIP_SECONDS} s video ready", "success")
    except Cancelled:
        say("clips", "Cancelled by the user", "error")
        raise
    except Exception as e:
        step = (log[-1].split("]")[0].strip("[") if log else "intake")
        report(step, "error", str(e)[:400], label=labels.get(step, step))
        raise

    final = st["final"]
    lines = [f"# {st.get('title') or 'Video'}", "",
             f"**Video ({n * CLIP_SECONDS} s, {aspect}):** {final['url']}", f"File: `{final['path']}`", "",
             f"Pod Studio campaign #{st['campaign_id']} · episode #{st['episode_id']} — board, cuts and every clip are there.", ""]
    for i, s in enumerate(plan["shots"], 1):
        lines.append(f"{i}. **{s['title']}** — {s['scene'][:120]}" + (f" — «{s['dialogue']}»" if s["dialogue"] else ""))
    if (st.get("board") or {}).get("ok"):
        lines += ["", f"Scene Panorama: `{st['board']['path']}` ({st['board']['engine']})"]
    return "\n".join(lines)


# ── mô tả loại việc cho cửa sổ «Nhiệm vụ mới» của Codex ───────────────────────

def task_kind_spec() -> Dict[str, Any]:
    L = lambda en, vi: {"en": en, "vi": vi}      # noqa: E731
    return {
        "id": KIND, "icon": "shopping_bag", "order": 20,
        "label": L("Video from reference images", "Video từ ảnh tham chiếu"),
        "hint": L("Model + product photos and a request (with the lines to say) → Scene Panorama → Muse clips that keep the "
                  "same person and outfit", "Ảnh người mẫu + sản phẩm và yêu cầu (kèm thoại) → Scene Panorama → chuỗi clip Muse giữ "
                  "đúng người, đúng đồ"),
        "submit_label": L("Create video", "Tạo video"),
        "submit_url": "/api/v1/pod_studio/ref-video/run",
        "upload_url": "/api/v1/pod_studio/gallery/upload-image",
        # Mẫu ở kho mẫu chung của lõi (dùng chung với Content Studio): chọn mẫu → điền các ô TEMPLATE_KEYS
        # (option có `fills`); «Lưu thành mẫu» gửi các ô ấy tới template_save_url.
        "template_field": "template",
        "template_keys": list(TEMPLATE_KEYS),
        "template_save_url": "/api/v1/pod_studio/ref-video/templates",
        "fields": [
            {"key": "template", "type": "select", "label": L("Template", "Mẫu"),
             "options_url": "/api/v1/pod_studio/ref-video/options/templates",
             "hint": L("Fills the style, format, clips… — templates are shared with Content Studio",
                       "Điền sẵn kiểu hình, thể loại, số clip… — mẫu dùng chung với Content Studio")},
            {"key": "model_images", "type": "images", "required": True, "max": MAX_MODELS,
             "label": L("Model / character photos", "Ảnh người mẫu / nhân vật"),
             "hint": L("A clear front view works best; up to 3 characters for drama", "Ảnh chính diện rõ mặt; drama được tới 3 nhân vật")},
            {"key": "product_images", "type": "images", "required": False, "max": MAX_PRODUCTS,
             "label": L("Product photos (optional)", "Ảnh sản phẩm (không bắt buộc)")},
            {"key": "request", "type": "textarea", "required": True, "rows": 5,
             "label": L("Request", "Yêu cầu"),
             "placeholder": L("What the video shows, where, in what mood — and the lines to say in quotes, e.g. «I was created with tubecli.app»",
                              "Video quay gì, ở đâu, không khí thế nào — và các câu thoại trong ngoặc kép, vd «Tôi được tạo từ tubecli.app»")},
            {"key": "format", "type": "select", "default": "ad", "label": L("Format", "Thể loại"),
             "options": [{"value": "ad", "label": L("Ad", "Quảng cáo")}, {"value": "short", "label": L("Short video", "Video ngắn")},
                         {"value": "drama", "label": L("Drama scene", "Drama")}]},
            {"key": "clips", "type": "number", "default": 3, "min": 1, "max": MAX_CLIPS,
             "label": L("Clips (×10 s)", "Số clip (×10 s)")},
            {"key": "aspect", "type": "select", "default": "9:16", "label": L("Aspect ratio", "Khung hình"),
             "options": [{"value": "9:16", "label": "9:16"}, {"value": "16:9", "label": "16:9"}, {"value": "1:1", "label": "1:1"}]},
            {"key": "style", "type": "select", "default": "auto", "label": L("Rendering style", "Kiểu hình"),
             "options": [{"value": "auto", "label": L("Same as the photo (auto)", "Giống ảnh (tự nhận)")}]
                        + [{"value": k, "label": v["label"]} for k, v in STYLE_PRESETS.items()],
             "hint": L("Kept the same in every clip", "Giữ nguyên trong mọi clip")},
            {"key": "style_custom", "type": "text", "label": L("Style description (optional)", "Mô tả kiểu hình (không bắt buộc)"),
             "placeholder": L("e.g. Japanese Edo watercolor, soft paper texture", "vd Tranh màu nước Nhật thời Edo, nền giấy mềm")},
            {"key": "chatgpt_profile", "type": "select", "label": L("Browser profile signed in to ChatGPT (for the board)",
                                                                   "Hồ sơ trình duyệt đã đăng nhập ChatGPT (vẽ bảng)"),
             "options_url": "/api/v1/pod_studio/ref-video/options/profiles",
             "hint": L("Leave empty to draw the board with Muse, then gpt-image-2", "Để trống thì vẽ bảng bằng Muse, rồi gpt-image-2")},
            {"key": "subtitles", "type": "checkbox", "default": False, "label": L("Burn subtitles of the lines", "Đốt phụ đề các câu thoại")},
            {"key": "title", "type": "text", "label": L("Title (optional)", "Tiêu đề (không bắt buộc)")},
        ],
    }
