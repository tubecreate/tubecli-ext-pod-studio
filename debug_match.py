
import os
import sqlite3
import glob
import sys
import importlib.util
import asyncio

# Change default encoding to utf-8 for stdout
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

outputs_dir = r"C:/tubecreate-vue/tubecli/data/tts_vibevoice/outputs"
whisper_engine_path = r"C:\tubecreate-vue\tubecli\data\extensions_external\subtitle_extractor\engines\whisper_engine.py"
studio_routes_path = r"C:\tubecreate-vue\tubecli\data\extensions_external\pod_studio\studio_routes.py"

spec_sr = importlib.util.spec_from_file_location("studio_routes", studio_routes_path)
studio_routes = importlib.util.module_from_spec(spec_sr)
spec_sr.loader.exec_module(studio_routes)
_find_shot_start_time = studio_routes._find_shot_start_time

files = glob.glob(os.path.join(outputs_dir, "*.mp3")) + glob.glob(os.path.join(outputs_dir, "*.wav"))
files = [f for f in files if "shot" not in f]
files.sort(key=os.path.getmtime, reverse=True)

latest_audio = files[0]

spec_w = importlib.util.spec_from_file_location("whisper_eng", whisper_engine_path)
whisper_mod = importlib.util.module_from_spec(spec_w)
spec_w.loader.exec_module(whisper_mod)

whisper_result = asyncio.run(whisper_mod.extract_whisper(latest_audio, language=None, model_size="small"))
segments = whisper_result.get("subtitles", [])

conn = sqlite3.connect(r"C:/tubecreate-vue/tubecli/data/pod_studio/pod_studio.db")
cursor = conn.cursor()
cursor.execute("SELECT id, narration_text, dialogue, description FROM storyboards WHERE episode_id = 144 ORDER BY storyboard_number ASC")
shots = cursor.fetchall()
import re
valid_shots = []
shot_texts = []
for s in shots:
    txt = s[1] or s[2] or s[3] or ""
    txt = re.sub(r'\[.*?\]', '', txt).strip()
    if txt:
        valid_shots.append(s)
        shot_texts.append(txt)

curr_seg_idx = 0
for i, (shot, s_text) in enumerate(zip(valid_shots, shot_texts)):
    if i >= 9: # Check from shot 10
        print(f"\n--- Shot {i+1} ---")
        print(f"Target text: {s_text[:100]}...")
        st, next_idx = _find_shot_start_time(segments, s_text, curr_seg_idx)
        print(f"Matched start time: {st:.2f}s at index {next_idx-1 if st != segments[curr_seg_idx]['start'] or curr_seg_idx != next_idx-1 else curr_seg_idx}")
        # Print 5 segments around the match
        match_idx = next_idx - 1 if next_idx > curr_seg_idx else curr_seg_idx
        for j in range(max(0, match_idx-2), min(len(segments), match_idx+3)):
            marker = "-->" if segments[j]['start'] == st else "   "
            print(f"{marker} Seg {j}: [{segments[j]['start']:.2f} - {segments[j]['end']:.2f}] {segments[j]['text']}")
    
    st, curr_seg_idx = _find_shot_start_time(segments, s_text, curr_seg_idx)
