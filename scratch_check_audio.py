import sqlite3, os
conn = sqlite3.connect(r'C:\tubecreate-vue\tubecli\data\content_studio\content_studio.db')
# Find episodes with ep_number=4
eps = conn.execute("SELECT id, episode_number FROM episodes WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 10").fetchall()
for ep in eps:
    ep_id, ep_num = ep
    shots = conn.execute("SELECT id, storyboard_number, tts_audio_url FROM storyboards WHERE episode_id=? AND deleted_at IS NULL ORDER BY storyboard_number", (ep_id,)).fetchall()
    with_audio = sum(1 for s in shots if s[2] and s[2].strip())
    if with_audio > 0:
        print(f"Episode {ep_num} (id={ep_id}): {with_audio}/{len(shots)} with audio")
        for s in shots:
            if s[2] and s[2].strip():
                url = s[2]
                # Check if file exists
                if url.startswith("/api/v1/tts/audio/"):
                    fname = url.split("/")[-1]
                    fpath = os.path.join(r'C:\tubecreate-vue\tubecli\data\tts_vibevoice\outputs', fname)
                    exists = os.path.exists(fpath)
                    size = os.path.getsize(fpath) if exists else 0
                    print(f"  Shot {s[1]}: {url} -> file exists={exists} size={size}")
                else:
                    print(f"  Shot {s[1]}: {url}")
        break
