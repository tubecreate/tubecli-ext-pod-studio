"""Mẫu của Pod Studio trên KHO MẪU CHUNG của lõi (tubecli.core.templates) — dùng chung với Content Studio (3/10/2026).

  GET/POST/DELETE /api/v1/pod_studio/presets      preset của trình hướng dẫn (static/studio2.js — cùng bộ khoá wiz* với
                                                  Content Studio → phần "wizard"). Trước đây route này KHÔNG có nên
                                                  preset chỉ sống trong localStorage của một trình duyệt.
  GET  /api/v1/pod_studio/ref-video/options/templates   mẫu cho ô «Mẫu» của form Bảng việc (mỗi mẫu kèm `fills`)
  POST /api/v1/pod_studio/ref-video/templates           «Lưu thành mẫu» từ form → phần "ref_video"

Lõi cũ (< 2026.08.09.192) không có kho chung: preset trả success:false (trình hướng dẫn giữ localStorage như cũ),
danh sách mẫu chỉ có dòng trống, lưu mẫu → 501.
"""
from __future__ import annotations

import json
import logging
import os
import sys
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

logger = logging.getLogger("PodStudio.Templates")
router = APIRouter(prefix="/api/v1/pod_studio", tags=["pod_studio"])
_EXT_DIR = os.path.dirname(os.path.abspath(__file__))
ORIGIN = "pod_studio"


def _store():
    try:
        from tubecli.core import templates as T
        return T
    except ImportError:
        return None


def _pipe():
    if _EXT_DIR not in sys.path:
        sys.path.insert(0, _EXT_DIR)
    import ref_video_pipeline
    return ref_video_pipeline


def _deny_guest(request: Request) -> None:
    if getattr(request.state, "guest_scope", None):
        raise HTTPException(403, "Not available in a shared workspace.")


def _name(n: Any) -> str:
    n = n.strip() if isinstance(n, str) else ""
    if not n:
        raise HTTPException(400, "Template name is required")
    return n[:120]


def _data(d: Any) -> Dict[str, Any]:
    if isinstance(d, str):
        try:
            d = json.loads(d)
        except ValueError:
            raise HTTPException(400, "Preset data is not valid JSON")
    if not isinstance(d, dict):
        raise HTTPException(400, "Preset data must be an object")
    return d


# ── preset của trình hướng dẫn ───────────────────────────────────────────────

@router.get("/presets")
async def list_presets():
    T = _store()
    if T is None:
        return {"success": False, "presets": {}, "message": "This TubeCLI core has no shared template store."}
    return {"success": True, "presets": {t["name"]: T.section_view(t, "wizard") for t in T.list_templates()}}


@router.post("/presets")
async def save_presets(request: Request):
    _deny_guest(request)
    T = _store()
    if T is None:
        raise HTTPException(501, "This TubeCLI core has no shared template store — update TubeCLI.")
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(400, "Body must be an object")
    items = body.get("presets") if "presets" in body else {body.get("name"): body.get("data")}
    if not isinstance(items, dict):
        raise HTTPException(400, "presets must be an object")
    cleaned = [(_name(n), _data(d)) for n, d in items.items()]      # kiểm hết trước, lô hỏng thì không ghi gì
    saved = []
    for name, data in cleaned:
        T.save_section(name, "wizard", data, origin=ORIGIN)
        saved.append(name)
    return {"success": True, "saved": saved}


@router.delete("/presets/{name:path}")
async def delete_preset(name: str, request: Request):
    _deny_guest(request)
    T = _store()
    if T is None:
        raise HTTPException(501, "This TubeCLI core has no shared template store — update TubeCLI.")
    t = T.get_template(_name(name))
    if t and t.get("name") == name.strip():
        T.delete_template(t["id"])
    return {"success": True}


# ── mẫu cho pipe «Video từ ảnh tham chiếu» ───────────────────────────────────

def fills_of(view: Dict[str, Any]) -> Dict[str, Any]:
    """Phần ref_video của một mẫu → giá trị điền vào form (chỉ các ô mẫu quản; kiểu hình luôn có để xoá giá trị cũ)."""
    P = _pipe()
    out: Dict[str, Any] = {k: view[k] for k in P.TEMPLATE_KEYS if k in view}
    out["style"] = out.get("style") if out.get("style") in P.STYLE_PRESETS else "auto"
    out["style_custom"] = str(out.get("style_custom") or "")
    return out


