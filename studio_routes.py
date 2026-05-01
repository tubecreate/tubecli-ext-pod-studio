"""
Content Studio API Routes
FastAPI router for drama CRUD, AI agent streaming, settings, and export.
"""
import os
import sys
import json
import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Request, HTTPException, BackgroundTasks
from fastapi.responses import StreamingResponse, FileResponse, HTMLResponse

logger = logging.getLogger("ContentStudio.Routes")

router = APIRouter()

# Gallery item type classification for injection logic
CHARACTER_TYPES = {"individual", "duo", "crowd", "group", "couple", "family"}
ASSET_TYPES = {"chart", "diagram", "infographic", "table", "screenshot", "object", "screen"}
EFFECT_TYPES = {"holographic", "thought_bubble", "overlay", "transition", "particle", "glow", "data_panel"}


def _get_telegram_config():
    """Read telegram bot_token and chat_id from global_settings.json."""
    try:
        from tubecli.config import DATA_DIR
        settings_path = DATA_DIR / "global_settings.json"
        if settings_path.exists():
            with open(settings_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            token = data.get("telegram_bot_token", "")
            chat_id = data.get("telegram_chat_id", "")
            if token and chat_id:
                return token, chat_id
    except Exception as e:
        logger.warning(f"Could not read telegram config: {e}")
    return None, None


async def _send_telegram(text: str, video_path: str = None):
    """Send a Telegram message (and optionally a video file) using global settings."""
    token, chat_id = _get_telegram_config()
    if not token or not chat_id:
        logger.debug("Telegram not configured, skipping notification.")
        return False

    import httpx
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            # Send text message
            await client.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
            )

            # Send video file if provided
            if video_path and os.path.isfile(video_path):
                file_size = os.path.getsize(video_path)
                # Telegram limit: 50MB for bots
                if file_size <= 50 * 1024 * 1024:
                    with open(video_path, "rb") as vf:
                        await client.post(
                            f"https://api.telegram.org/bot{token}/sendVideo",
                            data={"chat_id": chat_id, "caption": f"📎 {os.path.basename(video_path)}"},
                            files={"video": (os.path.basename(video_path), vf, "video/mp4")},
                            timeout=120.0,
                        )
                else:
                    size_mb = round(file_size / 1_048_576, 1)
                    await client.post(
                        f"https://api.telegram.org/bot{token}/sendMessage",
                        json={"chat_id": chat_id, "text": f"⚠️ Video quá lớn ({size_mb}MB), không thể gửi qua Telegram (giới hạn 50MB)."},
                    )
        return True
    except Exception as e:
        logger.error(f"Telegram notification failed: {e}")
        return False


@router.post("/api/v1/studio/notify-telegram")
async def notify_telegram(request: Request):
    """Send a notification to Telegram. Supports text and optional video attachment."""
    data = await request.json()
    text = data.get("text", "")
    video_path = data.get("video_path", "")

    if not text:
        raise HTTPException(400, "text is required")

    success = await _send_telegram(text, video_path)
    return {"success": success}


# Ensure extension dir is in path
_ext_dir = os.path.dirname(os.path.abspath(__file__))
if _ext_dir not in sys.path:
    sys.path.insert(0, _ext_dir)


def _repair_json(text: str) -> dict:
    """Try to parse JSON with automatic repair for common AI errors."""
    import re as _re
    
    # Step 1: Try direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    
    # Step 2: Strip markdown fences
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    cleaned = cleaned.strip()
    if cleaned.startswith("json"):
        cleaned = cleaned[4:].strip()
    
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    
    # Step 3: Extract JSON object via regex
    match = _re.search(r'(\{[\s\S]*\})', cleaned)
    if match:
        raw = match.group(1)
    else:
        raise ValueError(f"No JSON object found in response")
    
    # Step 4: Apply repairs
    repaired = raw
    
    # Fix trailing commas before } or ]
    repaired = _re.sub(r',\s*([}\]])', r'\1', repaired)
    
    # Fix missing commas between } { or ] [ or "value" "key"
    repaired = _re.sub(r'(\})\s*(\{)', r'\1,\2', repaired)
    repaired = _re.sub(r'(\])\s*(\[)', r'\1,\2', repaired)
    # Missing comma between "..." \n "..." (two strings on separate lines)
    repaired = _re.sub(r'(")\s*\n\s*(")', r'\1,\n\2', repaired)
    # Missing comma between number/bool/null and next "key"
    repaired = _re.sub(r'(\d|true|false|null)\s*\n\s*(")', r'\1,\n\2', repaired)
    
    # Fix unescaped newlines inside string values (but not between key-value pairs)
    # This is tricky, so we only do simple cases
    
    try:
        return json.loads(repaired)
    except json.JSONDecodeError:
        pass
    
    # Step 5: Try to fix truncated JSON by closing brackets
    bracket_stack = []
    for ch in repaired:
        if ch in '{[':
            bracket_stack.append('}' if ch == '{' else ']')
        elif ch in '}]':
            if bracket_stack:
                bracket_stack.pop()
    
    if bracket_stack:
        # Remove potential trailing comma before closing
        repaired = repaired.rstrip().rstrip(',')
        repaired += ''.join(reversed(bracket_stack))
        try:
            return json.loads(repaired)
        except json.JSONDecodeError as final_err:
            raise ValueError(f"JSON repair failed: {final_err}")
    
    raise ValueError(f"JSON repair failed")


def _db():
    from db.database import Database
    return Database.get_instance()

def _find_shot_start_time(segments, shot_text, search_from_idx=0):
    """
    Finds the start time of shot_text in segments, starting search from search_from_idx.
    Uses a long 10-word anchor for high precision and a 4-segment window to handle splits.
    """
    import re
    from difflib import SequenceMatcher
    
    def clean(t): return re.sub(r'[^\w\s]', '', t).lower().strip()
    
    # Clean text to words
    words = clean(shot_text).split()
    if not words:
        st = segments[search_from_idx]["start"] if search_from_idx < len(segments) else 0
        return st, search_from_idx
    
    # Generate Primary Anchors
    # 1. Standard anchor (first 10 words)
    anchors = []
    anchor_len = min(len(words), 10)
    anchors.append(" ".join(words[:anchor_len]))
    
    # 2. Body anchor (skip potential titles)
    # Storyboard text often has a title line that TTS skips (e.g. "Kết luận:\nBằng cách...")
    lines = [l.strip() for l in shot_text.split('\n') if l.strip()]
    if len(lines) > 1:
        # If the first line is short (likely a title), use the second line as an alternative anchor
        body_words = clean(lines[1]).split()
        if len(body_words) >= 4:
            anchors.append(" ".join(body_words[:min(len(body_words), 10)]))
            
    # 3. Shifted anchor (skip first 5 words in case they were mispronounced/skipped)
    if len(words) > 12:
        anchors.append(" ".join(words[5:15]))
        
    # Generate Fallback Anchors (Shorter phrases)
    fallbacks = []
    if anchor_len > 6: fallbacks.append(" ".join(words[:6]))
    if anchor_len > 4: fallbacks.append(" ".join(words[:4]))
    if anchor_len > 2: fallbacks.append(" ".join(words[:3]))
    
    best_idx = search_from_idx
    best_score = 0
    
    # Search window: next 100 segments
    search_limit = min(search_from_idx + 100, len(segments))
    
    for i in range(search_from_idx, search_limit):
        window_text_curr = clean(" ".join([s.get("text", "") for s in segments[i : i+4]]))
        window_text_next = clean(" ".join([s.get("text", "") for s in segments[i+1 : i+4]])) if i+1 < len(segments) else ""
        
        # A. Exact Match of any Primary Anchor (Highest Confidence)
        for anchor in anchors:
            if anchor in window_text_curr and anchor not in window_text_next:
                return segments[i]["start"], i
            
        # B. Fallback Exact Matches
        for fb in fallbacks:
            if fb in window_text_curr and fb not in window_text_next:
                if best_score < 0.7:
                    best_score = 0.7
                    best_idx = i
        
        # C. Fuzzy Match the very first anchor
        score = SequenceMatcher(None, anchors[0], window_text_curr).ratio()
        if score > best_score:
            best_score = score
            best_idx = i
            
        if score > 0.85:
            return segments[i]["start"], i
                
    if best_score > 0.45:
        return segments[best_idx]["start"], best_idx
        
    # Fallback
    st = segments[search_from_idx]["start"] if search_from_idx < len(segments) else 0
    next_idx = min(search_from_idx + 1, len(segments) - 1)
    return st, next_idx


def _clean_appearance_for_ref(appearance: str) -> str:
    """Strip emotional/expression descriptors from appearance for neutral reference photo.
    Keep only physical features (body, hair, face shape, skin) — like an ID photo."""
    import re
    # Remove emotion/expression phrases (Vietnamese + English)
    emotion_patterns = [
        # Vietnamese expressions
        r'đỏ hoe\s*(vì\s*)?xúc động', r'mang vẻ\s+\w+', r'nét mặt\s+\w+',
        r'ánh mắt\s+\w+', r'vẻ\s+(mệt mỏi|đau khổ|buồn|vui|giận|sợ|lo lắng|căng thẳng|phẫn nộ|tuyệt vọng|hạnh phúc|nghiêm nghị|lạnh lùng)',
        r'đang\s+(khóc|cười|mỉm cười|nhăn mặt|cau mày|trầm ngâm|suy tư)',
        r'(nước mắt|khóe mắt)\s+\w+',
        # English expressions
        r'crying', r'tears?\s+in\s+eyes?', r'angry', r'sad\w*', r'happy',
        r'smiling', r'frowning', r'worried', r'exhausted', r'tired[\-\s]looking',
        r'painful', r'sorrowful', r'emotional', r'tearful',
        # Clothing/outfit descriptors (keep for video, strip for face ref)
        r'\[Clothing\][^\[]*(?=\[|$)', r'\[Trang phục\][^\[]*(?=\[|$)',
    ]
    cleaned = appearance
    for pat in emotion_patterns:
        cleaned = re.sub(pat, '', cleaned, flags=re.IGNORECASE)
    # Remove CRITICAL blocks that often contain expression descriptions
    cleaned = re.sub(r'\*\*CRITICAL:.*?\*\*', '', cleaned, flags=re.IGNORECASE | re.DOTALL)
    # Clean up whitespace
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    cleaned = re.sub(r',\s*,', ',', cleaned)
    cleaned = re.sub(r',\s*\.', '.', cleaned)
    return cleaned


def _build_char_ref_prompt(name: str, appearance: str, visual_style: str = "Realistic", aspect_ratio: str = "1:1") -> str:
    """Build a neutral face-only reference prompt (like an ID photo) in the project's visual style."""
    clean_app = _clean_appearance_for_ref(appearance)
    
    # Map project style to prompt style descriptor
    style_map = {
        "default": "Photorealistic, cinematic lighting, studio quality",
        "realistic": "Photorealistic, cinematic lighting, studio quality",
        "anime": "Anime art style, clean lines, vibrant colors, anime aesthetic",
        "donghua": "Chinese animation (Donghua) style, detailed linework, vibrant colors",
        "chibi": "Chibi art style, cute proportions, simple shading",
        "3d cartoon": "3D Cartoon render, Pixar/Disney style, smooth shading",
        "stick figure": "Simple line drawing, minimalist style",
        "dark fantasy": "Dark fantasy art style, dramatic shadows, gothic aesthetic",
        "hollywood cinematic": "Photorealistic, Hollywood cinematic lighting, studio quality",
    }
    # Use mapped style, or pass through the raw visual_style directly
    style_desc = style_map.get(visual_style.lower().strip(),
                               f"{visual_style.strip()} style, highly detailed, professional quality")
    
    # Map aspect ratio to readable description for Grok
    ar_map = {
        "1:1": "1:1 square",
        "16:9": "16:9 widescreen landscape",
        "9:16": "9:16 vertical portrait",
        "4:3": "4:3 landscape",
        "3:4": "3:4 portrait",
    }
    ar_desc = ar_map.get(aspect_ratio, aspect_ratio or "1:1 square")
    
    return (
        f"Generate in {ar_desc} aspect ratio: "
        f"Close-up face portrait of {name}: {clean_app}. "
        f"Neutral expression, like an ID photo. "
        f"Focus on facial features only, no clothing, no emotions. "
        f"{style_desc}, highly detailed face, neutral background, 4K."
    )


def _get_char_style(drama: dict) -> str:
    """Extract Character Style from drama.style string like 'Visual Style: X | Character Style: Y'."""
    style_str = drama.get("style", "") or ""
    if "Character Style:" in style_str:
        parts = style_str.split("Character Style:")
        if len(parts) > 1:
            return parts[1].strip().split("|")[0].strip()
    return "Realistic"


def _get_visual_style(drama: dict) -> str:
    """Extract Visual Style from drama.style string like 'Visual Style: X | Character Style: Y'."""
    style_str = drama.get("style", "") or ""
    if "Visual Style:" in style_str:
        parts = style_str.split("Visual Style:")
        if len(parts) > 1:
            return parts[1].strip().split("|")[0].strip()
    # Fallback: use first segment or the raw style
    return style_str.split("|")[0].strip() if "|" in style_str else (style_str.strip() or "Realistic")


def _build_scene_ref_prompt(location: str, time_of_day: str, description: str,
                            visual_style: str = "Realistic", aspect_ratio: str = "16:9") -> str:
    """Build a scene/environment image prompt (like a cinematic still) in the project's visual style."""
    # Map project style to prompt style descriptor
    style_map = {
        "default": "Photorealistic, cinematic lighting, professional cinematography",
        "realistic": "Photorealistic, cinematic lighting, professional cinematography",
        "anime": "Anime background art style, vibrant colors, detailed environment, anime aesthetic",
        "donghua": "Chinese animation (Donghua) background style, detailed linework, vibrant scenery",
        "chibi": "Chibi world background, cute aesthetic, colorful simple environment",
        "3d cartoon": "3D Cartoon environment render, Pixar/Disney style, smooth shading",
        "stick figure": "Simple line drawing environment, minimalist style",
        "dark fantasy": "Dark fantasy landscape, dramatic shadows, gothic atmospheric environment",
        "hollywood cinematic": "Photorealistic, Hollywood cinematic lighting, professional cinematography",
    }
    # Use mapped style, or pass through the raw visual_style directly
    style_desc = style_map.get(visual_style.lower().strip(),
                               f"{visual_style.strip()} style environment, highly detailed, professional quality")

    # Map aspect ratio
    ar_map = {
        "1:1": "1:1 square",
        "16:9": "16:9 widescreen landscape",
        "9:16": "9:16 vertical portrait",
        "4:3": "4:3 landscape",
        "3:4": "3:4 portrait",
    }
    ar_desc = ar_map.get(aspect_ratio, aspect_ratio or "16:9 widescreen landscape")

    # Build descriptive scene prompt
    scene_parts = []
    if location:
        scene_parts.append(location.strip())
    if time_of_day:
        scene_parts.append(f"during {time_of_day.strip()}")
    if description:
        scene_parts.append(description.strip())
    scene_desc = ", ".join(scene_parts) if scene_parts else "a cinematic scene"

    return (
        f"Generate in {ar_desc} aspect ratio: "
        f"Cinematic wide establishing shot of {scene_desc}. "
        f"No people, no characters, no text, no letters. "
        f"Focus on environment, architecture, atmosphere and lighting. "
        f"{style_desc}, highly detailed environment, 4K."
    )


def _settings():
    from tubecli.config import DATA_DIR
    from config.settings_manager import StudioSettings
    data_dir = os.path.join(str(DATA_DIR), "content_studio")
    return StudioSettings(data_dir)


# ── Static Pages ────────────────────────────────────────────

@router.get("/content-studio", include_in_schema=False, response_class=HTMLResponse)
async def studio_page():
    """Serve the Content Studio HTML page."""
    html_path = os.path.join(_ext_dir, "static", "studio.html")
    if os.path.exists(html_path):
        with open(html_path, "r", encoding="utf-8") as f:
            return HTMLResponse(content=f.read())
    return HTMLResponse("<h1>Content Studio – HTML not found</h1>", status_code=404)


@router.get("/content-studio-static/{filepath:path}", include_in_schema=False)
async def content_studio_static(filepath: str):
    """Serve static files (CSS, JS) for the Content Studio UI."""
    file_path = os.path.join(_ext_dir, "static", filepath)
    if os.path.exists(file_path) and os.path.isfile(file_path):
        return FileResponse(file_path)
    raise HTTPException(404, f"Static file not found: {filepath}")


@router.get("/content-studio/settings", include_in_schema=False, response_class=HTMLResponse)
async def settings_page():
    """Serve the Settings HTML page."""
    html_path = os.path.join(_ext_dir, "static", "settings.html")
    if os.path.exists(html_path):
        with open(html_path, "r", encoding="utf-8") as f:
            return HTMLResponse(content=f.read())
    return HTMLResponse("<h1>Settings \u2013 HTML not found</h1>", status_code=404)


# ── Settings API ────────────────────────────────────────────

@router.get("/api/v1/studio/settings")
async def get_settings():
    return _settings().get_all()


@router.put("/api/v1/studio/settings")
async def update_settings(request: Request):
    data = await request.json()
    return _settings().update(data)


@router.get("/api/v1/studio/settings/ai-providers")
async def list_ai_providers():
    """List available AI providers (cloud + ollama)."""
    providers = []

    # Cloud providers from cloud_api
    try:
        from tubecli.config import DATA_DIR
        keys_file = os.path.join(str(DATA_DIR), "cloud_api_keys.json")
        if os.path.exists(keys_file):
            with open(keys_file, "r", encoding="utf-8") as f:
                keys = json.load(f)
            for prov_id in ["openai", "gemini", "claude", "deepseek", "grok"]:
                has_key = bool(keys.get(prov_id, {}))
                providers.append({
                    "type": "cloud",
                    "id": prov_id,
                    "name": prov_id.title(),
                    "has_key": has_key,
                })
    except Exception:
        pass

    # Ollama
    try:
        import requests
        resp = requests.get("http://localhost:11434/api/tags", timeout=3)
        if resp.status_code == 200:
            models = resp.json().get("models", [])
            providers.append({
                "type": "ollama",
                "id": "ollama",
                "name": "Ollama (Local)",
                "running": True,
                "models": [m.get("name", "") for m in models],
            })
    except Exception:
        providers.append({
            "type": "ollama",
            "id": "ollama",
            "name": "Ollama (Local)",
            "running": False,
            "models": [],
        })

    return {"providers": providers}


@router.post("/api/v1/studio/settings/ai-test")
async def test_ai_connection():
    """Test AI connection with current settings."""
    import httpx
    s = _settings()
    base_url, api_key, model, temp = s.get_ai_client_params()
    if not api_key:
        return {"status": "error", "message": "No API key configured"}
    if not model:
        return {"status": "error", "message": "No model configured"}

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{base_url}/chat/completions",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                },
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": "Say 'OK' in one word."}],
                    "max_tokens": 10,
                },
            )
            if resp.status_code == 200:
                return {"status": "success", "message": f"Connected to {model}", "model": model}
            else:
                return {"status": "error", "message": f"HTTP {resp.status_code}: {resp.text[:200]}"}
    except Exception as e:
        return {"status": "error", "message": str(e)[:300]}


@router.get("/api/v1/studio/settings/ai-info")
async def get_ai_info():
    """Return current AI model info for UI display."""
    s = _settings()
    base_url, api_key, model, temp = s.get_ai_client_params()
    ai_cfg = s.get_ai_config()
    source = ai_cfg.get("source", "global")
    has_key = bool(api_key)
    return {
        "model": model or "(not configured)",
        "source": source,
        "has_key": has_key,
        "base_url_host": base_url.split("//")[-1].split("/")[0] if base_url else "",
    }


# ── Drama CRUD ──────────────────────────────────────────────

@router.get("/api/v1/studio/dramas")
async def list_dramas():
    return {"items": _db().list_dramas()}


@router.post("/api/v1/studio/dramas")
async def create_drama(request: Request):
    data = await request.json()
    if not data.get("title"):
        raise HTTPException(400, "Title is required")
        
    drama = _db().create_drama(data)
    
    # The gallery_category_id is stored in metadata, but we no longer auto-clone 
    # characters here. Instead, we let the AI Extractor agent intelligently 
    # select the most suitable characters from the gallery during the Extract step.
    
    return drama


@router.get("/api/v1/studio/dramas/{drama_id}")
async def get_drama(drama_id: int):
    d = _db().get_drama_full(drama_id)
    if not d:
        raise HTTPException(404, "Drama not found")
    return d


@router.put("/api/v1/studio/dramas/{drama_id}")
async def update_drama(drama_id: int, request: Request):
    data = await request.json()
    result = _db().update_drama(drama_id, data)
    if not result:
        raise HTTPException(404, "Drama not found")
    return result


@router.delete("/api/v1/studio/dramas/{drama_id}")
async def delete_drama(drama_id: int):
    _db().delete_drama(drama_id)
    return {"status": "ok"}


