import os

TARGET_DIR = r"c:\tubecreate-vue\tubecli\data\extensions_external\pod_studio"

REPLACEMENTS = {
    "characters": "characters",
    "character": "character",
    "Characters": "Characters",
    "Character": "Character",
    "Characters": "Characters",
    "Character": "Character"
}

def process_file(filepath):
    if not filepath.endswith((".py", ".js", ".html", ".css", ".json")):
        return
        
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
            
        original_content = content
        for old, new in REPLACEMENTS.items():
            content = content.replace(old, new)
            
        if content != original_content:
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(content)
            print(f"Fixed {filepath}")
    except Exception as e:
        print(f"Error processing {filepath}: {e}")

for root, dirs, files in os.walk(TARGET_DIR):
    if ".git" in root or "__pycache__" in root:
        continue
    for file in files:
        process_file(os.path.join(root, file))

print("Done fixing syntax.")
