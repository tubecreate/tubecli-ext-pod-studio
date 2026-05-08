import sqlite3, json, sys, os
sys.stdout.reconfigure(encoding='utf-8')
db_path = r'C:\tubecreate-vue\tubecli\data\pod_studio\pod_studio.db'
conn = sqlite3.connect(db_path)

# Check characters with image_url
chars = conn.execute("SELECT id, name, image_url FROM characters WHERE campaign_id=113").fetchall()
print(f"Models & Products ({len(chars)}):")
broken = []
for c in chars:
    img = c[2] or ''
    exists = os.path.exists(img) if img.strip() else False
    size = os.path.getsize(img) if exists else 0
    status = "OK" if exists and size > 1000 else "BROKEN" if img.strip() else "EMPTY"
    if status == "BROKEN":
        broken.append(c[0])
    print(f"  ID={c[0]} name='{c[1][:30]}' status={status} size={size} path='{img[:80]}'")

# Check scenes with image_url
scenes = conn.execute("SELECT id, location, image_url FROM scenes WHERE campaign_id=113").fetchall()
print(f"\nScenes ({len(scenes)}):")
for s in scenes:
    img = s[2] or ''
    exists = os.path.exists(img) if img.strip() else False
    size = os.path.getsize(img) if exists else 0
    status = "OK" if exists and size > 1000 else "BROKEN" if img.strip() else "EMPTY"
    if status == "BROKEN":
        broken.append(('scene', s[0]))
    print(f"  ID={s[0]} loc='{(s[1] or '')[:35]}' status={status} size={size}")

print(f"\nBroken IDs: {broken}")
conn.close()