@router.post("/api/v1/studio/dramas/{drama_id}/generate-outline")
async def generate_outline(drama_id: int, request: Request):
    data = await request.json()
    premise = data.get("premise", "")
    episode_count = data.get("episode_count", 5)

    if not premise:
        raise HTTPException(400, "Premise is required")

    s = _settings()
    base_url, api_key, model, temp = s.get_ai_client_params()
    
    drama_doc = _db().get_drama(drama_id)
    language = drama_doc.get("language") if drama_doc and drama_doc.get("language") else s.get_script_language()
    
    agent_cfg = s.get_agent_config("series_planner")
    agent_temp = agent_cfg.get("temperature", 0.7)

    if not api_key:
        raise HTTPException(400, "No API key configured.")

    # Get content_format override if any
    content_format = "Drama / Narrative"
    if drama_doc:
        try:
            d_meta = json.loads(drama_doc.get("metadata", "{}") or "{}")
            content_format = d_meta.get("content_format", "Drama / Narrative")
        except:
            pass

    from agents.series_planner import SeriesPlannerAgent
    agent = SeriesPlannerAgent()
    if episode_count <= 0:
        char_count = len(premise)
        min_eps = max(3, char_count // 5000)
        target_eps_str = f"Auto (The premise is {char_count} characters long. You MUST break it down into at least {min_eps} plots. DO NOT summarize it mathematically into 1 episode!)"
    else:
        target_eps_str = f"Maximum {episode_count} (This is an UPPER BOUND, not a fixed number. If the content/premise is short or doesn't have enough material, create FEWER episodes. Only use up to {episode_count} if the content truly warrants it.)"

    user_msg = f"Premise Length: {len(premise)} characters\nPremise: {premise}\nTarget Outputs: {target_eps_str}\nLanguage: {language}"
    
    agent_context = {"content_format": content_format}

    full_response = []
    try:
        async for chunk in agent.chat_stream(user_msg, language, base_url, api_key, model, agent_temp, agent_context):
            full_response.append(chunk)
    except Exception as e:
        import traceback
        err_msg = f"AI Error: {str(e)}\n{traceback.format_exc()}"
        print(err_msg)  # also print to console
        raise HTTPException(500, f"AI Error: {str(e)}")

    full_text = "".join(full_response)

    # Parse JSON using robust repair function
    try:
        parsed = _repair_json(full_text)
    except Exception as e:
        logger.error(f"Failed to parse series outline JSON: {e}")
        raise HTTPException(500, f"Failed to parse series outline JSON. AI Output:\n{full_text[:500]}")

    # Save outline into drama metadata
    drama = _db().get_drama(drama_id)
    if not drama:
        raise HTTPException(404, "Drama not found.")
    
    meta = json.loads(drama.get("metadata", "{}") or "{}")
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except:
            meta = {}

    meta["series_outline"] = parsed
    _db().update_drama(drama_id, {"metadata": json.dumps(meta)})

    return {"status": "ok", "outline": parsed}


async def _autopilot_runner(drama_id: int):
    try:
        drama = _db().get_drama(drama_id)
        if not drama: return

        meta = json.loads(drama.get("metadata", "{}") or "{}")
        outline = meta.get("series_outline", {})
        episodes_plan = outline.get("episodes", [])

        if not episodes_plan:
            meta["autopilot_status"] = "failed: no outline"
            _db().update_drama(drama_id, {"metadata": json.dumps(meta)})
            return

        s = _settings()
        base_url, api_key, model, temp = s.get_ai_client_params()
        language = s.get_script_language()

        if not api_key:
            meta["autopilot_status"] = "failed: no api key"
            _db().update_drama(drama_id, {"metadata": json.dumps(meta)})
            return

        # Initialize Agents
        from agents.novel_writer import NovelWriterAgent
        from agents.script_rewriter import ScriptRewriterAgent
        from agents.extractor import ExtractorAgent
        from agents.storyboard_breaker import StoryboardBreakerAgent
        
        a_novel = NovelWriterAgent()
        a_script = ScriptRewriterAgent()
        a_extract = ExtractorAgent()
        a_storybd = StoryboardBreakerAgent()

        total = len(episodes_plan)
        
        for idx, ep_plan in enumerate(episodes_plan):
            ep_num = ep_plan.get("episode_number", idx + 1)
            title = ep_plan.get("title", f"Episode {ep_num}")
            plot_outline = ep_plan.get("plot_outline", "")

            # Update status
            meta["autopilot_status"] = f"running {idx+1}/{total} - {title}"
            meta["autopilot_progress"] = int((idx / total) * 100)
            _db().update_drama(drama_id, {"metadata": json.dumps(meta)})

            # 1. Create Episode in DB or use existing
            # For simplicity, we just create new ones during autopilot
            new_ep = _db().create_episode(drama_id, {
                "episode_number": ep_num,
                "title": title
            })
            ep_id = new_ep["id"]

            # Context for continuity and visual styles
            content_format = meta.get("content_format", "Drama / Narrative")
            context = {
                "visual_style": drama.get("style", "realistic") if drama else "realistic",
                "content_format": content_format
            }
            # Inject gallery items into context when gallery category is assigned
            gallery_cat_id = meta.get("gallery_category_id")
            if gallery_cat_id:
                try:
                    gallery_items = _db().list_gallery_items(gallery_cat_id)
                    if gallery_items:
                        context["gallery_assets"] = [
                            {
                                "name": gi.get("name", ""),
                                "type": gi.get("char_type", "individual"),
                                "role": gi.get("role_type", ""),
                                "appearance": gi.get("appearance", ""),
                                "tags": gi.get("tags", ""),
                                "has_reference_image": bool(gi.get("image_url", "")),
                            }
                            for gi in gallery_items
                        ]
                        logger.info(f"Autopilot context: injected {len(gallery_items)} gallery assets")
                except Exception as e:
                    logger.warning(f"Failed to load gallery items for autopilot context: {e}")
            if idx > 0:
                # Fetch prev ep
                eps = _db().list_episodes(drama_id)
                eps = sorted(eps, key=lambda x: x.get("episode_number", x["id"]))
                if eps:
                    prev = eps[-2] # Current one is last (-1), so previous is (-2)
                    prev_script = prev.get("script_content", "") or prev.get("content", "")
                    if prev_script:
                        context["previous_episode"] = {
                            "number": prev.get("episode_number", idx),
                            "ending_script_context": prev_script[-3000:]
                        }

            # 2. Flow: Novel Writer
            prose = await a_novel.chat_complete(
                f"Episode Title: {title}\nPlot Outline: {plot_outline}",
                language, base_url, api_key, model, s.get_agent_config("novel_writer").get("temperature", 0.7), context
            )
            _db().update_episode(ep_id, {"content": prose})

            # 3. Flow: Script Rewriter
            script = await a_script.chat_complete(
                f"Please write the formatted screenplay for this episode.\n\n{prose}",
                language, base_url, api_key, model, s.get_agent_config("script_rewriter").get("temperature", 0.6), context
            )
            _db().update_episode(ep_id, {"script_content": script})

            # 4. Flow: Extractor
            chars = _db().list_characters(drama_id)
            scenes = _db().list_scenes(drama_id)
            context["existing_characters"] = [{"name": c["name"], "role": c["role"]} for c in chars]
            context["existing_scenes"] = [{"location": s["location"], "time": s["time"]} for s in scenes]
            
            # Additional keys for storyboard compatibility later
            context["characters"] = [{"id": c["id"], "name": c["name"], "role": c["role"], "appearance": c["appearance"], "personality": c["personality"]} for c in chars]
            context["scenes"] = [{"id": s["id"], "location": s["location"], "time": s["time"], "description": s["description"]} for s in scenes]
            
            # Always extract for EVERY episode to discover new characters
            extract_json_str = await a_extract.chat_complete(
                f"Extract ALL characters and scenes from this FULL script. Do NOT skip any named character, even if they appear only once.\n\n{script[:15000]}",
                language, base_url, api_key, model, s.get_agent_config("extractor").get("temperature", 0.3), context
            )
            # Parse extracted JSON loosely
            try:
                extracted = _repair_json(extract_json_str)
                _db().save_characters_dedup(drama_id, ep_id, extracted.get("characters", []))
                _db().save_scenes_dedup(drama_id, ep_id, extracted.get("scenes", []))
            except Exception as e:
                logger.error(f"Autopilot Extractor error: {e}")

            # 4b. Flow: Generate AI reference images for characters without images
            # Runs every episode — the filter `chars_needing_images` ensures only NEW chars get generated
            meta["autopilot_status"] = f"running {idx+1}/{total} - generating character refs"
            _db().update_drama(drama_id, {"metadata": json.dumps(meta)})
            
            try:
                # Get browser profile, aspect ratio, and engine from drama metadata
                char_profile = meta.get("browser_profile_name") or meta.get("browser_profile") or "Default"
                char_aspect_ratio = meta.get("aspect_ratio", "16:9")
                image_engine = meta.get("video_engine", "grok")  # Use same engine as video
                all_chars = _db().list_characters(drama_id)
                chars_needing_images = [c for c in all_chars if c.get("appearance", "").strip() and not c.get("image_url", "").strip()]
                
                logger.info(f"Autopilot char gen: ep {ep_num}, total chars={len(all_chars)}, needing images={len(chars_needing_images)}, profile={char_profile}, engine={image_engine}")
                
                if chars_needing_images:
                    logger.info(f"Autopilot: generating ref images for {len(chars_needing_images)} NEW characters (engine={image_engine})")
                    
                    from pathlib import Path
                    if image_engine == 'veo3':
                        gen_script = os.path.join(_ext_dir, "engines", "veo3_char_image.js")
                    else:
                        gen_script = os.path.join(_ext_dir, "engines", "grok_char_image.js")
                    top_dir = Path(_ext_dir).parents[2]
                    browser_ext_dir = str(top_dir / "tubecli" / "extensions" / "browser")
                    
                    try:
                        from tubecli.config import DATA_DIR
                        profiles_dir = os.path.join(str(DATA_DIR), "browser_profiles")
                    except:
                        profiles_dir = str(top_dir / "data" / "browser_profiles")
                    
                    ref_dir = _get_ref_dir()
                    from datetime import datetime as _dt
                    
                    for ci, char_obj in enumerate(chars_needing_images):
                        cid = char_obj["id"]
                        cname = char_obj.get("name", "Unknown")
                        cappearance = char_obj.get("appearance", "")
                        
                        meta["autopilot_status"] = f"running {idx+1}/{total} - char ref {ci+1}/{len(chars_needing_images)}: {cname}"
                        _db().update_drama(drama_id, {"metadata": json.dumps(meta)})
                        
                        char_style = _get_char_style(drama) if drama else "Realistic"
                        char_prompt = _build_char_ref_prompt(cname, cappearance, char_style, char_aspect_ratio)
                        ts = _dt.now().strftime("%Y%m%d_%H%M%S")
                        out_file = f"char_{cid}_ai_{ts}.png"
                        out_path = os.path.join(ref_dir, out_file)
                        
                        cmd = [
                            "node", gen_script,
                            "--profile", char_profile,
                            "--prompt", char_prompt,
                            "--output", out_path,
                            "--profiles-dir", profiles_dir,
                            "--timeout", "120"
                        ]
                        if image_engine == 'veo3':
                            cmd.extend(["--aspect-ratio", char_aspect_ratio])
                        env = os.environ.copy()
                        env["NODE_PATH"] = os.path.join(browser_ext_dir, "node_modules")
                        
                        try:
                            proc = await asyncio.create_subprocess_exec(
                                *cmd,
                                stdout=asyncio.subprocess.PIPE,
                                stderr=asyncio.subprocess.PIPE,
                                cwd=browser_ext_dir,
                                env=env,
                            )
                            stdout_b, _ = await asyncio.wait_for(proc.communicate(), timeout=150)
                            stdout_text = stdout_b.decode("utf-8", errors="replace").strip()
                            
                            # Check result
                            img_ok = False
                            if stdout_text:
                                for line in reversed(stdout_text.splitlines()):
                                    if line.strip().startswith("{"):
                                        try:
                                            result = json.loads(line.strip())
                                            if result.get("status") == "success" and os.path.exists(out_path):
                                                try:
                                                    refs = json.loads(char_obj.get("reference_images") or "[]")
                                                except:
                                                    refs = []
                                                refs.append(out_path)
                                                _db().update_character(cid, {
                                                    "reference_images": json.dumps(refs),
                                                    "image_url": out_path
                                                })
                                                img_ok = True
                                                logger.info(f"  ✓ Generated ref image for {cname}")
                                                break
                                        except:
                                            pass
                            if not img_ok:
                                logger.warning(f"  ✗ Image gen failed for {cname} — skipping (no retry). Prompt may be blocked.")
                        except Exception as ce:
                            logger.warning(f"  ✗ Failed to generate ref for {cname}: {ce} — skipping (no retry)")
                            continue
                else:
                    logger.info(f"Autopilot: no NEW characters need image generation for ep {ep_num}")
            except Exception as e:
                import traceback
                logger.error(f"Autopilot char image gen error: {e}\n{traceback.format_exc()}")
                # Non-fatal: continue to storyboard step

            # 4c. Flow: Generate AI reference images for scenes without images
            meta["autopilot_status"] = f"running {idx+1}/{total} - generating scene images"
            _db().update_drama(drama_id, {"metadata": json.dumps(meta)})
            
            try:
                scene_profile = meta.get("browser_profile_name") or meta.get("browser_profile") or "Default"
                scene_aspect_ratio = meta.get("aspect_ratio", "16:9")
                scene_visual_style = _get_visual_style(drama) if drama else "Realistic"
                scene_engine = meta.get("video_engine", "grok")
                all_scenes = _db().list_scenes(drama_id)
                scenes_needing_images = [s for s in all_scenes if s.get("location", "").strip() and not s.get("image_url", "").strip()]
                
                logger.info(f"Autopilot scene gen: ep {ep_num}, total scenes={len(all_scenes)}, needing images={len(scenes_needing_images)}, profile={scene_profile}, engine={scene_engine}")
                
                if scenes_needing_images:
                    logger.info(f"Autopilot: generating ref images for {len(scenes_needing_images)} NEW scenes (engine={scene_engine})")
                    
                    from pathlib import Path
                    if scene_engine == 'veo3':
                        gen_script = os.path.join(_ext_dir, "engines", "veo3_char_image.js")
                    else:
                        gen_script = os.path.join(_ext_dir, "engines", "grok_char_image.js")
                    top_dir = Path(_ext_dir).parents[2]
                    browser_ext_dir = str(top_dir / "tubecli" / "extensions" / "browser")
                    
                    try:
                        from tubecli.config import DATA_DIR
                        profiles_dir = os.path.join(str(DATA_DIR), "browser_profiles")
                    except:
                        profiles_dir = str(top_dir / "data" / "browser_profiles")
                    
                    ref_dir = _get_ref_dir()
                    from datetime import datetime as _dt
                    
                    for si, scene_obj in enumerate(scenes_needing_images):
                        sid = scene_obj["id"]
                        slocation = scene_obj.get("location", "Unknown")
                        stime = scene_obj.get("time", "")
                        sdesc = scene_obj.get("description", "")
                        
                        meta["autopilot_status"] = f"running {idx+1}/{total} - scene ref {si+1}/{len(scenes_needing_images)}: {slocation[:30]}"
                        _db().update_drama(drama_id, {"metadata": json.dumps(meta)})
                        
                        scene_prompt = _build_scene_ref_prompt(slocation, stime, sdesc, scene_visual_style, scene_aspect_ratio)
                        ts = _dt.now().strftime("%Y%m%d_%H%M%S")
                        out_file = f"scene_{sid}_ai_{ts}.png"
                        out_path = os.path.join(ref_dir, out_file)
                        
                        cmd = [
                            "node", gen_script,
                            "--profile", scene_profile,
                            "--prompt", scene_prompt,
                            "--output", out_path,
                            "--profiles-dir", profiles_dir,
                            "--timeout", "120"
                        ]
                        if scene_engine == 'veo3':
                            cmd.extend(["--aspect-ratio", scene_aspect_ratio])
                        env = os.environ.copy()
                        env["NODE_PATH"] = os.path.join(browser_ext_dir, "node_modules")
                        
                        try:
                            proc = await asyncio.create_subprocess_exec(
                                *cmd,
                                stdout=asyncio.subprocess.PIPE,
                                stderr=asyncio.subprocess.PIPE,
                                cwd=browser_ext_dir,
                                env=env,
                            )
                            stdout_b, _ = await asyncio.wait_for(proc.communicate(), timeout=150)
                            stdout_text = stdout_b.decode("utf-8", errors="replace").strip()
                            
                            # Check result
                            img_ok = False
                            if stdout_text:
                                for line in reversed(stdout_text.splitlines()):
                                    if line.strip().startswith("{"):
                                        try:
                                            result = json.loads(line.strip())
                                            if result.get("status") == "success" and os.path.exists(out_path):
                                                _db().update_scene(sid, {"image_url": out_path})
                                                img_ok = True
                                                logger.info(f"  ✓ Generated ref image for scene '{slocation}'")
                                                break
                                        except:
                                            pass
                            if not img_ok:
                                logger.warning(f"  ✗ Image gen failed for scene '{slocation}' — skipping (no retry)")
                        except Exception as ce:
                            logger.warning(f"  ✗ Failed to generate ref for scene '{slocation}': {ce} — skipping (no retry)")
                            continue
                else:
                    logger.info(f"Autopilot: no NEW scenes need image generation for ep {ep_num}")
            except Exception as e:
                import traceback
                logger.error(f"Autopilot scene image gen error: {e}\n{traceback.format_exc()}")
                # Non-fatal: continue to storyboard step

            # 5. Flow: Storyboard Breaker
            import re as _re_ap
            _ap_headings = _re_ap.findall(r'^## S\d+[^\n]*', script, _re_ap.MULTILINE)
            _ap_count = len(_ap_headings) if _ap_headings else 1
            _ap_h_list = '\n'.join(_ap_headings) if _ap_headings else '(no headings)'
            
            # Add narration_source to context
            context["narration_source"] = meta.get("narration_source", "prose")
            if meta.get("narration_source") == "prose":
                raw_content = ep_plan.get("plot_outline", "")
                if raw_content:
                    context["raw_prose_content"] = raw_content[:8000]
            
            sb_prompt = (
                f"Break this screenplay into storyboard shots.\n"
                f"CRITICAL: Script has EXACTLY {_ap_count} scenes. Output EXACTLY {_ap_count} shots.\n"
                f"REMINDER: EVERY shot MUST include `illustrate_layout` describing visual composition with characters.\n"
                f"Scenes:\n{_ap_h_list}\n\nScript:\n\n{script[:15000]}"
            )
            sb_json_str = await a_storybd.chat_complete(
                sb_prompt,
                language, base_url, api_key, model, s.get_agent_config("storyboard_breaker").get("temperature", 0.6), context
            )
            try:
                import re
                match = re.search(r'\[[\s\S]*\]', sb_json_str)
                if match:
                    parsed_array = json.loads(match.group())
                    if isinstance(parsed_array, list):
                        _db().save_storyboards_bulk(ep_id, parsed_array, append=False)
            except Exception as e:
                logger.error(f"Autopilot Storyboard error: {e}")

        # ── 6. Flow: Publish to Platforms ──
        pipeline = meta.get("pipeline", [])
        if "publish" in pipeline:
            upload_targets = meta.get("upload_targets", [])
            if upload_targets:
                meta["autopilot_status"] = f"publishing to platforms"
                meta["autopilot_progress"] = 92
                _db().update_drama(drama_id, {"metadata": json.dumps(meta)})

                try:
                    # Step 8b: Publish each episode to each platform
                    eps = _db().list_episodes(drama_id)
                    for ep in eps:
                        ep_id = ep["id"]
                        video_path = _find_episode_video(drama_id, ep_id)
                        if not video_path:
                            logger.warning(f"Autopilot: No video found for ep {ep_id}, skipping publish")
                            continue

                        # Step 8a: Generate SEO for THIS episode if not done yet
                        ep_meta = json.loads(ep.get("metadata", "{}") or "{}")
                        if "seo_publish" not in ep_meta or not ep_meta["seo_publish"]:
                            content_summary = ep.get("script_content", "") or ep.get("content", "")
                            if not content_summary:
                                outline = meta.get("series_outline", {})
                                content_summary = outline.get("overview", drama.get("title", "")) if isinstance(outline, dict) else str(outline)[:3000]

                            ep_seo_publish = {}
                            language = drama.get("language", "vi")
                            ep_title = ep.get("title", "") or drama.get("title", "")
                            platforms_set = set(t.get("provider", "youtube") for t in upload_targets)
                            for plat in platforms_set:
                                try:
                                    seo_result = await _generate_seo_for_platform(
                                        str(content_summary)[:3000], ep_title, language, plat
                                    )
                                    ep_seo_publish[plat] = seo_result
                                    logger.info(f"Autopilot: Generated SEO for {plat} (ep {ep_id})")
                                except Exception as se:
                                    logger.warning(f"Autopilot SEO for {plat} (ep {ep_id}) failed: {se}")
                                    ep_seo_publish[plat] = {"title": ep_title, "description": "", "tags": []}
                            ep_meta["seo_publish"] = ep_seo_publish
                            _db().update_episode(ep_id, {"metadata": json.dumps(ep_meta, ensure_ascii=False)})

                        privacy = meta.get("upload_privacy", "private")
                        for target in upload_targets:
                            platform = target.get("provider", "youtube")
                            seo = ep_meta.get("seo_publish", {}).get(platform, {})
                            if not seo:
                                seo = meta.get("seo_publish", {}).get(platform, {})
                            upload_title = seo.get("title", drama.get("title", ""))
                            upload_desc = seo.get("description", "")
                            upload_tags = seo.get("tags", [])
                            category_id = seo.get("category_id", "22")

                            try:
                                import httpx
                                async with httpx.AsyncClient(base_url="http://127.0.0.1:5295") as client:
                                    payload = {
                                        "provider": platform,
                                        "email": target.get("email", ""),
                                        "cred_id": target.get("cred_id", ""),
                                        "token_id": target.get("cred_id", ""),
                                        "channel_id": target.get("channel_id", ""),
                                        "file_path": video_path,
                                        "title": upload_title,
                                        "description": upload_desc,
                                        "tags": upload_tags,
                                        "category_id": category_id,
                                        "privacy": privacy,
                                    }
                                    resp = await client.post("/api/v1/video_manager/upload", json=payload, timeout=30.0)
                                    result = resp.json()
                                    if result.get("success"):
                                        task_id = result.get("task_id", "")
                                        if "publish_tasks" not in ep_meta:
                                            ep_meta["publish_tasks"] = {}
                                        ep_meta["publish_tasks"][platform] = task_id
                                        _db().update_episode(ep_id, {"metadata": json.dumps(ep_meta)})
                                        logger.info(f"Autopilot: Published ep {ep_id} to {platform}, task={task_id}")
                                    else:
                                        logger.warning(f"Autopilot: Upload to {platform} returned error: {result}")
                            except Exception as ue:
                                logger.error(f"Autopilot: Publish ep {ep_id} to {platform} failed: {ue}")

                except Exception as pub_err:
                    logger.error(f"Autopilot Publish step error: {pub_err}")
                    # Non-fatal: continue to completion

        # Completed
        meta["autopilot_status"] = "completed"
        meta["autopilot_progress"] = 100
        _db().update_drama(drama_id, {"metadata": json.dumps(meta)})

    except Exception as e:
        logger.error(f"Autopilot Error: {e}")
        try:
            drama = _db().get_drama(drama_id)
            meta = json.loads(drama.get("metadata", "{}") or "{}")
            meta["autopilot_status"] = f"error: {str(e)}"
            _db().update_drama(drama_id, {"metadata": json.dumps(meta)})
        except:
            pass


@router.post("/api/v1/studio/dramas/{drama_id}/start-autopilot")
async def start_autopilot(drama_id: int, background_tasks: BackgroundTasks):
    drama = _db().get_drama(drama_id)
    if not drama:
        raise HTTPException(404, "Drama not found")
        
    meta = json.loads(drama.get("metadata", "{}") or "{}")
    meta["autopilot_status"] = "starting"
    meta["autopilot_progress"] = 0
    _db().update_drama(drama_id, {"metadata": json.dumps(meta)})

    background_tasks.add_task(_autopilot_runner, drama_id)
    return {"status": "started"}


@router.get("/api/v1/studio/dramas/{drama_id}/autopilot-status")
async def get_autopilot_status(drama_id: int):
    drama = _db().get_drama(drama_id)
    if not drama:
        raise HTTPException(404, "Drama not found")
    meta = json.loads(drama.get("metadata", "{}") or "{}")
    return {
        "status": meta.get("autopilot_status", "idle"),
        "progress": meta.get("autopilot_progress", 0),
        "outline": meta.get("series_outline")
    }


# ── Episode CRUD ────────────────────────────────────────────

@router.get("/api/v1/studio/dramas/{drama_id}/episodes")
async def list_episodes(drama_id: int):
    return {"items": _db().list_episodes(drama_id)}


@router.post("/api/v1/studio/dramas/{drama_id}/episodes")
async def create_episode(drama_id: int, request: Request):
    data = await request.json()
    return _db().create_episode(drama_id, data)


@router.get("/api/v1/studio/episodes/{episode_id}")
async def get_episode(episode_id: int):
    ep = _db().get_episode(episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")
    return ep


@router.put("/api/v1/studio/episodes/{episode_id}")
async def update_episode(episode_id: int, request: Request):
    data = await request.json()
    result = _db().update_episode(episode_id, data)
    if not result:
        raise HTTPException(404, "Episode not found")
    return result


# ── Character CRUD ──────────────────────────────────────────

@router.get("/api/v1/studio/dramas/{drama_id}/characters")
async def list_characters(drama_id: int):
    return {"items": _db().list_characters(drama_id)}


@router.put("/api/v1/studio/characters/{char_id}")
async def update_character(char_id: int, request: Request):
    data = await request.json()
    return _db().update_character(char_id, data)


@router.delete("/api/v1/studio/characters/{char_id}")
async def delete_character(char_id: int):
    _db().delete_character(char_id)
    return {"status": "ok"}


def _get_ref_dir():
    """Get the directory for storing reference images."""
    try:
        from tubecli.config import DATA_DIR
        ref_dir = os.path.join(str(DATA_DIR), "content_studio", "references")
    except Exception:
        ref_dir = os.path.join(_ext_dir, "outputs", "references")
    os.makedirs(ref_dir, exist_ok=True)
    return ref_dir


@router.post("/api/v1/studio/characters/{char_id}/upload-ref")
async def upload_character_ref(char_id: int, request: Request):
    """Upload a reference image for a character (multipart/form-data)."""
    import shutil
    from datetime import datetime
    
    form = await request.form()
    file = form.get("file")
    if not file:
        raise HTTPException(400, "No file uploaded")
    
    ref_dir = _get_ref_dir()
    ext = os.path.splitext(file.filename)[1] or ".png"
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"char_{char_id}_{timestamp}{ext}"
    filepath = os.path.join(ref_dir, filename)
    
    with open(filepath, "wb") as f:
        content = await file.read()
        f.write(content)
    
    # Update character's reference_images list
    db = _db()
    char = db._dict(db.conn.execute("SELECT * FROM characters WHERE id = ?", (char_id,)).fetchone())
    if not char:
        raise HTTPException(404, "Character not found")
    
    try:
        refs = json.loads(char.get("reference_images") or "[]")
    except:
        refs = []
    refs.append(filepath)
    
    db.update_character(char_id, {"reference_images": json.dumps(refs), "image_url": filepath})
    
    return {"status": "ok", "path": filepath, "filename": filename}


# Background task storage for generation status
_gen_tasks = {}

@router.post("/api/v1/studio/characters/{char_id}/generate-ref")
async def generate_character_ref(char_id: int, request: Request, background_tasks: BackgroundTasks):
    """Generate a character reference image using Grok Imagine or Veo3."""
    data = await request.json()
    profile_name = data.get("profile_name", "")
    engine = data.get("engine", "grok")  # 'grok' or 'veo3'
    
    if not profile_name:
        raise HTTPException(400, "Browser profile required")
    
    db = _db()
    char = db._dict(db.conn.execute("SELECT * FROM characters WHERE id = ?", (char_id,)).fetchone())
    if not char:
        raise HTTPException(404, "Character not found")
    
    # Build image prompt from character appearance
    appearance = char.get("appearance", "").strip()
    name = char.get("name", "Unknown")
    if not appearance:
        raise HTTPException(400, f"Character '{name}' has no appearance description. Please fill in the Appearance field first.")
    
    # Get visual style from drama
    drama = db.get_drama(char.get("drama_id")) if char.get("drama_id") else None
    char_style = _get_char_style(drama) if drama else "Realistic"
    
    # Get aspect ratio from drama metadata
    char_aspect_ratio = "1:1"
    if drama:
        try:
            drama_meta = json.loads(drama.get("metadata", "{}") or "{}")
            char_aspect_ratio = drama_meta.get("aspect_ratio", "1:1")
        except:
            pass
    
    prompt = _build_char_ref_prompt(name, appearance, char_style, char_aspect_ratio)
    
    ref_dir = _get_ref_dir()
    from datetime import datetime
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"char_{char_id}_ai_{timestamp}.png"
    output_path = os.path.join(ref_dir, filename)
    
    task_id = f"chargen_{char_id}_{timestamp}"
    _gen_tasks[task_id] = {"status": "running", "char_id": char_id, "name": name, "engine": engine}
    
    async def _run_generation():
        import asyncio
        try:
            # Select script based on engine
            if engine == 'veo3':
                gen_script = os.path.join(_ext_dir, "engines", "veo3_char_image.js")
            else:
                gen_script = os.path.join(_ext_dir, "engines", "grok_char_image.js")
            from pathlib import Path
            top_dir = Path(_ext_dir).parents[2]
            browser_ext_dir = str(top_dir / "tubecli" / "extensions" / "browser")
            
            try:
                from tubecli.config import DATA_DIR
                profiles_dir = os.path.join(str(DATA_DIR), "browser_profiles")
            except:
                profiles_dir = str(top_dir / "data" / "browser_profiles")
            
            cmd = [
                "node", gen_script,
                "--profile", profile_name,
                "--prompt", prompt,
                "--output", output_path,
                "--profiles-dir", profiles_dir,
                "--timeout", "120"
            ]
            if engine == 'veo3':
                cmd.extend(["--aspect-ratio", char_aspect_ratio])
            
            env = os.environ.copy()
            env["NODE_PATH"] = os.path.join(browser_ext_dir, "node_modules")
            
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=browser_ext_dir,
                env=env,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=150)
            
            stdout_text = stdout.decode("utf-8", errors="replace").strip()
            stderr_text = stderr.decode("utf-8", errors="replace").strip()
            
            if stderr_text:
                logger.info(f"[CharGen stderr]\n{stderr_text[-2000:]}")
            
            # Parse the JSON result from stdout (both success and error come through console.log → stdout)
            error_msg = "Generation failed"
            if stdout_text:
                for line in reversed(stdout_text.splitlines()):
                    line = line.strip()
                    if line.startswith("{"):
                        try:
                            result = json.loads(line)
                            if result.get("status") == "success" and os.path.exists(output_path):
                                # Update character with new reference image
                                try:
                                    refs = json.loads(char.get("reference_images") or "[]")
                                except:
                                    refs = []
                                refs.append(output_path)
                                db.update_character(char_id, {
                                    "reference_images": json.dumps(refs),
                                    "image_url": output_path
                                })
                                _gen_tasks[task_id] = {"status": "done", "path": output_path, "filename": filename}
                                return
                            elif result.get("status") == "error":
                                # Capture the real error message from the JS script
                                error_msg = result.get("message", "Generation failed")
                        except:
                            pass
                        break  # Only need the last JSON line
            
            logger.error(f"[CharGen] Failed for char {char_id}: {error_msg}")
            _gen_tasks[task_id] = {"status": "error", "message": error_msg}
        except Exception as e:
            logger.error(f"Character image gen error: {e}")
            _gen_tasks[task_id] = {"status": "error", "message": str(e)}
    
    background_tasks.add_task(_run_generation)
    return {"status": "started", "task_id": task_id}


@router.post("/api/v1/studio/scenes/{scene_id}/generate-ref")
async def generate_scene_ref(scene_id: int, request: Request, background_tasks: BackgroundTasks):
    """Generate a scene reference image using Grok Imagine or Veo3."""
    data = await request.json()
    profile_name = data.get("profile_name", "")
    engine = data.get("engine", "grok")  # 'grok' or 'veo3'
    
    if not profile_name:
        raise HTTPException(400, "Browser profile required")
    
    db = _db()
    scene = db._dict(db.conn.execute("SELECT * FROM scenes WHERE id = ?", (scene_id,)).fetchone())
    if not scene:
        raise HTTPException(404, "Scene not found")
    
    location = (scene.get("location", "") or "").strip()
    if not location:
        raise HTTPException(400, "Scene has no location description.")
    
    # Get visual style from drama
    drama = db.get_drama(scene.get("drama_id")) if scene.get("drama_id") else None
    scene_visual_style = _get_visual_style(drama) if drama else "Realistic"
    
    # Get aspect ratio from drama metadata
    scene_aspect_ratio = "16:9"
    if drama:
        try:
            drama_meta = json.loads(drama.get("metadata", "{}") or "{}")
            scene_aspect_ratio = drama_meta.get("aspect_ratio", "16:9")
        except:
            pass
    
    time_of_day = (scene.get("time", "") or "").strip()
    description = (scene.get("description", "") or "").strip()
    prompt = _build_scene_ref_prompt(location, time_of_day, description, scene_visual_style, scene_aspect_ratio)
    
    ref_dir = _get_ref_dir()
    from datetime import datetime
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"scene_{scene_id}_ai_{timestamp}.png"
    output_path = os.path.join(ref_dir, filename)
    
    task_id = f"scenegen_{scene_id}_{timestamp}"
    _gen_tasks[task_id] = {"status": "running", "scene_id": scene_id, "location": location, "engine": engine}
    
    async def _run_generation():
        import asyncio
        try:
            # Select script based on engine
            if engine == 'veo3':
                gen_script = os.path.join(_ext_dir, "engines", "veo3_char_image.js")
            else:
                gen_script = os.path.join(_ext_dir, "engines", "grok_char_image.js")
            from pathlib import Path
            top_dir = Path(_ext_dir).parents[2]
            browser_ext_dir = str(top_dir / "tubecli" / "extensions" / "browser")
            
            try:
                from tubecli.config import DATA_DIR
                profiles_dir = os.path.join(str(DATA_DIR), "browser_profiles")
            except:
                profiles_dir = str(top_dir / "data" / "browser_profiles")
            
            cmd = [
                "node", gen_script,
                "--profile", profile_name,
                "--prompt", prompt,
                "--output", output_path,
                "--profiles-dir", profiles_dir,
                "--timeout", "120"
            ]
            if engine == 'veo3':
                cmd.extend(["--aspect-ratio", scene_aspect_ratio])
            
            env = os.environ.copy()
            env["NODE_PATH"] = os.path.join(browser_ext_dir, "node_modules")
            
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=browser_ext_dir,
                env=env,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=150)
            
            stdout_text = stdout.decode("utf-8", errors="replace").strip()
            stderr_text = stderr.decode("utf-8", errors="replace").strip()
            
            if stderr_text:
                logger.info(f"[SceneGen stderr]\n{stderr_text[-2000:]}")
            
            error_msg = "Generation failed"
            if stdout_text:
                for line in reversed(stdout_text.splitlines()):
                    line = line.strip()
                    if line.startswith("{"):
                        try:
                            result = json.loads(line)
                            if result.get("status") == "success" and os.path.exists(output_path):
                                db.update_scene(scene_id, {"image_url": output_path})
                                _gen_tasks[task_id] = {"status": "done", "path": output_path, "filename": filename}
                                return
                            elif result.get("status") == "error":
                                error_msg = result.get("message", "Generation failed")
                        except:
                            pass
                        break
            
            logger.error(f"[SceneGen] Failed for scene {scene_id}: {error_msg}")
            _gen_tasks[task_id] = {"status": "error", "message": error_msg}
        except Exception as e:
            logger.error(f"Scene image gen error: {e}")
            _gen_tasks[task_id] = {"status": "error", "message": str(e)}
    
    background_tasks.add_task(_run_generation)
    return {"status": "started", "task_id": task_id}


