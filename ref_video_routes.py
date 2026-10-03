"""Route của pipe «Video từ ảnh tham chiếu»: tạo task Codex kind `pod_studio.video` + danh sách hồ sơ cho form.
Nạp bởi extension.get_routes (gộp vào router chính). Ảnh đã lên gallery qua POST /gallery/upload-image có sẵn."""
from __future__ import annotations

import logging
import os
import sys
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

logger = logging.getLogger("PodStudio.RefVideo")
router = APIRouter(prefix="/api/v1/pod_studio/ref-video", tags=["pod_studio"])
_EXT_DIR = os.path.dirname(os.path.abspath(__file__))


def _pipe():
    if _EXT_DIR not in sys.path:
        sys.path.insert(0, _EXT_DIR)
    import ref_video_pipeline
    return ref_video_pipeline


class RunRequest(BaseModel):
    model_images: List[Any] = []
    product_images: List[Any] = []
    request: str = ""
    format: str = "ad"
    clips: Any = 3
    aspect: str = "9:16"
    style: str = "auto"
    style_custom: str = ""
    template: str = ""
    watermark: Any = False          # nhãn «AI · tubecli.app» — việc thuê trên Town luôn bật
    hire: str = ""                  # mã việc thuê Town (core/public_hire) — ghi vào origin của task để chủ thấy
    chatgpt_profile: str = ""
    subtitles: Any = False
    title: str = ""
    language: str = ""
    board_engines: str = ""
    created_by: str = "user"
    queue: bool = False


def _apply_template(req: "RunRequest", P) -> None:
    """Có `template`: các ô mẫu quản mà người gọi KHÔNG gửi thì lấy theo mẫu (form Bảng việc đã tự điền khi chọn mẫu;
    đường này cho agent/API chỉ gửi tên mẫu + ảnh + yêu cầu). Mẫu không có → 404."""
    name = (req.template or "").strip()
    if not name:
        return
    try:
        from tubecli.core import templates as T
    except ImportError:
        raise HTTPException(501, "This TubeCLI core has no shared template store — update TubeCLI.")
    t = T.get_template(name)
    if not t:
        raise HTTPException(404, f"Template «{name}» not found")
    sent = getattr(req, "model_fields_set", None) or getattr(req, "__fields_set__", set())
    view = T.section_view(t, "ref_video")
    for k in P.TEMPLATE_KEYS:
        if k not in sent and k in view:
            setattr(req, k, view[k])
    # NGƯỜI MẪU MẶC ĐỊNH của mẫu (vd cô tóc xanh 3D của task #161): người gọi không gửi ảnh người mẫu nào thì dùng
    # ảnh của mẫu — việc thuê trên Town: khách chỉ gửi ảnh sản phẩm + thoại. Chỉ nhận file CÓ THẬT trên máy.
    if not [x for x in (req.model_images or []) if P._resolve_image(x)]:
        own = [p for p in (view.get("model_images") or []) if isinstance(p, str) and os.path.isfile(p)]
        if own:
            req.model_images = own[:P.MAX_MODELS]


@router.get("/kind")
async def kind_spec():
    """Mô tả form (để kiểm / cho giao diện khác) — Codex lấy qua GET /api/v1/codex/task-kinds."""
    return _pipe().task_kind_spec()


@router.get("/options/profiles")
async def profile_options():
    """Hồ sơ trình duyệt để vẽ bảng bằng ChatGPT — {options: [{value, label}]}; dòng đầu = để trống."""
    opts = [{"value": "", "label": "—"}]
    try:
        from tubecli.extensions.browser.profile_manager import list_profiles
        for p in list_profiles():
            name = str(p.get("name") or "")
            if name and not name.endswith("_bas"):
                opts.append({"value": name, "label": name})
    except Exception as e:      # noqa: BLE001
        logger.warning("profiles: %s", e)
    return {"options": opts}


@router.post("/run")
async def run(req: RunRequest, request: Request):
    """Xếp một task «Video từ ảnh tham chiếu» lên Bảng việc (làn video, chạy liền hay vào hàng đợi)."""
    if getattr(request.state, "guest_scope", None):
        raise HTTPException(403, "Not available in a shared workspace.")
    P = _pipe()
    _apply_template(req, P)
    models = [x for x in req.model_images if P._resolve_image(x)]
    if not models:
        raise HTTPException(400, "Add at least one model/character photo.")
    if not req.request.strip():
        raise HTTPException(400, "Write the request (what the video shows and the lines to say).")
    try:
        from tubecli.extensions.codex.manager import codex_manager
    except ImportError:
        raise HTTPException(400, "The codex extension is required to run pipelines.")
    fmt = req.format if req.format in P.FORMATS else "ad"
    try:
        clips = max(1, min(P.MAX_CLIPS, int(req.clips or 3)))
    except (TypeError, ValueError):
        clips = 3
    title = (req.title or req.request.strip().split("\n")[0][:60]).strip()
    lines = P.extract_lines(req.request)
    goal = "\n".join([
        f"Make a {clips * P.CLIP_SECONDS}-second {fmt} video ({req.aspect}) from {len(models)} model photo(s)"
        + (f" and {len(req.product_images)} product photo(s)" if req.product_images else ""),
        "", req.request.strip()[:1500],
        "", "Steps: character sheet → scene panorama → storyboard cuts → Muse clips (same person, same outfit, the "
        "character speaks the lines) → join",
    ] + ([""] + [f"- Line: «{l}»" for l in lines] if lines else []))
    task = codex_manager.create_task(
        goal=goal, title=title[:150], created_by=req.created_by or "user",
        origin={"extension": "pod_studio", **({"hire": req.hire[:16]} if req.hire else {})},
        assignee_type="agent", assignee_id="", assignee_name="Pod Studio", approval_required=False,
        lane="video", hold=bool(req.queue))
    payload: Dict[str, Any] = {
        "kind": P.KIND, "task_id": task["id"], "model_images": req.model_images, "product_images": req.product_images,
        "request": req.request.strip(), "format": fmt, "clips": clips,
        "aspect": req.aspect if req.aspect in P.ASPECTS else "9:16", "chatgpt_profile": req.chatgpt_profile or "",
        "style": req.style if req.style in P.STYLE_PRESETS else "auto",
        "style_custom": (req.style_custom or "").strip()[:300], "template": (req.template or "").strip(),
        "watermark": req.watermark in (True, 1, "1", "true", "on"),
        "subtitles": bool(req.subtitles), "title": title, "language": req.language or "", "board_engines": req.board_engines or "",
    }
    codex_manager.append_event(task["id"], "log", f"Reference video queued: {clips} clip(s), {fmt}", actor=P.ACTOR, data=payload)
    return {"status": "queued", "task": task}
