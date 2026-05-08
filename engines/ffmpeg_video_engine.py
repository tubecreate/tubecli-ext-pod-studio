import asyncio
import os
import subprocess
import tempfile
import logging
import json
logger = logging.getLogger("ffmpeg")

try:
    from tubecli.config import DATA_DIR
    OUT_DIR = os.path.join(str(DATA_DIR), "pod_studio", "outputs", "exports")
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


import random

async def _dynamic_image_to_video(image_path, target_duration, output_path, scale_res="1920:1080", size_res="1920x1080", fade_in=True):
    """Convert an image to a video of specified duration with dynamic zoom and fade."""
    # Increase resolution by 3x for zoompan to fix sub-pixel rounding jitter
    w_str, h_str = scale_res.split(":")
    w3, h3 = int(w_str)*3, int(h_str)*3

    directions = [
        "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'", # Center
        "x='0':y='0'", # Top Left
        "x='iw-(iw/zoom)':y='0'", # Top Right
        "x='0':y='ih-(ih/zoom)'", # Bottom Left
        "x='iw-(iw/zoom)':y='ih-(ih/zoom)'" # Bottom Right
    ]
    direction = random.choice(directions)
    
    # Smooth zoom in and out using sin wave: z=1.0+0.1*sin(PI*time/duration)
    # on/30 represents current time in seconds (assuming 30fps)
    zoom_expr = f"1.0 + 0.1 * sin(PI*(on/30)/{target_duration})"
    
    # Fade in slightly at start (if enabled), fade out at end
    if fade_in:
        fade_expr = f"fade=t=in:st=0:d=0.5,fade=t=out:st={max(0, target_duration - 0.5)}:d=0.5"
    else:
        fade_expr = f"fade=t=out:st={max(0, target_duration - 0.5)}:d=0.5"
    
    filter_complex = (
        f"scale={w3}:{h3}:force_original_aspect_ratio=increase,crop={w3}:{h3},"
        f"zoompan=z='{zoom_expr}':{direction}:d={int(target_duration*30)}:s={w3}x{h3}:fps=30,"
        f"scale={scale_res}:flags=bicubic,"
        f"{fade_expr}"
    )

    cmd = [
        "ffmpeg", "-y",
        "-loop", "1",
        "-i", image_path,
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-t", str(target_duration),
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-vf", filter_complex,
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
        "-pix_fmt", "yuv420p",
        "-shortest",
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

async def _extend_video_to_duration(video_path, target_duration, output_path, scale_res="1920:1080", size_res="1920x1080"):
    """Extend a video clip to match target duration.
    If it needs extension, extract the last frame and animate it (zoom/fade), then concat.
    """
    orig_dur = await _get_duration(video_path)
    
    if orig_dur >= target_duration or target_duration - orig_dur < 0.5:
        # Just cut and standardize the video and add silent audio if needed
        cmd = [
            "ffmpeg", "-y",
            "-i", video_path,
            "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"
        ]
        if target_duration > 0:
            cmd.extend(["-t", str(target_duration)])
            
        cmd.extend([
            "-vf", f"scale={scale_res}:force_original_aspect_ratio=increase,crop={scale_res},fps=30",
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
            "-pix_fmt", "yuv420p",
            "-shortest",
            output_path
        ])
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        _, stderr = await proc.communicate()
        return proc.returncode == 0
        
    # It needs extension
    extra_dur = target_duration - orig_dur
    temp_dir = os.path.dirname(output_path)
    base_name = os.path.basename(output_path).replace(".mp4", "")
    
    std_vid = os.path.join(temp_dir, f"{base_name}_std.mp4")
    last_frame = os.path.join(temp_dir, f"{base_name}_last.jpg")
    anim_vid = os.path.join(temp_dir, f"{base_name}_anim.mp4")
    list_file = os.path.join(temp_dir, f"{base_name}_concat.txt")
    
    # 1. Standardize original video (with silent audio)
    cmd1 = [
        "ffmpeg", "-y", "-i", video_path,
        "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
        "-vf", f"scale={scale_res}:force_original_aspect_ratio=increase,crop={scale_res},fps=30",
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
        "-pix_fmt", "yuv420p", "-shortest", std_vid
    ]
    p1 = await asyncio.create_subprocess_exec(*cmd1, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    await p1.communicate()
    
    # 2. Extract last frame. -update 1 overwrites the image until the last frame.
    cmd2 = [
        "ffmpeg", "-y", "-i", std_vid, "-update", "1", "-q:v", "2", last_frame
    ]
    p2 = await asyncio.create_subprocess_exec(*cmd2, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    await p2.communicate()
    
    # 3. Animate the last frame for extra_dur (disable fade_in to avoid blink)
    if os.path.exists(last_frame):
        await _dynamic_image_to_video(last_frame, extra_dur, anim_vid, scale_res, size_res, fade_in=False)
    
    # 4. Concat
    if os.path.exists(std_vid) and os.path.exists(anim_vid):
        with open(list_file, "w", encoding="utf-8") as f:
            f.write(f"file '{std_vid}'\n")
            f.write(f"file '{anim_vid}'\n")
            
        cmd3 = [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_file,
            "-c", "copy", output_path
        ]
        p3 = await asyncio.create_subprocess_exec(*cmd3, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        await p3.communicate()
        
        # Cleanup
        for f_path in [std_vid, last_frame, anim_vid, list_file]:
            try: os.remove(f_path)
            except: pass
            
        return p3.returncode == 0
    
    return False

async def _image_to_video(image_path, target_duration, output_path, scale_res="1920:1080", size_res="1920x1080"):
    return await _dynamic_image_to_video(image_path, target_duration, output_path, scale_res, size_res)


async def _merge_video_audio(video_path, audio_path, output_path):
    """Merge a video and audio into one file."""
    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-i", audio_path,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
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


async def build_ffmpeg_video(episode, shots, video_aspect_ratio="16:9", progress_callback=None):
    """
    Assemble MP4: for each shot with per-shot audio, loop video to match audio duration.
    Then concat all segments into final video.
    Falls back to simple concat + global audio if no per-shot audio.
    """
    if video_aspect_ratio == "9:16":
        scale_res, size_res = "1080:1920", "1080x1920"
    elif video_aspect_ratio == "1:1":
        scale_res, size_res = "1080:1080", "1080x1080"
    else:
        scale_res, size_res = "1920:1080", "1920x1080"
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

    def resolve_audio_path(audio_path):
        if not audio_path: return ""
        if audio_path.startswith("/api/"):
            filename = audio_path.split("/")[-1]
            try:
                from tubecli.config import DATA_DIR as _DD
                local_audio = os.path.join(str(_DD), "tts_vibevoice", "outputs", filename)
                if os.path.exists(local_audio): return local_audio
            except: pass
            try:
                ext_audio = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tts_vibevoice", "outputs", filename)
                if os.path.exists(ext_audio): return ext_audio
            except: pass
        return audio_path if os.path.exists(audio_path) else ""

    # Check if any shots have per-shot audio
    has_per_shot_audio = any(
        resolve_audio_path(s.get("tts_audio_url", "")) != ""
        for s in valid_shots
    )

    segment_files = []
    total = len(valid_shots)

    for idx, shot in enumerate(valid_shots):
        media_type = shot.get("_media_type")
        media_path = shot.get("_media_path")
        audio_path = resolve_audio_path(shot.get("tts_audio_url", ""))

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
                    ok = await _extend_video_to_duration(media_path, audio_dur, looped_path, scale_res, size_res)
                else:
                    ok = await _image_to_video(media_path, audio_dur, looped_path, scale_res, size_res)

                if ok and os.path.exists(looped_path):
                    ok2 = await _merge_video_audio(looped_path, audio_path, merged_path)
                    if ok2 and os.path.exists(merged_path):
                        segment_files.append(merged_path)
                        continue

        # No per-shot audio or processing failed: use raw video/image
        if media_type == "video":
            # Pass it through extend_video_to_duration with 0 target duration to standardize it
            raw_vid = os.path.join(temp_dir, f"shot_{idx}_raw.mp4")
            if await _extend_video_to_duration(media_path, 0, raw_vid, scale_res, size_res):
                segment_files.append(raw_vid)
        elif media_type == "image":
            raw_vid = os.path.join(temp_dir, f"shot_{idx}_raw.mp4")
            if await _image_to_video(media_path, 5.0, raw_vid, scale_res, size_res):
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
    audio_path_global = resolve_audio_path(episode.get("audio_url"))
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
