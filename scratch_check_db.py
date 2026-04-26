import sqlite3
import sys
sys.stdout.reconfigure(encoding='utf-8')
conn = sqlite3.connect(r'C:\tubecreate-vue\tubecli\data\content_studio\content_studio.db')
res = conn.execute("SELECT tts_audio_url FROM storyboards WHERE tts_audio_url != '' LIMIT 5").fetchall()
print("TTS URLS:", res)
