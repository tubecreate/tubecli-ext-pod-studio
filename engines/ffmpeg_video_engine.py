import asyncio
import os
import subprocess
import tempfile
import logging
import json
logger = logging.getLogger("ffmpeg")

try:
    from tubecli.config import DATA_DIR
    OUT_DIR = os.path.join(str(DATA_DIR), "content_studio", "exports")
except Exception:
    ext_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    OUT_DIR = os.path.join(ext_dir, "outputs", "exports")

os.makedirs(OUT_DIR, exist_ok=True)


async def _get_duration(filepath):
    """Get media file duration in seconds using ffprobe."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", filepath,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        stdout, _ = await proc.communicate()
        data = json.loads(stdout.decode("utf-8", errors="replace"))
        return float(data.get("format", {}).get("duration", 0))
    except Exception:
        return 0


async def _loop_video_to_duration(video_path, target_duration, output_path):
    """Loop a video clip to match target duration using FFmpeg stream_loop."""
    cmd = [
        "ffmpeg", "-y",
        "-stream_loop", "-1",
        "-i", video_path,
        "-t", str(target_duration),
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-an",  # no audio in looped video
        output_path
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        logger.warning(f"Loop video error: {stderr.decode()[:200]}")
        return False
    return True

async def _image_to_video(image_path, target_duration, output_path):
    """Convert an image to a video of specified duration."""
    cmd = [
        "ffmpeg", "-y",
        "-loop", "1",
        "-i", image_path,
        "-t", str(target_duration),
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-vf", "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080",
        "-pix_fmt", "yuv420p",
        "-an",
        output_path
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        logger.warning(f"Image to video error: {stderr.decode()[:200]}")
        return False
    return True


async def _merge_video_audio(video_path, audio_path, output_path):
    """Merge a video and audio into one file."""
    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-i", audio_path,
        "-c:v", "copy",
        "-c:a", "aac",
        "-shortest",
        output_path
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        logger.warning(f"Merge error: {stderr.decode()[:200]}")
        return False
    return True


async def build_ffmpeg_video(episode, shots, progress_callback=None):
    """
    Assemble MP4: for each shot with per-shot audio, loop video to match audio duration.
    Then concat all segments into final video.
    Falls back to simple concat + global audio if no per-shot audio.
    """
    if not shots:
        raise ValueError("No shots to assemble.")

    valid_shots = []
    for s in shots:
        vid_path = s.get("video_url")
        img_path = s.get("composed_image") or s.get("image_url")
        
        if vid_path and os.path.exists(vid_path):
            s["_media_type"] = "video"
            s["_media_path"] = vid_path
            valid_shots.append(s)
        elif img_path and os.path.exists(img_path):
            s["_media_type"] = "image"
            s["_media_path"] = img_path
            valid_shots.append(s)

    if not valid_shots:
        raise ValueError("None of the shots have valid videos or images generated yet.")

    export_path = os.path.join(OUT_DIR, f"episode_{episode['id']}_pipeline_export.mp4")
    temp_dir = os.path.join(OUT_DIR, f"temp_{episode['id']}")
    os.makedirs(temp_dir, exist_ok=True)

    if progress_callback:
        await progress_callback("Processing shots...", 5)

    # Check if any shots have per-shot audio
    has_per_shot_audio = any(
        s.get("tts_audio_url") and os.path.exists(s["tts_audio_url"])
        for s in valid_shots
    )

    segment_files = []
    total = len(valid_shots)

    for idx, shot in enumerate(valid_shots):
        media_type = shot.get("_media_type")
        media_path = shot.get("_media_path")
        audio_path = shot.get("tts_audio_url", "")

        # Resolve audio path: could be API URL like /api/v1/tts/audio/xxx.wav
        if audio_path and audio_path.startswith("/api/"):
            # Try to resolve to local file
            filename = audio_path.split("/")[-1]
            try:
                from tubecli.config import DATA_DIR as _DD
                local_audio = os.path.join(str(_DD), "tts_vibevoice", "outputs", filename)
            except:
                local_audio = ""
            if local_audio and os.path.exists(local_audio):
                audio_path = local_audio
            else:
                audio_path = ""

        pct = int(10 + (idx / total) * 70)
        if progress_callback:
            await progress_callback(f"Shot {idx+1}/{total}: {shot.get('title', '')}", pct)

        if audio_path and os.path.exists(audio_path):
            # Loop video or create video from image to match audio duration
            audio_dur = await _get_duration(audio_path)
            if audio_dur > 0:
                looped_path = os.path.join(temp_dir, f"shot_{idx}_looped.mp4")
                merged_path = os.path.join(temp_dir, f"shot_{idx}_merged.mp4")

                if media_type == "video":
                    ok = await _loop_video_to_duration(media_path, audio_dur, looped_path)
                else:
                    ok = await _image_to_video(media_path, audio_dur, looped_path)

                if ok and os.path.exists(looped_path):
                    ok2 = await _merge_video_audio(looped_path, audio_path, merged_path)
                    if ok2 and os.path.exists(merged_path):
                        segment_files.append(merged_path)
                        continue

        # No per-shot audio or processing failed: use raw video/image
        if media_type == "video":
            segment_files.append(media_path)
        elif media_type == "image":
            raw_vid = os.path.join(temp_dir, f"shot_{idx}_raw.mp4")
            if await _image_to_video(media_path, 5.0, raw_vid):
                segment_files.append(raw_vid)

    if not segment_files:
        raise ValueError("No segments assembled.")

    if progress_callback:
        await progress_callback("Concatenating all segments...", 85)

    # Create concat list
    with tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt", encoding='utf-8') as f:
        list_file = f.name
        for p in segment_files:
            p_escaped = str(p).replace("\\", "/").replace("'", "'\\''")
            f.write(f"file '{p_escaped}'\n")

    concat_out = os.path.join(OUT_DIR, f"temp_concat_{episode['id']}.mp4")

    cmd_concat = [
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_file,
        "-c", "copy", concat_out
    ]

    proc1 = await asyncio.create_subprocess_exec(
        *cmd_concat, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    _, stderr = await proc1.communicate()

    if proc1.returncode != 0:
        logger.error(f"FFmpeg concat error: {stderr.decode()}")
        os.remove(list_file)
        raise RuntimeError("FFmpeg concat failed.")

    os.remove(list_file)

    if progress_callback:
        await progress_callback("Finalizing...", 90)

    # If no per-shot audio was used, try global episode audio
    audio_path_global = episode.get("audio_url")
    if not has_per_shot_audio and audio_path_global and os.path.exists(audio_path_global):
        cmd_merge = [
            "ffmpeg", "-y",
            "-i", concat_out,
            "-i", audio_path_global,
            "-c:v", "copy",
            "-c:a", "aac",
            "-shortest",
            export_path
        ]
        proc2 = await asyncio.create_subprocess_exec(
            *cmd_merge, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        _, stderr2 = await proc2.communicate()

        if proc2.returncode != 0:
            logger.error(f"FFmpeg merge error: {stderr2.decode()}")
            os.remove(concat_out)
            raise RuntimeError("FFmpeg audio merge failed.")

        os.remove(concat_out)
    else:
        import shutil
        shutil.move(concat_out, export_path)

    # Clean up temp dir
    try:
        import shutil
        shutil.rmtree(temp_dir, ignore_errors=True)
    except:
        pass

    if progress_callback:
        await progress_callback("Export complete.", 100, export_path)

    return export_path
