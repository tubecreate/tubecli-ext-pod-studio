import sqlite3
conn = sqlite3.connect(r'C:\tubecreate-vue\tubecli\data\content_studio\content_studio.db')
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT e.id, e.episode_number, d.id as did, d.title, length(e.script_content) as slen FROM episodes e JOIN dramas d ON e.drama_id=d.id ORDER BY e.id DESC LIMIT 10").fetchall()
for r in rows:
    print(f"Ep ID={r['id']} #{r['episode_number']} drama_id={r['did']} title={r['title'][:25]} script_len={r['slen']}")
conn.close()
