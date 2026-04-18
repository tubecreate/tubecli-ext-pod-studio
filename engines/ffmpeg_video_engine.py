import asyncio
import os
import subprocess
import tempfile
from loguru import logger

try:
    from tubecli.config import DATA_DIR
    OUT_DIR = os.path.join(str(DATA_DIR), "content_studio", "exports")
except Exception:
    ext_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    OUT_DIR = os.path.join(ext_dir, "outputs", "exports")

os.makedirs(OUT_DIR, exist_ok=True)

async def build_ffmpeg_video(episode, shots, progress_callback=None):
    """
    Assemble the MP4 shots with the global episode TTS audio.
    If global TTS audio doesn't exist, we just concat videos.
    """
    if not shots:
        raise ValueError("No shots to assemble.")
        
    # Gather valid videos
    valid_shots = []
    for s in shots:
        path = s.get("composed_video")
        if path and os.path.exists(path):
            valid_shots.append(path)
            
    if not valid_shots:
        raise ValueError("None of the shots have valid composed videos generated yet.")

    export_path = os.path.join(OUT_DIR, f"episode_{episode['id']}_pipeline_export.mp4")
    
    # Create temp concat list file
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt", encoding='utf-8') as f:
        list_file = f.name
        for p in valid_shots:
            # Escape single quotes and backslashes for FFmpeg concat format
            p_escaped = str(p).replace("\\", "/").replace("'", "'\\''")
            f.write(f"file '{p_escaped}'\n")
            
    audio_path = episode.get("audio_url")
    is_absolute_audio = audio_path and os.path.exists(audio_path)
    # If audio is served via API i.e. /api/v1/..., we might need to map it back to local disk.
    # We will assume if it's absolute path or we can fetch it, but usually the app serves it directly.
    # In tubecli content_studio, 'audio_url' usually stores the system absolute path if it was generated locally or a URL.
    # For now, let's keep it simple: concat video, then optionally merge audio.

    if progress_callback:
        await progress_callback("Concatenating videos...", 10)
        
    concat_out = os.path.join(OUT_DIR, f"temp_concat_{episode['id']}.mp4")
    
    # 1. Concat videos (assuming they are all same resolution and framerate from Grok)
    cmd_concat = [
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_file,
        "-c", "copy", concat_out
    ]
    
    proc1 = await asyncio.create_subprocess_exec(
        *cmd_concat,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    stdout, stderr = await proc1.communicate()
    
    if proc1.returncode != 0:
        logger.error(f"FFmpeg concat error: {stderr.decode()}")
        os.remove(list_file)
        raise RuntimeError("FFmpeg concat failed.")
        
    os.remove(list_file)
    
    if progress_callback:
        await progress_callback("Merging audio...", 50)
        
    if not audio_path or not os.path.exists(audio_path):
        # Fallback if audio URL is not local
        # For simplicity, move concat_out to export_path
        import shutil
        shutil.move(concat_out, export_path)
    else:
        # 2. Merge audio
        cmd_merge = [
            "ffmpeg", "-y",
            "-i", concat_out,
            "-i", audio_path,
            "-c:v", "copy",
            "-c:a", "aac",
            "-shortest", 
            export_path
        ]
        
        proc2 = await asyncio.create_subprocess_exec(
            *cmd_merge,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout2, stderr2 = await proc2.communicate()
        
        if proc2.returncode != 0:
            logger.error(f"FFmpeg merge error: {stderr2.decode()}")
            os.remove(concat_out)
            raise RuntimeError("FFmpeg audio merge failed.")
            
        os.remove(concat_out)

    if progress_callback:
        await progress_callback("Export complete.", 100, export_path)
        
    return export_path
