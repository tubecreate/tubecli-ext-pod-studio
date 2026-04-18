"""
Grok Video Engine — Uses TubeCLI Browser Extension's Playwright
to generate videos from Grok via an existing browser profile (no separate Playwright install needed).

Calls: node grok_video.js --profile <name> --shots-file <path>
Node.js script lives next to this file in /engines/grok_video.js
It uses node_modules from the browser extension (playwright-with-fingerprints).
"""
import os
import sys
import json
import asyncio
import subprocess
import logging
from pathlib import Path

logger = logging.getLogger("ContentStudio.GrokVideoEngine")

# Path to browser extension node_modules
BROWSER_EXT_DIR = Path(__file__).parents[4] / "tubecli" / "extensions" / "browser"
GROK_JS_SCRIPT = Path(__file__).parent / "grok_video.js"


def get_output_dir() -> str:
    try:
        from tubecli.config import DATA_DIR
        out_dir = os.path.join(str(DATA_DIR), "content_studio", "grok_videos")
    except Exception:
        out_dir = str(Path(__file__).parent.parent / "outputs" / "grok_videos")
    os.makedirs(out_dir, exist_ok=True)
    return out_dir


def get_profiles_dir() -> str:
    try:
        from tubecli.config import DATA_DIR
        return os.path.join(str(DATA_DIR), "browser_profiles")
    except Exception:
        return str(BROWSER_EXT_DIR.parent.parent.parent / "data" / "browser_profiles")


async def generate_video(
    prompt: str,
    output_filename: str,
    profile_name: str,
    headless: bool = False,
    timeout: int = 240,
) -> dict:
    """
    Generate one video via Grok using a TubeCLI browser profile.
    """
    out_dir = get_output_dir()
    if not output_filename.endswith(('.mp4', '.webm')):
        output_filename += ".mp4"
    out_path = os.path.join(out_dir, output_filename)

    if not GROK_JS_SCRIPT.exists():
        return {"status": "error", "message": f"grok_video.js not found at {GROK_JS_SCRIPT}"}

    profiles_dir = get_profiles_dir()

    cmd = [
        "node",
        str(GROK_JS_SCRIPT),
        "--profile", profile_name,
        "--prompt", prompt,
        "--output", out_path,
        "--profiles-dir", profiles_dir,
        "--timeout", str(timeout),
    ]
    if headless:
        cmd.append("--headless")

    env = os.environ.copy()
    node_path = str(BROWSER_EXT_DIR / "node_modules")
    env["NODE_PATH"] = node_path

    logger.info(f"Running: {' '.join(cmd[:6])}...")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(BROWSER_EXT_DIR),
            env=env,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(),
            timeout=timeout + 30
        )

        stdout_text = stdout.decode("utf-8", errors="replace").strip()
        stderr_text = stderr.decode("utf-8", errors="replace").strip()

        if stderr_text:
            logger.debug(f"[grok_video.js stderr] {stderr_text[-500:]}")

        if stdout_text:
            for line in reversed(stdout_text.splitlines()):
                line = line.strip()
                if line.startswith("{"):
                    try:
                        result = json.loads(line)
                        return result
                    except json.JSONDecodeError:
                        pass

        if proc.returncode != 0:
            return {"status": "error", "message": f"Script exited with code {proc.returncode}. Check logs."}

        if os.path.exists(out_path):
            return {"status": "success", "path": out_path}

        return {"status": "error", "message": "Script finished but no output found"}

    except asyncio.TimeoutError:
        return {"status": "error", "message": f"Timeout after {timeout}s"}
    except FileNotFoundError:
        return {"status": "error", "message": "node not found. Please install Node.js."}
    except Exception as e:
        logger.error(f"Engine error: {e}")
        return {"status": "error", "message": str(e)}


async def batch_generate(
    shots: list,
    profile_name: str,
    episode_id: int,
    headless: bool = False,
    overwrite: bool = False,
    progress_callback=None,
) -> list:
    """
    Generate videos for a batch of storyboard shots.
    """
    # Pending condition uses image_prompt but outputs to video
    pending = [s for s in shots if s.get("image_prompt", "").strip()]
    if not overwrite:
        pending = [s for s in pending if not s.get("composed_video", "").strip()]

    total = len(pending)
    if total == 0:
        return []

    logger.info(f"Batch gen videos: {total} shots using profile '{profile_name}'")
    out_dir = get_output_dir()
    os.makedirs(out_dir, exist_ok=True)

    tasks_data = []
    for shot in pending:
        shot_num = shot.get("storyboard_number", shot["id"])
        prompt = shot.get("image_prompt", "").strip()

        if "[IMAGE PROMPT]" in prompt:
            lines = prompt.split('\n')
            p = []
            capture = False
            for line in lines:
                if line.startswith("[IMAGE PROMPT]"):
                    capture = True
                    continue
                elif line.startswith("[") and line.endswith("]"):
                    capture = False
                if capture:
                    p.append(line.strip())
            prompt = " ".join(p).strip()
            if not prompt:
                prompt = shot.get("image_prompt", "").strip()

        filename = f"ep{episode_id}_shot{shot_num:03d}.mp4"
        out_path = os.path.join(out_dir, filename)
        tasks_data.append({"id": shot["id"], "prompt": prompt, "output": out_path})

    import tempfile
    with tempfile.NamedTemporaryFile("w+", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(tasks_data, f)
        temp_file = f.name

    profiles_dir = get_profiles_dir()
    node_path = str(BROWSER_EXT_DIR / "node_modules")
    
    cmd = [
        "node",
        str(GROK_JS_SCRIPT),
        "--profile", profile_name,
        "--shots-file", temp_file,
        "--profiles-dir", profiles_dir,
        "--timeout", "240"
    ]
    if headless:
        cmd.append("--headless")

    env = os.environ.copy()
    env["NODE_PATH"] = node_path

    results = []
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(BROWSER_EXT_DIR),
            env=env,
        )

        completed_count = 0
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            line_str = line.decode("utf-8", errors="replace").strip()
            if line_str.startswith("{"):
                try:
                    res = json.loads(line_str)
                    if "status" in res and "shot_id" in res:
                        if res["status"] == "generating":
                            # Real-time generating progress (percent update)
                            if progress_callback:
                                try:
                                    await progress_callback(
                                        completed_count, total, res["shot_id"],
                                        "generating", None, res.get("percent", 0)
                                    )
                                except Exception:
                                    pass
                        elif res["status"] in ("success", "error"):
                            completed_count += 1
                            res["shot_number"] = next((s["storyboard_number"] for s in pending if s["id"] == res["shot_id"]), res["shot_id"])
                            results.append(res)
                            if progress_callback:
                                try:
                                    await progress_callback(completed_count, total, res["shot_id"], res["status"], res.get("path"))
                                except Exception:
                                    pass
                    elif "status" in res and "message" in res:
                        logger.error(f"Global Node error: {res}")
                except json.JSONDecodeError:
                    pass

        await proc.wait()
        if proc.returncode != 0:
            stderr_text = (await proc.stderr.read()).decode("utf-8", errors="replace").strip()
            logger.error(f"grok_video.js exited with {proc.returncode}. stderr: {stderr_text[-500:]}")

    except Exception as e:
        logger.error(f"Batch execution failed: {e}")
    finally:
        try:
            os.remove(temp_file)
        except OSError:
            pass

    return results
