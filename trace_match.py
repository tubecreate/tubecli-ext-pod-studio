
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
import re
from difflib import SequenceMatcher

def clean(t): return re.sub(r'[^\w\s]', '', t).lower().strip()

segments = [
    {"start": 329.40, "end": 333.56, "text": "Thứ nhất, không gian cá nhân, nhu cầu cơ bản của con người về vùng của riêng mình."},
    {"start": 333.56, "end": 338.08, "text": "Thứ hai, cơ chế sinh lý, chọn vị trí chiến lược giúp giảm lượng thông tin phải xử lý."},
    {"start": 338.16, "end": 342.28, "text": "Thứ ba, thói quen lập lại, tạo trực tự và cảm giác kiểm soát giữa bức ổn định."},
    {"start": 342.28, "end": 347.16, "text": "Thứ tư, phản ứng hệ thống não, sử dụng quy tắc để vô hiệu hóa lo âu."},
    {"start": 347.16, "end": 349.76, "text": "Bằng cách hiểu rõ những cơ chế này bạn không chỉ hiểu hành vi của chính mình"}
]

shot_text = "Kết Luận: Ứng Dụng Thực Tế Bằng cách hiểu rõ những cơ chế này, bạn không chỉ hiểu hành vi của chính mình"

words = clean(shot_text).split()
anchor_len = min(len(words), 10)
anchor = " ".join(words[:anchor_len])
print(f"Anchor: '{anchor}'")

for i in range(len(segments)):
    window_text = clean(" ".join([s.get("text", "") for s in segments[i : i+4]]))
    print(f"\nEvaluating Window {i}:")
    print(f"Window text: '{window_text}'")
    if anchor in window_text:
        print("-> EXACT MATCH!")
    
    score = SequenceMatcher(None, anchor, window_text).ratio()
    print(f"-> Fuzzy Score: {score}")

