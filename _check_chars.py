import sqlite3, json, os
conn = sqlite3.connect(r'C:\tubecreate-vue\tubecli\data\pod_studio\pod_studio.db')
conn.row_factory = sqlite3.Row

chars = conn.execute("SELECT id, name, image_url FROM characters WHERE campaign_id=113").fetchall()
print(f"Models & Products for campaign 113 ({len(chars)}):")
for c in chars:
    img = c['image_url'] or ''
    has_file = os.path.isfile(img) if img and not img.startswith('/api/') and not img.startswith('http') else False
    is_api = img.startswith('/api/') if img else False
    is_web = img.startswith('http') if img else False
    status = 'LOCAL_FILE' if has_file else 'API_REF' if is_api else 'WEB_URL' if is_web else 'EMPTY'
    print(f"  ID={c['id']} name='{(c['name'] or '')[:25]}' img={status} url='{img[:80]}'")

scenes = conn.execute("SELECT id, location, image_url FROM scenes WHERE campaign_id=113").fetchall()
print(f"\nScenes for campaign 113 ({len(scenes)}):")
for s in scenes:
    img = s['image_url'] or ''
    has_file = os.path.isfile(img) if img and not img.startswith('/api/') and not img.startswith('http') else False
    is_api = img.startswith('/api/') if img else False
    status = 'LOCAL_FILE' if has_file else 'API_REF' if is_api else 'EMPTY'
    print(f"  ID={s['id']} loc='{(s['location'] or '')[:30]}' img={status}")
conn.close()
