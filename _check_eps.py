import sqlite3
db_path = r'C:\tubecreate-vue\tubecli\data\pod_studio\pod_studio.db'
conn = sqlite3.connect(db_path)
campaigns = conn.execute("SELECT id, title FROM campaigns WHERE title LIKE '%top%' ORDER BY id DESC LIMIT 5").fetchall()
for d in campaigns:
    eps = conn.execute("SELECT id, ep_num, title FROM episodes WHERE campaign_id=?", (d[0],)).fetchall()
    print(f"Ad Campaign {d[0]}: {d[1]}")
    for e in eps:
        print(f"  Ep {e[1]} (ID: {e[0]})")
