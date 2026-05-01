import sqlite3
db_path = r'C:\tubecreate-vue\tubecli\data\content_studio\content_studio.db'
conn = sqlite3.connect(db_path)
dramas = conn.execute("SELECT id, title FROM dramas WHERE title LIKE '%top%' ORDER BY id DESC LIMIT 5").fetchall()
for d in dramas:
    eps = conn.execute("SELECT id, ep_num, title FROM episodes WHERE drama_id=?", (d[0],)).fetchall()
    print(f"Drama {d[0]}: {d[1]}")
    for e in eps:
        print(f"  Ep {e[1]} (ID: {e[0]})")
