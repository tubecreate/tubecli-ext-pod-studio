
import os, sys, importlib.util, asyncio, sqlite3, re

import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

studio_routes_path = r"C:\tubecreate-vue\tubecli\data\extensions_external\pod_studio\studio_routes.py"
spec_sr = importlib.util.spec_from_file_location("studio_routes", studio_routes_path)
studio_routes = importlib.util.module_from_spec(spec_sr)
spec_sr.loader.exec_module(studio_routes)

whisper_engine_path = r"C:\tubecreate-vue\tubecli\data\extensions_external\subtitle_extractor\engines\whisper_engine.py"
spec_w = importlib.util.spec_from_file_location("whisper_eng", whisper_engine_path)
whisper_mod = importlib.util.module_from_spec(spec_w)
spec_w.loader.exec_module(whisper_mod)

latest_audio = r"C:\tubecreate-vue\tubecli\data\tts_vibevoice\outputs\tts_3927d2ba.wav"
whisper_result = asyncio.run(whisper_mod.extract_whisper(latest_audio, language=None, model_size="small"))
segments = whisper_result.get("subtitles", [])

conn = sqlite3.connect(r"C:/tubecreate-vue/tubecli/data/pod_studio/pod_studio.db")
cursor = conn.cursor()
cursor.execute("SELECT id, narration_text, dialogue, description FROM storyboards WHERE episode_id = 144 ORDER BY storyboard_number ASC")
shots = cursor.fetchall()
valid_shots = []
shot_texts = []
for s in shots:
    txt = s[1] or s[2] or s[3] or ""
    txt = re.sub(r'\[.*?\]', '', txt).strip()
    if txt:
        valid_shots.append(s)
        shot_texts.append(txt)

def clean(t): return re.sub(r'[^\w\s]', '', t).lower().strip()

shot_text = shot_texts[12] # Shot 13
words = clean(shot_text).split()
print("SHOT 13 TARGET:", shot_text)

anchors = []
anchor_len = min(len(words), 10)
anchors.append(" ".join(words[:anchor_len]))

lines = [l.strip() for l in shot_text.split('\n') if l.strip()]
if len(lines) > 1:
    body_words = clean(lines[1]).split()
    if len(body_words) >= 4:
        anchors.append(" ".join(body_words[:min(len(body_words), 10)]))

if len(words) > 12:
    anchors.append(" ".join(words[5:15]))

print("\n--- ANCHORS ---")
for i, a in enumerate(anchors):
    print(f"{i}: '{a}'")

fallbacks = []
if anchor_len > 6: fallbacks.append(" ".join(words[:6]))
if anchor_len > 4: fallbacks.append(" ".join(words[:4]))
if anchor_len > 2: fallbacks.append(" ".join(words[:3]))

print("\n--- FALLBACKS ---")
for i, f in enumerate(fallbacks):
    print(f"{i}: '{f}'")

print("\n--- CHECKING SEG 75 ---")
window_75 = clean(" ".join([s.get("text", "") for s in segments[75 : 75+4]]))
print("Window 75:", window_75)
for a in anchors:
    if a in window_75: print("EXACT MATCH ANCHOR:", a)
for f in fallbacks:
    if f in window_75: print("FALLBACK MATCH:", f)
from difflib import SequenceMatcher
print("Fuzzy:", SequenceMatcher(None, anchors[0], window_75).ratio())

print("\n--- CHECKING SEG 78 ---")
window_78 = clean(" ".join([s.get("text", "") for s in segments[78 : 78+4]]))
print("Window 78:", window_78)
for a in anchors:
    if a in window_78: print("EXACT MATCH ANCHOR:", a)

