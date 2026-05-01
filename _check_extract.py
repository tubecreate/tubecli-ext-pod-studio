import sqlite3, json
conn = sqlite3.connect(r'C:\tubecreate-vue\tubecli\data\content_studio\content_studio.db')
conn.row_factory = sqlite3.Row

# Check episode columns
cols = conn.execute("PRAGMA table_info(episodes)").fetchall()
print("Episode columns:", [c['name'] for c in cols])

eps = conn.execute('SELECT e.id, e.title, d.title as dtitle, d.id as did FROM episodes e JOIN dramas d ON e.drama_id=d.id ORDER BY e.id DESC LIMIT 5').fetchall()
for e in eps:
    print(f"Ep ID={e['id']} Drama={e['did']}:{e['dtitle'][:30]}")

# Check AI settings
settings_path = r'C:\tubecreate-vue\tubecli\data\content_studio\settings.json'
try:
    with open(settings_path, 'r') as f:
        s = json.load(f)
    print(f"\nAI Model: {s.get('model','?')}")
    print(f"API Base: {s.get('base_url','?')}")
    key = s.get('api_key','')
    print(f"API Key: {'***' + key[-6:] if key else 'MISSING'}")
except Exception as ex:
    print(f"Settings error: {ex}")
conn.close()
