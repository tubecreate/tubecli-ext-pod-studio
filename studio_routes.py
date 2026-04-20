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

# Ensure extension dir is in path
_ext_dir = os.path.dirname(os.path.abspath(__file__))
if _ext_dir not in sys.path:
    sys.path.insert(0, _ext_dir)


def _db():
    from db.database import Database
    return Database.get_instance()


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
    style_desc = style_map.get(visual_style.lower().strip(), style_map["realistic"])
    
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


# ── Drama CRUD ──────────────────────────────────────────────

@router.get("/api/v1/studio/dramas")
async def list_dramas():
    return {"items": _db().list_dramas()}


@router.post("/api/v1/studio/dramas")
async def create_drama(request: Request):
    data = await request.json()
    if not data.get("title"):
        raise HTTPException(400, "Title is required")
    return _db().create_drama(data)


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

    from agents.series_planner import SeriesPlannerAgent
    agent = SeriesPlannerAgent()
    if episode_count <= 0:
        char_count = len(premise)
        min_eps = max(3, char_count // 5000)
        target_eps_str = f"Auto (The premise is {char_count} characters long. You MUST break it down into at least {min_eps} episodes. DO NOT summarize it mathematically into 1 episode!)"
    else:
        target_eps_str = str(episode_count)

    user_msg = f"Premise Length: {len(premise)} characters\nPremise: {premise}\nTarget Episodes: {target_eps_str}\nLanguage: {language}"

    full_response = []
    try:
        async for chunk in agent.chat_stream(user_msg, language, base_url, api_key, model, agent_temp, {}):
            full_response.append(chunk)
    except Exception as e:
        import traceback
        err_msg = f"AI Error: {str(e)}\n{traceback.format_exc()}"
        print(err_msg)  # also print to console
        raise HTTPException(500, f"AI Error: {str(e)}")

    full_text = "".join(full_response)

    # Parse JSON
    try:
        cleaned = full_text.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        cleaned = cleaned.strip()
        if cleaned.startswith("json"):
            cleaned = cleaned[4:].strip()
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        import re
        match = re.search(r'\{[\s\S]*\}', full_text)
        if match:
            try:
                parsed = json.loads(match.group())
            except Exception:
                raise HTTPException(500, f"Failed to parse series outline JSON. AI Output:\n{full_text[:400]}")
        else:
            raise HTTPException(500, f"AI returned invalid format. AI Output:\n{full_text[:400]}")

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
            context = {"visual_style": drama.get("style", "realistic") if drama else "realistic"}
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
                import re
                match = re.search(r'\{[\s\S]*\}', extract_json_str)
                if match:
                    extracted = json.loads(match.group())
                    _db().save_characters_dedup(drama_id, ep_id, extracted.get("characters", []))
                    _db().save_scenes_dedup(drama_id, ep_id, extracted.get("scenes", []))
            except Exception as e:
                logger.error(f"Autopilot Extractor error: {e}")

            # 4b. Flow: Generate AI reference images for characters without images
            # Runs every episode — the filter `chars_needing_images` ensures only NEW chars get generated
            meta["autopilot_status"] = f"running {idx+1}/{total} - generating character refs"
            _db().update_drama(drama_id, {"metadata": json.dumps(meta)})
            
            try:
                # Get browser profile and aspect ratio from drama metadata
                char_profile = meta.get("browser_profile_name") or meta.get("browser_profile") or "Default"
                char_aspect_ratio = meta.get("aspect_ratio", "16:9")
                all_chars = _db().list_characters(drama_id)
                chars_needing_images = [c for c in all_chars if c.get("appearance", "").strip() and not c.get("image_url", "").strip()]
                
                logger.info(f"Autopilot char gen: ep {ep_num}, total chars={len(all_chars)}, needing images={len(chars_needing_images)}, profile={char_profile}, aspect_ratio={char_aspect_ratio}")
                
                if chars_needing_images:
                    logger.info(f"Autopilot: generating ref images for {len(chars_needing_images)} NEW characters")
                    
                    from pathlib import Path
                    grok_script = os.path.join(_ext_dir, "engines", "grok_char_image.js")
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
                            "node", grok_script,
                            "--profile", char_profile,
                            "--prompt", char_prompt,
                            "--output", out_path,
                            "--profiles-dir", profiles_dir,
                            "--timeout", "120"
                        ]
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
                        _db().save_storyboards_bulk(drama_id, ep_id, parsed_array)
            except Exception as e:
                logger.error(f"Autopilot Storyboard error: {e}")

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
    """Generate a character reference image using Grok Imagine."""
    data = await request.json()
    profile_name = data.get("profile_name", "")
    
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
    _gen_tasks[task_id] = {"status": "running", "char_id": char_id, "name": name}
    
    async def _run_generation():
        import asyncio
        try:
            grok_script = os.path.join(_ext_dir, "engines", "grok_char_image.js")
            from pathlib import Path
            # _ext_dir = .../tubecli/data/extensions_external/content_studio
            # parents: content_studio → extensions_external → data → tubecli(top)
            top_dir = Path(_ext_dir).parents[2]  # .../tubecli
            browser_ext_dir = str(top_dir / "tubecli" / "extensions" / "browser")
            
            try:
                from tubecli.config import DATA_DIR
                profiles_dir = os.path.join(str(DATA_DIR), "browser_profiles")
            except:
                profiles_dir = str(top_dir / "data" / "browser_profiles")
            
            cmd = [
                "node", grok_script,
                "--profile", profile_name,
                "--prompt", prompt,
                "--output", output_path,
                "--profiles-dir", profiles_dir,
                "--timeout", "120"
            ]
            
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
            
            if stdout_text:
                for line in reversed(stdout_text.splitlines()):
                    if line.strip().startswith("{"):
                        try:
                            result = json.loads(line.strip())
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
                        except:
                            pass
            
            _gen_tasks[task_id] = {"status": "error", "message": "Generation failed"}
        except Exception as e:
            logger.error(f"Character image gen error: {e}")
            _gen_tasks[task_id] = {"status": "error", "message": str(e)}
    
    background_tasks.add_task(_run_generation)
    return {"status": "started", "task_id": task_id}


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
    return {"items": _db().list_storyboards(episode_id)}


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
        context["visual_style"] = drama.get("style", "realistic") if drama else "realistic"
        context["characters"] = [{"id": c["id"], "name": c["name"], "role": c["role"], "appearance": c.get("appearance", ""), "personality": c.get("personality", "")} for c in chars]
        context["scenes"] = [{"id": s["id"], "location": s["location"], "time": s["time"], "description": s.get("description", "")} for s in scenes]

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
async def extract_characters_scenes(episode_id: int):
    """AI extracts characters and scenes from script, saves to DB with dedup.
    Returns SSE stream with progress + final extracted data."""
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
    context = {
        "visual_style": drama.get("style", "realistic") if drama else "realistic",
        "existing_characters": [{"name": c["name"], "role": c["role"]} for c in existing_chars],
        "existing_scenes": [{"location": s["location"], "time": s["time"]} for s in existing_scenes],
    }

    agent = _get_agent("extractor")

    async def generate():
        yield f"data: {json.dumps({'event': 'status', 'message': 'Analyzing script...'})}\n\n"

        # Collect full AI response
        full_response = []
        async for chunk in agent.chat_stream(
            f"Extract ALL characters and scenes from this script. Do NOT skip any named character even if minor. If character/scene already exists in context, skip it.\n\nScript:\n{script[:15000]}",
            language, base_url, api_key, model, agent_temp, context
        ):
            full_response.append(chunk)
            yield f"data: {json.dumps({'event': 'progress', 'content': chunk})}\n\n"

        full_text = "".join(full_response)

        # Parse JSON from AI response
        try:
            # Clean: strip markdown fences if present
            cleaned = full_text.strip()
            if cleaned.startswith("```"):
                cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            cleaned = cleaned.strip()
            if cleaned.startswith("json"):
                cleaned = cleaned[4:].strip()

            extracted = json.loads(cleaned)
        except json.JSONDecodeError:
            # Try to find JSON in the response
            import re
            match = re.search(r'\{[\s\S]*\}', full_text)
            if match:
                try:
                    extracted = json.loads(match.group())
                except json.JSONDecodeError:
                    yield f"data: {json.dumps({'event': 'error', 'message': 'AI did not return valid JSON. Please try again.'})}\n\n"
                    yield "data: [DONE]\n\n"
                    return
            else:
                yield f"data: {json.dumps({'event': 'error', 'message': 'Could not parse extraction results.'})}\n\n"
                yield "data: [DONE]\n\n"
                return

        # Save to DB with deduplication
        characters = extracted.get("characters", [])
        scenes = extracted.get("scenes", [])

        saved_chars = []
        saved_scenes = []

        if characters:
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
                profile_name_img = drama_meta_img.get("browser_profile_name") or drama_meta_img.get("browser_profile") or ""
            except:
                profile_name_img = ""

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
        "shot_density": drama_metadata.get("shot_density", "normal"),
        "camera_angle": drama_metadata.get("camera_angle", "Default"),
        "ethnicity": drama_metadata.get("ethnicity", "Default"),
        "prompt_focus": drama_metadata.get("prompt_focus", "Default"),
        "narration_source": drama_metadata.get("narration_source", "prose"),
        "characters": [{"id": c["id"], "name": c["name"], "role": c["role"], "appearance": c["appearance"], "personality": c["personality"]} for c in characters],
        "scenes": [{"id": s["id"], "location": s["location"], "time": s["time"], "description": s["description"]} for s in scenes],
    }
    # Provide raw prose content for narration extraction
    raw_content = ep.get("content") or ""
    if drama_metadata.get("narration_source") == "prose" and raw_content.strip():
        context["raw_prose_content"] = raw_content[:12000]

    # Build name-to-id map for character resolution
    char_name_map = {c["name"].lower().strip(): c["id"] for c in characters}

    agent = _get_agent("storyboard_breaker")

    async def generate():
        try:
            import re
            parts = re.split(r'(?m)(?=^## S\d+)', script)
            parts = [p.strip() for p in parts if p.strip()]
            
            has_tags = any(p.startswith("## S") for p in parts)
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
                    if part.startswith("## S"):
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
                scenes_in_chunk = chunk_text.count("## S") if has_tags else 1
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
                scene_headings = _re_sb.findall(r'^## S\d+[^\n]*', chunk_text, _re_sb.MULTILINE)
                scene_count_in_chunk = len(scene_headings) if scene_headings else 1
                headings_list = '\n'.join(scene_headings) if scene_headings else '(no scene headings found)'
                
                prompt = (
                    f"Break this portion of the screenplay into storyboard shots.\n"
                    f"CRITICAL: This chunk contains EXACTLY {scene_count_in_chunk} scenes. "
                    f"You MUST output EXACTLY {scene_count_in_chunk} shot objects, one per scene heading.\n"
                    f"Scene headings in this chunk:\n{headings_list}\n\n"
                    f"Script:\n\n{chunk_text}"
                )
                if append_mode and existing_shots and is_first:
                    last_shot = existing_shots[-1]
                    prompt += f"\n\nIMPORTANT: You have already generated up to shot number {last_shot['storyboard_number']}.\nYOU MUST RESUME GENERATION EXACTLY FROM SHOT NUMBER {last_shot['storyboard_number'] + 1}."

                full_response = []
                # We yield a new line to separate JSON blocks in the UI stream
                yield f"data: {json.dumps({'event': 'progress', 'content': '\n\n---\n\n'})}\n\n"
            
                async for chunk in agent.chat_stream(
                    prompt,
                    language, base_url, api_key, model, agent_temp, context
                ):
                    full_response.append(chunk)
                    yield f"data: {json.dumps({'event': 'progress', 'content': chunk})}\n\n"

                full_text = "".join(full_response)
                cleaned = full_text.strip()
                if cleaned.startswith("```json"): cleaned = cleaned[7:]
                elif cleaned.startswith("```"): cleaned = cleaned[3:]
                cleaned = cleaned.strip()
                if cleaned.endswith("```"): cleaned = cleaned[:-3]
                cleaned = cleaned.strip()

                parsed = None
                try:
                    parsed = json.loads(cleaned)
                except json.JSONDecodeError:
                    pass
            
                if not parsed:
                    array_match = re.search(r'\[[\s\S]*\]', cleaned)
                    if array_match:
                        try:
                            parsed_array = json.loads(array_match.group())
                            if isinstance(parsed_array, list):
                                parsed = {"storyboards": parsed_array}
                        except Exception:
                            pass

                if not parsed:
                    idx = cleaned.find("[")
                    if idx != -1:
                        salvage_target = cleaned[idx:]
                        for i in range(len(salvage_target), 0, -1):
                            if salvage_target[i-1] in '}]':
                                candidate = salvage_target[:i]
                                if candidate.endswith('}'): candidate += ']'
                                try:
                                    parsed_array = json.loads(candidate)
                                    if isinstance(parsed_array, list) and len(parsed_array) > 0:
                                        parsed = {"storyboards": parsed_array}
                                        break
                                except Exception:
                                    continue

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

            yield f"data: {json.dumps({'event': 'status', 'message': f'Saving {len(all_shots)} shots...'})}\n\n"

            for shot in all_shots:
                names = shot.pop("character_names", [])
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
            )

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


