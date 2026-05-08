import cv2
import numpy as np
import os
import json

def split_production_board(image_path: str, output_dir: str = None, prefix: str = "") -> dict:
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"Cannot read: {image_path}")
    
    h, w = img.shape[:2]
    
    if output_dir is None:
        output_dir = os.path.dirname(image_path)
    os.makedirs(output_dir, exist_ok=True)
    
    sb_top = int(h * 0.51)
    sb_bot = int(h * 0.69)
    v_split_top = int(w * 0.495)
    v_split_bot = int(w * 0.48)
    
    zones_def = {
        "zone1_character":    (0, 0, v_split_top, sb_top),
        "zone2_environment":  (v_split_top, 0, w, sb_top),
        "zone3_storyboard":   (0, sb_top, w, sb_bot),
        "zone4_lighting":     (0, sb_bot, v_split_bot, h),
        "zone5_floorplan":    (v_split_bot, sb_bot, w, h),
    }
    
    result = {"source": image_path, "dimensions": {"width": w, "height": h}, "zones": {}}
    
    for zone_name, (x1, y1, x2, y2) in zones_def.items():
        zone_img = img[y1:y2, x1:x2]
        zh, zw = zone_img.shape[:2]
        
        # Flattened path
        zone_filename = f"{prefix}{zone_name}.jpg"
        zone_path = os.path.join(output_dir, zone_filename)
        cv2.imwrite(zone_path, zone_img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        
        result["zones"][zone_name] = {
            "filename": zone_filename,
            "full_image": zone_path,
            "bbox": [x1, y1, x2, y2],
            "size": [zw, zh]
        }
        
    # Split Storyboard Zone into 5 Cuts
    sb_img = img[sb_top:sb_bot, :]
    sb_h, sb_w = sb_img.shape[:2]
    
    cut_count = 5
    cut_w = sb_w // cut_count
    cuts = []
    
    for i in range(cut_count):
        cx1 = i * cut_w
        cx2 = (i + 1) * cut_w if i < cut_count - 1 else sb_w
        
        cut_img = sb_img[:, cx1:cx2]
        cut_filename = f"{prefix}cut_{i+1:02d}.jpg"
        cut_path = os.path.join(output_dir, cut_filename)
        cv2.imwrite(cut_path, cut_img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        
        cuts.append({"cut_number": i + 1, "filename": cut_filename, "path": cut_path, "bbox": [cx1, sb_top, cx2, sb_bot]})
        
    result["storyboard_cuts"] = cuts
    result["floor_plan"] = result["zones"]["zone5_floorplan"]["full_image"]
    result["floor_plan_filename"] = result["zones"]["zone5_floorplan"]["filename"]
    
    return result

if __name__ == '__main__':
    import sys
    img_path = sys.argv[1] if len(sys.argv) > 1 else r'C:\Users\ADMIN\.gemini\antigravity\brain\70bbdf2c-a850-4ac0-8ced-fa193de7cf03\media__1778244695627.jpg'
    out = sys.argv[2] if len(sys.argv) > 2 else None
    split_production_board(img_path, out, 'test_')