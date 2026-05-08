import os
import re

TARGET_DIR = r"c:\tubecreate-vue\tubecli\data\extensions_external\pod_studio\static"

def fix_file(filepath):
    if not filepath.endswith((".js", ".html", ".py")):
        return
        
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
            
        original_content = content
        
        # currentCampaignModels & Products -> currentCampaignCharacters
        content = content.replace("currentCampaignModels & Products", "currentCampaignCharacters")
        
        # Check for any other Models & Products in variables
        content = re.sub(r'(\w+)Models & Products', r'\1Characters', content)
        content = re.sub(r'(\w+)Model/Product', r'\1Character', content)
        content = re.sub(r'(\w+)Model/Products', r'\1Characters', content)
        
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
