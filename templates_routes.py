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
from typing import Any, Dict

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
    if not data:
        raise HTTPException(400, "Nothing to save — the template needs at least one setting.")
    t = T.save_section(_name(body.name), "ref_video", data, origin=ORIGIN)
    return {"success": True, "template": {"id": t["id"], "name": t["name"], "fills": fills_of(T.section_view(t, "ref_video"))}}
