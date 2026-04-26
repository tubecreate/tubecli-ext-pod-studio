
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

files = glob.glob(os.path.join(outputs_dir, "*.mp3")) + glob.glob(os.path.join(outputs_dir, "*.wav"))
files = [f for f in files if "shot" not in f]
files.sort(key=os.path.getmtime, reverse=True)

if not files: sys.exit(1)
latest_audio = files[0]

spec_w = importlib.util.spec_from_file_location("whisper_eng", whisper_engine_path)
whisper_mod = importlib.util.module_from_spec(spec_w)
spec_w.loader.exec_module(whisper_mod)

whisper_result = asyncio.run(whisper_mod.extract_whisper(latest_audio, language=None, model_size="small"))
segments = whisper_result.get("subtitles", [])

print("--- Whisper Segments (from 230s) ---")
for i, s in enumerate(segments):
    if s['end'] > 230:
        print(f"Seg {i}: [{s['start']:.2f} - {s['end']:.2f}] {s['text']}")
