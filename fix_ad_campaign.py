import os

TARGET_DIR = r"c:\tubecreate-vue\tubecli\data\extensions_external\pod_studio\static"

def fix_file(filepath):
    if not filepath.endswith((".js", ".html")):
        return
        
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
            
        original_content = content
        
        content = content.replace("Ad Campaigns", "Campaigns")
        content = content.replace("Ad Campaign", "Campaign")
        
        if content != original_content:
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(content)
            print(f"Fixed {filepath}")
    except Exception as e:
        print(f"Error processing {filepath}: {e}")

for root, dirs, files in os.walk(TARGET_DIR):
    for file in files:
        fix_file(os.path.join(root, file))

print("Done.")
