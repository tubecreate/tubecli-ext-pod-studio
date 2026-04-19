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
    profile_names: list,
    episode_id: int,
    headless: bool = False,
    overwrite: bool = False,
    progress_callback=None,
) -> list:
    """
    Generate videos for a batch of storyboard shots using multiple browser profiles concurrently.
    """
    pending = [s for s in shots if s.get("image_prompt", "").strip()]
    if not overwrite:
        pending = [s for s in pending if not s.get("video_url", "").strip()]

    total = len(pending)
    if total == 0:
        return []

    if not isinstance(profile_names, list):
        profile_names = [profile_names] if profile_names else ["Default"]

    num_profiles = len(profile_names)
    logger.info(f"Batch gen videos: {total} shots distributed across {num_profiles} profiles: {profile_names}")
    
    out_dir = get_output_dir()
    os.makedirs(out_dir, exist_ok=True)

    # Distribute the pending shots among profiles (Round-Robin)
    profile_workloads = {p: [] for p in profile_names}
    for i, shot in enumerate(pending):
        profile_workloads[profile_names[i % num_profiles]].append(shot)

    global_completed_count = 0
    global_results = []
    
    async def process_batch_for_profile(profile, p_shots):
        nonlocal global_completed_count
        if not p_shots:
            return
            
        tasks_data = []
        for shot in p_shots:
            shot_num = shot.get("storyboard_number", shot["id"])
            raw_prompt = shot.get("image_prompt", "").strip()
            prompt = ""

            # Priority 1: Extract [VIDEO PROMPT] section (dedicated video description)
            if "[VIDEO PROMPT]" in raw_prompt:
                lines = raw_prompt.split('\n')
                p = []
                capture = False
                for line in lines:
                    if line.strip().startswith("[VIDEO PROMPT]"):
                        capture = True
                        continue
                    elif line.strip().startswith("[") and line.strip().endswith("]"):
                        if capture:
                            capture = False
                    if capture:
                        p.append(line.strip())
                prompt = " ".join(p).strip()

            # Priority 2: Fall back to [IMAGE PROMPT] section
            if not prompt and "[IMAGE PROMPT]" in raw_prompt:
                lines = raw_prompt.split('\n')
                p = []
                capture = False
                for line in lines:
                    if line.strip().startswith("[IMAGE PROMPT]"):
                        capture = True
                        continue
                    elif line.strip().startswith("[") and line.strip().endswith("]"):
                        if capture:
                            capture = False
                    if capture:
                        p.append(line.strip())
                prompt = " ".join(p).strip()

            # Priority 3: Use full raw prompt as-is
            if not prompt:
                prompt = raw_prompt

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
            "--profile", profile,
            "--shots-file", temp_file,
            "--profiles-dir", profiles_dir,
            "--timeout", "240"
        ]
        if headless:
            cmd.append("--headless")

        env = os.environ.copy()
        env["NODE_PATH"] = node_path

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(BROWSER_EXT_DIR),
                env=env,
            )

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
                                if progress_callback:
                                    try:
                                        await progress_callback(
                                            global_completed_count, total, res["shot_id"],
                                            "generating", None, res.get("percent", 0)
                                        )
                                    except Exception:
                                        pass
                            elif res["status"] in ("success", "error"):
                                global_completed_count += 1
                                res["shot_number"] = next((s["storyboard_number"] for s in pending if s["id"] == res["shot_id"]), res["shot_id"])
                                global_results.append(res)
                                if progress_callback:
                                    try:
                                        await progress_callback(
                                            global_completed_count, total, res["shot_id"], 
                                            res["status"], res.get("path")
                                        )
                                    except Exception:
                                        pass
                        elif "status" in res and "message" in res:
                            logger.error(f"Global Node error from {profile}: {res}")
                    except json.JSONDecodeError:
                        pass

            await proc.wait()
            if proc.returncode != 0:
                stderr_text = (await proc.stderr.read()).decode("utf-8", errors="replace").strip()
                logger.error(f"grok_video.js ({profile}) exited with {proc.returncode}. stderr: {stderr_text[-500:]}")

        except Exception as e:
            logger.error(f"Batch execution failed for {profile}: {e}")
        finally:
            try:
                os.remove(temp_file)
            except OSError:
                pass

    tasks = [process_batch_for_profile(profile, p_shots) for profile, p_shots in profile_workloads.items() if p_shots]
    await asyncio.gather(*tasks)

    return global_results