@router.get("/ref-video/options/templates")
async def template_options():
    T = _store()
    opts = [{"value": "", "label": "—"}]
    if T is not None:
        for t in sorted(T.list_templates(), key=lambda x: str(x.get("name") or "").casefold()):
            opts.append({"value": t["name"], "label": t["name"], "origin": t.get("origin") or "",
                         "fills": fills_of(T.section_view(t, "ref_video"))})
    return {"options": opts}


class FromTask(BaseModel):
    task_id: str = "latest"
    name: str
    include_model: bool = True


def _latest_task(P) -> str:
    """Task «Video từ ảnh tham chiếu» gần nhất ĐÃ ra video (thư mục dự án có state.json với final)."""
    root = os.path.join(P._data_dir(), "ref_video")
    best, best_t = "", 0.0
    try:
        names = os.listdir(root)
    except OSError:
        return ""
    for n in names:
        p = os.path.join(root, n, "state.json")
        try:
            t = os.path.getmtime(p)
            with open(p, encoding="utf-8") as f:
                if t > best_t and (json.load(f) or {}).get("final"):
                    best, best_t = n, t
        except (OSError, ValueError):
            continue
    return best


def _task_payload(P, task_id: str) -> Dict[str, Any]:
    """Payload lúc xếp task (event `log` mang kind pod_studio.video trên Bảng việc) — kiểu hình/thể loại người gọi chọn."""
    try:
        from tubecli.extensions.codex.manager import codex_manager
        for ev in reversed(codex_manager.get_events(task_id, limit=0) or []):
            d = ev.get("data") if isinstance(ev, dict) else None
            if isinstance(d, dict) and d.get("kind") == P.KIND:
                return d
    except Exception as e:      # noqa: BLE001
        logger.warning("from-task: events of %s: %s", task_id, e)
    return {}


@router.post("/ref-video/templates/from-task")
async def template_from_task(body: FromTask, request: Request):
    """Lưu MẪU từ một task đã chạy (mặc định: task gần nhất ra video) — kiểu hình, thể loại, số clip, khung hình và
    NGƯỜI MẪU của task (ảnh chép riêng vào thư mục mẫu: dọn kho ảnh không làm mẫu mất người mẫu). Dùng cho việc thuê
    trên Town (khách chỉ gửi ảnh sản phẩm) và cho Codex ChatGPT trên VPS (user 3/10/2026)."""
    _deny_guest(request)
    T = _store()
    if T is None:
        raise HTTPException(501, "This TubeCLI core has no shared template store — update TubeCLI.")
    P = _pipe()
    name = _name(body.name)
    tid = (body.task_id or "").strip()
    if tid in ("", "latest"):
        tid = _latest_task(P)
        if not tid:
            raise HTTPException(404, "No finished «Video from reference images» task yet.")
    st = P.load_state(tid)
    if not st.get("intake"):
        raise HTTPException(404, f"Task {tid} has no reference-video project on this machine.")
    pay = _task_payload(P, tid)
    model = (st.get("models") or [{}])[0]
    style = pay.get("style") if pay.get("style") in P.STYLE_PRESETS else (model.get("style") if model.get("style") in P.STYLE_PRESETS else "auto")
    data: Dict[str, Any] = {
        "format": pay.get("format") if pay.get("format") in P.FORMATS else "ad",
        "clips": max(1, min(P.MAX_CLIPS, int(pay.get("clips") or len(st.get("clips") or {}) or 3))),
        "aspect": pay.get("aspect") if pay.get("aspect") in P.ASPECTS else "9:16",
        "style": style, "style_custom": str(pay.get("style_custom") or "")[:300],
        "subtitles": bool(pay.get("subtitles")),
    }
    copied: List[str] = []
    if body.include_model:
        import re
        import shutil
        slug = re.sub(r"[^\w-]+", "_", name, flags=re.UNICODE).strip("_")[:40] or "template"
        dst_dir = os.path.join(P._data_dir(), "templates", slug)
        os.makedirs(dst_dir, exist_ok=True)
        for i, src in enumerate([p for p in (model.get("images") or [model.get("image")]) if p and os.path.isfile(p)][:P.MAX_MODELS], 1):
            dst = os.path.join(dst_dir, f"model_{i}{os.path.splitext(src)[1].lower() or '.jpg'}")
            shutil.copyfile(src, dst)
            copied.append(dst)
        data["model_images"] = copied
    t = T.save_section(name, "ref_video", data, origin=ORIGIN)
    return {"success": True, "task_id": tid, "template": {"id": t["id"], "name": t["name"], "model_images": len(copied),
                                                          "fills": fills_of(T.section_view(t, "ref_video"))}}


