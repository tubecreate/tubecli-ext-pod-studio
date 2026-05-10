"""
ChatGPT Image Engine — Batch generate images using ChatGPT (browser automation).
Same interface as grok_image_engine.py for seamless integration with Pod Studio.
"""
import asyncio
import json
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)


def _get_ref_dir():
    """Get the reference images directory (must match studio_routes.py _get_ref_dir)."""
    try:
        from tubecli.config import DATA_DIR
        ref_dir = os.path.join(str(DATA_DIR), "pod_studio", "references")
    except Exception:
        ref_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "data", "pod_studio", "references")
    os.makedirs(ref_dir, exist_ok=True)
    return ref_dir



async def batch_generate(
    shots: list,
    profile_name: str,
    episode_id: int,
    headless: bool = False,
    overwrite: bool = False,
    progress_callback=None,
    cancel_event=None,
    process_list=None,
):
    """
    Generate images for a batch of storyboard shots using ChatGPT browser automation.
    
    Args:
        shots: List of shot dicts (each must have 'id', 'image_prompt')
        profile_name: TubeCLI browser profile name
        episode_id: Episode ID for file naming
        headless: Run browser headless
        overwrite: Regenerate even if composed_image exists
        progress_callback: async fn(done, total, shot_id, status, path=None)
        cancel_event: asyncio.Event for cancellation
        process_list: List to track subprocess for cancellation
    
    Returns:
        List of result dicts: [{"status": "success"|"error", "shot_id": ..., "path": ...}]
    """
    ext_dir = os.path.dirname(os.path.abspath(__file__))
    script_path = os.path.join(ext_dir, "chatgpt_image.js")

    # Resolve paths
    top_dir = Path(ext_dir).parents[3]
    browser_ext_dir = str(top_dir / "tubecli" / "extensions" / "browser")
    try:
        from tubecli.config import DATA_DIR
        profiles_dir = os.path.join(str(DATA_DIR), "browser_profiles")
    except Exception:
        profiles_dir = str(top_dir / "data" / "browser_profiles")

    ref_dir = _get_ref_dir()

    # Filter shots
    pending = [s for s in shots if s.get("image_prompt", "").strip()]
    if not overwrite:
        pending = [s for s in pending if not s.get("composed_image", "").strip()]

    if not pending:
        logger.info("ChatGPT Image: No pending shots to generate")
        return []

    total = len(pending)
    logger.info(f"ChatGPT Image: Generating {total} images with profile '{profile_name}'")

    # Build jobs file
    batch_jobs = []
    job_shot_map = {}
    for shot in pending:
        sid = shot["id"]
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        out_path = os.path.join(ref_dir, f"screen_{sid}_{ts}.png")
        job_id = f"screen_{sid}"
        job_entry = {
            "id": job_id,
            "prompt": shot.get("image_prompt", "").strip(),
            "output": out_path,
        }
        # Pass reference images to the engine if available
        ref_imgs = shot.get("ref_images", [])
        if ref_imgs:
            job_entry["ref_images"] = ref_imgs
        batch_jobs.append(job_entry)
        job_shot_map[job_id] = {"shot": shot, "output": out_path}

    jobs_file = os.path.join(ref_dir, f"_chatgpt_batch_{episode_id}.json")
    with open(jobs_file, "w", encoding="utf-8") as f:
        json.dump(batch_jobs, f, ensure_ascii=False)

    # Build command
    cmd = [
        "node", script_path,
        "--profile", profile_name,
        "--jobs", jobs_file,
        "--profiles-dir", profiles_dir,
        "--timeout", "300",
    ]
    if headless:
        cmd.extend(["--headless", "true"])

    env = os.environ.copy()
    env["NODE_PATH"] = os.path.join(browser_ext_dir, "node_modules")

    results = []
    done_count = 0

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=browser_ext_dir,
            env=env,
        )

        if process_list is not None:
            process_list.append(proc)

        while True:
            if cancel_event and cancel_event.is_set():
                proc.terminate()
                break

            try:
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=360)
            except asyncio.TimeoutError:
                continue

            if not line:
                break

            line_str = line.decode("utf-8", errors="replace").strip()
            if not line_str.startswith("{"):
                continue

            try:
                res = json.loads(line_str)
            except json.JSONDecodeError:
                continue

            job_id = res.get("id", "")
            status = res.get("status", "")

            if status == "success" and job_id in job_shot_map:
                info = job_shot_map[job_id]
                saved_path = res.get("path", info["output"])
                done_count += 1
                result = {"status": "success", "shot_id": info["shot"]["id"], "path": saved_path}
                results.append(result)
                logger.info(f"  ✓ ChatGPT Image: shot {info['shot']['id']} saved")
                if progress_callback:
                    await progress_callback(done_count, total, info["shot"]["id"], "success", saved_path)

            elif status == "error":
                if res.get("message") == "RATE_LIMIT":
                    logger.error("ChatGPT rate limit reached!")
                    results.append({"status": "error", "shot_id": None, "message": "RATE_LIMIT_REACHED"})
                    break
                elif job_id in job_shot_map:
                    done_count += 1
                    info = job_shot_map[job_id]
                    results.append({"status": "error", "shot_id": info["shot"]["id"], "message": res.get("message", "Unknown error")})
                    if progress_callback:
                        await progress_callback(done_count, total, info["shot"]["id"], "error")

            elif status == "batch_done":
                logger.info(f"ChatGPT Image batch done: {res.get('success', 0)}/{res.get('total', 0)} success")

        await proc.wait()

    except Exception as e:
        logger.error(f"ChatGPT Image engine error: {e}")
        import traceback
        logger.error(traceback.format_exc())

    # Cleanup
    try:
        os.remove(jobs_file)
    except Exception:
        pass

    return results
