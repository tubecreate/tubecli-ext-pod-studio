import sqlite3
import sys
import asyncio
import os
sys.path.append(r'C:\tubecreate-vue')
sys.stdout.reconfigure(encoding='utf-8')

from tubecli.data.extensions_external.pod_studio.engines.ffmpeg_video_engine import build_ffmpeg_video

async def test_build():
    conn = sqlite3.connect(r'C:\tubecreate-vue\tubecli\data\pod_studio\pod_studio.db')
    conn.row_factory = sqlite3.Row
    ep = dict(conn.execute('SELECT * FROM episodes WHERE id=137').fetchone() or {})
    if not ep:
        # Get the latest episode
        ep = dict(conn.execute('SELECT * FROM episodes ORDER BY id DESC LIMIT 1').fetchone() or {})
    
    ep_id = ep.get('id')
    print("Testing episode:", ep_id)
    
    shots = [dict(r) for r in conn.execute('SELECT * FROM storyboards WHERE episode_id=? ORDER BY storyboard_number ASC', (ep_id,)).fetchall()]
    print("Total shots:", len(shots))
    
    async def cb(msg, pct, output=None):
        print(f"[{pct}%] {msg}")
        
    try:
        out_path = await build_ffmpeg_video(ep, shots[:2], progress_callback=cb)
        print("Success:", out_path)
    except Exception as e:
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(test_build())