class SaveTemplate(BaseModel):
    name: str
    values: Dict[str, Any] = {}


@router.post("/ref-video/templates")
async def save_template(body: SaveTemplate, request: Request):
    _deny_guest(request)
    T = _store()
    if T is None:
        raise HTTPException(501, "This TubeCLI core has no shared template store — update TubeCLI.")
    P = _pipe()
    v = body.values or {}
    data: Dict[str, Any] = {}
    if v.get("format") in P.FORMATS:
        data["format"] = v["format"]
    try:
        if v.get("clips") not in (None, ""):
            data["clips"] = max(1, min(P.MAX_CLIPS, int(v["clips"])))
    except (TypeError, ValueError):
        raise HTTPException(400, "clips must be a number")
    if v.get("aspect") in P.ASPECTS:
        data["aspect"] = v["aspect"]
    if "style" in v:
        data["style"] = v["style"] if v["style"] in P.STYLE_PRESETS else "auto"
    if "style_custom" in v:
        data["style_custom"] = str(v.get("style_custom") or "").strip()[:300]
    if "subtitles" in v:
        data["subtitles"] = v["subtitles"] in (True, 1, "1", "true", "on")
    # Pod 1.3.3: kiểu quay + kiểu giọng nằm trong mẫu (TEMPLATE_KEYS); lõi/pipe cũ không có thì bỏ qua.
    if "camera_style" in v:
        data["camera_style"] = v["camera_style"] if v["camera_style"] in getattr(P, "CAMERA_STYLES", {}) else "auto"
    if "voice" in v:
        data["voice"] = v["voice"] if v["voice"] in getattr(P, "VOICE_PRESETS", {}) else "auto"
    if "voice_custom" in v:
        data["voice_custom"] = str(v.get("voice_custom") or "").strip()[:200]
    name = _name(body.name)
    # Người mẫu MẶC ĐỊNH của mẫu (user 3/10/2026: «mỗi style là 1 template»): ảnh chép riêng vào thư mục mẫu như
    # from-task — dọn kho ảnh không làm mẫu mất người mẫu. Nhận đường dẫn / URL gallery / {url, filepath}.
    if isinstance(v.get("model_images"), list):
        import re
        import shutil
        slug = re.sub(r"[^\w-]+", "_", name, flags=re.UNICODE).strip("_")[:40] or "template"
        dst_dir = os.path.join(P._data_dir(), "templates", slug)
        os.makedirs(dst_dir, exist_ok=True)
        copied: List[str] = []
        for i, src in enumerate([s for s in (P._resolve_image(x) for x in v["model_images"]) if s][:P.MAX_MODELS], 1):
            dst = os.path.join(dst_dir, f"model_{i}{os.path.splitext(src)[1].lower() or '.jpg'}")
            if os.path.abspath(src) != os.path.abspath(dst):
                shutil.copyfile(src, dst)
            copied.append(dst)
        data["model_images"] = copied
    if not data:
        raise HTTPException(400, "Nothing to save — the template needs at least one setting.")
    t = T.save_section(name, "ref_video", data, origin=ORIGIN)
    return {"success": True, "template": {"id": t["id"], "name": t["name"], "fills": fills_of(T.section_view(t, "ref_video"))}}


