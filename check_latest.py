
import os
import sqlite3
import glob
import sys
import importlib.util

# Change default encoding to utf-8 for stdout
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

db_path = r"C:/tubecreate-vue/tubecli/data/content_studio/content_studio.db"
outputs_dir = r"C:/tubecreate-vue/tubecli/data/tts_vibevoice/outputs"
studio_routes_path = r"C:\tubecreate-vue\tubecli\data\extensions_external\content_studio\studio_routes.py"

# Import _find_shot_start_time dynamically to test the actual code
spec = importlib.util.spec_from_file_location("studio_routes", studio_routes_path)
studio_routes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(studio_routes)
_find_shot_start_time = studio_routes._find_shot_start_time

# 1. Find latest audio
files = glob.glob(os.path.join(outputs_dir, "*.mp3")) + glob.glob(os.path.join(outputs_dir, "*.wav"))
files = [f for f in files if "shot" not in f] # exclude split shots
files.sort(key=os.path.getmtime, reverse=True)

if not files:
    print("No audio files found")
    sys.exit(1)

latest_audio = files[0]
print(f"Latest audio: {latest_audio}")

# 2. Extract Whisper Subtitles
whisper_engine_path = r"C:\tubecreate-vue\tubecli\data\extensions_external\subtitle_extractor\engines\whisper_engine.py"
spec_w = importlib.util.spec_from_file_location("whisper_eng", whisper_engine_path)
whisper_mod = importlib.util.module_from_spec(spec_w)
spec_w.loader.exec_module(whisper_mod)

print("Running Whisper extraction... (This might take a moment)")
import asyncio
whisper_result = asyncio.run(whisper_mod.extract_whisper(latest_audio, language=None, model_size="small"))

if whisper_result.get("status") != "success":
    print(f"Whisper failed: {whisper_result.get('message')}")
    sys.exit(1)

segments = whisper_result.get("subtitles", [])
print(f"Whisper extracted {len(segments)} segments.")

# 3. Connect to DB and get shots
conn = sqlite3.connect(db_path)
cursor = conn.cursor()
ep_id = 144
ep_title = "Episode 144"
print(f"Testing against latest Episode: ID={ep_id}, Title='{ep_title}'")

cursor.execute("SELECT id, narration_text, dialogue, description FROM storyboards WHERE episode_id = ? ORDER BY storyboard_number ASC", (ep_id,))
shots = cursor.fetchall()

valid_shots = []
shot_texts = []
import re
for s in shots:
    txt = s[1] or s[2] or s[3] or ""
    txt = re.sub(r'\[.*?\]', '', txt).strip()
    if txt:
        valid_shots.append(s)
        shot_texts.append(txt)

print(f"Found {len(valid_shots)} valid shots with narration.")

# 4. Run the alignment test
print("\n--- ALIGNMENT TEST RESULTS ---")
shot_starts = []
curr_seg_idx = 0
total_audio_duration = segments[-1]["end"] if segments else 0

for i, (shot, s_text) in enumerate(zip(valid_shots, shot_texts)):
    st, next_idx = _find_shot_start_time(segments, s_text, curr_seg_idx)
    shot_starts.append(st)
    
    # Just to show what it matched against
    match_segment_text = segments[curr_seg_idx]["text"] if curr_seg_idx < len(segments) else "N/A"
    
    print(f"Shot {i+1} (ID={shot[0]}):")
    print(f"  Anchor Target : {s_text[:50]}...")
    print(f"  Matched Time  : {st:.2f}s")
    print(f"  Advancing Idx : {curr_seg_idx} -> {next_idx}")
    
    curr_seg_idx = next_idx

print("\n--- FINAL FFmpeg Splitting Plan ---")
for i, shot in enumerate(valid_shots):
    start_t = shot_starts[i]
    end_t = shot_starts[i+1] if i + 1 < len(shot_starts) else total_audio_duration
    duration = max(0.2, end_t - start_t)
    print(f"Shot {i+1} (ID={shot[0]}): Start = {start_t:.2f}s, End = {end_t:.2f}s, Dur = {duration:.2f}s")

conn.close()
