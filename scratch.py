import sqlite3, json, sys
sys.stdout.reconfigure(encoding='utf-8')

db = sqlite3.connect(r"C:\tubecreate-vue\tubecli\data\content_studio\content_studio.db")
c = db.cursor()
c.execute("SELECT id, title, metadata FROM dramas ORDER BY id DESC")
rows = c.fetchall()

def count_steps(p):
    return len(p)

for row in rows:
    try:
        meta = json.loads(row[2])
        pipeline = meta.get('pipeline', [])
        tpl = meta.get('pipeline_template', '')
        if "TRÚC MÃ" in row[1] or tpl == "drama_scene":
            print(f"ID={row[0]}, Title={row[1]}, Tpl={tpl}, Pipe={pipeline}")
    except Exception as e:
        pass