# ── ẢNH BÌA MẪU (3/10/2026: 30 mẫu kiểu nghệ thuật cần bìa riêng trên Town) ───────────────────────────────────────
# Một khung Muse theo kiểu của mẫu + người mẫu mặc định (≈1 phút) thay vì dựng cả video. Lưu cạnh ảnh người mẫu của mẫu
# và ghi khoá "cover" vào phần ref_video; GET trả ảnh để Bảng việc / cloud lấy.
class CoverBody(BaseModel):
    force: bool = False
    aspect: str = ""        # "" = khung hình của mẫu; "16:9" / "9:16" / "1:1" = bản bìa riêng cho khung đó


def _cover_path(P, t: Dict[str, Any], aspect: str = "") -> str:
    import re
    slug = re.sub(r"[^\w-]+", "_", str(t.get("name") or ""), flags=re.UNICODE).strip("_")[:40] or "template"
    suffix = "" if not aspect or aspect == "9:16" else "_" + aspect.replace(":", "")
    return os.path.join(P._data_dir(), "templates", slug, f"cover{suffix}.jpg")


def _cover_key(aspect: str) -> str:
    return "cover" if not aspect or aspect == "9:16" else "cover_" + aspect.replace(":", "")


@router.post("/ref-video/templates/{key:path}/cover")
async def template_cover(key: str, request: Request, body: CoverBody = CoverBody()):
    _deny_guest(request)
    T = _store()
    if T is None:
        raise HTTPException(501, "This TubeCLI core has no shared template store — update TubeCLI.")
    P = _pipe()
    t = T.get_template(key)
    if not t:
        raise HTTPException(404, f"Template «{key}» not found")
    v = T.section_view(t, "ref_video")
    imgs = [p for p in (v.get("model_images") or []) if isinstance(p, str) and os.path.isfile(p)]
    if not imgs:
        raise HTTPException(400, "This template has no default model photo — a cover needs one.")
    aspect = body.aspect if body.aspect in P.ASPECTS else (v.get("aspect") if v.get("aspect") in P.ASPECTS else "9:16")
    want = body.aspect if body.aspect in P.ASPECTS else ""
    out = _cover_path(P, t, want)
    url = f"/api/v1/pod_studio/ref-video/templates/{t['id']}/cover" + (f"?aspect={want}" if want else "")
    if os.path.isfile(out) and not body.force:
        return {"success": True, "path": out, "cached": True, "url": url}
    style = P.resolve_style(v.get("style"), "")
    custom = str(v.get("style_custom") or "")
    preset = P.STYLE_PRESETS[style]
    prompt = (f"A single {P.style_name(style, custom)} {aspect} frame — the cover image of an ad-video template: the person "
              "from the attached reference portrait stands in a setting that fits this style, looks at the camera with a "
              "friendly smile and holds a small plain unbranded product (a cup, a bottle or a box). No text, captions, logos "
              "or watermarks.\n\n"
              f"RENDERING STYLE: {P.style_name(style, custom)}"
              + (f" ({preset['name']} — {preset['desc']})" if custom else f" — {preset['desc']}")
              + ". Redraw the person IN THIS STYLE — keep their face shape, hair, outfit and colors recognisable.")
    import asyncio
    from tubecli.core import muse
    try:
        data = await asyncio.to_thread(P.muse_image_fresh, muse, prompt, aspect, imgs[:1])
    except Exception as e:      # noqa: BLE001 — Muse từ chối / bận: nói lý do, không 500
        raise HTTPException(502, f"Muse did not draw the cover: {' '.join(str(e).split())[:200]}")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as f:
        f.write(data)
    T.save_section(t["name"], "ref_video", {_cover_key(want): out}, origin=ORIGIN)
    return {"success": True, "path": out, "cached": False, "url": url}


@router.get("/ref-video/templates/{key:path}/cover")
async def template_cover_get(key: str, aspect: str = ""):
    from fastapi.responses import FileResponse
    T = _store()
    t = T.get_template(key) if T else None
    if not t:
        raise HTTPException(404, f"Template «{key}» not found")
    v = T.section_view(t, "ref_video")
    P = _pipe()
    want = aspect if aspect in P.ASPECTS else ""
    p = str(v.get(_cover_key(want)) or "") or _cover_path(P, t, want)
    if not os.path.isfile(p):
        raise HTTPException(404, "This template has no cover yet.")
    return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "no-cache"})
