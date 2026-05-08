"""
Grok Image Engine — Uses TubeCLI Browser Extension's Playwright + profile system
to generate images from Grok via an existing browser profile (no separate Playwright install needed).

Calls: node grok_image.js --profile <name> --prompt <text> --output <path>
Node.js script lives next to this file in /engines/grok_image.js
It uses node_modules from the browser extension (playwright-with-fingerprints).
"""
import os
import sys
import json
import asyncio
import subprocess
import logging
from pathlib import Path

logger = logging.getLogger("PodStudio.GrokImageEngine")

# Path to browser extension node_modules
BROWSER_EXT_DIR = Path(__file__).parents[4] / "tubecli" / "extensions" / "browser"
GROK_JS_SCRIPT = Path(__file__).parent / "grok_image.js"


def get_output_dir() -> str:
    try:
        from tubecli.config import DATA_DIR
        out_dir = os.path.join(str(DATA_DIR), "pod_studio", "grok_images")
    except Exception:
        out_dir = str(Path(__file__).parent.parent / "outputs" / "grok_images")
    os.makedirs(out_dir, exist_ok=True)
    return out_dir


def get_profiles_dir() -> str:
    try:
        from tubecli.config import DATA_DIR
        return os.path.join(str(DATA_DIR), "browser_profiles")
    except Exception:
        return str(BROWSER_EXT_DIR.parent.parent.parent / "data" / "browser_profiles")


async def generate_image(
    prompt: str,
    output_filename: str,
    profile_name: str,
    headless: bool = False,
    timeout: int = 90,
) -> dict:
    """
    Generate one image via Grok using a TubeCLI browser profile.

    Args:
        prompt: The image prompt text
        output_filename: Filename to save (without directory)
        profile_name: Name of the TubeCLI browser profile (e.g. 'browser11')
        headless: Whether to run invisibly
        timeout: Max seconds to wait

    Returns:
        {"status": "success", "path": "..."} or {"status": "error", "message": "..."}
    """
    out_dir = get_output_dir()
    if not output_filename.endswith(('.jpg', '.jpeg', '.png', '.webp')):
        output_filename += ".jpg"
    out_path = os.path.join(out_dir, output_filename)

    if not GROK_JS_SCRIPT.exists():
        return {"status": "error", "message": f"grok_image.js not found at {GROK_JS_SCRIPT}"}

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
    # Point Node to use browser extension's node_modules
    node_path = str(BROWSER_EXT_DIR / "node_modules")
    env["NODE_PATH"] = node_path

    logger.info(f"Running: {' '.join(cmd[:6])}...")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(BROWSER_EXT_DIR),  # Run from browser ext dir so imports resolve
            env=env,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(),
            timeout=timeout + 30
        )

        stdout_text = stdout.decode("utf-8", errors="replace").strip()
        stderr_text = stderr.decode("utf-8", errors="replace").strip()

        if stderr_text:
            logger.debug(f"[grok_image.js stderr] {stderr_text[-500:]}")

        # stdout should be JSON from console.log
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

        # If file exists, assume success
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
    cancel_event: asyncio.Event = None,
    process_registry: list = None,
) -> list:
    """
    Generate images for a batch of storyboard shots.

    Args:
        shots: List of storyboard dicts (need 'id', 'storyboard_number', 'image_prompt')
        profile_name: TubeCLI browser profile name
        episode_id: For output file naming
        headless: Run browser headless
        overwrite: Overwrite existing images
        progress_callback: async callable(done, total, shot_id, status)

    Returns:
        List of result dicts
    """
    pending = [s for s in shots if s.get("image_prompt", "").strip()]
    if not overwrite:
        pending = [s for s in pending if not s.get("composed_image", "").strip()]

    total = len(pending)
    if total == 0:
        return []

    logger.info(f"Batch gen: {total} shots using profile '{profile_name}'")
    out_dir = get_output_dir()
    os.makedirs(out_dir, exist_ok=True)

    tasks_data = []
    for shot in pending:
        shot_num = shot.get("storyboard_number", shot["id"])
        prompt = shot.get("image_prompt", "").strip()

        # Isolate the [IMAGE PROMPT] portion if it's auto-generated from outline
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
            # If empty after trying to parse, fallback to original
            if not prompt:
                prompt = shot.get("image_prompt", "").strip()

        filename = f"ep{episode_id}_shot{shot_num:03d}.jpg"
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
        "--timeout", "120"
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

        # Register process so cancel endpoint can kill it
        if process_registry is not None:
            process_registry.append(proc)

        completed_count = 0
        while True:
            # Check cancel before reading
            if cancel_event and cancel_event.is_set():
                logger.info(f"Cancel event set — killing image gen subprocess")
                try:
                    proc.kill()
                except Exception:
                    pass
                break

            try:
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=5.0)
            except asyncio.TimeoutError:
                continue  # no output yet, loop back and check cancel again
            if not line:
                break
            line_str = line.decode("utf-8", errors="replace").strip()
            if line_str.startswith("{"):
                try:
                    res = json.loads(line_str)
                    if "status" in res and ("shot_id" in res or "message" in res):
                        if "shot_id" in res:
                            completed_count += 1
                            res["shot_number"] = next((s["storyboard_number"] for s in pending if s["id"] == res["shot_id"]), res["shot_id"])
                            results.append(res)
                            if progress_callback:
                                try:
                                    await progress_callback(completed_count, total, res["shot_id"], res["status"], res.get("path"))
                                except Exception:
                                    pass
                        else:
                            # Global error (e.g. RATE_LIMIT_REACHED, crash)
                            logger.error(f"Global Node error: {res}")
                            results.append(res)  # propagate to caller
                except json.JSONDecodeError:
                    pass

        await proc.wait()
        if proc.returncode != 0:
            stderr_text = (await proc.stderr.read()).decode("utf-8", errors="replace").strip()
            logger.error(f"grok_image.js exited with {proc.returncode}. stderr: {stderr_text[-500:]}")

    except Exception as e:
        logger.error(f"Batch execution failed: {e}")
    finally:
        try:
            os.remove(temp_file)
        except OSError:
            pass

    return results