@router.get("/api/v1/studio/browser-profiles")
async def list_browser_profiles():
    """List available browser profiles from data/browser_profiles directory."""
    try:
        from tubecli.config import DATA_DIR
        profiles_dir = os.path.join(str(DATA_DIR), "browser_profiles")
    except Exception:
        from pathlib import Path
        profiles_dir = str(Path(_ext_dir).parents[2] / "data" / "browser_profiles")

    if not os.path.isdir(profiles_dir):
        return {"profiles": [], "profiles_dir": profiles_dir}

    profiles = []
    try:
        for name in sorted(os.listdir(profiles_dir)):
            profile_path = os.path.join(profiles_dir, name)
            if os.path.isdir(profile_path):
                profiles.append(name)
    except Exception as e:
        logger.warning(f"Failed to list profiles: {e}")

    return {"profiles": profiles, "profiles_dir": profiles_dir}


@router.get("/api/v1/studio/generate-status/{task_id}")
async def get_gen_status(task_id: str):
    task = _gen_tasks.get(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    return task


@router.get("/api/v1/studio/references/{filename}")
async def serve_reference(filename: str):
    """Serve a reference image file."""
    ref_dir = _get_ref_dir()
    filepath = os.path.join(ref_dir, filename)
    if os.path.exists(filepath):
        return FileResponse(filepath)
    raise HTTPException(404, "Reference image not found")


@router.post("/api/v1/studio/scenes/{scene_id}/upload-ref")
async def upload_scene_ref(scene_id: int, request: Request):
    """Upload a reference image for a scene."""
    from datetime import datetime
    
    form = await request.form()
    file = form.get("file")
    if not file:
        raise HTTPException(400, "No file uploaded")
    
    ref_dir = _get_ref_dir()
    ext = os.path.splitext(file.filename)[1] or ".png"
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"scene_{scene_id}_{timestamp}{ext}"
    filepath = os.path.join(ref_dir, filename)
    
    with open(filepath, "wb") as f:
        content = await file.read()
        f.write(content)
    
    _db().update_scene(scene_id, {"image_url": filepath})
    return {"status": "ok", "path": filepath, "filename": filename}


# ── Scene CRUD ──────────────────────────────────────────────

@router.get("/api/v1/studio/dramas/{drama_id}/scenes")
async def list_scenes(drama_id: int):
    return {"items": _db().list_scenes(drama_id)}


@router.put("/api/v1/studio/scenes/{scene_id}")
async def update_scene(scene_id: int, request: Request):
    data = await request.json()
    return _db().update_scene(scene_id, data)


# ── Storyboard CRUD ─────────────────────────────────────────

@router.get("/api/v1/studio/episodes/{episode_id}/storyboards")
async def list_storyboards(episode_id: int):
    db = _db()
    items = db.list_storyboards(episode_id)
    # Resolve character_ids → character_names for UI display
    if items:
        ep = db.get_episode(episode_id)
        drama_id = ep.get("drama_id") if ep else None
        if drama_id:
            all_chars = {c["id"]: c["name"] for c in db.list_characters(drama_id)}
            for item in items:
                char_ids = item.get("character_ids", [])
                item["character_names"] = [all_chars[cid] for cid in char_ids if cid in all_chars]
    return {"items": items}


@router.put("/api/v1/studio/storyboards/{sb_id}")
async def update_storyboard(sb_id: int, request: Request):
    data = await request.json()
    return _db().update_storyboard(sb_id, data)


# ── AI Agent Chat (SSE) ────────────────────────────────────

@router.get("/api/v1/studio/agent/types")
async def agent_types():
    return {
        "types": [
            {"id": "script_rewriter", "name": "Script Rewriter", "icon": "✍️",
             "description": "Convert novel/outline into formatted screenplay"},
            {"id": "extractor", "name": "Character & Scene Extractor", "icon": "🔍",
             "description": "Extract characters and scenes from script"},
            {"id": "storyboard_breaker", "name": "Storyboard Breaker", "icon": "🎬",
             "description": "Break script into shot sequences"},
            {"id": "voice_assigner", "name": "Voice Assigner", "icon": "🎙️",
             "description": "Assign AI voices to characters"},
            {"id": "prompt_generator", "name": "Image Prompt Generator", "icon": "🖼️",
             "description": "Generate image prompts for production"},
        ]
    }


@router.post("/api/v1/studio/agent/chat")
async def agent_chat(request: Request):
    """Chat with AI agent. SSE streaming response."""
    data = await request.json()
    agent_type = data.get("agent_type", "script_rewriter")
    message = data.get("message", "")
    episode_id = data.get("episode_id")
    drama_id = data.get("drama_id")

    if not message:
        raise HTTPException(400, "Message is required")

    # Get settings
    s = _settings()
    base_url, api_key, model, temp = s.get_ai_client_params()
    
    language = s.get_script_language()
    if drama_id:
        d = _db().get_drama(drama_id)
        if d and d.get("language"):
            language = d["language"]
    elif episode_id:
        ep = _db().get_episode(episode_id)
        if ep and ep.get("drama_id"):
            d = _db().get_drama(ep["drama_id"])
            if d and d.get("language"):
                language = d["language"]

    # Get agent-specific temperature
    agent_cfg = s.get_agent_config(agent_type)
    agent_temp = agent_cfg.get("temperature", temp)

    if not api_key:
        raise HTTPException(400, "No AI API key configured. Please configure in Settings.")
    if not model:
        raise HTTPException(400, "No AI model configured. Please configure in Settings.")

    # Build context from DB
    context = {}
    if episode_id:
        ep = _db().get_episode(episode_id)
        if ep:
            context["episode"] = {
                "id": ep["id"],
                "title": ep["title"],
                "content": ep["content"][:3000] if ep.get("content") else "",
                "script_content": ep["script_content"][:3000] if ep.get("script_content") else "",
            }
    if drama_id:
        drama = _db().get_drama(drama_id)
        chars = _db().list_characters(drama_id)
        scenes = _db().list_scenes(drama_id)
        drama_meta_chat = json.loads(drama.get("metadata", "{}") or "{}") if drama else {}
        context["visual_style"] = drama.get("style", "realistic") if drama else "realistic"
        context["content_format"] = drama_meta_chat.get("content_format", "Drama / Narrative")
        context["characters"] = [{"id": c["id"], "name": c["name"], "role": c["role"], "appearance": c.get("appearance", ""), "personality": c.get("personality", "")} for c in chars]
        context["scenes"] = [{"id": s["id"], "location": s["location"], "time": s["time"], "description": s.get("description", "")} for s in scenes]

        # ── Inject gallery character roster for Script Rewriter ──
        # So the AI can reference gallery characters by name tag in the script
        gallery_cat_id_chat = drama_meta_chat.get("gallery_category_id")
        if gallery_cat_id_chat and agent_type == "script_rewriter":
            try:
                gallery_items_chat = _db().list_gallery_items(gallery_cat_id_chat)
                if gallery_items_chat:
                    roster = []
                    for gi in gallery_items_chat:
                        roster.append({
                            "name": gi["name"],
                            "gender": gi.get("gender", ""),
                            "age_range": gi.get("age_range", ""),
                            "role_type": gi.get("role_type", ""),
                            "tags": gi.get("tags", ""),
                            "appearance": (gi.get("appearance", "") or "")[:150],
                        })
                    context["gallery_characters"] = roster
                    logger.info(f"[script_rewriter] Injected {len(roster)} gallery characters into context")
            except Exception as e:
                logger.warning(f"Failed to inject gallery roster for script_rewriter: {e}")

        # Auto-fetch previous episode for continuity context
        eps = _db().list_episodes(drama_id)
        eps = sorted(eps, key=lambda x: x.get("episode_number", x["id"]))
        curr_idx = next((i for i, e in enumerate(eps) if e["id"] == episode_id), -1)
        if curr_idx > 0:
            prev = eps[curr_idx - 1]
            # Provide the last ~3000 characters of previous script so AI knows how it ended
            prev_script = prev.get("script_content", "") or prev.get("content", "")
            if prev_script:
                context["previous_episode"] = {
                    "number": prev.get("episode_number", curr_idx),
                    "ending_script_context": prev_script[-3000:]
                }

    # Get the right agent
    agent = _get_agent(agent_type)
    if not agent:
        raise HTTPException(400, f"Unknown agent type: {agent_type}")

    async def generate():
        full_response = []
        async for chunk in agent.chat_stream(
            message, language, base_url, api_key, model, agent_temp, context
        ):
            full_response.append(chunk)
            yield f"data: {json.dumps({'content': chunk})}\n\n"

        # Auto-save script if agent is script_rewriter and episode_id provided
        if agent_type == "script_rewriter" and episode_id:
            full_text = "".join(full_response)
            if full_text and not full_text.startswith("❌"):
                _db().update_episode(episode_id, {"script_content": full_text})
                yield f"data: {json.dumps({'event': 'saved', 'message': 'Script saved to episode'})}\n\n"

        yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _get_agent(agent_type: str):
    """Get agent instance by type."""
    if agent_type == "script_rewriter":
        from agents.script_rewriter import ScriptRewriterAgent
        return ScriptRewriterAgent()
    elif agent_type == "extractor":
        from agents.extractor import ExtractorAgent
        return ExtractorAgent()
    elif agent_type == "storyboard_breaker":
        from agents.storyboard_breaker import StoryboardBreakerAgent
        return StoryboardBreakerAgent()
    elif agent_type == "series_planner":
        from agents.series_planner import SeriesPlannerAgent
        return SeriesPlannerAgent()
    elif agent_type == "novel_writer":
        from agents.novel_writer import NovelWriterAgent
        return NovelWriterAgent()
    return None


# ── Extract Characters & Scenes ─────────────────────────────

@router.post("/api/v1/studio/episodes/{episode_id}/extract")
async def extract_characters_scenes(episode_id: int, request: Request):
    """AI extracts characters and scenes from script, saves to DB with dedup.
    Returns SSE stream with progress + final extracted data.
    Optional body: { profile_name: str }  — overrides drama metadata browser_profile_name."""
    # Parse optional JSON body (profile_name override)
    _req_profile_name = ""
    try:
        _ctype = request.headers.get("content-type", "")
        if "application/json" in _ctype:
            _body = await request.json()
            _req_profile_name = (_body.get("profile_name") or "").strip()
    except Exception:
        pass
    ep = _db().get_episode(episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")

    drama_id = ep["drama_id"]
    script = ep.get("script_content") or ep.get("content") or ""
    if not script.strip():
        raise HTTPException(400, "No script content to extract from. Please write or rewrite first.")

    # Get settings
    s = _settings()
    base_url, api_key, model, temp = s.get_ai_client_params()
    drama_doc2 = _db().get_drama(drama_id)
    language = drama_doc2.get("language") if drama_doc2 and drama_doc2.get("language") else s.get_script_language()
    agent_cfg = s.get_agent_config("extractor")
    agent_temp = agent_cfg.get("temperature", 0.3)

    if not api_key:
        raise HTTPException(400, "No AI API key configured. Please configure in Settings.")

    # Build context with existing data so AI doesn't re-extract
    existing_chars = _db().list_characters(drama_id)
    existing_scenes = _db().list_scenes(drama_id)
    drama = _db().get_drama(drama_id)
    drama_meta = json.loads(drama.get("metadata", "{}") or "{}") if drama else {}
    context = {
        "visual_style": drama.get("style", "realistic") if drama else "realistic",
        "content_format": drama_meta.get("content_format", "Drama / Narrative"),
        "existing_characters": [{"name": c["name"], "role": c["role"]} for c in existing_chars],
        "existing_scenes": [{"location": s["location"], "time": s["time"]} for s in existing_scenes],
    }

    # Inject available gallery characters for the AI to select from
    gallery_category_id = drama_meta.get("gallery_category_id")
    if gallery_category_id:
        try:
            gallery_items = _db().list_gallery_items(gallery_category_id)
            context["available_gallery_characters"] = [
                {
                    "id": item["id"],
                    "name": item["name"],
                    "char_type": item.get("char_type", "individual"),
                    "gender": item.get("gender", ""),
                    "age_range": item.get("age_range", ""),
                    "role_type": item.get("role_type", ""),
                    "tags": item.get("tags", ""),
                    "appearance_summary": item.get("appearance", "")[:200]
                }
                for item in gallery_items
            ]
        except Exception as e:
            logger.error(f"Failed to load gallery items for context: {e}")

    agent = _get_agent("extractor")

    async def generate():
        yield f"data: {json.dumps({'event': 'status', 'message': 'Analyzing script...'})}\n\n"

        # Build extraction message based on content format
        content_format = context.get("content_format", "Drama / Narrative")
        is_drama = "Drama" in content_format or "Phim" in content_format or "Narrative" in content_format
        
        if is_drama:
            extract_msg = (
                "Extract ALL characters and scenes from this script. "
                "Do NOT skip any named character even if minor. "
                "If character/scene already exists in context, skip it."
            )
        else:
            extract_msg = (
                "Extract ALL visual characters/actors and scenes from this educational/informational script.\n"
                "IMPORTANT RULES:\n"
                "- Extract EVERY visual actor from [SHOW:] and [DISPLAY:] tags — including generic unnamed actors "
                "(e.g. 'một người nằm trằn trọc', 'Hai người đang nói chuyện', 'đám đông').\n"
                "- CONSOLIDATE the same character in different poses into ONE entry "
                "(e.g. 'Nhân vật Chibi đang ngồi' + 'Nhân vật Chibi nhận tin nhắn' = ONE character 'Nhân vật Chibi').\n"
                "- Do NOT extract 'Narrator' or 'Người dẫn chuyện' — they are voice-only.\n"
                "- For EACH unique visual actor, create a character entry with detailed appearance.\n"
                "- If character/scene already exists in context, skip it."
            )
        
        full_response = []
        async for chunk in agent.chat_stream(
            f"{extract_msg}\n\nScript:\n{script[:15000]}",
            language, base_url, api_key, model, agent_temp, context
        ):
            full_response.append(chunk)
            yield f"data: {json.dumps({'event': 'progress', 'content': chunk})}\n\n"

        full_text = "".join(full_response)

        # Parse JSON from AI response (with auto-repair)
        try:
            extracted = _repair_json(full_text)
        except (ValueError, json.JSONDecodeError) as parse_err:
            snippet = full_text[:150] + ("..." if len(full_text) > 150 else "")
            yield f"data: {json.dumps({'event': 'error', 'message': f'JSON parse error: {parse_err}. Raw: {snippet}'})}\n\n"
            yield "data: [DONE]\n\n"
            return

        # Save to DB with deduplication
        characters = extracted.get("characters", [])
        scenes = extracted.get("scenes", [])

        saved_chars = []
        saved_scenes = []

        if characters:
            yield f"data: {json.dumps({'event': 'status', 'message': f'Matching {len(characters)} characters against gallery...'})}\n\n"

            # ── Backend Deterministic Gallery Matching ──
            # Load gallery items if available
            _gallery_items_full = []
            _gallery_cat_id = drama_meta.get("gallery_category_id")
            if _gallery_cat_id:
                try:
                    _gallery_items_full = _db().list_gallery_items(_gallery_cat_id)
                except Exception:
                    pass

            if _gallery_items_full:
                _used_gallery_ids = set()

                def _score_match(char_data, gallery_item):
                    """Score how well a gallery item matches an extracted character."""
                    score = 0
                    # Gender match (STRICT — most important)
                    c_gender = (char_data.get("gender", "") or "").lower().strip()
                    g_gender = (gallery_item.get("gender", "") or "").lower().strip()
                    # Infer gender from appearance if not explicit
                    if not c_gender:
                        app = (char_data.get("appearance", "") or "").lower()
                        if any(w in app for w in ["cô gái", "female", "woman", "girl", "nữ", "she", "her", "phụ nữ"]):
                            c_gender = "female"
                        elif any(w in app for w in ["chàng trai", "male", "man", "boy", "nam", "he", "his", "đàn ông"]):
                            c_gender = "male"
                    if c_gender and g_gender:
                        if c_gender == g_gender:
                            score += 40  # Big bonus for gender match
                        else:
                            return -100  # HARD REJECT gender mismatch

                    # Name similarity
                    c_name = (char_data.get("name", "") or "").lower()
                    g_name = (gallery_item.get("name", "") or "").lower()
                    if c_name and g_name:
                        if g_name in c_name or c_name in g_name:
                            score += 30  # Strong name match
                        else:
                            # Check word overlap
                            c_words = set(c_name.split())
                            g_words = set(g_name.split())
                            overlap = c_words & g_words
                            if overlap:
                                score += 15 * len(overlap)

                    # Tags match
                    g_tags = set(t.strip().lower() for t in (gallery_item.get("tags", "") or "").split(",") if t.strip())
                    if g_tags:
                        c_text = f"{c_name} {char_data.get('appearance', '')} {char_data.get('personality', '')}".lower()
                        tag_hits = sum(1 for t in g_tags if t in c_text)
                        score += tag_hits * 10

                    # Role type match
                    g_role = (gallery_item.get("role_type", "") or "").lower()
                    c_role = (char_data.get("role", "") or "").lower()
                    if g_role and c_role and (g_role in c_role or c_role in g_role):
                        score += 10

                    # Age range match
                    g_age = (gallery_item.get("age_range", "") or "").lower()
                    c_app = (char_data.get("appearance", "") or "").lower()
                    if g_age and g_age in c_app:
                        score += 10

                    return score

                for char in characters:
                    # Skip if AI already set a valid gallery_item_id and it's in our gallery
                    ai_gid = char.get("gallery_item_id")
                    if ai_gid and any(gi["id"] == ai_gid for gi in _gallery_items_full) and ai_gid not in _used_gallery_ids:
                        _used_gallery_ids.add(ai_gid)
                        logger.info(f"Character '{char.get('name')}' — kept AI match gallery_item_id={ai_gid}")
                        continue

                    # Backend scoring: find best unused gallery match
                    best_gi = None
                    best_score = 0
                    for gi in _gallery_items_full:
                        if gi["id"] in _used_gallery_ids:
                            continue
                        s = _score_match(char, gi)
                        if s > best_score:
                            best_score = s
                            best_gi = gi

                    if best_gi and best_score >= 20:
                        char["gallery_item_id"] = best_gi["id"]
                        char["suitability_score"] = best_score
                        _used_gallery_ids.add(best_gi["id"])
                        logger.info(f"Character '{char.get('name')}' → matched gallery '{best_gi['name']}' (score={best_score})")
                    else:
                        char["gallery_item_id"] = None
                        char["suitability_score"] = None
                        logger.info(f"Character '{char.get('name')}' → no gallery match (best_score={best_score})")

                match_count = sum(1 for c in characters if c.get("gallery_item_id"))
                yield f"data: {json.dumps({'event': 'status', 'message': f'Gallery matched: {match_count}/{len(characters)} characters'})}\n\n"

            # Enrich matched characters with gallery attributes
            for char in characters:
                gid = char.get("gallery_item_id")
                if gid:
                    try:
                        g_item = _db().get_gallery_item(int(gid))
                        if g_item:
                            if g_item.get("image_url"):
                                char["image_url"] = g_item["image_url"]
                            if g_item.get("reference_images"):
                                char["reference_images"] = g_item["reference_images"]
                            if g_item.get("voice_style"):
                                char["voice_style"] = g_item["voice_style"]
                            base_app = g_item.get("appearance", "")
                            if base_app:
                                char["appearance"] = f"{base_app}\n\nAdditional Details: {char.get('appearance', '')}"
                    except Exception as e:
                        logger.error(f"Failed to merge gallery item {gid}: {e}")

            yield f"data: {json.dumps({'event': 'status', 'message': f'Saving {len(characters)} characters...'})}\n\n"
            saved_chars = _db().save_characters_dedup(drama_id, episode_id, characters)

        if scenes:
            yield f"data: {json.dumps({'event': 'status', 'message': f'Saving {len(scenes)} scenes...'})}\n\n"
            saved_scenes = _db().save_scenes_dedup(drama_id, episode_id, scenes)

        # Mark extract as completed in metadata
        try:
            ep_meta = json.loads(ep.get("metadata", "{}") or "{}")
            ep_meta["extract_completed"] = True
            _db().conn.execute("UPDATE episodes SET metadata = ? WHERE id = ?", (json.dumps(ep_meta), episode_id))
            _db().conn.commit()
        except:
            pass

        # --- Auto-generate AI reference images for new characters ---
        # Re-fetch from DB to get fresh data (saved_chars may have stale image_url from dedup)
        all_drama_chars = _db().list_characters(drama_id)
        chars_for_gen = [c for c in all_drama_chars if c.get("appearance", "").strip() and not c.get("image_url", "").strip()]
        if chars_for_gen:
            drama_obj = _db().get_drama(drama_id)
            char_style = _get_char_style(drama_obj) if drama_obj else "Realistic"
            try:
                drama_meta_img = json.loads(drama_obj.get("metadata", "{}") or "{}")
                # Priority: request body override > drama metadata (browser_profile_name / browser_profile)
                profile_name_img = (
                    _req_profile_name
                    or drama_meta_img.get("browser_profile_name")
                    or drama_meta_img.get("browser_profile")
                    or ""
                )
                logger.info(f"[extract] browser profile resolved: req='{_req_profile_name}' meta='{drama_meta_img.get('browser_profile_name')}' → using='{profile_name_img}'")
                # If we got profile from request and drama metadata was missing it, persist it
                if _req_profile_name and not drama_meta_img.get("browser_profile_name"):
                    drama_meta_img["browser_profile_name"] = _req_profile_name
                    _db().conn.execute(
                        "UPDATE dramas SET metadata = ? WHERE id = ?",
                        (json.dumps(drama_meta_img), drama_id)
                    )
                    _db().conn.commit()
                    logger.info(f"[extract] Persisted browser_profile_name='{_req_profile_name}' to drama {drama_id} metadata")
            except Exception as _meta_ex:
                logger.warning(f"[extract] Failed to parse drama metadata: {_meta_ex}")
                profile_name_img = _req_profile_name or ""

            if not profile_name_img:
                _msg = "⚠️ Chưa chọn Browser Profile — bỏ qua tạo ảnh AI cho " + str(len(chars_for_gen)) + " nhân vật. Chọn profile rồi bấm AI Gen."
                yield f'data: {json.dumps({"event": "status", "message": _msg})}\n\n'
            else:
                _msg = "🎨 Đang tạo ảnh tham chiếu cho " + str(len(chars_for_gen)) + " nhân vật mới..."
                yield f'data: {json.dumps({"event": "status", "message": _msg})}\n\n'
                from pathlib import Path as _PImg
                _grok_s = os.path.join(_ext_dir, "engines", "grok_char_image.js")
                _top = _PImg(_ext_dir).parents[2]
                _bdir = str(_top / "tubecli" / "extensions" / "browser")
                try:
                    from tubecli.config import DATA_DIR as _D2
                    _pdir = os.path.join(str(_D2), "browser_profiles")
                except:
                    _pdir = str(_top / "data" / "browser_profiles")
                _rdir = _get_ref_dir()
                from datetime import datetime as _dt3
                _gok = 0
                _ger = 0
                # Get aspect ratio from drama metadata
                _char_ar = "1:1"
                try:
                    _drama_meta_ar = json.loads(drama_obj.get("metadata", "{}") or "{}")
                    _char_ar = _drama_meta_ar.get("aspect_ratio", "1:1")
                except:
                    pass
                for _ci, _co in enumerate(chars_for_gen):
                    _cid = _co["id"]
                    _cn = _co.get("name", "Unknown")
                    _ca = _co.get("appearance", "")
                    _msg2 = f"🎨 [{_ci+1}/{len(chars_for_gen)}] Tạo ảnh: {_cn}..."
                    yield f'data: {json.dumps({"event": "status", "message": _msg2})}\n\n'
                    _cp = _build_char_ref_prompt(_cn, _ca, char_style, _char_ar)
                    _ts = _dt3.now().strftime("%Y%m%d_%H%M%S")
                    _cout = os.path.join(_rdir, f"char_{_cid}_ai_{_ts}.png")
                    os.makedirs(os.path.dirname(_cout), exist_ok=True)
                    logger.info(f"CharGen [{_cn}] output={_cout}, profile={profile_name_img}")
                    _cmd = ["node", _grok_s, "--profile", profile_name_img, "--prompt", _cp, "--output", _cout, "--profiles-dir", _pdir, "--timeout", "120"]
                    _env = os.environ.copy()
                    _env["NODE_PATH"] = os.path.join(_bdir, "node_modules")
                    try:
                        _pr = await asyncio.create_subprocess_exec(*_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=_bdir, env=_env)
                        _so, _se = await asyncio.wait_for(_pr.communicate(), timeout=150)
                        _sot = _so.decode("utf-8", errors="replace").strip()
                        _set = _se.decode("utf-8", errors="replace").strip()
                        logger.info(f"CharGen [{_cn}] exit={_pr.returncode}, stdout_len={len(_sot)}, stderr_len={len(_set)}")
                        logger.info(f"CharGen [{_cn}] stdout last 500: {_sot[-500:]}")
                        _imok = False
                        if _sot:
                            for _ln in reversed(_sot.splitlines()):
                                if _ln.strip().startswith("{"):
                                    try:
                                        _rj = json.loads(_ln.strip())
                                        logger.info(f"CharGen [{_cn}] parsed JSON: {_rj}")
                                        # Use actual path from result, fallback to expected path
                                        actual_path = _rj.get("path", _cout)
                                        if _rj.get("status") == "success" and os.path.exists(actual_path):
                                            try:
                                                _ors = json.loads(_co.get("reference_images") or "[]")
                                            except:
                                                _ors = []
                                            _ors.append(actual_path)
                                            _db().update_character(_cid, {"reference_images": json.dumps(_ors), "image_url": actual_path})
                                            _imok = True
                                            _gok += 1
                                            yield f'data: {json.dumps({"event": "status", "message": "✅ Đã tạo ảnh cho " + _cn})}\n\n'
                                            break
                                        elif _rj.get("status") == "success":
                                            logger.warning(f"CharGen [{_cn}] success but file not found: {actual_path}, exists={os.path.exists(actual_path)}, cout_exists={os.path.exists(_cout)}")
                                    except:
                                        pass
                        if not _imok:
                            _ger += 1
                            _em = _set[:150] if _set else "Không tìm thấy ảnh output"
                            logger.warning(f"CharGen [{_cn}] FAILED: {_em}")
                            yield f'data: {json.dumps({"event": "status", "message": "⚠️ Lỗi tạo ảnh " + _cn + ": " + _em[:80]})}\n\n'
                    except Exception as _ex:
                        _ger += 1
                        yield f'data: {json.dumps({"event": "status", "message": "⚠️ Lỗi tạo ảnh " + _cn + ": " + str(_ex)[:80]})}\n\n'
                _msg3 = f"🎨 Hoàn thành: {_gok} thành công, {_ger} thất bại"
                yield f'data: {json.dumps({"event": "status", "message": _msg3})}\n\n'

        # --- Auto-generate AI reference images for new scenes ---
        all_drama_scenes = _db().list_scenes(drama_id)
        scenes_for_gen = [sc for sc in all_drama_scenes if sc.get("location", "").strip() and not sc.get("image_url", "").strip()]
        if scenes_for_gen:
            drama_obj_sc = _db().get_drama(drama_id)
            scene_visual_style = _get_visual_style(drama_obj_sc) if drama_obj_sc else "Realistic"
            try:
                drama_meta_sc = json.loads(drama_obj_sc.get("metadata", "{}") or "{}")
                profile_name_sc = (
                    _req_profile_name
                    or drama_meta_sc.get("browser_profile_name")
                    or drama_meta_sc.get("browser_profile")
                    or ""
                )
            except:
                profile_name_sc = _req_profile_name or ""
            
            scene_ar = "16:9"
            try:
                scene_ar = drama_meta_sc.get("aspect_ratio", "16:9")
            except:
                pass

            if not profile_name_sc:
                _smsg = "⚠️ Chưa chọn Browser Profile — bỏ qua tạo ảnh AI cho " + str(len(scenes_for_gen)) + " cảnh."
                yield f'data: {json.dumps({"event": "status", "message": _smsg})}\n\n'
            else:
                _smsg = "🖼️ Đang tạo ảnh tham chiếu cho " + str(len(scenes_for_gen)) + " cảnh mới..."
                yield f'data: {json.dumps({"event": "status", "message": _smsg})}\n\n'
                from pathlib import Path as _PSc
                _grok_sc = os.path.join(_ext_dir, "engines", "grok_char_image.js")
                _top_sc = _PSc(_ext_dir).parents[2]
                _bdir_sc = str(_top_sc / "tubecli" / "extensions" / "browser")
                try:
                    from tubecli.config import DATA_DIR as _DSc
                    _pdir_sc = os.path.join(str(_DSc), "browser_profiles")
                except:
                    _pdir_sc = str(_top_sc / "data" / "browser_profiles")
                _rdir_sc = _get_ref_dir()
                from datetime import datetime as _dtsc
                _sok = 0
                _ser = 0
                for _si, _so_obj in enumerate(scenes_for_gen):
                    _sid = _so_obj["id"]
                    _sloc = _so_obj.get("location", "Unknown")
                    _stime = _so_obj.get("time", "")
                    _sdesc = _so_obj.get("description", "")
                    _smsg2 = f"🖼️ [{_si+1}/{len(scenes_for_gen)}] Tạo ảnh cảnh: {_sloc[:40]}..."
                    yield f'data: {json.dumps({"event": "status", "message": _smsg2})}\n\n'
                    _sp = _build_scene_ref_prompt(_sloc, _stime, _sdesc, scene_visual_style, scene_ar)
                    _sts = _dtsc.now().strftime("%Y%m%d_%H%M%S")
                    _sout = os.path.join(_rdir_sc, f"scene_{_sid}_ai_{_sts}.png")
                    os.makedirs(os.path.dirname(_sout), exist_ok=True)
                    logger.info(f"SceneGen [{_sloc[:30]}] output={_sout}, profile={profile_name_sc}")
                    _scmd = ["node", _grok_sc, "--profile", profile_name_sc, "--prompt", _sp, "--output", _sout, "--profiles-dir", _pdir_sc, "--timeout", "120"]
                    _senv = os.environ.copy()
                    _senv["NODE_PATH"] = os.path.join(_bdir_sc, "node_modules")
                    try:
                        _spr = await asyncio.create_subprocess_exec(*_scmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=_bdir_sc, env=_senv)
                        _sso, _sse = await asyncio.wait_for(_spr.communicate(), timeout=150)
                        _ssot = _sso.decode("utf-8", errors="replace").strip()
                        _simok = False
                        if _ssot:
                            for _sln in reversed(_ssot.splitlines()):
                                if _sln.strip().startswith("{"):
                                    try:
                                        _srj = json.loads(_sln.strip())
                                        actual_path_sc = _srj.get("path", _sout)
                                        if _srj.get("status") == "success" and os.path.exists(actual_path_sc):
                                            _db().update_scene(_sid, {"image_url": actual_path_sc})
                                            _simok = True
                                            _sok += 1
                                            yield f'data: {json.dumps({"event": "status", "message": "✅ Đã tạo ảnh cảnh " + _sloc[:40]})}\n\n'
                                            break
                                    except:
                                        pass
                        if not _simok:
                            _ser += 1
                            yield f'data: {json.dumps({"event": "status", "message": "⚠️ Lỗi tạo ảnh cảnh " + _sloc[:40]})}\n\n'
                    except Exception as _sex:
                        _ser += 1
                        yield f'data: {json.dumps({"event": "status", "message": "⚠️ Lỗi tạo ảnh cảnh " + _sloc[:40] + ": " + str(_sex)[:60]})}\n\n'
                _smsg3 = f"🖼️ Hoàn thành cảnh: {_sok} thành công, {_ser} thất bại"
                yield f'data: {json.dumps({"event": "status", "message": _smsg3})}\n\n'

        # Return final result
        result = {
            "event": "complete",
            "characters": characters,
            "scenes": scenes,
            "saved_characters": len(saved_chars),
            "saved_scenes": len(saved_scenes),
        }
        yield f"data: {json.dumps(result)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Storyboard Breakdown ───────────────────────────────

@router.delete("/api/v1/studio/episodes/{episode_id}/storyboards")
async def clear_storyboards(episode_id: int):
    """Clear (soft delete) all storyboards for an episode."""
    import datetime
    now = datetime.datetime.now().isoformat()
    _db().conn.execute("UPDATE storyboards SET deleted_at = ? WHERE episode_id = ? AND deleted_at IS NULL", (now, episode_id))
    _db().conn.commit()
    return {"status": "ok"}


@router.post("/api/v1/studio/episodes/{episode_id}/storyboard")
async def generate_storyboard(episode_id: int, request: Request):
    """AI breaks script into storyboard shots, saves to DB.
    Returns SSE stream with progress + final shot data."""
    data = await request.json() if request.headers.get('content-type') == 'application/json' else {}
    append_mode = data.get("append", False)

    ep = _db().get_episode(episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")

    drama_id = ep["drama_id"]
    script = ep.get("script_content") or ep.get("content") or ""
    if not script.strip():
        raise HTTPException(400, "No script content. Please complete Rewrite first.")

    # Check for existing storyboards if append_mode is true
    existing_shots = []
    if append_mode:
        existing_shots = _db().conn.execute(
            "SELECT storyboard_number, description FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number",
            (episode_id,)
        ).fetchall()

    # Get settings
    s = _settings()
    base_url, api_key, model, temp = s.get_ai_client_params()
    drama_doc3 = _db().get_drama(drama_id)
    language = drama_doc3.get("language") if drama_doc3 and drama_doc3.get("language") else s.get_script_language()
    agent_cfg = s.get_agent_config("storyboard_breaker")
    agent_temp = agent_cfg.get("temperature", 0.5)

    if not api_key:
        raise HTTPException(400, "No AI API key configured.")

    # Build context with characters and scenes
    drama = _db().get_drama(drama_id)
    characters = _db().list_characters(drama_id)
    scenes = _db().list_scenes(drama_id)
    drama_metadata = json.loads(drama.get("metadata", "{}") or "{}") if drama else {}
    
    context = {
        "visual_style": drama.get("style", "realistic") if drama else "realistic",
        "content_format": drama_metadata.get("content_format", "Drama / Narrative"),
        "shot_density": drama_metadata.get("shot_density", "normal"),
        "camera_angle": drama_metadata.get("camera_angle", "Default"),
        "ethnicity": drama_metadata.get("ethnicity", "Default"),
        "prompt_focus": drama_metadata.get("prompt_focus", "Default"),
        "no_text_in_prompt": drama_metadata.get("no_text_in_prompt", False),
        "text_in_video": drama_metadata.get("text_in_video", "notext" if drama_metadata.get("no_text_in_prompt", False) else "none"),
        "narration_source": drama_metadata.get("narration_source", "prose"),
        "characters": [{"id": c["id"], "name": c["name"], "role": c["role"], "appearance": c["appearance"], "personality": c["personality"]} for c in characters],
        "scenes": [{"id": s["id"], "location": s["location"], "time": s["time"], "description": s["description"]} for s in scenes],
    }
    # Provide raw prose content for narration extraction
    raw_content = ep.get("content") or ""
    if drama_metadata.get("narration_source") == "prose" and raw_content.strip():
        context["raw_prose_content"] = raw_content[:12000]

    # Inject gallery items into context — split by type for AI targeting
    gallery_cat_id = drama_metadata.get("gallery_category_id")
    if gallery_cat_id:
        try:
            gallery_items = _db().list_gallery_items(gallery_cat_id)
            if gallery_items:
                visual_assets = []  # charts, infographics, diagrams, etc.
                visual_effects = []  # holograms, overlays, thought bubbles, etc.
                for gi in gallery_items:
                    gi_type = gi.get("char_type", "individual")
                    entry = {
                        "name": gi.get("name", ""),
                        "type": gi_type,
                        "appearance": gi.get("appearance", ""),
                        "tags": gi.get("tags", ""),
                    }
                    if gi_type in ASSET_TYPES:
                        visual_assets.append(entry)
                    elif gi_type in EFFECT_TYPES:
                        visual_effects.append(entry)
                    # CHARACTER_TYPES are already in context["characters"]
                if visual_assets:
                    context["visual_assets"] = visual_assets
                if visual_effects:
                    context["visual_effects"] = visual_effects
                logger.info(f"Storyboard context: {len(visual_assets)} assets, {len(visual_effects)} effects from gallery {gallery_cat_id}")
        except Exception as e:
            logger.warning(f"Failed to load gallery items for storyboard context: {e}")

    # Build name-to-id map for character resolution
    char_name_map = {c["name"].lower().strip(): c["id"] for c in characters}

    agent = _get_agent("storyboard_breaker")

    async def generate():
        try:
            import re
            # Generic section heading pattern: matches ## S01, ## N01, ## L01, ## AD01, ## H01, ## D01, ## EP01, etc.
            section_pattern = r'(?m)(?=^## (?:S|N|L|AD|H|D|EP)\d+)'
            parts = re.split(section_pattern, script)
            parts = [p.strip() for p in parts if p.strip()]
            
            has_tags = any(re.match(r'^## (?:S|N|L|AD|H|D|EP)\d+', p) for p in parts)
            if not has_tags:
                chunk_size = 1
                chunks = [script]
            else:
                chunk_size = 6
                chunks = []
                current_chunk = ""
                scene_count = 0
                for part in parts:
                    current_chunk += part + "\n\n"
                    if re.match(r'^## (?:S|N|L|AD|H|D|EP)\d+', part):
                        scene_count += 1
                    if scene_count >= chunk_size:
                        chunks.append(current_chunk.strip())
                        current_chunk = ""
                        scene_count = 0
                if current_chunk.strip():
                    chunks.append(current_chunk.strip())

            total_chunks_original = len(chunks)
            existing_shots_count = len(existing_shots) if (append_mode and existing_shots) else 0
            
            pending_chunk_indices = []
            scenes_so_far = 0
            for idx, chunk_text in enumerate(chunks):
                scenes_in_chunk = len(re.findall(r'^## (?:S|N|L|AD|H|D|EP)\d+', chunk_text, re.MULTILINE)) if has_tags else 1
                scenes_so_far += scenes_in_chunk
                
                if scenes_so_far <= existing_shots_count and existing_shots_count > 0:
                    continue
                pending_chunk_indices.append(idx)

            all_shots = []
            is_first = True

            for idx in pending_chunk_indices:
                chunk_text = chunks[idx]
                yield f"data: {json.dumps({'event': 'status', 'message': f'Phân đoạn {idx+1}/{total_chunks_original}...'})}\n\n"

                # Count scenes in this chunk and list their headings
                import re as _re_sb
                scene_headings = _re_sb.findall(r'^## (?:S|N|L|AD|H|D|EP)\d+[^\n]*', chunk_text, _re_sb.MULTILINE)
                scene_count_in_chunk = len(scene_headings) if scene_headings else 1
                headings_list = '\n'.join(scene_headings) if scene_headings else '(no section headings found)'
                
                prompt = (
                    f"Break this portion of the screenplay into storyboard shots.\n"
                    f"CRITICAL: This chunk contains EXACTLY {scene_count_in_chunk} scenes. "
                    f"You MUST output EXACTLY {scene_count_in_chunk} shot objects, one per scene heading.\n"
                    f"Scene headings in this chunk:\n{headings_list}\n\n"
                    f"REMINDER: For EVERY shot, you MUST include the `illustrate_layout` field describing how visual elements are composed with characters (e.g. 'Character on left gesturing at floating data panel on right', 'Split screen: character top, process diagram bottom'). "
                    f"Even without gallery assets, use Auto-Illustrate to create engaging visual compositions.\n\n"
                    f"Script:\n\n{chunk_text}"
                )
                if append_mode and existing_shots and is_first:
                    last_shot = existing_shots[-1]
                    prompt += f"\n\nIMPORTANT: You have already generated up to shot number {last_shot['storyboard_number']}.\nYOU MUST RESUME GENERATION EXACTLY FROM SHOT NUMBER {last_shot['storyboard_number'] + 1}."

                full_response = []
                # We yield a new line to separate JSON blocks in the UI stream
                data_json = json.dumps({'event': 'progress', 'content': '\n\n---\n\n'})
                yield f"data: {data_json}\n\n"
            
                async for chunk in agent.chat_stream(
                    prompt,
                    language, base_url, api_key, model, agent_temp, context
                ):
                    full_response.append(chunk)
                    yield f"data: {json.dumps({'event': 'progress', 'content': chunk})}\n\n"

                full_text = "".join(full_response)

                parsed = None
                try:
                    parsed = _repair_json(full_text)
                except (ValueError, json.JSONDecodeError):
                    pass
                
                # Fallback 1: try to find a raw JSON array
                if not parsed:
                    import re as _re_arr
                    array_match = _re_arr.search(r'\[[\s\S]*\]', full_text)
                    if array_match:
                        try:
                            parsed_array = json.loads(array_match.group())
                            if isinstance(parsed_array, list):
                                parsed = {"storyboards": parsed_array}
                        except Exception:
                            pass

                # Fallback 2: extract JSON from markdown code fence
                if not parsed:
                    import re as _re_fence
                    fence_match = _re_fence.search(r'```(?:json)?\s*(\{[\s\S]*?\})\s*```', full_text)
                    if fence_match:
                        try:
                            parsed = json.loads(fence_match.group(1))
                        except Exception:
                            try:
                                parsed = _repair_json(fence_match.group(1))
                            except Exception:
                                pass

                # Fallback 3: extract individual JSON objects via bracket matching
                if not parsed:
                    obj_candidates = []
                    depth = 0
                    start = -1
                    for ci, ch in enumerate(full_text):
                        if ch == '{':
                            if depth == 0:
                                start = ci
                            depth += 1
                        elif ch == '}':
                            depth -= 1
                            if depth == 0 and start >= 0:
                                candidate = full_text[start:ci+1]
                                try:
                                    obj = json.loads(candidate)
                                    if isinstance(obj, dict):
                                        if any(k in obj for k in ['title', 'scene_heading', 'shot_type', 'image_prompt', 'narration_text']):
                                            obj_candidates.append(obj)
                                        elif any(isinstance(v, list) for v in obj.values()):
                                            parsed = obj
                                            break
                                except Exception:
                                    pass
                                start = -1
                    if not parsed and obj_candidates:
                        parsed = {"storyboards": obj_candidates}

                shots = []
                if parsed:
                    for possible_key in ["storyboards", "storyboard", "shots", "shot", "scenes", "data"]:
                        if possible_key in parsed and isinstance(parsed[possible_key], list):
                            shots = parsed[possible_key]
                            break
                    if not shots and isinstance(parsed, dict):
                        for k, v in parsed.items():
                            if isinstance(v, list):
                                shots = v
                                break
                    # Edge case: AI returns bare array
                    if not shots and isinstance(parsed, list):
                        shots = parsed

                # If still no shots, log and retry once with stricter prompt
                if not shots:
                    logger.warning(f"Storyboard chunk {idx+1}: parse failed. First 500 chars: {full_text[:500]}")
                    retry_prompt = (
                        f"Your previous response could not be parsed as JSON. "
                        f"Please output ONLY a valid JSON object with a 'storyboards' array. "
                        f"No markdown, no explanation, ONLY JSON.\n\n"
                        f"Script:\n\n{chunk_text}"
                    )
                    retry_response = []
                    async for rchunk in agent.chat_stream(
                        retry_prompt, language, base_url, api_key, model, agent_temp, context
                    ):
                        retry_response.append(rchunk)
                    retry_text = "".join(retry_response)
                    try:
                        retry_parsed = _repair_json(retry_text)
                        if retry_parsed:
                            for pk in ["storyboards", "storyboard", "shots", "shot", "scenes", "data"]:
                                if pk in retry_parsed and isinstance(retry_parsed[pk], list):
                                    shots = retry_parsed[pk]
                                    break
                            if not shots:
                                for k, v in retry_parsed.items():
                                    if isinstance(v, list):
                                        shots = v
                                        break
                    except Exception:
                        logger.error(f"Storyboard chunk {idx+1}: retry also failed. First 500 chars: {retry_text[:500]}")

                if shots:
                    # Validate: AI should produce one shot per scene
                    expected = scene_count_in_chunk
                    if len(shots) < expected:
                        logger.warning(f"Storyboard chunk {idx+1}: AI returned {len(shots)} shots but expected {expected}")
                        yield f"data: {json.dumps({'event': 'status', 'message': f'⚠️ Chunk {idx+1}: {len(shots)}/{expected} shots'})}\\n\\n"
                    all_shots.extend(shots)
            
                is_first = False

            if not all_shots:
                yield f"data: {json.dumps({'event': 'error', 'message': 'Could not locate shots array in AI response across all chunks.'})}\n\n"
                yield "data: [DONE]\n\n"
                return

            # -- Auto-split shots exceeding MAX_SHOT_DURATION --
            import math as _math_sb
            MAX_SHOT_DURATION = 15
            split_result = []
            split_count = 0
            for shot in all_shots:
                dur = shot.get("duration", 10)
                if isinstance(dur, str):
                    try:
                        dur = int(dur)
                    except (ValueError, TypeError):
                        dur = 10
                if dur > MAX_SHOT_DURATION:
                    num_parts = _math_sb.ceil(dur / MAX_SHOT_DURATION)
                    sub_dur = round(dur / num_parts)
                    narration = shot.get("narration_text", "") or ""
                    # Split narration by sentence boundaries
                    _sentences = re.split(r'(?<=[.!?\u3002\uff01\uff1f])\s+', narration) if narration.strip() else ['']
                    _sentences = [s for s in _sentences if s.strip()]
                    if not _sentences:
                        _sentences = ['']
                    _spp = max(1, len(_sentences) // num_parts)
                    for part_idx in range(num_parts):
                        sub_shot = dict(shot)
                        sub_shot["duration"] = sub_dur
                        orig_title = shot.get("title", "")
                        sub_shot["title"] = f"{orig_title} (Part {part_idx + 1}/{num_parts})"
                        # Distribute narration sentences
                        s_start = part_idx * _spp
                        s_end = s_start + _spp if part_idx < num_parts - 1 else len(_sentences)
                        sub_shot["narration_text"] = " ".join(_sentences[s_start:s_end])
                        split_result.append(sub_shot)
                    split_count += 1
                    logger.info(f"Auto-split shot '{shot.get('title', '')}' ({dur}s) into {num_parts} sub-shots of ~{sub_dur}s")
                else:
                    split_result.append(shot)
            if split_count > 0:
                yield f"data: {json.dumps({'event': 'status', 'message': f'Auto-split {split_count} shots exceeding {MAX_SHOT_DURATION}s'})}\n\n"
            all_shots = split_result

            yield f"data: {json.dumps({'event': 'status', 'message': f'Saving {len(all_shots)} shots...'})}\n\n"

            for shot in all_shots:
                names = shot.get("character_names", [])
                char_ids = []
                for name in (names or []):
                    cid = char_name_map.get(name.lower().strip())
                    if cid:
                        char_ids.append(cid)
                shot["character_ids"] = char_ids

            scene_map = {f"{s['location'].lower()}|{s['time'].lower()}": s["id"] for s in scenes}
            for shot in all_shots:
                loc = (shot.get("location") or "").lower()
                tm = (shot.get("time") or "").lower()
                key = f"{loc}|{tm}"
                if key in scene_map:
                    shot["scene_id"] = scene_map[key]
                else:
                    for skey, sid in scene_map.items():
                        if loc and loc in skey.split("|")[0]:
                            shot["scene_id"] = sid
                            break

            saved = _db().save_storyboards_bulk(episode_id, all_shots, append=append_mode)

            result = {
                "event": "complete",
                "storyboards": all_shots,
                "saved_count": len(saved),
            }
            yield f"data: {json.dumps(result, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"

        except Exception as e:
            import traceback
            traceback.print_exc()
            yield f"data: {json.dumps({'event': 'error', 'message': str(e)})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Export ──────────────────────────────────────────────────

@router.post("/api/v1/studio/episodes/{episode_id}/export")
async def export_episode(episode_id: int, request: Request):
    """Export episode content as markdown/txt/json."""
    data = await request.json()
    fmt = data.get("format", "md")
    ep = _db().get_episode(episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")

    drama = _db().get_drama(ep["drama_id"]) if ep.get("drama_id") else {}

    title = drama.get("title", "Untitled") if drama else "Untitled"
    ep_title = ep.get("title", f"Episode {ep.get('episode_number', '')}".strip() or "Untitled")

    import re
    safe_title = re.sub(r'[\\/*?:"<>|]', "", title).strip()
    safe_ep_title = re.sub(r'[\\/*?:"<>|]', "", ep_title).strip()
    safe_filename = f"{safe_title}_{safe_ep_title}.{fmt}"

    if fmt == "json":
        return {
            "format": "json",
            "filename": safe_filename,
            "data": {
                "drama": drama,
                "episode": ep,
                "characters": _db().list_characters(ep["drama_id"]),
                "scenes": _db().list_scenes(ep["drama_id"]),
                "storyboards": _db().list_storyboards(episode_id),
            },
        }

    # MD/TXT format
    title = drama.get("title", "Untitled") if drama else "Untitled"
    ep_title = ep.get("title", f"Episode {ep.get('episode_number', '?')}")
    content = ep.get("script_content") or ep.get("content", "")

    if fmt == "md":
        output = f"# {title}\n## {ep_title}\n\n{content}"
    else:
        output = f"{title}\n{ep_title}\n{'=' * 40}\n\n{content}"

    return {"format": fmt, "content": output, "filename": f"{title}_{ep_title}.{fmt}"}


# ── Browser Profile Discovery (TubeCLI Browser Extension) ────

@router.get("/api/v1/studio/browser-profiles")
async def list_browser_profiles():
    """List available TubeCLI browser profiles from the browser extension."""
    try:
        import sys
        browser_ext = os.path.normpath(os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "..", "..", "..", "tubecli", "extensions", "browser"
        ))
        if browser_ext not in sys.path:
            sys.path.insert(0, browser_ext)
        from profile_manager import list_profiles
        profiles = list_profiles()
        result = [{
            "id": p["name"],
            "name": p["name"],
            "has_cookies": p.get("has_cookies", False),
            "has_fingerprint": p.get("has_fingerprint", False),
            "notes": p.get("notes", ""),
            "google_account": p.get("google_account"),
        } for p in profiles]
        return {"success": True, "profiles": result, "count": len(result)}
    except Exception as e:
        logger.warning(f"Could not load browser profiles: {e}")
        return {"success": True, "profiles": [], "count": 0, "error": str(e)}


# ── Grok Image Generation ────────────────────────────────────

# In-memory tracker for gen-image tasks
_image_tasks: dict = {}


@router.post("/api/v1/studio/episodes/{episode_id}/gen-images")
async def start_gen_images(episode_id: int, request: Request, background_tasks: BackgroundTasks):
    """Start Grok image generation for an episode's storyboard shots using TubeCLI browser profile."""
    data = await request.json()
    profile_name = data.get("profile_name", data.get("profile_path", ""))  # accept both keys
    headless = data.get("headless", False)
    overwrite = data.get("overwrite", False)

    if not profile_name:
        raise HTTPException(400, "browser profile_name is required")

    ep = _db().get_episode(episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")

    shots = _db().list_storyboards(episode_id)
    if not shots:
        raise HTTPException(400, "No storyboard shots found. Generate storyboard first.")

    import uuid
    task_id = str(uuid.uuid4())[:8]

    pending = [s for s in shots if s.get("image_prompt", "").strip()]
    if not overwrite:
        pending = [s for s in pending if not s.get("composed_image", "").strip()]

    _image_tasks[task_id] = {
        "status": "starting",
        "episode_id": episode_id,
        "done": 0,
        "total": len(pending),
        "current_shot": None,
        "errors": [],
    }

    # Setup cancel infrastructure
    import asyncio as _asyncio
    cancel_event = _asyncio.Event()
    process_list = []
    _gen_cancel_events[task_id] = cancel_event
    _gen_processes[task_id] = process_list

    async def _runner():
        _image_tasks[task_id]["status"] = "running"
        try:
            import sys, os
            ext_dir = os.path.dirname(os.path.abspath(__file__))
            engines_dir = os.path.join(ext_dir, "engines")
            if engines_dir not in sys.path:
                sys.path.insert(0, engines_dir)
            from grok_image_engine import batch_generate

            async def on_progress(done, total, shot_id, status, path=None):
                _image_tasks[task_id]["done"] = done
                _image_tasks[task_id]["total"] = total
                _image_tasks[task_id]["current_shot"] = shot_id
                if path:
                    _image_tasks[task_id]["current_path"] = path
                    # Save to DB immediately so the UI is synchronized if refreshed
                    _db().update_storyboard(shot_id, {"composed_image": path, "status": "image_done"})
                if status == "error":
                    _image_tasks[task_id]["errors"].append(shot_id)

            results = await batch_generate(
                shots=shots,
                profile_name=profile_name,
                episode_id=episode_id,
                headless=headless,
                overwrite=overwrite,
                progress_callback=on_progress,
                cancel_event=cancel_event,
                process_registry=process_list,
            )

            if any(r.get("message") == "RATE_LIMIT_REACHED" for r in results):
                logger.error("Rate limit reached during image generation. Aborting task.")
                _image_tasks[task_id]["status"] = "error: RATE_LIMIT_REACHED"
                
                # Send telegram notification
                try:
                    import httpx
                    from tubecli.config import DATA_DIR
                    settings_path = DATA_DIR / "global_settings.json"
                    if settings_path.exists():
                        with open(settings_path, "r", encoding="utf-8") as f:
                            data = json.load(f)
                        token = data.get("telegram_bot_token")
                        chat_id = data.get("telegram_chat_id")
                        if token and chat_id:
                            httpx.post(
                                f"https://api.telegram.org/bot{token}/sendMessage",
                                json={"chat_id": chat_id, "text": "⛔ [Auto-Pilot] Dừng khẩn cấp: Đã đạt giới hạn Grok Rate Limit (Hết lượt render Image)."},
                                timeout=10
                            )
                except Exception as e:
                    logger.error(f"Telegram notify failed: {e}")
                
                return

            _image_tasks[task_id]["status"] = "completed"
            _image_tasks[task_id]["done"] = _image_tasks[task_id]["total"]

        except Exception as e:
            logger.error(f"Gen images runner error: {e}")
            _image_tasks[task_id]["status"] = f"error: {str(e)}"

    background_tasks.add_task(_runner)
    return {"success": True, "task_id": task_id, "total": len(pending)}


@router.get("/api/v1/studio/gen-images/status/{task_id}")
async def get_gen_images_status(task_id: str):
    """Poll image generation task status."""
    task = _image_tasks.get(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    return {"success": True, **task}


_video_tasks: dict = {}
_tts_tasks: dict = {}
# Store cancel events and subprocess refs for killing on abort
_gen_cancel_events: dict = {}  # task_id -> asyncio.Event
_gen_processes: dict = {}  # task_id -> list of asyncio.subprocess.Process


@router.post("/api/v1/studio/gen-videos/cancel/{task_id}")
async def cancel_gen_videos(task_id: str):
    """Cancel an in-progress video generation task and kill browser processes."""
    task = _video_tasks.get(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    
    # Set cancel event so engine loop stops
    cancel_event = _gen_cancel_events.get(task_id)
    if cancel_event:
        cancel_event.set()
    
    # Kill all subprocess (Node.js browsers)
    procs = _gen_processes.get(task_id, [])
    for proc in procs:
        try:
            proc.kill()
            logger.info(f"Killed gen-video subprocess PID {proc.pid} for task {task_id}")
        except Exception as e:
            logger.warning(f"Failed to kill subprocess: {e}")
    
    task["status"] = "error: cancelled by user"
    return {"success": True, "message": "Cancellation requested"}


@router.post("/api/v1/studio/gen-images/cancel/{task_id}")
async def cancel_gen_images(task_id: str):
    """Cancel an in-progress image generation task and kill browser processes."""
    task = _image_tasks.get(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    
    cancel_event = _gen_cancel_events.get(task_id)
    if cancel_event:
        cancel_event.set()
    
    procs = _gen_processes.get(task_id, [])
    for proc in procs:
        try:
            proc.kill()
            logger.info(f"Killed gen-image subprocess PID {proc.pid} for task {task_id}")
        except Exception as e:
            logger.warning(f"Failed to kill subprocess: {e}")
    
    task["status"] = "error: cancelled by user"
    return {"success": True, "message": "Cancellation requested"}


def _generate_fallback_slide(shot, episode_id, aspect_ratio="16:9", engines_dir=None):
    """
    Generate a fallback slide image (then convert to mp4) for a shot that failed video gen.
    Uses Pillow to draw text on a dark gradient background.
    """
    import os
    from pathlib import Path

    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        logger.warning("Pillow not installed, cannot generate fallback slide")
        return None

    # Determine dimensions from aspect ratio
    ar_map = {
        "16:9": (1280, 720),
        "9:16": (720, 1280),
        "1:1": (720, 720),
        "4:3": (960, 720),
        "3:4": (720, 960),
    }
    w, h = ar_map.get(aspect_ratio, (1280, 720))

    # Create dark gradient background
    img = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(img)

    for y in range(h):
        ratio = y / h
        r = int(15 + ratio * 25)
        g = int(15 + ratio * 20)
        b = int(30 + ratio * 40)
        draw.line([(0, y), (w, y)], fill=(r, g, b))

    # Try to load a decent font
    font_big = None
    font_small = None
    font_paths = [
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for fp in font_paths:
        if os.path.exists(fp):
            try:
                font_big = ImageFont.truetype(fp, max(28, w // 25))
                font_small = ImageFont.truetype(fp, max(18, w // 40))
                break
            except:
                pass
    if not font_big:
        font_big = ImageFont.load_default()
        font_small = font_big

    # Draw shot number badge
    shot_num = shot.get("storyboard_number", "?")
    title = shot.get("title", "")
    desc = shot.get("description", shot.get("narration_text", ""))

    badge = f"Shot #{shot_num}"
    draw.rounded_rectangle(
        [w // 2 - 80, int(h * 0.15), w // 2 + 80, int(h * 0.15) + 36],
        radius=18, fill=(100, 80, 200)
    )
    bbox = draw.textbbox((0, 0), badge, font=font_small)
    tw = bbox[2] - bbox[0]
    draw.text((w // 2 - tw // 2, int(h * 0.15) + 8), badge, fill="white", font=font_small)

    # Draw title
    if title:
        # Word wrap title
        max_chars = max(20, w // 20)
        lines = []
        words = title.split()
        current = ""
        for word in words:
            if len(current) + len(word) + 1 > max_chars:
                lines.append(current)
                current = word
            else:
                current = (current + " " + word).strip()
        if current:
            lines.append(current)
        
        y_pos = int(h * 0.30)
        for line in lines[:3]:
            bbox = draw.textbbox((0, 0), line, font=font_big)
            tw = bbox[2] - bbox[0]
            draw.text((w // 2 - tw // 2, y_pos), line, fill=(230, 230, 255), font=font_big)
            y_pos += int(font_big.size * 1.4) if hasattr(font_big, 'size') else 40

    # Draw description (smaller, dimmer)
    if desc:
        max_chars = max(30, w // 14)
        lines = []
        words = desc.split()
        current = ""
        for word in words:
            if len(current) + len(word) + 1 > max_chars:
                lines.append(current)
                current = word
            else:
                current = (current + " " + word).strip()
        if current:
            lines.append(current)
        
        y_pos = int(h * 0.50)
        for line in lines[:5]:
            bbox = draw.textbbox((0, 0), line, font=font_small)
            tw = bbox[2] - bbox[0]
            draw.text((w // 2 - tw // 2, y_pos), line, fill=(160, 160, 190), font=font_small)
            y_pos += int(font_small.size * 1.3) if hasattr(font_small, 'size') else 28

    # Draw "fallback" watermark
    wm = "⚠ Fallback Slide"
    bbox = draw.textbbox((0, 0), wm, font=font_small)
    draw.text((w - (bbox[2] - bbox[0]) - 16, h - 30), wm, fill=(80, 80, 100), font=font_small)

    # Save image
    try:
        from tubecli.config import DATA_DIR
        out_dir = os.path.join(str(DATA_DIR), "content_studio", "grok_videos")
    except:
        out_dir = str(Path(__file__).parent / "outputs" / "grok_videos")
    os.makedirs(out_dir, exist_ok=True)

    img_path = os.path.join(out_dir, f"ep{episode_id}_shot{shot_num:03d}_fallback.png")
    img.save(img_path, "PNG")

    # Convert to MP4 using ffmpeg (5s still image video)
    mp4_path = img_path.replace(".png", ".mp4")
    try:
        import subprocess
        subprocess.run([
            "ffmpeg", "-y",
            "-loop", "1", "-i", img_path,
            "-c:v", "libx264", "-t", "5",
            "-pix_fmt", "yuv420p", "-vf", f"scale={w}:{h}",
            "-r", "24",
            mp4_path,
        ], capture_output=True, timeout=30)
        if os.path.exists(mp4_path):
            return mp4_path
    except Exception as e:
        logger.warning(f"FFmpeg fallback conversion failed: {e}, using PNG")

    # If ffmpeg fails, return the image path
    return img_path


@router.delete("/api/v1/studio/episodes/{episode_id}/storyboards/{shot_id}/video")
async def clear_single_video(episode_id: int, shot_id: int):
    """Delete the generated video for a specific shot and clear video_url in DB."""
    db = _db()
    shots = db.list_storyboards(episode_id)
    shot = next((s for s in shots if s["id"] == shot_id), None)
    if not shot:
        raise HTTPException(404, "Shot not found")
        
    video_url = shot.get("video_url", "")
    if video_url:
        if os.path.isfile(video_url):
            try:
                os.remove(video_url)
                logger.info(f"Deleted single video: {video_url}")
            except Exception as e:
                logger.warning(f"Failed to delete {video_url}: {e}")
        db.update_storyboard(shot_id, {"video_url": ""})
        
    return {"success": True, "message": "Video cleared"}


@router.post("/api/v1/studio/episodes/{episode_id}/clear-videos")
async def clear_episode_videos(episode_id: int):
    """Delete all generated videos for an episode and clear video_url in DB."""
    db = _db()
    ep = db.get_episode(episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")

    shots = db.list_storyboards(episode_id)
    deleted = 0
    for s in shots:
        video_url = s.get("video_url", "")
        if video_url:
            if os.path.isfile(video_url):
                try:
                    os.remove(video_url)
                    deleted += 1
                    logger.info(f"Deleted video: {video_url}")
                except Exception as e:
                    logger.warning(f"Failed to delete {video_url}: {e}")
            db.update_storyboard(s["id"], {"video_url": ""})

    return {"success": True, "deleted": deleted, "total": len(shots)}


@router.post("/api/v1/studio/episodes/{episode_id}/gen-videos")
async def start_gen_videos(episode_id: int, request: Request, background_tasks: BackgroundTasks):
    """Start video generation for an episode's storyboard shots. Supports engine: 'grok' (default) or 'veo3'."""
    data = await request.json()
    profile_names = data.get("profile_names")
    if not profile_names:
        single_profile = data.get("profile_name", data.get("profile_path", ""))
        profile_names = [single_profile] if single_profile else []

    headless = data.get("headless", False)
    overwrite = data.get("overwrite", False)
    engine = data.get("engine", "grok")  # 'grok' or 'veo3'

    if not profile_names:
        raise HTTPException(400, "At least one browser profile is required")

    ep = _db().get_episode(episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")

    shots = _db().list_storyboards(episode_id)
    if not shots:
        raise HTTPException(400, "No storyboard shots found. Generate storyboard first.")

    # --- Inject character reference images into each shot ---
    db = _db()
    drama_id = ep.get("drama_id")
    all_chars = {c["id"]: c for c in db.list_characters(drama_id)} if drama_id else {}

    # Helper: resolve image_url (web URL or file path) to absolute file path
    _gallery_dir_cache = _get_gallery_dir()
    _ref_dir_cache = _get_ref_dir()
    def _resolve_image_path(url):
        """Convert web URL or file path to absolute path. Returns path if file exists, else None."""
        if not url:
            return None
        # Gallery web URL: /api/v1/studio/gallery/image/filename
        if url.startswith("/api/v1/studio/gallery/image/"):
            fname = url.replace("/api/v1/studio/gallery/image/", "", 1)
            fpath = os.path.join(_gallery_dir_cache, fname)
            if os.path.isfile(fpath):
                return fpath
            return None
        # Already an absolute file path
        if os.path.isfile(url):
            return url
        # Try reference dir as fallback
        fname = url.replace("\\", "/").split("/")[-1]
        fpath = os.path.join(_ref_dir_cache, fname)
        if os.path.isfile(fpath):
            return fpath
        return None

    for shot in shots:
        char_ids = shot.get("character_ids", [])
        # Handle character_ids stored as JSON string
        if isinstance(char_ids, str):
            try:
                char_ids = json.loads(char_ids)
            except:
                char_ids = []
        ref_images = []
        # Narrator/Host role names that should NOT have reference images injected
        # These are voice-only characters — injecting their face causes Grok blocks
        _NARRATOR_PATTERNS = [
            'narrator', 'host', 'voiceover', 'presenter',
            'người dẫn', 'dẫn chuyện', 'mc ', 'người kể',
            'health narrator', 'spiritual narrator',
        ]
        for cid in char_ids:
            char = all_chars.get(cid)
            if not char:
                continue
            # Skip narrator/host characters — they don't need visual consistency
            char_name = (char.get("name") or "").lower().strip()
            char_role_desc = (char.get("description") or "").lower()
            is_narrator = any(p in char_name for p in _NARRATOR_PATTERNS) or \
                          any(p in char_role_desc for p in ['narrator', 'host', 'người dẫn', 'dẫn chuyện'])
            if is_narrator:
                logger.info(f"Shot {shot.get('storyboard_number', shot['id'])}: skipping narrator/host '{char.get('name')}' — no ref image needed")
                continue
            resolved = _resolve_image_path(char.get("image_url", ""))
            if resolved:
                ref_images.append(resolved)
            else:
                try:
                    refs = json.loads(char.get("reference_images") or "[]")
                    for r in refs:
                        rp = _resolve_image_path(r)
                        if rp:
                            ref_images.append(rp)
                            break
                except:
                    pass
        if ref_images:
            shot["ref_images"] = ref_images[:3]
            logger.info(f"Shot {shot.get('storyboard_number', shot['id'])}: {len(ref_images)} ref images injected from {len(char_ids)} characters")
        elif char_ids:
            logger.warning(f"Shot {shot.get('storyboard_number', shot['id'])}: {len(char_ids)} characters but 0 ref images found")
    # --- Inject gallery reference images ONLY for shots with characters but missing refs ---
    try:
        drama_meta = json.loads(db.get_drama(drama_id).get("metadata") or "{}")
        gallery_cat_id = drama_meta.get("gallery_category_id")
        if gallery_cat_id:
            gallery_items = db.list_gallery_items(gallery_cat_id)
            gallery_ref_images = []
            for gi in gallery_items:
                resolved = _resolve_image_path(gi.get("image_url", ""))
                if resolved:
                    gallery_ref_images.append(resolved)
                else:
                    try:
                        gi_refs = json.loads(gi.get("reference_images") or "[]")
                        for r in gi_refs:
                            rp = _resolve_image_path(r)
                            if rp:
                                gallery_ref_images.append(rp)
                                break
                    except:
                        pass
            if gallery_ref_images:
                for shot in shots:
                    existing_refs = shot.get("ref_images", [])
                    # Only inject gallery refs if:
                    # 1. Shot has NO character ref images already
                    # 2. Shot actually has characters assigned (not an empty/scenery shot)
                    char_names = shot.get("character_names", [])
                    if isinstance(char_names, str):
                        try:
                            char_names = json.loads(char_names)
                        except:
                            char_names = []
                    if not existing_refs and char_names:
                        # Shot has characters but no ref images — use gallery as fallback
                        shot["ref_images"] = gallery_ref_images[:3]
                        logger.info(f"Shot {shot.get('storyboard_number', shot['id'])}: injected {len(shot['ref_images'])} gallery ref images (fallback)")
                    # Do NOT merge gallery images into shots that already have character refs
                    # The character-specific refs are more accurate than generic gallery images
                logger.info(f"Gallery ref injection: {len(gallery_ref_images)} gallery images available from category {gallery_cat_id}")
    except Exception as e:
        logger.warning(f"Failed to inject gallery ref images: {e}")

    # --- Inject scene images as ref_images for shots with scene_id ---
    try:
        all_scenes = {s["id"]: s for s in db.list_scenes(drama_id)} if drama_id else {}
        for shot in shots:
            scene_id = shot.get("scene_id")
            if not scene_id:
                continue
            scene = all_scenes.get(scene_id)
            if not scene:
                continue
            scene_img = scene.get("image_url", "")
            if scene_img and os.path.isfile(scene_img):
                existing_refs = shot.get("ref_images", [])
                if scene_img not in existing_refs:
                    # Scene image goes FIRST (highest priority for establishing the shot)
                    shot["ref_images"] = [scene_img] + existing_refs[:2]  # max 3 total
                    logger.info(f"Shot {shot.get('storyboard_number', shot['id'])}: injected scene image from scene {scene_id}")
    except Exception as e:
        logger.warning(f"Failed to inject scene ref images: {e}")

    # Inject aspect ratio from drama metadata
    try:
        drama_meta = json.loads(db.get_drama(drama_id).get("metadata") or "{}")
        video_aspect_ratio = drama_meta.get("aspect_ratio", "16:9")
    except:
        video_aspect_ratio = "16:9"
    for shot in shots:
        shot["aspect_ratio"] = video_aspect_ratio

    # Inject text_in_video constraint suffix into prompts for Grok
    text_in_video = drama_meta.get("text_in_video", "")
    # Backward compat: old boolean field
    if not text_in_video and drama_meta.get("no_text_in_prompt"):
        text_in_video = "notext"
    if text_in_video == "notext":
        notext_suffix = ". IMPORTANT: no text, no letters, no words, no typography in the video."
        for shot in shots:
            p = shot.get("image_prompt", "")
            if p and notext_suffix not in p:
                shot["image_prompt"] = p.rstrip(". ") + notext_suffix
    elif text_in_video == "english_only":
        eng_suffix = ". English text only, no CJK characters, no non-Latin script."
        for shot in shots:
            p = shot.get("image_prompt", "")
            if p and eng_suffix not in p:
                shot["image_prompt"] = p.rstrip(". ") + eng_suffix

    import uuid
    task_id = str(uuid.uuid4())[:8]

    pending = [s for s in shots if s.get("image_prompt", "").strip()]
    if overwrite:
        # Delete old video files from disk and clear video_url in DB
        for s in pending:
            old_video = s.get("video_url", "")
            if old_video and os.path.isfile(old_video):
                try:
                    os.remove(old_video)
                    logger.info(f"Deleted old video: {old_video}")
                except Exception as e:
                    logger.warning(f"Failed to delete old video {old_video}: {e}")
            # Clear video_url in database
            db.update_storyboard(s["id"], {"video_url": ""})
            s["video_url"] = ""
    else:
        pending = [s for s in pending if not s.get("video_url", "").strip()]

    _video_tasks[task_id] = {
        "status": "starting",
        "episode_id": episode_id,
        "done": 0,
        "total": len(pending),
        "current_shot": None,
        "errors": [],
        "shot_ids": [s["id"] for s in pending],
        "shot_progress": {s["id"]: {"percent": 0, "status": "pending"} for s in pending},
    }

    # Setup cancel infrastructure
    import asyncio as _asyncio
    cancel_event = _asyncio.Event()
    process_list = []
    _gen_cancel_events[task_id] = cancel_event
    _gen_processes[task_id] = process_list

    async def _runner():
        _video_tasks[task_id]["status"] = "running"
        try:
            import sys, os, re
            ext_dir = os.path.dirname(os.path.abspath(__file__))
            engines_dir = os.path.join(ext_dir, "engines")
            if engines_dir not in sys.path:
                sys.path.insert(0, engines_dir)
            if engine == "veo3":
                from veo3_video_engine import batch_generate
                logger.info("Using Veo3 (Google VideoFX) engine")
            else:
                from grok_video_engine import batch_generate
                logger.info("Using Grok video engine")

            async def on_progress(done, total, shot_id, status, path=None, percent=0):
                _video_tasks[task_id]["done"] = done
                _video_tasks[task_id]["total"] = total
                _video_tasks[task_id]["current_shot"] = shot_id
                # Update per-shot progress
                if shot_id in _video_tasks[task_id]["shot_progress"]:
                    if status == "generating":
                        _video_tasks[task_id]["shot_progress"][shot_id] = {"percent": percent, "status": "generating"}
                    elif status == "success":
                        _video_tasks[task_id]["shot_progress"][shot_id] = {"percent": 100, "status": "done", "path": path}
                    elif status == "error":
                        _video_tasks[task_id]["shot_progress"][shot_id] = {"percent": 0, "status": "error"}
                if path:
                    _video_tasks[task_id]["current_path"] = path
                    _db().update_storyboard(shot_id, {"video_url": path, "status": "video_done"})
                if status == "error":
                    _video_tasks[task_id]["errors"].append(shot_id)

            # ── Sensitive word list for prompt cleaning ──
            _sensitive_words = [
                # Violence / weapons
                "kill", "murder", "blood", "gore", "violent", "violence",
                "weapon", "gun", "knife", "sword", "attack", "stab", "shoot",
                "dead", "death", "die", "dying", "corpse", "wound", "bleeding",
                "fight", "punch", "slap", "hit", "beat", "abuse", "torture",
                "war", "bomb", "explosion", "destroy", "destruction",
                # Sexual / NSFW
                "nude", "naked", "sexy", "sexual", "erotic", "kiss", "kissing",
                "hug", "hugging", "embrace", "intimate", "romance", "romantic",
                "seductive", "seduce", "lust", "desire", "passion", "passionate",
                "breast", "thigh", "body", "skin", "touch", "touching",
                "bed", "bedroom", "undress", "strip",
                # Drugs / substance
                "drug", "drugs", "alcohol", "drunk", "smoking", "cigarette",
                "inject", "needle", "overdose",
                # Hate / discrimination
                "hate", "racist", "racism", "discriminat",
                # Self-harm
                "suicide", "self-harm", "cut", "hang",
                # Vietnamese equivalents
                "giết", "chết", "máu", "bạo lực", "vũ khí", "súng", "dao",
                "khỏa thân", "gợi cảm", "tình dục", "ôm", "hôn",
                "ma túy", "rượu", "thuốc lá",
            ]

            def _extract_core_prompt(raw):
                """Extract the visual prompt from structured [VIDEO PROMPT] or [IMAGE PROMPT] sections."""
                for tag in ["[VIDEO PROMPT]", "[IMAGE PROMPT]"]:
                    if tag in raw:
                        match = re.search(re.escape(tag) + r'\s*(.*?)(?:\[|$)', raw, re.DOTALL)
                        if match:
                            return match.group(1).strip()
                return raw

            def _clean_sensitive(text):
                """Remove NSFW/sensitive words from prompt."""
                cleaned = text
                for word in _sensitive_words:
                    pattern = re.compile(r'\b' + re.escape(word) + r'\b', re.IGNORECASE)
                    cleaned = pattern.sub('', cleaned)
                return re.sub(r'\s+', ' ', cleaned).strip()

            def _simplify_prompt(raw, attempt):
                """Progressively simplify prompt based on retry attempt number.
                attempt 1: clean sensitive words + keep first 2 sentences
                attempt 2: even shorter (1 sentence) + generic style cue
                attempt 3: ultra-minimal description + safe animation style
                """
                core = _extract_core_prompt(raw)
                core = _clean_sensitive(core)
                sentences = re.split(r'[.!?]+', core)
                sentences = [s.strip() for s in sentences if s.strip()]

                if attempt == 1:
                    # Keep first 2 sentences + style cue
                    simplified = '. '.join(sentences[:2])
                    if simplified:
                        simplified += '.'
                    return f"[VIDEO PROMPT]\n{simplified}\nSimple animation, clean composition, minimal details."
                elif attempt == 2:
                    # Keep only first sentence + safe animation
                    simplified = sentences[0] if sentences else "A calm scene"
                    return f"[VIDEO PROMPT]\n{simplified}. Smooth animation, soft lighting, simple background."
                else:
                    # Ultra-minimal: just keywords + maximum safety
                    keywords = ' '.join(sentences[0].split()[:8]) if sentences else "peaceful landscape"
                    return f"[VIDEO PROMPT]\n{keywords}. Gentle animated scene, minimal movement, soft colors."

            # ── Initial attempt (attempt 0) ──
            results = await batch_generate(
                shots=shots,
                profile_names=profile_names,
                episode_id=episode_id,
                headless=headless,
                overwrite=overwrite,
                progress_callback=on_progress,
                cancel_event=cancel_event,
                process_registry=process_list,
            )

            if any(r.get("message") == "RATE_LIMIT_REACHED" for r in results):
                logger.error("Rate limit reached during video generation. Aborting task.")
                _video_tasks[task_id]["status"] = "error: RATE_LIMIT_REACHED"
                
                # Send telegram notification
                try:
                    import httpx, json
                    from tubecli.config import DATA_DIR
                    settings_path = DATA_DIR / "global_settings.json"
                    if settings_path.exists():
                        with open(settings_path, "r", encoding="utf-8") as f:
                            data = json.load(f)
                        token = data.get("telegram_bot_token")
                        chat_id = data.get("telegram_chat_id")
                        if token and chat_id:
                            httpx.post(
                                f"https://api.telegram.org/bot{token}/sendMessage",
                                json={"chat_id": chat_id, "text": "⛔ [Auto-Pilot] Dừng khẩn cấp: Đã đạt giới hạn Grok Rate Limit (Hết lượt render Video/Image)."},
                                timeout=10
                            )
                except Exception as e:
                    logger.error(f"Telegram notify failed: {e}")
                
                return

            # ── Retry loop: up to 3 retries with progressively simplified prompts ──
            MAX_RETRIES = 3
            for attempt in range(1, MAX_RETRIES + 1):
                # Check cancel before retry
                if cancel_event.is_set():
                    _video_tasks[task_id]["status"] = "error: cancelled by user"
                    return

                failed_ids = set(_video_tasks[task_id].get("errors", []))
                failed_shots = [s for s in shots if s["id"] in failed_ids]

                if not failed_shots:
                    break

                logger.info(f"Retry attempt {attempt}/{MAX_RETRIES}: {len(failed_shots)} failed shots")
                _video_tasks[task_id]["status"] = f"retry {attempt}/{MAX_RETRIES} — {len(failed_shots)} shots"

                # Simplify prompts progressively
                for shot in failed_shots:
                    original_prompt = shot.get("_original_prompt") or shot.get("image_prompt", "")
                    # Preserve original prompt for subsequent retries
                    if not shot.get("_original_prompt"):
                        shot["_original_prompt"] = original_prompt
                    shot["video_url"] = ""
                    shot["image_prompt"] = _simplify_prompt(original_prompt, attempt)
                    logger.info(f"Retry {attempt} shot {shot['id']}: {shot['image_prompt'][:80]}...")

                # Clear errors for this retry round
                _video_tasks[task_id]["errors"] = []
                retry_results = await batch_generate(
                    shots=failed_shots,
                    profile_names=profile_names,
                    episode_id=episode_id,
                    headless=headless,
                    overwrite=True,
                    progress_callback=on_progress,
                    cancel_event=cancel_event,
                    process_registry=process_list,
                )
                results.extend(retry_results)

                if any(r.get("message") == "RATE_LIMIT_REACHED" for r in retry_results):
                    logger.error("Rate limit reached during video generation retry. Aborting task.")
                    _video_tasks[task_id]["status"] = "error: RATE_LIMIT_REACHED"

                    try:
                        import httpx, json
                        from tubecli.config import DATA_DIR
                        settings_path = DATA_DIR / "global_settings.json"
                        if settings_path.exists():
                            with open(settings_path, "r", encoding="utf-8") as f:
                                data = json.load(f)
                            token = data.get("telegram_bot_token")
                            chat_id = data.get("telegram_chat_id")
                            if token and chat_id:
                                httpx.post(
                                    f"https://api.telegram.org/bot{token}/sendMessage",
                                    json={"chat_id": chat_id, "text": "⛔ [Auto-Pilot] Dừng khẩn cấp: Đã đạt giới hạn Grok Rate Limit (Hết lượt render Video/Image)."},
                                    timeout=10
                                )
                    except Exception as e:
                        logger.error(f"Telegram notify failed: {e}")

                    return

            # ── After all retries: skip remaining failures (NO fallback text slides) ──
            still_failed_ids = set(_video_tasks[task_id].get("errors", []))
            if still_failed_ids:
                logger.warning(
                    f"Skipping {len(still_failed_ids)} shots after {MAX_RETRIES} retries: {still_failed_ids}"
                )
                for sid in still_failed_ids:
                    _db().update_storyboard(sid, {"status": "video_skipped"})
                    if sid in _video_tasks[task_id]["shot_progress"]:
                        _video_tasks[task_id]["shot_progress"][sid] = {"percent": 0, "status": "skipped"}

            successful = [r for r in results if r.get("status") == "success"]
            skipped_count = len(still_failed_ids)

            if successful:
                _video_tasks[task_id]["status"] = "completed"
                if skipped_count > 0:
                    _video_tasks[task_id]["status"] = f"completed ({skipped_count} shots skipped)"
                _video_tasks[task_id]["done"] = _video_tasks[task_id]["total"]
            elif results:
                _video_tasks[task_id]["status"] = f"error: all {len(results)} shots failed after {MAX_RETRIES} retries"
                _video_tasks[task_id]["done"] = 0
            else:
                _video_tasks[task_id]["status"] = "error: Node script crashed or returned no results. Check logs."

        except Exception as e:
            logger.error(f"Gen videos runner error: {e}")
            _video_tasks[task_id]["status"] = f"error: {str(e)}"

    background_tasks.add_task(_runner)
    return {"success": True, "task_id": task_id, "total": len(pending)}


@router.get("/api/v1/studio/gen-videos/status/{task_id}")
async def get_gen_videos_status(task_id: str):
    """Poll video generation task status."""
    task = _video_tasks.get(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    return {"success": True, **task}


@router.post("/api/v1/studio/storyboards/{shot_id}/generate-tts")
async def generate_shot_tts(shot_id: int, request: Request):
    """Generate TTS audio for a single storyboard shot using its narration_text."""
    shot = _db().conn.execute("SELECT * FROM storyboards WHERE id = ? AND deleted_at IS NULL", (shot_id,)).fetchone()
    if not shot:
        raise HTTPException(404, "Shot not found")
    shot = dict(shot)
    
    narration = shot.get("narration_text") or shot.get("dialogue") or shot.get("description") or shot.get("action") or ""
    narration = narration.strip()
    
    # Clean out stage directions / visual cues that shouldn't be spoken
    import re
    narration = re.sub(r'\[.*?\]', '', narration).strip()
    
    if not narration or len(narration) < 3:
        logger.warning(f"Shot {shot_id} has no narration text, skipping TTS")
        return {"success": False, "message": "No narration text for this shot", "audio_url": None}
    
    # Get voice config from request body
    body = {}
    try:
        body = await request.json()
    except:
        pass
    
    # Resolve voice/engine: request body > project metadata > defaults 
    voice_id = body.get("voice")
    engine = body.get("engine")
    
    if not voice_id or not engine:
        # Try project metadata
        ep = _db().conn.execute("SELECT drama_id FROM episodes WHERE id = ?", (shot.get("episode_id"),)).fetchone()
        if ep:
            drama = _db().conn.execute("SELECT metadata FROM dramas WHERE id = ?", (ep["drama_id"],)).fetchone()
            if drama and drama["metadata"]:
                meta = json.loads(drama["metadata"])
                if not voice_id:
                    voice_id = meta.get("tts_voice", "vi-VN-HoaiMyNeural")
                if not engine:
                    engine = meta.get("tts_engine", "edge")
    
    voice_id = voice_id or "vi-VN-HoaiMyNeural"
    engine = engine or "edge"
    
    logger.info(f"Shot TTS: id={shot_id}, voice={voice_id}, engine={engine}, text={narration[:60]}...")
    
    import httpx
    tts_base = str(request.base_url).rstrip("/")
    async with httpx.AsyncClient(timeout=300) as client:
        # Start synthesis
        resp = await client.post(f"{tts_base}/api/v1/tts/synthesize", json={
            "text": narration,
            "voice": voice_id,
            "engine": engine,
        })
        if resp.status_code != 200:
            raise HTTPException(500, f"TTS API error: {resp.text[:200]}")
        
        result = resp.json()
        if not result.get("success") or not result.get("task_id"):
            raise HTTPException(500, "TTS API returned no task_id")
        
        task_id = result["task_id"]
        
        # Poll for completion
        import asyncio
        for _ in range(150):  # max ~5 min
            await asyncio.sleep(2)
            st_resp = await client.get(f"{tts_base}/api/v1/tts/status/{task_id}")
            if st_resp.status_code != 200:
                continue
            st = st_resp.json()
            if st.get("status") == "success":
                output_path = st.get("result", {}).get("output", "")
                if output_path:
                    import os
                    filename = os.path.basename(output_path)
                    audio_url = f"/api/v1/tts/audio/{filename}"
                    _db().update_storyboard(shot_id, {"tts_audio_url": audio_url})
                    return {"success": True, "audio_url": audio_url}
                raise HTTPException(500, "TTS success but no output file")
            elif st.get("status") == "error":
                msg = st.get("result", {}).get("message", "Unknown error")
                raise HTTPException(500, f"TTS error: {msg}")
        
        raise HTTPException(504, "TTS generation timed out")


# ── Batch TTS (Background) ────────────────────────────────

@router.post("/api/v1/studio/episodes/{episode_id}/batch-tts")
async def start_batch_tts(episode_id: int, request: Request):
    """Start batch TTS for all shots missing audio. Runs in background."""
    import uuid

    ep = _db().get_episode(episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")

    shots = _db().list_storyboards(episode_id)
    if not shots:
        raise HTTPException(400, "No storyboard shots")

    # Resolve voice/engine from project metadata
    voice_id = "vi-VN-HoaiMyNeural"
    engine = "edge"
    browser_profile = None
    drama_id = ep.get("drama_id")
    if drama_id:
        drama = _db().get_drama(drama_id)
        if drama and drama.get("metadata"):
            try:
                meta = json.loads(drama["metadata"])
                voice_id = meta.get("tts_voice", voice_id)
                engine = meta.get("tts_engine", engine)
                browser_profile = meta.get("browser_profile_name")
            except:
                pass

    task_id = str(uuid.uuid4())[:8]
    base_url = str(request.base_url).rstrip("/")

    _tts_tasks[task_id] = {
        "status": "running",
        "episode_id": episode_id,
        "done": 0,
        "total": len(shots),
        "success": 0,
        "failed": 0,
        "results": [],
    }

    import threading

    def _run_batch():
        import asyncio as _aio
        loop = _aio.new_event_loop()
        _aio.set_event_loop(loop)
        try:
            if engine == "gemini":
                loop.run_until_complete(_batch_tts_worker_gemini(task_id, episode_id, shots, voice_id, engine, base_url, browser_profile))
            else:
                loop.run_until_complete(_batch_tts_worker(task_id, episode_id, shots, voice_id, engine, base_url))
        except Exception as e:
            logger.error(f"Batch TTS error: {e}")
            _tts_tasks[task_id]["status"] = "error"
            _tts_tasks[task_id]["message"] = str(e)
        finally:
            loop.close()

    t = threading.Thread(target=_run_batch, daemon=True)
    t.start()

    return {"success": True, "task_id": task_id, "total": len(shots)}


async def _batch_tts_worker(task_id, episode_id, shots, voice_id, engine, base_url):
    """Background worker that processes TTS for all shots."""
    import re
    import httpx

    task = _tts_tasks[task_id]

    async with httpx.AsyncClient(timeout=300) as client:
        for shot in shots:
            shot_id = shot["id"]

            # Skip if already has audio
            if shot.get("tts_audio_url") and shot["tts_audio_url"].strip():
                task["done"] += 1
                task["success"] += 1
                continue

            narration = shot.get("narration_text") or shot.get("dialogue") or shot.get("description") or shot.get("action") or ""
            narration = re.sub(r'\\[.*?\\]', '', narration).strip()

            if not narration or len(narration) < 3:
                task["done"] += 1
                task["results"].append({"shot_id": shot_id, "status": "skipped"})
                continue

            try:
                # Start TTS
                resp = await client.post(f"{base_url}/api/v1/tts/synthesize", json={
                    "text": narration, "voice": voice_id, "engine": engine,
                })
                if resp.status_code != 200:
                    raise Exception(f"TTS API {resp.status_code}")

                result = resp.json()
                if not result.get("success") or not result.get("task_id"):
                    raise Exception("No task_id")

                tts_task_id = result["task_id"]

                # Poll for this shot
                import os
                for _ in range(150):
                    await asyncio.sleep(2)
                    st_resp = await client.get(f"{base_url}/api/v1/tts/status/{tts_task_id}")
                    if st_resp.status_code != 200:
                        continue
                    st = st_resp.json()
                    if st.get("status") == "success":
                        output_path = st.get("result", {}).get("output", "")
                        if output_path:
                            filename = os.path.basename(output_path)
                            audio_url = f"/api/v1/tts/audio/{filename}"
                            _db().update_storyboard(shot_id, {"tts_audio_url": audio_url})
                            task["success"] += 1
                            task["results"].append({"shot_id": shot_id, "status": "ok", "audio_url": audio_url})
                        break
                    elif st.get("status") == "error":
                        task["failed"] += 1
                        task["results"].append({"shot_id": shot_id, "status": "error"})
                        break
                else:
                    task["failed"] += 1
                    task["results"].append({"shot_id": shot_id, "status": "timeout"})

            except Exception as e:
                logger.error(f"Batch TTS shot {shot_id}: {e}")
                task["failed"] += 1
                task["results"].append({"shot_id": shot_id, "status": "error", "message": str(e)})

            task["done"] += 1

    task["status"] = "done"
    logger.info(f"Batch TTS {task_id}: {task['success']}/{task['total']} success, {task['failed']} failed")


async def _batch_tts_worker_gemini(task_id, episode_id, shots, voice_id, engine, base_url, browser_profile=None):
    """Special background worker for Gemini: generate full episode audio, use Whisper, then split."""
    import re
    import httpx
    import asyncio
    import os
    import json
    import subprocess
    import shutil

    task = _tts_tasks[task_id]
    
    # 1. Collect all narrations
    shot_texts = []
    valid_shots = []
    
    for shot in shots:
        narration = shot.get("narration_text") or shot.get("dialogue") or shot.get("description") or shot.get("action") or ""
        narration = re.sub(r'\[.*?\]', '', narration).strip()
        
        if not narration or len(narration) < 3:
            task["done"] += 1
            task["results"].append({"shot_id": shot["id"], "status": "skipped"})
            continue
            
        valid_shots.append(shot)
        shot_texts.append(narration)

    if not valid_shots:
        task["status"] = "done"
        return

    full_text = "\n\n".join(shot_texts)
    
    async with httpx.AsyncClient(timeout=600) as client:
        try:
            # 2. Synthesize full text
            logger.info("Starting Gemini Full TTS...")
            payload = {
                "text": full_text, "voice": voice_id, "engine": "gemini",
            }
            if browser_profile:
                payload["browser_profile"] = browser_profile
                
            resp = await client.post(f"{base_url}/api/v1/tts/synthesize", json=payload)
            if resp.status_code != 200:
                raise Exception(f"Gemini TTS API error {resp.status_code}")

            result = resp.json()
            if not result.get("success") or not result.get("task_id"):
                raise Exception("No task_id returned from Gemini TTS")

            tts_task_id = result["task_id"]
            
            # Poll for full audio
            full_audio_url = ""
            full_audio_path = ""
            for _ in range(300): # Up to 10 mins
                await asyncio.sleep(2)
                st_resp = await client.get(f"{base_url}/api/v1/tts/status/{tts_task_id}")
                if st_resp.status_code != 200: continue
                st = st_resp.json()
                
                # Mock update overall progress visually (Gemini takes time)
                task["done"] = min(len(shots) - 1, task["done"] + 1 if task["done"] < len(shots) // 2 else task["done"])
                
                if st.get("status") == "success":
                    full_audio_path = st.get("result", {}).get("output", "")
                    filename = os.path.basename(full_audio_path)
                    full_audio_url = f"/api/v1/tts/audio/{filename}"
                    break
                elif st.get("status") == "error":
                    raise Exception(st.get("message", "Gemini TTS Generation Error"))
            else:
                raise Exception("Timeout waiting for Gemini TTS")

            if not full_audio_path or not os.path.exists(full_audio_path):
                raise Exception("Full audio path not found")

            # 3. Whisper Alignment (DIRECT call - avoids HTTP deadlock)
            logger.info(f"Full audio generated. Running Whisper directly on: {full_audio_path}")
            
            import importlib.util
            whisper_engine_path = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), 
                "..", "subtitle_extractor", "engines", "whisper_engine.py"
            )
            spec = importlib.util.spec_from_file_location("whisper_eng", whisper_engine_path)
            whisper_mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(whisper_mod)
            
            whisper_result = await whisper_mod.extract_whisper(full_audio_path, language=None, model_size="small")
            
            if whisper_result.get("status") != "success":
                raise Exception(f"Whisper failed: {whisper_result.get('message', 'unknown error')}")
            
            segments = whisper_result.get("subtitles", [])
            if not segments:
                raise Exception("Whisper returned no segments")
            
            logger.info(f"Whisper returned {len(segments)} segments")
            
            # 4. Get total audio duration
            ffmpeg_path = shutil.which("ffmpeg") or "ffmpeg"
            ffprobe_path = shutil.which("ffprobe") or "ffprobe"
            out_dir = os.path.dirname(full_audio_path)
            
            total_audio_duration = 0
            try:
                probe_cmd = [ffprobe_path, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", full_audio_path]
                probe_result = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=10)
                total_audio_duration = float(probe_result.stdout.strip())
            except:
                total_audio_duration = segments[-1]["end"] if segments else 0
                
            # 5. Split by finding shot start boundaries using keyword matching
            shot_starts = []
            curr_seg_idx = 0
            for shot, s_text in zip(valid_shots, shot_texts):
                st, curr_seg_idx = _find_shot_start_time(segments, s_text, curr_seg_idx)
                shot_starts.append(st)
                
            for i, shot in enumerate(valid_shots):
                shot_id = shot["id"]
                start_t = shot_starts[i]
                
                # End time is the start of the next shot, or total duration for the last one
                if i + 1 < len(shot_starts):
                    end_t = shot_starts[i+1]
                else:
                    end_t = total_audio_duration
                
                duration = max(0.2, end_t - start_t)
                
                # Split audio with ffmpeg
                shot_out_path = os.path.join(out_dir, f"gemini_shot_{shot_id}_{task_id}.mp3")
                cmd = [ffmpeg_path, "-y", "-i", full_audio_path, "-ss", f"{start_t:.3f}", "-t", f"{duration:.3f}", "-acodec", "libmp3lame", "-ab", "192k", shot_out_path]
                logger.info(f"FFmpeg split shot {shot_id}: time={start_t:.2f}-{end_t:.2f} (dur={duration:.2f}s)")
                subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                
                if os.path.exists(shot_out_path):
                    filename = os.path.basename(shot_out_path)
                    audio_url = f"/api/v1/tts/audio/{filename}"
                    _db().update_storyboard(shot_id, {"tts_audio_url": audio_url})
                    task["success"] += 1
                    task["results"].append({"shot_id": shot_id, "status": "ok", "audio_url": audio_url})
                else:
                    task["failed"] += 1
                    task["results"].append({"shot_id": shot_id, "status": "error", "message": "FFmpeg split failed"})
                    
                task["done"] += 1
        except Exception as e:
            logger.error(f"Gemini Batch TTS pipeline error: {e}")
            task["status"] = "error"
            task["message"] = str(e)
            for shot in valid_shots:
                if not any(r["shot_id"] == shot["id"] for r in task["results"]):
                    task["failed"] += 1
                    task["done"] += 1
                    task["results"].append({"shot_id": shot["id"], "status": "error", "message": str(e)})

    task["status"] = "done" if task["status"] != "error" else "error"
    logger.info(f"Gemini Batch TTS {task_id}: {task['success']}/{task['total']} success, {task['failed']} failed")


@router.get("/api/v1/studio/batch-tts/{task_id}")
async def get_batch_tts_status(task_id: str):
    """Poll batch TTS task status."""
    task = _tts_tasks.get(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    return {"success": True, **task}


@router.post("/api/v1/studio/episodes/{episode_id}/upload-audio")
async def upload_audio_and_split(episode_id: int, request: Request):
    """
    Upload a full audio file, run Whisper alignment, split by shot with FFmpeg,
    and assign each fragment to the corresponding storyboard shot.
    """
    import shutil, subprocess, uuid, tempfile, os
    from fastapi import UploadFile
    import importlib.util

    ep = _db().get_episode(episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")

    # Parse multipart body
    form = await request.form()
    audio_file: UploadFile = form.get("audio")
    if not audio_file:
        raise HTTPException(400, "No audio file provided")

    # Save uploaded file to TTS outputs dir
    try:
        from tubecli.config import DATA_DIR
        tts_output_dir = os.path.join(str(DATA_DIR), "tts_vibevoice", "outputs")
    except Exception:
        tts_output_dir = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "tts_vibevoice", "outputs"
        )
    os.makedirs(tts_output_dir, exist_ok=True)

    upload_id = uuid.uuid4().hex[:8]
    ext = os.path.splitext(audio_file.filename)[-1] or ".mp3"
    full_audio_path = os.path.join(tts_output_dir, f"upload_{episode_id}_{upload_id}{ext}")

    with open(full_audio_path, "wb") as f:
        content = await audio_file.read()
        f.write(content)

    logger.info(f"Upload audio saved: {full_audio_path}")

    # Load storyboard shots
    shots = _db().list_storyboards(episode_id)
    valid_shots = [s for s in shots if (s.get("narration_text") or s.get("dialogue") or s.get("description"))]
    if not valid_shots:
        os.remove(full_audio_path)
        raise HTTPException(400, "No storyboard shots with narration text found.")

    shot_texts = []
    import re
    for s in valid_shots:
        txt = s.get("narration_text") or s.get("dialogue") or s.get("description") or ""
        # Clean [brackets] to match the worker logic
        txt = re.sub(r'\[.*?\]', '', txt).strip()
        shot_texts.append(txt)

    # Run Whisper directly
    whisper_engine_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..", "subtitle_extractor", "engines", "whisper_engine.py"
    )
    spec = importlib.util.spec_from_file_location("whisper_eng", whisper_engine_path)
    whisper_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(whisper_mod)

    logger.info("Running Whisper on uploaded audio...")
    whisper_result = await whisper_mod.extract_whisper(full_audio_path, language=None, model_size="small")

    if whisper_result.get("status") != "success":
        raise HTTPException(500, f"Whisper failed: {whisper_result.get('message', 'unknown error')}")

    whisper_subs = whisper_result.get("subtitles", [])
    if not whisper_subs:
        raise HTTPException(500, "Whisper returned no segments")

    segments = [{"start": s["start"], "end": s["end"], "text": s["text"]} for s in whisper_subs]

    # FFmpeg split by aligned segments
    ffmpeg_path = shutil.which("ffmpeg") or "ffmpeg"
    out_dir = tts_output_dir
    shot_starts = []
    curr_seg_idx = 0
    total_audio_duration = segments[-1]["end"] if segments else 0
    
    for shot, s_text in zip(valid_shots, shot_texts):
        st, curr_seg_idx = _find_shot_start_time(segments, s_text, curr_seg_idx)
        shot_starts.append(st)

    for i, shot in enumerate(valid_shots):
        shot_id = shot["id"]
        start_t = shot_starts[i]
        
        if i + 1 < len(shot_starts):
            end_t = shot_starts[i+1]
        else:
            end_t = total_audio_duration

        duration = max(0.2, end_t - start_t)
        shot_out_path = os.path.join(out_dir, f"upload_shot_{shot_id}_{upload_id}.mp3")

        cmd = [ffmpeg_path, "-y", "-i", full_audio_path, "-ss", f"{start_t:.3f}", "-t", f"{duration:.3f}",
               "-acodec", "libmp3lame", "-ab", "192k", shot_out_path]
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        if os.path.exists(shot_out_path):
            filename = os.path.basename(shot_out_path)
            audio_url = f"/api/v1/tts/audio/{filename}"
            _db().update_storyboard(shot_id, {"tts_audio_url": audio_url})

    return {"success": True, "message": f"Successfully split and assigned {len(valid_shots)} shots"}


@router.post("/api/v1/studio/episodes/{episode_id}/export-ffmpeg")
async def start_export_ffmpeg(episode_id: int, request: Request, background_tasks: BackgroundTasks):
    """Start FFmpeg video assembly."""
    ep = _db().get_episode(episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")

    shots = _db().list_storyboards(episode_id)
    if not shots:
        raise HTTPException(400, "No storyboard shots found.")

    import uuid
    task_id = str(uuid.uuid4())[:8]

    _video_tasks[task_id] = {
        "status": "starting",
        "episode_id": episode_id,
        "done": 0,
        "total": 100,  # percentage
        "current_shot": None,
        "errors": [],
    }

    async def _runner():
        _video_tasks[task_id]["status"] = "running"
        try:
            import sys, os
            ext_dir = os.path.dirname(os.path.abspath(__file__))
            engines_dir = os.path.join(ext_dir, "engines")
            if engines_dir not in sys.path:
                sys.path.insert(0, engines_dir)
            
            from ffmpeg_video_engine import build_ffmpeg_video

            async def on_progress(msg, pct, path=None):
                _video_tasks[task_id]["done"] = pct
                _video_tasks[task_id]["current_shot"] = msg
                if path:
                    _video_tasks[task_id]["current_path"] = path

            drama = _db().get_drama(ep["drama_id"])
            drama_meta = json.loads(drama.get("metadata", "{}") or "{}") if drama else {}
            video_aspect_ratio = drama_meta.get("aspect_ratio", "16:9")

            export_path = await build_ffmpeg_video(
                episode=ep,
                shots=shots,
                video_aspect_ratio=video_aspect_ratio,
                progress_callback=on_progress,
            )

            # Save the final video path to the episode
            _db().update_episode(episode_id, {"video_url": export_path})

            _video_tasks[task_id]["status"] = "completed"
            _video_tasks[task_id]["done"] = 100

        except Exception as e:
            logger.error(f"FFmpeg export error: {e}")
            _video_tasks[task_id]["status"] = f"error: {str(e)}"

    background_tasks.add_task(_runner)
    return {"success": True, "task_id": task_id}


@router.get("/api/v1/studio/export-ffmpeg/status/{task_id}")
async def get_export_ffmpeg_status(task_id: str):
    """Poll FFmpeg export task status."""
    task = _video_tasks.get(task_id)
    if not task:
        raise HTTPException(404, "Task not found")
    return {"success": True, **task}

@router.get("/api/v1/studio/grok-image/{filename}")
async def serve_grok_image(filename: str):
    """Serve a locally generated Grok image."""
    try:
        from tubecli.config import DATA_DIR
        out_dir = os.path.join(str(DATA_DIR), "content_studio", "grok_images")
    except Exception:
        out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "outputs", "grok_images")

    path = os.path.join(out_dir, filename)
    if os.path.exists(path):
        return FileResponse(path)
    raise HTTPException(404, "Image not found")


@router.get("/api/v1/studio/grok-video/{filename}")
async def serve_grok_video(filename: str):
    """Serve a locally generated video (Grok or Veo3)."""
    try:
        from tubecli.config import DATA_DIR
        grok_dir = os.path.join(str(DATA_DIR), "content_studio", "grok_videos")
        veo3_dir = os.path.join(str(DATA_DIR), "content_studio", "veo3_videos")
    except Exception:
        base = os.path.dirname(os.path.abspath(__file__))
        grok_dir = os.path.join(base, "outputs", "grok_videos")
        veo3_dir = os.path.join(base, "outputs", "veo3_videos")

    # Check grok_videos first, then veo3_videos
    for d in [grok_dir, veo3_dir]:
        p = os.path.join(d, filename)
        if os.path.exists(p):
            return FileResponse(p, media_type="video/mp4")
    raise HTTPException(404, "Video not found")


@router.get("/api/v1/studio/export-video/{filename}")
async def serve_export_video(filename: str):
    """Serve an exported FFmpeg video."""
    try:
        from tubecli.config import DATA_DIR
        out_dir = os.path.join(str(DATA_DIR), "content_studio", "outputs", "exports")
    except Exception:
        out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "outputs", "exports")

    path = os.path.join(out_dir, filename)
    if os.path.exists(path):
        return FileResponse(path, media_type="video/mp4")
    raise HTTPException(404, "Exported video not found")


# ═══════════════════════════════════════════════════════════════
# ── Auto Pipeline API ─────────────────────────────────────────
# ═══════════════════════════════════════════════════════════════

_auto_pipeline_running = False
_auto_pipeline_current_job_id = None


@router.get("/api/v1/studio/auto-pipeline/jobs")
async def list_auto_pipeline_jobs(status: str = None):
    """List auto pipeline jobs."""
    jobs = _db().list_pipeline_jobs(status=status)
    return {"success": True, "jobs": jobs, "count": len(jobs)}


@router.post("/api/v1/studio/auto-pipeline/jobs")
async def create_auto_pipeline_jobs(request: Request):
    """Create batch pipeline jobs from a list of URLs + shared config."""
    data = await request.json()
    urls = data.get("urls", [])
    if not urls:
        raise HTTPException(400, "No URLs provided")

    config = {
        "source_type": data.get("source_type", "youtube_link"),
        "preset_name": data.get("preset_name", ""),
        "pipeline_template": data.get("pipeline_template", "drama_scene"),
        "content_format": data.get("content_format", "Educational / Learning"),
        "visual_style": data.get("visual_style", "Default"),
        "max_episodes": data.get("max_episodes", 1),
        "language": data.get("language", "vi"),
        "voice_preset": data.get("voice_preset", ""),
        "browser_profiles": data.get("browser_profiles", []),
        "aspect_ratio": data.get("aspect_ratio", "16:9"),
        "narration_source": data.get("narration_source", "prose"),
        "seo_mode": data.get("seo_mode", "ai_generate"),
        "seo_title_template": data.get("seo_title_template", ""),
        "seo_description_template": data.get("seo_description_template", ""),
        "seo_tags": data.get("seo_tags", []),
        "upload_targets": data.get("upload_targets", []),
        "upload_privacy": data.get("upload_privacy", "private"),
        "gallery_category_id": data.get("gallery_category_id"),
    }

    db = _db()
    created = []
    for url in urls:
        url = url.strip()
        if not url:
            continue
        job_data = {**config, "source_url": url}
        job = db.create_pipeline_job(job_data)
        created.append(job)

    return {"success": True, "jobs": created, "count": len(created)}


@router.get("/api/v1/studio/auto-pipeline/jobs/{job_id}")
async def get_auto_pipeline_job(job_id: int):
    """Get a single pipeline job."""
    job = _db().get_pipeline_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return {"success": True, "job": job}


@router.put("/api/v1/studio/auto-pipeline/jobs/{job_id}")
async def update_auto_pipeline_job(job_id: int, request: Request):
    """Update a pipeline job config (only if pending or error)."""
    data = await request.json()
    db = _db()
    job = db.get_pipeline_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.get("status") not in ["pending", "error"]:
        raise HTTPException(400, "Cannot edit a job that is already processing or done")
    
    updated = db.update_pipeline_job(job_id, data)
    return {"success": True, "job": updated}


@router.delete("/api/v1/studio/auto-pipeline/jobs/{job_id}")
async def delete_auto_pipeline_job(job_id: int):
    """Delete/cancel a pipeline job."""
    _db().delete_pipeline_job(job_id)
    return {"success": True}


@router.get("/api/v1/studio/auto-pipeline/status")
async def get_auto_pipeline_status():
    """Get overall pipeline status."""
    db = _db()
    pending = len(db.list_pipeline_jobs(status="pending"))
    processing = len(db.list_pipeline_jobs(status="processing"))
    return {
        "success": True,
        "running": _auto_pipeline_running,
        "current_job_id": _auto_pipeline_current_job_id,
        "pending_count": pending,
        "processing_count": processing,
    }


@router.post("/api/v1/studio/auto-pipeline/start")
async def start_auto_pipeline(background_tasks: BackgroundTasks):
    """Start processing the job queue in background."""
    global _auto_pipeline_running
    if _auto_pipeline_running:
        return {"success": True, "message": "Pipeline already running"}

    background_tasks.add_task(_run_auto_pipeline_queue)
    return {"success": True, "message": "Pipeline queue started"}


@router.post("/api/v1/studio/auto-pipeline/stop")
async def stop_auto_pipeline():
    """Request pipeline to stop after current job finishes."""
    global _auto_pipeline_running
    _auto_pipeline_running = False
    return {"success": True, "message": "Stop requested"}


async def _run_auto_pipeline_queue():
    """Background task: process pending jobs one by one."""
    global _auto_pipeline_running, _auto_pipeline_current_job_id
    _auto_pipeline_running = True
    db = _db()

    try:
        while _auto_pipeline_running:
            job = db.get_next_pending_job()
            if not job:
                logger.info("Auto pipeline: no more pending jobs")
                break

            _auto_pipeline_current_job_id = job["id"]
            db.update_pipeline_job(job["id"], {"status": "processing"})

            try:
                await _process_single_job(job)
                db.update_pipeline_job(job["id"], {"status": "done"})
            except Exception as e:
                import traceback
                logger.error(f"Auto pipeline job {job['id']} failed: {e}\n{traceback.format_exc()}")
                db.update_pipeline_job(job["id"], {
                    "status": "error",
                    "error_message": str(e)[:500]
                })

            await asyncio.sleep(3)
    finally:
        _auto_pipeline_running = False
        _auto_pipeline_current_job_id = None


async def _process_single_job(job: dict):
    """Process one auto pipeline job end-to-end."""
    import httpx
    db = _db()
    job_id = job["id"]
    source_url = job["source_url"]

    logger.info(f"Auto pipeline: processing job {job_id} — {source_url}")

    # ── Step 1: Extract CC from YouTube ──
    db.update_pipeline_job(job_id, {"status": "extracting"})

    async with httpx.AsyncClient(base_url="http://127.0.0.1:5295", timeout=120) as client:
        cc_resp = await client.post("/api/v1/subtitle/extract/youtube", json={
            "url": source_url,
            "languages": None
        })
    if cc_resp.status_code != 200:
        raise Exception(f"CC extraction failed: {cc_resp.text[:200]}")

    cc_data = cc_resp.json()
    if cc_data.get("status") == "error":
        raise Exception(f"CC extraction error: {cc_data.get('message', 'unknown')}")

    subtitles = cc_data.get("subtitles", [])
    if not subtitles:
        raise Exception("No subtitles found in video")

    cc_text = "\n".join(s.get("text", "") for s in subtitles)
    source_title = cc_data.get("title", "") or f"Video {job_id}"

    db.update_pipeline_job(job_id, {
        "extracted_text": cc_text[:50000],
        "source_title": source_title,
    })

    # ── Step 2: Create Drama Project ──
    drama_meta = {
        "content_format": job.get("content_format", "Educational / Learning"),
        "auto_pipeline_job_id": job_id,
        "source_url": source_url,
        "pipeline": _get_pipeline_steps(job.get("pipeline_template", "drama_scene")),
        "aspect_ratio": job.get("aspect_ratio", "16:9"),
        "narration_source": job.get("narration_source", "prose"),
    }

    if job.get("gallery_category_id"):
        drama_meta["gallery_category_id"] = job["gallery_category_id"]

    browser_profiles = json.loads(job.get("browser_profiles", "[]")) if isinstance(job.get("browser_profiles"), str) else job.get("browser_profiles", [])
    if browser_profiles:
        drama_meta["browser_profile_name"] = browser_profiles[0]
        drama_meta["browser_profile_names_video"] = browser_profiles

    if job.get("voice_preset"):
        drama_meta["voice_preset"] = job["voice_preset"]
        parts = job["voice_preset"].split("|")
        if len(parts) > 1:
            drama_meta["tts_engine"] = parts[1]

    drama = db.create_drama({
        "title": source_title,
        "style": job.get("visual_style", "Default"),
        "language": job.get("language", "vi"),
        "total_episodes": job.get("max_episodes", 1),
        "metadata": drama_meta,
    })
    drama_id = drama["id"]
    db.update_pipeline_job(job_id, {"drama_id": drama_id})

    # ── Step 3: Generate Outline using AI ──
    s = _settings()
    base_url, api_key, model, temp = s.get_ai_client_params()
    
    if not api_key:
        raise Exception("No API key configured for AI")
        
    from agents.series_planner import SeriesPlannerAgent
    agent = SeriesPlannerAgent()
    agent_cfg = s.get_agent_config("series_planner")
    agent_temp = agent_cfg.get("temperature", 0.7)
    
    db.update_pipeline_job(job_id, {"status": "planning"})
    logger.info(f"Auto pipeline job {job_id}: generating outline...")
    
    try:
        episode_count = job.get("max_episodes", 1)
        language = job.get("language", "vi")
        premise_text = cc_text[:15000]
        char_count = len(premise_text)
        
        if episode_count <= 0:
            min_eps = max(3, char_count // 5000)
            target_eps_str = f"Auto (The premise is {char_count} characters long. You MUST break it down into at least {min_eps} plots. DO NOT summarize it mathematically into 1 episode!)"
        else:
            target_eps_str = f"Maximum {episode_count} (This is an UPPER BOUND, not a fixed number. If the content/premise is short or doesn't have enough material, create FEWER episodes. Only use up to {episode_count} if the content truly warrants it.)"

        user_msg = f"Premise Length: {char_count} characters\nPremise: {premise_text}\nTarget Outputs: {target_eps_str}\nLanguage: {language}"
        content_format = job.get("content_format", "Educational / Learning")
        agent_context = {"content_format": content_format}

        full_response = []
        async for chunk in agent.chat_stream(user_msg, language, base_url, api_key, model, agent_temp, agent_context):
            full_response.append(chunk)
            
        full_text = "".join(full_response)
        
        if full_text.strip().startswith("❌"):
            raise Exception(f"AI API Error: {full_text.strip()}")
            
        try:
            outline_json = _repair_json(full_text)
        except Exception as e:
            raise Exception(f"Failed to parse series outline JSON from AI output: {str(e)[:100]}. AI output was: {full_text[:200]}")
        
        meta = json.loads(drama.get("metadata", "{}") or "{}")
        meta["series_outline"] = outline_json
        db.update_drama(drama_id, {"metadata": json.dumps(meta)})
        
    except Exception as e:
        logger.error(f"Auto pipeline job {job_id}: outline generation failed: {e}")
        raise Exception(f"AI Outline Generation Failed: {e}")

    logger.info(f"Auto pipeline job {job_id}: drama {drama_id} created, outline generated. "
                f"AutoPilot will be triggered from frontend.")

    # ── Step 5: Generate SEO metadata ──
    if job.get("seo_mode") == "ai_generate":
        try:
            seo_result = await _generate_seo_metadata(cc_text[:3000], source_title, job.get("language", "vi"))
            meta = json.loads(db.get_drama(drama_id).get("metadata", "{}") or "{}")
            meta["seo"] = seo_result
            db.update_drama(drama_id, {"metadata": json.dumps(meta)})
            logger.info(f"Auto pipeline job {job_id}: SEO metadata generated")
        except Exception as e:
            logger.warning(f"SEO generation failed for job {job_id}: {e}")

    # ── Step 6: Queue upload (will happen after video is built) ──
    # Upload config is stored in drama metadata; the autopilot frontend
    # will read it and trigger upload after FFmpeg export completes
    upload_targets = json.loads(job.get("upload_targets", "[]")) if isinstance(job.get("upload_targets"), str) else job.get("upload_targets", [])
    if upload_targets:
        meta = json.loads(db.get_drama(drama_id).get("metadata", "{}") or "{}")
        meta["upload_targets"] = upload_targets
        meta["upload_privacy"] = job.get("upload_privacy", "private")
        db.update_drama(drama_id, {"metadata": json.dumps(meta)})

    logger.info(f"Auto pipeline job {job_id}: ready for autopilot execution")


def _get_pipeline_steps(template_key: str) -> list:
    """Map template key to pipeline steps."""
    templates = {
        "drama_scene": ["raw", "rewrite", "extract", "storyboard", "videos", "audio", "video", "publish"],
        "drama_full": ["raw", "rewrite", "extract", "storyboard", "images", "audio", "video", "publish"],
        "audio_story": ["raw", "rewrite", "audio", "video"],
        "content_only": ["raw", "rewrite"],
    }
    return templates.get(template_key, templates["drama_scene"])


async def _generate_seo_metadata(content: str, title: str, language: str) -> dict:
    """Generate SEO metadata using the SEO agent."""
    s = _settings()
    base_url, api_key, model, temp = s.get_ai_client_params()
    if not api_key:
        return {"title": title, "description": "", "tags": []}

    from agents.seo_agent import SEOAgent
    agent = SEOAgent()
    user_msg = f"Source Title: {title}\nLanguage: {language}\nPlatform: facebook\nContent Summary:\n{content[:3000]}"

    full_response = []
    async for chunk in agent.chat_stream(user_msg, language, base_url, api_key, model, 0.7):
        full_response.append(chunk)

    full_text = "".join(full_response)
    try:
        return _repair_json(full_text)
    except Exception:
        return {"title": title, "description": content[:300], "tags": []}

# ═══════════════════════════════════════════════════════════════
# ── Step 08: Publish to Platforms ─────────────────────────────
# ═══════════════════════════════════════════════════════════════

async def _generate_seo_for_platform(content: str, title: str, language: str, platform: str) -> dict:
    """Generate SEO metadata for a specific platform using the SEO agent."""
    s = _settings()
    base_url, api_key, model, temp = s.get_ai_client_params()
    if not api_key:
        return {"title": title, "description": "", "tags": []}

    from agents.seo_agent import SEOAgent
    agent = SEOAgent()
    user_msg = (
        f"Source Title: {title}\n"
        f"Language: {language}\n"
        f"Platform: {platform}\n"
        f"Content Summary:\n{content[:3000]}"
    )

    full_response = []
    async for chunk in agent.chat_stream(user_msg, language, base_url, api_key, model, 0.7):
        full_response.append(chunk)

    full_text = "".join(full_response)
    try:
        return _repair_json(full_text)
    except Exception:
        return {"title": title, "description": content[:300], "tags": []}


@router.post("/api/v1/studio/dramas/{drama_id}/episodes/{episode_id}/validate-before-publish")
async def validate_before_publish(drama_id: int, episode_id: int):
    """Validate that an episode is fully ready for publishing.
    Checks: storyboard images, AI videos, TTS audio, and final exported video."""
    db = _db()
    drama = db.get_drama(drama_id)
    if not drama:
        raise HTTPException(404, "Drama not found")
    ep = db.get_episode(episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")

    shots = db.list_storyboards(episode_id)
    total = len(shots)
    if total == 0:
        return {"valid": False, "errors": ["No storyboard shots found for this episode."], "warnings": [], "summary": {}}

    errors = []
    warnings = []
    missing_image = []
    missing_video = []
    missing_audio = []
    short_audio = []

    for sb in shots:
        num = sb.get("storyboard_number", "?")

        # Check composed image
        img = sb.get("composed_image", "") or sb.get("first_frame_image", "")
        if not img or not img.strip():
            missing_image.append(num)

        # Check AI video
        vid = sb.get("video_url", "")
        if not vid or not vid.strip():
            missing_video.append(num)

        # Check TTS audio
        audio = sb.get("tts_audio_url", "")
        if not audio or not audio.strip():
            missing_audio.append(num)
        else:
            # Validate audio file exists and has reasonable size
            audio_file = ""
            if audio.startswith("/api/"):
                # It's a relative URL like /api/v1/tts/audio/filename.mp3
                filename = audio.split("/")[-1]
                ext_dir = os.path.dirname(os.path.abspath(__file__))
                # Check common audio dirs
                for audio_dir in [
                    os.path.join(ext_dir, "..", "tts_vibevoice", "data", "audio"),
                    os.path.join(ext_dir, "data", "audio"),
                ]:
                    candidate = os.path.join(audio_dir, filename)
                    if os.path.isfile(candidate):
                        audio_file = candidate
                        break
            elif os.path.isfile(audio):
                audio_file = audio

            if audio_file:
                fsize = os.path.getsize(audio_file)
                if fsize < 1000:  # Less than 1KB = likely corrupted/empty
                    short_audio.append({"shot": num, "size_bytes": fsize, "file": os.path.basename(audio_file)})

    # Build error messages
    if missing_image:
        warnings.append(f"⚠️ {len(missing_image)}/{total} shots missing images: #{', #'.join(str(n) for n in missing_image)}")

    if missing_video:
        errors.append(f"❌ {len(missing_video)}/{total} shots missing AI video: #{', #'.join(str(n) for n in missing_video)}")

    if missing_audio:
        errors.append(f"❌ {len(missing_audio)}/{total} shots missing TTS audio: #{', #'.join(str(n) for n in missing_audio)}")

    if short_audio:
        details = ", ".join([f"#{s['shot']}({s['size_bytes']}B)" for s in short_audio])
        errors.append(f"❌ {len(short_audio)} audio files appear corrupted (too small): {details}")

    # Check final exported video
    video_path = _find_episode_video(drama_id, episode_id)
    has_export = False
    export_size = 0
    if video_path and os.path.isfile(video_path):
        export_size = os.path.getsize(video_path)
        if export_size > 100_000:  # At least 100KB
            has_export = True
        else:
            errors.append(f"❌ Exported video file is too small ({export_size} bytes), likely corrupted: {os.path.basename(video_path)}")
    else:
        errors.append("❌ No exported video found. Run FFmpeg export (Step 7) first.")

    summary = {
        "total_shots": total,
        "with_image": total - len(missing_image),
        "with_video": total - len(missing_video),
        "with_audio": total - len(missing_audio),
        "corrupted_audio": len(short_audio),
        "has_export": has_export,
        "export_size_mb": round(export_size / 1_048_576, 2) if export_size else 0,
        "export_path": os.path.basename(video_path) if video_path else "",
        "export_path_full": video_path if video_path else "",
    }

    is_valid = len(errors) == 0
    return {"valid": is_valid, "errors": errors, "warnings": warnings, "summary": summary}

def _find_episode_video(drama_id: int, episode_id: int) -> str:
    """Find the final exported video file for an episode."""
    import glob
    db = _db()
    drama = db.get_drama(drama_id)
    ep = db.get_episode(episode_id)
    if not drama or not ep:
        return ""

    # Check episode video_url first
    video_url = ep.get("video_url", "")
    if video_url and os.path.isfile(video_url):
        return video_url

    # Check common export paths
    drama_title = drama.get("title", f"drama_{drama_id}")
    ep_num = ep.get("episode_number", 1)

    # Search in data/content_studio/exports/
    ext_dir = os.path.dirname(os.path.abspath(__file__))
    export_dir = os.path.join(ext_dir, "data", "exports")
    
    # Safely construct episode title pattern
    ep_title_clean = ep.get('title', '').replace(' ', '*').replace(':', '*')
    
    if os.path.isdir(export_dir):
        patterns = [
            os.path.join(export_dir, f"episode_{episode_id}_pipeline_export.mp4"),
            os.path.join(export_dir, f"*{drama_id}*ep{ep_num}*.mp4")
        ]
        if ep_title_clean:
            patterns.append(os.path.join(export_dir, f"*{ep_title_clean}*.mp4"))
            
        for pat in patterns:
            files = glob.glob(pat)
            if files:
                return max(files, key=os.path.getmtime)

    # Search in output directory
    output_dir = os.path.join(os.path.dirname(ext_dir), "..", "output")
    if os.path.isdir(output_dir):
        patterns = [
            os.path.join(output_dir, "**", f"episode_{episode_id}_pipeline_export.mp4"),
            os.path.join(output_dir, "**", f"*{drama_id}*ep{ep_num}*.mp4")
        ]
        if ep_title_clean:
            patterns.append(os.path.join(output_dir, "**", f"*{ep_title_clean}*.mp4"))
            
        for pat in patterns:
            files = glob.glob(pat, recursive=True)
            if files:
                return max(files, key=os.path.getmtime)

    return ""


@router.post("/api/v1/studio/dramas/{drama_id}/generate-seo")
async def generate_seo_for_publish(drama_id: int, request: Request):
    """Generate SEO metadata for all configured upload targets (per-platform).
    SEO is stored per-episode so each episode has unique title/description/tags."""
    data = await request.json()
    episode_id = data.get("episode_id")

    drama = _db().get_drama(drama_id)
    if not drama:
        raise HTTPException(404, "Drama not found")

    meta = json.loads(drama.get("metadata", "{}") or "{}")
    targets = meta.get("upload_targets", [])
    language = drama.get("language", "vi")
    title = drama.get("title", "")

    # Get content summary from episode
    ep = None
    content_summary = ""
    ep_title = title
    if episode_id:
        ep = _db().get_episode(episode_id)
        if ep:
            content_summary = ep.get("script_content", "") or ep.get("content", "")
            if not content_summary:
                # Try to build content from storyboards
                storyboards = _db().list_storyboards(episode_id)
                if storyboards:
                    content_summary = " ".join(
                        filter(None, [sb.get("narration_text", "").strip() or sb.get("description", "").strip() for sb in storyboards])
                    )
            
            # Combine drama title and episode title for better context
            ep_name = ep.get("title", "")
            if ep_name and ep_name.lower() != title.lower():
                ep_title = f"{title} - {ep_name}"

    if not content_summary:
        content_summary = meta.get("series_outline", {}).get("overview", title)
    if isinstance(content_summary, dict):
        content_summary = json.dumps(content_summary, ensure_ascii=False)

    # Determine platforms to generate SEO for
    platforms = set()
    for t in targets:
        platforms.add(t.get("provider", "youtube"))
    if not platforms:
        platforms = {"youtube"}  # Default

    seo_publish = {}
    for platform in platforms:
        try:
            seo_result = await _generate_seo_for_platform(
                content_summary[:3000], ep_title, language, platform
            )
            seo_publish[platform] = seo_result
            logger.info(f"Generated SEO for {platform} (ep {episode_id}): {seo_result.get('title', '')[:50]}")
        except Exception as e:
            logger.warning(f"SEO generation failed for {platform}: {e}")
            seo_publish[platform] = {"title": ep_title, "description": "", "tags": []}

    # Save to EPISODE metadata (per-episode SEO)
    if ep and episode_id:
        ep_meta = json.loads(ep.get("metadata", "{}") or "{}")
        ep_meta["seo_publish"] = seo_publish
        _db().update_episode(episode_id, {"metadata": json.dumps(ep_meta, ensure_ascii=False)})
    else:
        # Fallback: save to drama if no episode specified
        meta["seo_publish"] = seo_publish
        _db().update_drama(drama_id, {"metadata": json.dumps(meta, ensure_ascii=False)})

    return {"success": True, "seo_publish": seo_publish}


@router.post("/api/v1/studio/dramas/{drama_id}/episodes/{episode_id}/publish")
async def publish_episode(drama_id: int, episode_id: int, request: Request):
    """Publish an episode's final video to a specific platform target."""
    data = await request.json()
    target_index = data.get("target_index", 0)

    drama = _db().get_drama(drama_id)
    if not drama:
        raise HTTPException(404, "Drama not found")

    ep = _db().get_episode(episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")

    meta = json.loads(drama.get("metadata", "{}") or "{}")
    targets = meta.get("upload_targets", [])
    if target_index >= len(targets):
        raise HTTPException(400, "Invalid target_index")

    target = targets[target_index]
    platform = target.get("provider", "youtube")
    privacy = meta.get("upload_privacy", "private")

    # Find the video file
    video_path = _find_episode_video(drama_id, episode_id)
    if not video_path or not os.path.isfile(video_path):
        raise HTTPException(400, f"No exported video found for episode {episode_id}. Export video in Step 7 first.")

    # Get SEO for this platform (per-episode, fallback to drama-level)
    ep_meta = json.loads(ep.get("metadata", "{}") or "{}")
    seo = ep_meta.get("seo_publish", {}).get(platform, {})
    if not seo:
        seo = meta.get("seo_publish", {}).get(platform, {})
    upload_title = seo.get("title", drama.get("title", f"Episode {ep.get('episode_number', 1)}"))
    upload_desc = seo.get("description", "")
    upload_tags = seo.get("tags", [])
    category_id = seo.get("category_id", "22")

    # Call Video Manager upload API internally
    import httpx
    try:
        async with httpx.AsyncClient(base_url="http://127.0.0.1:5295") as client:
            payload = {
                "provider": platform,
                "email": target.get("email", ""),
                "cred_id": target.get("cred_id", ""),
                "token_id": target.get("cred_id", ""),
                "channel_id": target.get("channel_id", ""),
                "file_path": video_path,
                "title": upload_title,
                "description": upload_desc,
                "tags": upload_tags,
                "category_id": category_id,
                "privacy": privacy,
            }
            resp = await client.post("/api/v1/video_manager/upload", json=payload, timeout=30.0)
            result = resp.json()

            if result.get("success") and result.get("task_id"):
                # Save task_id to episode metadata for status tracking
                ep_meta = json.loads(ep.get("metadata", "{}") or "{}")
                if "publish_tasks" not in ep_meta:
                    ep_meta["publish_tasks"] = {}
                ep_meta["publish_tasks"][platform] = result["task_id"]
                _db().update_episode(episode_id, {"metadata": json.dumps(ep_meta)})

                return {"success": True, "task_id": result["task_id"], "platform": platform}
            else:
                return {"success": False, "error": result.get("detail", "Upload failed")}
    except Exception as e:
        logger.error(f"Publish to {platform} failed: {e}")
        raise HTTPException(500, f"Publish failed: {str(e)}")


@router.get("/api/v1/studio/dramas/{drama_id}/episodes/{episode_id}/publish-status")
async def get_publish_status(drama_id: int, episode_id: int):
    """Get publish status for all platforms."""
    ep = _db().get_episode(episode_id)
    if not ep:
        raise HTTPException(404, "Episode not found")

    ep_meta = json.loads(ep.get("metadata", "{}") or "{}")
    publish_tasks = ep_meta.get("publish_tasks", {})

    platforms = {}
    for platform, task_id in publish_tasks.items():
        try:
            import httpx
            async with httpx.AsyncClient(base_url="http://127.0.0.1:5295") as client:
                resp = await client.get(f"/api/v1/video_manager/upload/tasks/{task_id}", timeout=10.0)
                data = resp.json()
                task = data.get("task", {})
                platforms[platform] = {
                    "task_id": task_id,
                    "status": task.get("status", "unknown"),
                    "progress": task.get("progress_pct", 0),
                    "video_url": task.get("video_url", ""),
                    "video_id": task.get("video_id", ""),
                    "error": task.get("error_message", ""),
                }
        except Exception as e:
            platforms[platform] = {"task_id": task_id, "status": "unknown", "error": str(e)}

    return {"success": True, "platforms": platforms}


# ═══════════════════════════════════════════════════════════════
# ── Channel Watcher API ───────────────────────────────────────
# ═══════════════════════════════════════════════════════════════


_channel_watcher_running = False


@router.get("/api/v1/studio/channel-watchers")
async def list_channel_watchers():
    """List all channel watchers."""
    watchers = _db().list_channel_watchers()
    return {"success": True, "watchers": watchers, "count": len(watchers)}


@router.post("/api/v1/studio/channel-watchers")
async def create_channel_watcher(request: Request):
    """Create a new channel watcher."""
    data = await request.json()
    if not data.get("channel_url"):
        raise HTTPException(400, "channel_url is required")

    # Try to resolve channel name via yt-dlp
    channel_url = data["channel_url"]
    channel_name = data.get("channel_name", "")
    channel_id = data.get("channel_id", "")

    if not channel_name and "youtube.com" in channel_url:
        try:
            proc = await asyncio.create_subprocess_exec(
                "yt-dlp", "--print", "channel", "--playlist-items", "1", "--skip-download", channel_url,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
            channel_name = stdout.decode().strip() or channel_url
        except Exception:
            channel_name = channel_url

    data["channel_name"] = channel_name
    data["channel_id"] = channel_id

    watcher = _db().create_channel_watcher(data)
    return {"success": True, "watcher": watcher}


@router.put("/api/v1/studio/channel-watchers/{watcher_id}")
async def update_channel_watcher(watcher_id: int, request: Request):
    """Update a channel watcher."""
    data = await request.json()
    watcher = _db().update_channel_watcher(watcher_id, data)
    if not watcher:
        raise HTTPException(404, "Watcher not found")
    return {"success": True, "watcher": watcher}


@router.delete("/api/v1/studio/channel-watchers/{watcher_id}")
async def delete_channel_watcher(watcher_id: int):
    """Delete a channel watcher."""
    _db().delete_channel_watcher(watcher_id)
    return {"success": True}


@router.post("/api/v1/studio/channel-watchers/start")
async def start_channel_watcher_loop(background_tasks: BackgroundTasks):
    """Start the channel watcher background loop."""
    global _channel_watcher_running
    if _channel_watcher_running:
        return {"success": True, "message": "Watcher already running"}
    background_tasks.add_task(_run_channel_watcher_loop)
    return {"success": True, "message": "Channel watcher started"}


@router.post("/api/v1/studio/channel-watchers/stop")
async def stop_channel_watcher_loop():
    """Stop the channel watcher background loop."""
    global _channel_watcher_running
    _channel_watcher_running = False
    return {"success": True, "message": "Stop requested"}


@router.get("/api/v1/studio/channel-watchers/status")
async def channel_watcher_status():
    """Get channel watcher loop status."""
    return {"success": True, "running": _channel_watcher_running}


async def _run_channel_watcher_loop():
    """Background loop: check all active watchers for new videos."""
    global _channel_watcher_running
    _channel_watcher_running = True
    db = _db()

    try:
        while _channel_watcher_running:
            watchers = db.list_channel_watchers()
            active_watchers = [w for w in watchers if w.get("is_active")]

            for watcher in active_watchers:
                if not _channel_watcher_running:
                    break

                last_checked = watcher.get("last_checked_at")
                interval = watcher.get("check_interval_minutes", 30)

                # Check if it's time to poll
                if last_checked:
                    from datetime import datetime, timezone, timedelta
                    last_dt = datetime.fromisoformat(last_checked)
                    if datetime.now(timezone.utc) - last_dt < timedelta(minutes=interval):
                        continue

                try:
                    await _check_channel_for_new_videos(watcher)
                except Exception as e:
                    logger.error(f"Channel watcher {watcher['id']} error: {e}")

            # Sleep 60 seconds between full sweeps
            for _ in range(60):
                if not _channel_watcher_running:
                    break
                await asyncio.sleep(1)
    finally:
        _channel_watcher_running = False


async def _check_channel_for_new_videos(watcher: dict):
    """Check a single channel for new videos via YouTube RSS."""
    import xml.etree.ElementTree as ET
    import httpx
    from datetime import datetime, timezone

    db = _db()
    watcher_id = watcher["id"]
    channel_url = watcher["channel_url"]

    # Resolve channel ID for RSS if needed
    channel_id = watcher.get("channel_id", "")
    if not channel_id and "youtube.com" in channel_url:
        try:
            proc = await asyncio.create_subprocess_exec(
                "yt-dlp", "--print", "channel_id", "--playlist-items", "1", "--skip-download", channel_url,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
            channel_id = stdout.decode().strip()
            if channel_id:
                db.update_channel_watcher(watcher_id, {"channel_id": channel_id})
        except Exception:
            pass

    if not channel_id:
        logger.warning(f"Channel watcher {watcher_id}: could not resolve channel_id")
        db.update_channel_watcher(watcher_id, {"last_checked_at": datetime.now(timezone.utc).isoformat()})
        return

    # Fetch YouTube RSS feed
    rss_url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(rss_url)

    if resp.status_code != 200:
        logger.warning(f"Channel watcher {watcher_id}: RSS fetch failed ({resp.status_code})")
        db.update_channel_watcher(watcher_id, {"last_checked_at": datetime.now(timezone.utc).isoformat()})
        return

    # Parse RSS XML
    root = ET.fromstring(resp.text)
    ns = {"atom": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015"}

    known_ids = json.loads(watcher.get("known_video_ids", "[]")) if isinstance(watcher.get("known_video_ids"), str) else watcher.get("known_video_ids", [])
    new_videos = []

    for entry in root.findall("atom:entry", ns):
        video_id_el = entry.find("yt:videoId", ns)
        if video_id_el is None:
            continue
        video_id = video_id_el.text
        if video_id not in known_ids:
            title_el = entry.find("atom:title", ns)
            title = title_el.text if title_el is not None else ""
            new_videos.append({"video_id": video_id, "title": title})
            known_ids.append(video_id)

    # Update known videos
    db.update_channel_watcher(watcher_id, {
        "last_checked_at": datetime.now(timezone.utc).isoformat(),
        "known_video_ids": json.dumps(known_ids[-200:]),  # keep last 200
        "last_video_id": known_ids[-1] if known_ids else "",
    })

    if not new_videos:
        logger.info(f"Channel watcher {watcher_id}: no new videos")
        return

    logger.info(f"Channel watcher {watcher_id}: found {len(new_videos)} new video(s)")

    # Create pipeline jobs for new videos
    for vid in new_videos:
        video_url = f"https://www.youtube.com/watch?v={vid['video_id']}"
        job_data = {
            "source_type": "channel_watch",
            "source_url": video_url,
            "source_title": vid["title"],
            "preset_name": watcher.get("preset_name", ""),
            "pipeline_template": watcher.get("pipeline_template", "drama_scene"),
            "content_format": watcher.get("content_format", "Educational / Learning"),
            "visual_style": watcher.get("visual_style", "Default"),
            "max_episodes": watcher.get("max_episodes", 1),
            "language": watcher.get("language", "vi"),
            "voice_preset": watcher.get("voice_preset", ""),
            "browser_profiles": json.loads(watcher.get("browser_profiles", "[]")) if isinstance(watcher.get("browser_profiles"), str) else watcher.get("browser_profiles", []),
            "seo_mode": watcher.get("seo_mode", "ai_generate"),
            "upload_targets": json.loads(watcher.get("upload_targets", "[]")) if isinstance(watcher.get("upload_targets"), str) else watcher.get("upload_targets", []),
            "upload_privacy": watcher.get("upload_privacy", "private"),
        }
        db.create_pipeline_job(job_data)
        logger.info(f"Channel watcher {watcher_id}: queued job for {video_url}")


# ═══════════════════════════════════════════════════════════════
# Character Gallery API
# ═══════════════════════════════════════════════════════════════

def _get_gallery_dir():
    """Get directory for storing gallery character images."""
    try:
        from tubecli.config import DATA_DIR
        d = os.path.join(str(DATA_DIR), "content_studio", "gallery")
    except Exception:
        d = os.path.join(_ext_dir, "outputs", "gallery")
    os.makedirs(d, exist_ok=True)
    return d


# ── Category CRUD ──

@router.get("/api/v1/studio/gallery/categories")
async def list_gallery_categories():
    cats = _db().list_gallery_categories()
    return {"success": True, "categories": cats}


@router.post("/api/v1/studio/gallery/categories")
async def create_gallery_category(request: Request):
    data = await request.json()
    cat = _db().create_gallery_category(data)
    return {"success": True, "category": cat}


@router.put("/api/v1/studio/gallery/categories/{cat_id}")
async def update_gallery_category(cat_id: int, request: Request):
    data = await request.json()
    cat = _db().update_gallery_category(cat_id, data)
    if not cat:
        raise HTTPException(404, "Category not found")
    return {"success": True, "category": cat}


@router.delete("/api/v1/studio/gallery/categories/{cat_id}")
async def delete_gallery_category(cat_id: int):
    _db().delete_gallery_category(cat_id)
    return {"success": True}


# ── Item CRUD ──

@router.get("/api/v1/studio/gallery/items")
async def list_gallery_items(category_id: int = None):
    items = _db().list_gallery_items(category_id)
    return {"success": True, "items": items}


@router.post("/api/v1/studio/gallery/items")
async def create_gallery_item(request: Request):
    data = await request.json()
    item = _db().create_gallery_item(data)
    return {"success": True, "item": item}


@router.get("/api/v1/studio/gallery/items/{item_id}")
async def get_gallery_item(item_id: int):
    item = _db().get_gallery_item(item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    return {"success": True, "item": item}


@router.put("/api/v1/studio/gallery/items/{item_id}")
async def update_gallery_item(item_id: int, request: Request):
    data = await request.json()
    item = _db().update_gallery_item(item_id, data)
    if not item:
        raise HTTPException(404, "Item not found")
    return {"success": True, "item": item}


@router.delete("/api/v1/studio/gallery/items/{item_id}")
async def delete_gallery_item(item_id: int):
    _db().delete_gallery_item(item_id)
    return {"success": True}


# ── Upload Image ──

@router.post("/api/v1/studio/gallery/upload-image")
async def upload_gallery_image_generic(request: Request):
    """Upload a reference image for a gallery character (before saving item)."""
    import shutil
    from datetime import datetime

    form = await request.form()
    file = form.get("file")
    if not file:
        raise HTTPException(400, "No file uploaded")

    gallery_dir = _get_gallery_dir()
    ext = os.path.splitext(file.filename)[1] or ".png"
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"gallery_new_{ts}{ext}"
    filepath = os.path.join(gallery_dir, filename)

    with open(filepath, "wb") as f:
        content = await file.read()
        f.write(content)

    web_url = f"/api/v1/studio/gallery/image/{filename}"
    return {"success": True, "url": web_url, "filepath": filepath}


@router.post("/api/v1/studio/gallery/items/{item_id}/upload-image")
async def upload_gallery_image(item_id: int, request: Request):
    """Upload a reference image for a gallery character."""
    import shutil
    from datetime import datetime

    item = _db().get_gallery_item(item_id)
    if not item:
        raise HTTPException(404, "Item not found")

    form = await request.form()
    file = form.get("file")
    if not file:
        raise HTTPException(400, "No file uploaded")

    gallery_dir = _get_gallery_dir()
    ext = os.path.splitext(file.filename)[1] or ".png"
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"gallery_{item_id}_{ts}{ext}"
    filepath = os.path.join(gallery_dir, filename)

    with open(filepath, "wb") as f:
        content = await file.read()
        f.write(content)

    # Update item's image_url and reference_images
    try:
        refs = json.loads(item.get("reference_images") or "[]")
    except Exception:
        refs = []
    refs.append(filepath)

    web_url = f"/api/v1/studio/gallery/image/{filename}"
    _db().update_gallery_item(item_id, {
        "image_url": web_url,
        "reference_images": refs,
    })

    return {"success": True, "image_url": web_url, "url": web_url}


# ── Gemini Image Analysis ──

# ── Save Gemini API Key ──

@router.post("/api/v1/studio/gallery/save-api-key")
async def save_gemini_api_key(request: Request):
    """Save a Gemini API key to cloud_api_keys.json for persistent use."""
    data = await request.json()
    api_key = data.get("api_key", "").strip()
    if not api_key:
        raise HTTPException(400, "API key is required")

    try:
        from tubecli.extensions.cloud_api.extension import key_manager

        # Save using the proper manager to support dict format and multiple keys
        # Auto-label: gallery_1, gallery_2, ...
        existing = key_manager._keys.get("gemini", {})
        if isinstance(existing, str):
            existing = {}
        idx = 1
        while f"gallery_{idx}" in existing:
            idx += 1
        label = f"gallery_{idx}"
        key_manager.add_key("gemini", api_key, label)

        logger.info(f"Gemini API key saved via gallery modal as '{label}'")
        return {"success": True, "message": "Gemini API key saved successfully", "label": label}
    except Exception as e:
        logger.error(f"Failed to save Gemini API key: {e}")
        raise HTTPException(500, f"Failed to save API key: {str(e)}")


@router.get("/api/v1/studio/gallery/list-gemini-keys")
async def list_gemini_keys():
    """List all saved Gemini API keys (masked) with active status."""
    try:
        from tubecli.extensions.cloud_api.extension import key_manager
        key_manager._load()
        entries = key_manager._keys.get("gemini", {})

        # Handle legacy string format
        if isinstance(entries, str) and entries:
            masked = entries[:8] + "..." + entries[-4:] if len(entries) > 12 else "***"
            return {"keys": [{"label": "default", "masked_key": masked, "active": True}]}

        if not isinstance(entries, dict):
            return {"keys": []}

        result = []
        for label, entry in entries.items():
            if not isinstance(entry, dict):
                continue
            key_val = entry.get("key", "")
            masked = key_val[:8] + "..." + key_val[-4:] if len(key_val) > 12 else "***"
            result.append({
                "label": label,
                "masked_key": masked,
                "active": entry.get("active", False),
                "added_at": entry.get("added_at", ""),
            })
        return {"keys": result}
    except Exception as e:
        logger.error(f"Failed to list Gemini keys: {e}")
        return {"keys": []}


@router.post("/api/v1/studio/gallery/set-active-gemini-key")
async def set_active_gemini_key(request: Request):
    """Set a specific Gemini key label as the active one (deactivate others)."""
    data = await request.json()
    target_label = data.get("label", "").strip()
    if not target_label:
        raise HTTPException(400, "Label is required")

    try:
        from tubecli.extensions.cloud_api.extension import key_manager
        key_manager._load()
        entries = key_manager._keys.get("gemini", {})
        if not isinstance(entries, dict) or target_label not in entries:
            raise HTTPException(404, f"Key '{target_label}' not found")

        # Deactivate all, then activate the target
        for label, entry in entries.items():
            if isinstance(entry, dict):
                entry["active"] = (label == target_label)
        key_manager._save()
        logger.info(f"Active Gemini key set to '{target_label}'")
        return {"success": True, "message": f"Active key changed to '{target_label}'"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to set active Gemini key: {e}")
        raise HTTPException(500, f"Failed: {str(e)}")


@router.post("/api/v1/studio/gallery/delete-gemini-key")
async def delete_gemini_key(request: Request):
    """Delete a specific Gemini key by label."""
    data = await request.json()
    target_label = data.get("label", "").strip()
    if not target_label:
        raise HTTPException(400, "Label is required")

    try:
        from tubecli.extensions.cloud_api.extension import key_manager
        result = key_manager.remove_key("gemini", target_label)
        return {"success": result.get("status") == "success", "message": result.get("message", "")}
    except Exception as e:
        logger.error(f"Failed to delete Gemini key: {e}")
        raise HTTPException(500, f"Failed: {str(e)}")


@router.post("/api/v1/studio/gallery/analyze-image")
async def analyze_gallery_image(request: Request):
    """
    Analyze a character image using Gemini Vision API.
    Accepts either an uploaded file or an existing image path.
    Returns structured character data: gender, age_range, appearance, tags.
    """
    import httpx
    import base64

    content_type = request.headers.get("content-type", "")

    # Get image data
    if "multipart" in content_type:
        form = await request.form()
        file = form.get("file")
        api_key = form.get("api_key", "")
        if not file:
            raise HTTPException(400, "No file uploaded")
        image_bytes = await file.read()
        mime_type = file.content_type or "image/png"

        # Also save the file if item_id provided
        item_id = form.get("item_id")
        if item_id:
            gallery_dir = _get_gallery_dir()
            from datetime import datetime
            ext = os.path.splitext(file.filename)[1] or ".png"
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"gallery_analyze_{ts}{ext}"
            filepath = os.path.join(gallery_dir, filename)
            with open(filepath, "wb") as f:
                f.write(image_bytes)
    else:
        data = await request.json()
        api_key = data.get("api_key", "")
        image_path = data.get("image_path", "")

        # Resolve web URL to filesystem path if needed
        if image_path and image_path.startswith("/api/v1/studio/gallery/image/"):
            fname = image_path.replace("/api/v1/studio/gallery/image/", "", 1)
            image_path = os.path.join(_get_gallery_dir(), fname)

        if not image_path or not os.path.isfile(image_path):
            raise HTTPException(400, f"Image path not found: {image_path}")
        with open(image_path, "rb") as f:
            image_bytes = f.read()
        ext = os.path.splitext(image_path)[1].lower()
        mime_map = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                    ".webp": "image/webp", ".gif": "image/gif"}
        mime_type = mime_map.get(ext, "image/png")
        filepath = image_path

    if not api_key:
        # Try to get from KeyManager
        try:
            from tubecli.extensions.cloud_api.extension import key_manager
            api_key = key_manager.get_active_key("gemini")
        except Exception:
            pass

    if not api_key:
        raise HTTPException(400, "Gemini API key required. Configure in Settings → Cloud API Keys.")

    # Build Gemini request
    image_b64 = base64.b64encode(image_bytes).decode("utf-8")

    prompt = """Look at this image carefully. First determine WHAT the image shows: is it a character, a group of people, an animal/creature, or a non-living OBJECT/PRODUCT (such as a book, box set, toy, vehicle, food, furniture, etc)?

IMPORTANT RULES:
- If the image shows a PRODUCT, BOOK, PACKAGE, or any non-living OBJECT: set char_type to "object". Describe the OBJECT ITSELF (what it is, its shape, colors, text/labels on it, brand, packaging). Do NOT describe characters/people printed on it.
- If the image shows a CREATURE or ANIMAL: set char_type to "creature". Describe the animal/creature itself.
- If the image shows exactly 1 person/character: set char_type to "individual". Describe their physical appearance.
- If the image shows exactly 2 characters: set char_type to "duo".
- If the image shows 3-5 characters together: set char_type to "friend_group".
- If the image shows 6+ people: set char_type to "crowd".

RESPOND ONLY with valid JSON, no markdown or explanation.

{
  "char_type": one of "individual", "duo", "friend_group", "crowd", "creature", "object",
  "name_suggestion": "A descriptive name for this entry (e.g. 'Sherlock Holmes Book Set', 'Black Cat', 'Beach Crowd', 'Blue Hair Girl')",
  "gender": "male" / "female" / "mixed" / "other" / "" (leave empty for objects/creatures if not applicable),
  "age_range": "child" / "teen" / "young_adult" / "adult" / "middle_aged" / "elderly" / "mixed" / "" (leave empty for objects),
  "appearance": "For CHARACTERS: hair, eyes, skin, build, clothing, accessories. For OBJECTS/PRODUCTS: describe the item — shape, size, colors, text/title/brand visible, packaging, condition, material. For CREATURES: species, color, size, features. Write as a plain English paragraph.",
  "role_type": "A concise label: e.g. 'detective', 'book set', 'pet dog', 'student group', 'toy figure'",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "art_style": "realistic / anime / chibi / cartoon / 3d_render / photograph / illustration / etc."
}"""

    gemini_payload = {
        "contents": [{
            "parts": [
                {"text": prompt},
                {"inline_data": {"mime_type": mime_type, "data": image_b64}}
            ]
        }],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 1024,
        }
    }

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}",
                json=gemini_payload,
            )

        if resp.status_code != 200:
            error_detail = resp.text[:300]
            logger.error(f"Gemini API error: {resp.status_code} — {error_detail}")
            raise HTTPException(resp.status_code, f"Gemini API error: {error_detail}")

        result = resp.json()
        # Gemini 2.5 Flash returns thinking in separate parts with thought=true
        # Find the actual text part (not the thinking part)
        parts = result.get("candidates", [{}])[0].get("content", {}).get("parts", [])
        text = ""
        for part in parts:
            # Skip thinking parts (Gemini 2.5 reasoning)
            if part.get("thought"):
                continue
            if part.get("text"):
                text = part["text"]
                break
        # Fallback: if no non-thought text found, use first text part
        if not text:
            for part in parts:
                if part.get("text"):
                    text = part["text"]
                    break

        # Parse JSON from response — robust handling of markdown fences
        import re
        logger.info(f"[Gallery Analyze] Gemini parts count: {len(parts)}, thought parts: {sum(1 for p in parts if p.get('thought'))}")
        logger.info(f"[Gallery Analyze] Raw text (first 300): {text[:300]}")
        # 1. Strip <think>...</think> blocks (inline reasoning fallback)
        clean_text = re.sub(r'<think>[\s\S]*?</think>', '', text).strip()
        # 2. Strip markdown code fences
        clean_text = re.sub(r'^```(?:json)?\s*', '', clean_text, flags=re.MULTILINE)
        clean_text = re.sub(r'^```\s*$', '', clean_text, flags=re.MULTILINE)
        clean_text = clean_text.strip()
        logger.info(f"[Gallery Analyze] Clean text (first 300): {clean_text[:300]}")
        # 3. Try parsing the cleaned text directly (often it's just JSON)
        analysis = None
        try:
            analysis = json.loads(clean_text)
        except (json.JSONDecodeError, ValueError):
            pass
        # 4. Fallback: find last complete JSON object (most likely the actual response)
        if not analysis:
            # Find all top-level JSON objects
            brace_depth = 0
            obj_start = -1
            candidates = []
            for i, ch in enumerate(clean_text):
                if ch == '{':
                    if brace_depth == 0:
                        obj_start = i
                    brace_depth += 1
                elif ch == '}':
                    brace_depth -= 1
                    if brace_depth == 0 and obj_start >= 0:
                        candidates.append(clean_text[obj_start:i+1])
                        obj_start = -1
            # Try candidates from last to first (last is most likely the actual answer)
            for candidate in reversed(candidates):
                try:
                    analysis = json.loads(candidate)
                    if isinstance(analysis, dict) and ("char_type" in analysis or "appearance" in analysis):
                        break
                    analysis = None
                except (json.JSONDecodeError, ValueError):
                    continue
        if not analysis:
            analysis = {"appearance": text, "tags": [], "gender": "", "age_range": ""}

        return {
            "success": True,
            "analysis": analysis,
            "image_path": filepath if 'filepath' in dir() else "",
        }

    except httpx.TimeoutException:
        raise HTTPException(504, "Gemini API timeout")
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse Gemini response: {e}")
        return {"success": True, "analysis": {"appearance": text, "tags": [], "gender": "", "age_range": ""}}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Gemini analysis error: {e}")
        raise HTTPException(500, f"Analysis failed: {str(e)[:200]}")


# ── Clone Gallery to Drama ──

@router.post("/api/v1/studio/gallery/apply-to-drama")
async def apply_gallery_to_drama(request: Request):
    """
    Clone gallery characters into a drama project.
    Copies name, appearance, image_url, reference_images from gallery items
    into the drama's characters table.
    """
    data = await request.json()
    drama_id = data.get("drama_id")
    category_id = data.get("category_id")
    item_ids = data.get("item_ids", [])

    if not drama_id:
        raise HTTPException(400, "drama_id required")

    db = _db()
    drama = db.get_drama(drama_id)
    if not drama:
        raise HTTPException(404, "Drama not found")

    # Get gallery items to clone
    if item_ids:
        items = [db.get_gallery_item(iid) for iid in item_ids]
        items = [i for i in items if i is not None]
    elif category_id:
        items = db.list_gallery_items(category_id)
    else:
        raise HTTPException(400, "category_id or item_ids required")

    cloned = []
    for gi in items:
        # Check if character with same name already exists in drama
        existing = db.list_characters(drama_id)
        already_exists = any(c.get("name", "").lower() == gi.get("name", "").lower() for c in existing)
        if already_exists:
            continue

        char_data = {
            "name": gi.get("name", ""),
            "role": gi.get("role_type", ""),
            "description": gi.get("personality", ""),
            "appearance": gi.get("appearance", ""),
            "voice_style": gi.get("voice_style", ""),
            "image_url": gi.get("image_url", ""),
            "reference_images": gi.get("reference_images", "[]"),
        }
        char = db.create_character(drama_id, char_data)
        cloned.append(char)

    # Store gallery_category_id in drama metadata for pipeline reference
    if category_id:
        try:
            meta = json.loads(drama.get("metadata") or "{}")
            meta["gallery_category_id"] = category_id
            db.update_drama(drama_id, {"metadata": json.dumps(meta)})
        except Exception:
            pass

    return {"success": True, "cloned_count": len(cloned), "characters": cloned}


# ── Search Gallery ──

@router.get("/api/v1/studio/gallery/search")
async def search_gallery(q: str = "", gender: str = "", age_range: str = "", visual_style: str = ""):
    items = _db().search_gallery_items(query=q, gender=gender, age_range=age_range, visual_style=visual_style)
    return {"success": True, "items": items, "count": len(items)}


# ── Serve Gallery Images ──

@router.get("/api/v1/studio/gallery/image/{filename:path}")
async def serve_gallery_image(filename: str):
    """Serve gallery images."""
    gallery_dir = _get_gallery_dir()
    filepath = os.path.join(gallery_dir, filename)
    if not os.path.isfile(filepath):
        raise HTTPException(404, "Image not found")
    return FileResponse(filepath)