@router.post("/api/v1/studio/episodes/{episode_id}/gen-videos")
async def start_gen_videos(episode_id: int, request: Request, background_tasks: BackgroundTasks):
    """Start Grok video generation for an episode's storyboard shots."""
    data = await request.json()
    profile_names = data.get("profile_names")
    if not profile_names:
        single_profile = data.get("profile_name", data.get("profile_path", ""))
        profile_names = [single_profile] if single_profile else []

    headless = data.get("headless", False)
    overwrite = data.get("overwrite", False)

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
    
    for shot in shots:
        char_ids = shot.get("character_ids", [])
        ref_images = []
        for cid in char_ids:
            char = all_chars.get(cid)
            if not char:
                continue
            img_url = char.get("image_url", "")
            if img_url and os.path.isfile(img_url):
                ref_images.append(img_url)
            else:
                try:
                    refs = json.loads(char.get("reference_images") or "[]")
                    for r in refs:
                        if r and os.path.isfile(r):
                            ref_images.append(r)
                            break
                except:
                    pass
        if ref_images:
            shot["ref_images"] = ref_images[:3]

    # Inject aspect ratio from drama metadata
    try:
        drama_meta = json.loads(db.get_drama(drama_id).get("metadata") or "{}")
        video_aspect_ratio = drama_meta.get("aspect_ratio", "16:9")
    except:
        video_aspect_ratio = "16:9"
    for shot in shots:
        shot["aspect_ratio"] = video_aspect_ratio

    import uuid
    task_id = str(uuid.uuid4())[:8]

    pending = [s for s in shots if s.get("image_prompt", "").strip()]
    if not overwrite:
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

    async def _runner():
        _video_tasks[task_id]["status"] = "running"
        try:
            import sys, os
            ext_dir = os.path.dirname(os.path.abspath(__file__))
            engines_dir = os.path.join(ext_dir, "engines")
            if engines_dir not in sys.path:
                sys.path.insert(0, engines_dir)
            from grok_video_engine import batch_generate

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

            results = await batch_generate(
                shots=shots,
                profile_names=profile_names,
                episode_id=episode_id,
                headless=headless,
                overwrite=overwrite,
                progress_callback=on_progress,
            )

            successful = [r for r in results if r.get("status") == "success"]
            if successful:
                _video_tasks[task_id]["status"] = "completed"
                _video_tasks[task_id]["done"] = _video_tasks[task_id]["total"]
            elif results:
                _video_tasks[task_id]["status"] = f"error: {len(results)} shots failed"
                _video_tasks[task_id]["done"] = len(successful)
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
    
    narration = shot.get("narration_text") or shot.get("dialogue") or shot.get("description") or ""
    narration = narration.strip()
    if not narration:
        raise HTTPException(400, "No narration text for this shot")
    
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

            export_path = await build_ffmpeg_video(
                episode=ep,
                shots=shots,
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
    """Serve a locally generated Grok video."""
    try:
        from tubecli.config import DATA_DIR
        out_dir = os.path.join(str(DATA_DIR), "content_studio", "grok_videos")
    except Exception:
        out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "outputs", "grok_videos")

    path = os.path.join(out_dir, filename)
    if os.path.exists(path):
        return FileResponse(path)
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
