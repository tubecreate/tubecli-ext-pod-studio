import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pod_db.database import Database
from tubecli.config import DATA_DIR

db_path = os.path.join(str(DATA_DIR), "pod_studio", "studio.db")
print(f"DB: {db_path} exists={os.path.exists(db_path)}")
db = Database(db_path)

campaigns = db.list_campaigns()
for d in campaigns[:5]:
    print(f"\nAd Campaign {d['id']}: {d['title']}")
    chars = db.list_characters(d['id'])
    scenes = db.list_scenes(d['id'])
    print(f"  Models & Products: {len(chars)}, Scenes: {len(scenes)}")
    eps = db.list_episodes(d['id'])
    for ep in eps[:3]:
        cl = len(ep.get('content','') or '')
        sl = len(ep.get('script_content','') or '')
        print(f"  Ep {ep['id']}: content={cl}, script={sl}")
