import os

TARGET_DIR = r"c:\tubecreate-vue\tubecli\data\extensions_external\pod_studio\static"

REPLACEMENTS = {
    ">Character Gallery<": ">Product & Model Gallery<",
    ">Characters<": ">Models & Products<",
    "Add Character": "Add Model/Product",
    "Edit Character": "Edit Model/Product",
    "Character Style:": "Model/Product Style:",
    "Character List": "Model/Product List"
}

def process_file(filepath):
    if not filepath.endswith((".js", ".html")):
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
            print(f"Fixed UI in {filepath}")
    except Exception as e:
        print(f"Error processing {filepath}: {e}")

for root, dirs, files in os.walk(TARGET_DIR):
    for file in files:
        process_file(os.path.join(root, file))

print("Done fixing UI labels.")
