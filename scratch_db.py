import sqlite3
conn = sqlite3.connect(r'C:\tubecreate-vue\tubecli\data\content_studio\content_studio.db')
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT id, episode_number, title, video_url FROM episodes WHERE video_url IS NOT NULL AND video_url != ''").fetchall()
for r in rows:
    print(dict(r))
conn.close()
