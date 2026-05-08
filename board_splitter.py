"""
Production Board Splitter v4
Uses proportional layout expected from the prompt, then extracts individual frames.
"""
import cv2
import numpy as np
import os
import json


def split_production_board(image_path: str, output_dir: str = None) -> dict:
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"Cannot read: {image_path}")
    
    h, w = img.shape[:2]
    
    if output_dir is None:
        output_dir = os.path.join(os.path.dirname(image_path), "board_splits")
    os.makedirs(output_dir, exist_ok=True)
    
    # ── Strict Proportional Layout ──
    # Based on the prompt we sent to the AI:
    # Zone 1 (Top-left, ~48% width, ~51% height)
    # Zone 2 (Top-right, ~52% width, ~51% height)
    # Zone 3 (Middle, full width, ~51% to ~68% height)
    # Zone 4 (Bottom-left, ~45% width, ~68% to 100% height)
    # Zone 5 (Bottom-right, ~55% width, ~68% to 100% height)
    
    # Fine-tuned percentages from the generated image:
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
    debug_img = img.copy()
    
    zone_colors = {
        "zone1_character": (0, 255, 0),
        "zone2_environment": (255, 200, 0),
        "zone3_storyboard": (0, 165, 255),
        "zone4_lighting": (255, 255, 0),
        "zone5_floorplan": (255, 0, 255),
    }
    
    for zone_name, (x1, y1, x2, y2) in zones_def.items():
        zone_img = img[y1:y2, x1:x2]
        zh, zw = zone_img.shape[:2]
        zone_dir = os.path.join(output_dir, zone_name)
        os.makedirs(zone_dir, exist_ok=True)
        
        zone_path = os.path.join(zone_dir, f"{zone_name}_full.jpg")
        cv2.imwrite(zone_path, zone_img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        
        result["zones"][zone_name] = {
            "full_image": zone_path,
            "bbox": [x1, y1, x2, y2],
            "size": [zw, zh]
        }
        
        color = zone_colors.get(zone_name, (128, 128, 128))
        cv2.rectangle(debug_img, (x1, y1), (x2, y2), color, 2)
        cv2.putText(debug_img, zone_name.upper(), (x1 + 5, y1 + 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
    
    # ── Split Storyboard Zone into 5 Cuts ──
    # Since we explicitly asked for 5 cuts in the prompt, let's divide it equally
    sb_img = img[sb_top:sb_bot, :]
    sb_h, sb_w = sb_img.shape[:2]
    
    cut_count = 5
    cut_w = sb_w // cut_count
    cuts = []
    
    for i in range(cut_count):
        cx1 = i * cut_w
        cx2 = (i + 1) * cut_w if i < cut_count - 1 else sb_w
        
        cut_img = sb_img[:, cx1:cx2]
        cut_path = os.path.join(output_dir, f"storyboard_cut_{i+1:02d}.jpg")
        cv2.imwrite(cut_path, cut_img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        
        cuts.append({"cut_number": i + 1, "path": cut_path, "bbox": [cx1, sb_top, cx2, sb_bot]})
        
        # Draw on debug
        cv2.line(debug_img, (cx1, sb_top), (cx1, sb_bot), (0, 165, 255), 2)
        cv2.putText(debug_img, f"CUT {i+1}", (cx1 + 5, sb_top + 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 165, 255), 2)
    
    result["storyboard_cuts"] = cuts
    
    # Extract Floor Plan (Zone 5)
    result["floor_plan"] = result["zones"]["zone5_floorplan"]["full_image"]
    
    # Save debug
    debug_path = os.path.join(output_dir, "_debug_zones.jpg")
    cv2.imwrite(debug_path, debug_img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    result["debug_image"] = debug_path
    
    # Save JSON
    meta_path = os.path.join(output_dir, "_metadata.json")
    with open(meta_path, "w", encoding="utf-8") as mf:
        json.dump(result, mf, indent=2, ensure_ascii=False)
        
    print(f"Successfully extracted {len(cuts)} storyboard cuts!")
    print(f"Check the splits in: {output_dir}")
    return result

if __name__ == "__main__":
    import sys
    img_path = sys.argv[1] if len(sys.argv) > 1 else r'C:\Users\ADMIN\.gemini\antigravity\brain\70bbdf2c-a850-4ac0-8ced-fa193de7cf03\media__1778242246179.jpg'
    out = sys.argv[2] if len(sys.argv) > 2 else None
    split_production_board(img_path, out)
