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
    chatgpt_profile: str = ""
    subtitles: Any = False
    title: str = ""
    language: str = ""
    board_engines: str = ""
    created_by: str = "user"
    queue: bool = False


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
        goal=goal, title=title[:150], created_by=req.created_by or "user", origin={"extension": "pod_studio"},
        assignee_type="agent", assignee_id="", assignee_name="Pod Studio", approval_required=False,
        lane="video", hold=bool(req.queue))
    payload: Dict[str, Any] = {
        "kind": P.KIND, "task_id": task["id"], "model_images": req.model_images, "product_images": req.product_images,
        "request": req.request.strip(), "format": fmt, "clips": clips,
        "aspect": req.aspect if req.aspect in P.ASPECTS else "9:16", "chatgpt_profile": req.chatgpt_profile or "",
        "subtitles": bool(req.subtitles), "title": title, "language": req.language or "", "board_engines": req.board_engines or "",
    }
    codex_manager.append_event(task["id"], "log", f"Reference video queued: {clips} clip(s), {fmt}", actor=P.ACTOR, data=payload)
    return {"status": "queued", "task": task}
