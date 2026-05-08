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
        
        # Fix currentAd Campaign -> currentCampaign
        content = content.replace("currentAd Campaign", "currentCampaign")
        # Fix _fc_getAd Campaign -> _fc_getCampaign
        content = content.replace("_fc_getAd Campaign", "_fc_getCampaign")
        # Fix pendingAutoPilotAd CampaignId -> pendingAutoPilotCampaignId
        content = content.replace("pendingAutoPilotAd CampaignId", "pendingAutoPilotCampaignId")
        # Fix window.currentAd CampaignModels & Products -> window.currentCampaignCharacters
        content = content.replace("currentAd CampaignModels & Products", "currentCampaignCharacters")
        # Fix window.currentAd CampaignScenes -> window.currentCampaignScenes
        content = content.replace("currentAd CampaignScenes", "currentCampaignScenes")
        
        # Fix any remaining "Ad Campaign" in variable names (like createAd Campaign)
        content = content.replace("showCreateAd Campaign", "showCreateCampaign")
        content = content.replace("deleteAd Campaign", "deleteCampaign")
        content = content.replace("selectAd Campaign", "selectCampaign")
        content = content.replace("loadAd Campaigns", "loadCampaigns")
        content = content.replace("_createAd CampaignFromWiz", "_createCampaignFromWiz")
        
        if content != original_content:
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(content)
            print(f"Fixed variables in {filepath}")
    except Exception as e:
        print(f"Error processing {filepath}: {e}")

for root, dirs, files in os.walk(TARGET_DIR):
    for file in files:
        fix_file(os.path.join(root, file))

# Also fix studio_routes.py just in case it has some camelCase
fix_file(r"c:\tubecreate-vue\tubecli\data\extensions_external\pod_studio\studio_routes.py")

print("Done fixing JS variables.")
