import os

TARGET_DIR = r"c:\tubecreate-vue\tubecli\data\extensions_external\pod_studio"

REPLACEMENTS = {
    "/api/v1/pod_studio": "/api/v1/pod_studio",
    "/pod-studio": "/pod-studio",
    "POD Studio": "POD Studio",
    "PodStudio": "PodStudio",
    "pod_studio": "pod_studio",
    "Ad Campaign": "Ad Campaign",
    "Ad Campaigns": "Ad Campaigns",
    "campaign": "campaign",
    "campaigns": "campaigns",
    "Models & Products": "Models & Products",
    "Product & Model Gallery": "Product & Model Gallery",
    "character": "character"
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
            print(f"Updated {filepath}")
    except Exception as e:
        print(f"Error processing {filepath}: {e}")

for root, dirs, files in os.walk(TARGET_DIR):
    # skip .git or node_modules if any
    if ".git" in root or "__pycache__" in root:
        continue
    for file in files:
        process_file(os.path.join(root, file))

print("Done.")
