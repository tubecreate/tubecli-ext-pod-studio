# -*- coding: utf-8 -*-
"""Pipe «Video từ ảnh tham chiếu» (ref_video_pipeline.py) — chạy trọn với mọi thứ bên ngoài giả lập:
Muse (mô tả / ảnh / clip), LLM (chia cảnh), engine vẽ bảng; ffmpeg THẬT (clip màu 10 s) để ghép thật.

Kiểm:
  A. extract_lines / template_shots / speak_block / identity_block / task_kind_spec
  B. plan_shots: LLM trả JSON → dùng; LLM hỏng → khuôn mẫu; trả thiếu → bù đủ n
  C. run(): 7 bước báo đúng tên, campaign/nhân vật/tập/storyboard ghi vào Pod Studio, clip + video cuối tồn tại,
     chạy lại = tiếp từ checkpoint (không vẽ lại clip), huỷ giữa chừng → Cancelled
  D. panorama.split_cuts + route /ref-video/run tạo task Codex kind pod_studio.video

Run:  python tests/ref_video_test.py   (từ thư mục pod_studio)
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, r"c:\tubecreate-vue\tubecli")
sys.path.insert(0, str(HERE))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

import ref_video_pipeline as P  # noqa: E402
import panorama  # noqa: E402

TMP = Path(tempfile.mkdtemp(prefix="refvideo_"))
P._data_dir = lambda: str(TMP / "pod_studio")
PASS = FAIL = 0


def ok(cond, label, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok  ", label)
    else:
        FAIL += 1
        print("  FAIL", label, "—", str(detail)[:300])


def jpg(path, color=(200, 120, 90), size=(400, 700)):
    from PIL import Image
    Image.new("RGB", size, color).save(path, quality=85)
    return str(path)


def mp4(path, color="blue"):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={color}:s=360x640:d=10:r=24",
                    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "10", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", str(path)], check=True)
    return str(path)


print("A. helpers")
ok(P.extract_lines("Quay ở hành lang. «Chào buổi sáng!» rồi «Hẹn gặp lại»") == ["Chào buổi sáng!", "Hẹn gặp lại"], "thoại trong «…»")
ok(P.extract_lines('Thoại: "I was created with tubecli.app"') == ["I was created with tubecli.app"], 'thoại trong "…"')
ok(P.extract_lines("Thoại:\n- câu một\n- câu hai\n") == ["câu một", "câu hai"], "thoại sau 'Thoại:' từng dòng")
t = P.template_shots("ad", "Áo len «Xin chào»", "Model", "vest", 3)
ok(len(t["shots"]) == 3 and t["shots"][0]["dialogue"] == "Xin chào" and t["shots"][2]["dialogue"] == "", "khuôn mẫu ad: thoại 1 vào shot 1")
t2 = P.template_shots("short", "x «câu a» «câu b» «câu c» «câu d»", "M", "", 3)
ok([s["dialogue"] for s in t2["shots"]] == ["câu a", "câu b", "câu c"], "nhiều thoại hơn shot → cắt bớt (thoại ≥ 3 ký tự)")
ok("exactly: \"Hi\"" in P.speak_block("Hi", "female") and "female voice" in P.speak_block("Hi", "female"), "speak_block")
ok("IDENTITY LOCK — Lin" in P.identity_block("Lin", "x") and "attached reference" in P.identity_block("Lin", ""), "identity_block có/không appearance")
ok(P.art_style("1. FACE: oval … 11. ART STYLE: anime illustration.") == "anime illustration"
   and P.art_style("… 11. ART STYLE: real photograph.") == "photorealistic"
   and P.art_style("a stylized 3D render of a girl with cat-ear headphones") == "3D render"
   and P.art_style("a young woman in a cream vest") == "photorealistic" and P.art_style("") == "photorealistic", "art_style: mục 11 ưu tiên, rồi từ khoá, mặc định ảnh thật")
ok("do NOT turn" in P.style_block("anime illustration") and "real photograph" in P.style_block("photorealistic"), "style_block")
ok(P.guess_gender("cyberpunk techwear anime heroine") == "female" and P.guess_gender("a young man") == "male"
   and P.guess_gender("the person") == "", "guess_gender: heroine → nữ")
spec = P.task_kind_spec()
ok(spec["id"] == "pod_studio.video" and spec["submit_url"].startswith("/api/v1/pod_studio/ref-video/")
   and [f["key"] for f in spec["fields"]][:3] == ["model_images", "product_images", "request"], "task_kind_spec")

print("B. plan_shots")
P._llm = lambda messages, max_tokens=1800: json.dumps({"title": "T", "environment": "a hall", "shots": [
    {"title": "Hook", "scene": "s1", "camera": "wide", "action": "a", "speaker": "Model", "dialogue": "Xin chào"},
    {"title": "Pay", "scene": "s2", "camera": "close", "action": "", "speaker": "", "dialogue": ""}]})
plan = P.plan_shots(fmt="ad", request="r «Xin chào»", characters=[{"name": "Model"}], products=[], n=3, say=lambda m: None)
ok(len(plan["shots"]) == 3 and plan["shots"][0]["dialogue"] == "Xin chào" and plan["shots"][2]["dialogue"] == "" and plan["title"] == "T",
   "LLM trả 2/3 → bù đủ 3, giữ thoại", plan["shots"])
P._llm = lambda messages, max_tokens=1800: (_ for _ in ()).throw(RuntimeError("down"))
said = []
plan = P.plan_shots(fmt="short", request="r «câu a»", characters=[{"name": "M"}], products=[], n=2, say=said.append)
ok(len(plan["shots"]) == 2 and plan["shots"][0]["dialogue"] == "câu a" and said, "LLM hỏng → khuôn mẫu + báo", said)

print("C. run()")
# giả lập Muse
import types
muse = types.SimpleNamespace()
muse.settings = lambda: {"profile": "chayagent"}
muse.ask = lambda prompt, files=None, timeout=0, **k: {"text": "1. FACE: oval. 2. EYES: brown. A young woman with long dark hair, lilac sweater, white skirt, platform shoes, dreamy mood. " * 2}
img_calls, clip_calls = [], []
def gen_img(prompt, aspect, refs, timeout=300):
    img_calls.append((prompt, aspect, list(refs)))
    from PIL import Image; import io
    b = io.BytesIO(); Image.new("RGB", (90, 160), (10, 20, 30)).save(b, "JPEG"); return b.getvalue()
muse.generate_image_bytes = gen_img
def gen_clip(prompt, out_dir, refs, aspect, continue_from, thread_id=""):
    clip_calls.append({"prompt": prompt, "refs": list(refs), "thread": thread_id})
    os.makedirs(out_dir, exist_ok=True)
    p = mp4(Path(out_dir) / "muse.mp4", ["blue", "green", "red"][len(clip_calls) % 3])
    return {"path": p, "width": 360, "height": 640, "duration": 10, "thread_id": "T-1"}
muse.generate_video_clip = gen_clip
sys.modules["tubecli.core.muse"] = muse
import tubecli.core as _core
_core.muse = muse
# giả lập engine vẽ bảng: trả một ảnh thật để split_cuts cắt được
def fake_draw(prompt, refs, out_png, **kw):
    kw["say"]("fake engine") if kw.get("say") else None
    jpg(out_png, (30, 40, 90), (1280, 720)); return {"ok": True, "engine": "fake", "path": out_png, "layout": "chatgpt", "seconds": 1, "tried": []}
panorama.draw_board = fake_draw
P._llm = lambda messages, max_tokens=1800: json.dumps({"title": "Campus", "environment": "a sunlit hall", "shots": [
    {"title": "Hook", "scene": "walks", "camera": "wide", "action": "", "speaker": "", "dialogue": ""},
    {"title": "Line", "scene": "talks", "camera": "close", "action": "", "speaker": "Model", "dialogue": "Tôi được tạo từ tubecli.app"}]})
model_img = jpg(TMP / "model.jpg")
prod_img = jpg(TMP / "prod.jpg", (50, 50, 200), (300, 300))
reports = []
payload = {"task_id": "t-abc", "model_images": [{"url": "", "filepath": model_img}], "product_images": [prod_img],
           "request": "Quảng cáo áo. «Tôi được tạo từ tubecli.app»", "format": "ad", "clips": 2, "aspect": "9:16", "subtitles": True}
text = P.run(payload, lambda name, status, msg="", label="", progress=None: reports.append((name, status, msg)), lambda: False)
steps = [r[0] for r in reports]
ok([s for s, _ in P.STEPS if s in steps] == [s for s, _ in P.STEPS], "7 bước đều báo", sorted(set(steps)))
ok(all(any(r[0] == s and r[1] == "success" for r in reports) for s in ("intake", "character", "shots", "board", "cuts", "clips", "render")), "mỗi bước có success", [r for r in reports if r[1] not in ("running", "success")])
st = P.load_state("t-abc")
ok(st.get("campaign_id") and st.get("episode_id") and len(st["models"]) == 1 and len(st["products"]) == 1, "campaign + nhân vật + sản phẩm", st.keys())
ok(st["models"][0]["appearance"].startswith("1. FACE") and st["models"][0]["gender"] == "female", "appearance từ Muse + giới tính", st["models"][0].get("gender"))
ok(st["board"]["ok"] and len(st["cuts"]) == 2 and all(os.path.isfile(c) for c in st["cuts"]), "bảng + 2 cut", st.get("cuts"))
ok(len(clip_calls) == 2 and clip_calls[1]["thread"] == "T-1" and "tubecli.app" in clip_calls[1]["prompt"] and "IDENTITY LOCK" in clip_calls[1]["prompt"]
   and "Nobody speaks" in clip_calls[0]["prompt"], "clip 1 im, clip 2 nói; cùng chat; khối IDENTITY", [c["prompt"][:80] for c in clip_calls])
ok(len(clip_calls[1]["refs"]) == 3 and clip_calls[1]["refs"][0].endswith("clip2_start.jpg") and clip_calls[1]["refs"][1] == model_img,
   "clip 2 refs = khung đầu VẼ LẠI + chân dung + (cut/sản phẩm)", clip_calls[1]["refs"])
ok(img_calls and img_calls[0][2][0] == model_img and len(img_calls[0][2]) == 3, "khung đầu clip 1 vẽ từ chân dung + sản phẩm + cut", img_calls[0][2])
ok(len(img_calls) == 2 and img_calls[1][2][0].endswith("clip1_last.jpg") and img_calls[1][2][1] == model_img
   and "CONTINUES the FIRST attached image" in img_calls[1][0] and "RENDERING STYLE" in img_calls[1][0],
   "khung đầu clip 2 vẽ lại từ khung cuối clip 1 + chân dung (khoá kiểu vẽ)", [c[2] for c in img_calls])
ok(img_calls[0][0].startswith("A single photorealistic 9:16 frame") and "RENDERING STYLE: photorealistic" in img_calls[0][0]
   and "RENDERING STYLE: photorealistic" in clip_calls[0]["prompt"] and st["models"][0]["style"] == "photorealistic",
   "kiểu vẽ ảnh thật ghim vào khung đầu + clip", img_calls[0][0][:60])
final = st["final"]["path"]
dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", final], capture_output=True, text=True).stdout.strip())
ok(os.path.isfile(final) and 19.5 < dur < 20.6 and st["final"]["url"].startswith("/api/v1/pod_studio/export-video/"), "video cuối 20 s + url", dur)
ok("tubecli.app" in text and st["final"]["url"] in text, "kết quả có link + thoại")
from pod_db.json_store import JsonStore
db = JsonStore.get_instance(P._data_dir())
sbs = db.list_storyboards(st["episode_id"])
ok(len(sbs) == 2 and sbs[1]["video_url"].startswith("/api/v1/pod_studio/grok-video/") and "tubecli.app" in sbs[1]["dialogue"], "storyboard có video_url + thoại", sbs[1].get("video_url"))
ok(db.get_episode(st["episode_id"])["video_url"] == st["final"]["url"], "tập có video_url")
# chạy lại = checkpoint: không vẽ lại clip
n_before = len(clip_calls)
P.run(payload, lambda *a, **k: None, lambda: False)
ok(len(clip_calls) == n_before, "chạy lại: clip đã có không vẽ lại")
# huỷ giữa chừng
P._data_dir = lambda: str(TMP / "pod2")
flag = {"n": 0}
def cancelled():
    flag["n"] += 1
    return flag["n"] > 3
try:
    P.run({**payload, "task_id": "t-cancel"}, lambda *a, **k: None, cancelled)
    ok(False, "huỷ → Cancelled")
except P.Cancelled:
    ok(True, "huỷ giữa chừng → Cancelled")
P._data_dir = lambda: str(TMP / "pod_studio")

print("C2. gom ảnh người mẫu theo thể loại")
P._data_dir = lambda: str(TMP / "pod3")
second = jpg(TMP / "model2.jpg", (90, 200, 120))
P.run({**payload, "task_id": "t-ad2", "model_images": [model_img, second], "clips": 1}, lambda *a, **k: None, lambda: False)
s3 = P.load_state("t-ad2")
ok(len(s3["models"]) == 1 and s3["models"][0]["images"] == [model_img, second] and s3["models"][0]["image"] == model_img,
   "ad: 2 ảnh = MỘT người (ảnh đầu làm chân dung, cả hai để mô tả)", s3["models"])
P.run({**payload, "task_id": "t-drama", "model_images": [model_img, second], "format": "drama", "clips": 1}, lambda *a, **k: None, lambda: False)
s4 = P.load_state("t-drama")
ok(len(s4["models"]) == 2 and [m["name"] for m in s4["models"]] == ["Character 1", "Character 2"], "drama: mỗi ảnh một nhân vật", s4["models"])
P._data_dir = lambda: str(TMP / "pod_studio")

print("D. split_cuts + route")
board = jpg(TMP / "board.png", (5, 5, 5), (1000, 600))
cuts = panorama.split_cuts(board, 3, "gptimage", str(TMP / "cuts"))
ok(len(cuts) == 3 and all(os.path.isfile(c) for c in cuts), "split 3 cut (gptimage) — bảng trơn → lùi về khuôn")
ok(len(panorama.split_cuts(board, 5, "chatgpt", str(TMP / "cuts5"))) == 5, "split 5 cut (chatgpt, chia đều)")
# bảng giả theo bố cục gpt-image: nền navy, dải storyboard = 3 ô ảnh nhiễu + ô chữ trắng thưa chen giữa, sơ đồ hẹp bên phải
import random
from PIL import Image as _Im, ImageDraw as _Dr
random.seed(7)
bd = _Im.new("RGB", (1600, 900), (10, 22, 40)); d = _Dr.Draw(bd)
photo_boxes = [(20, 470, 380, 700), (560, 470, 930, 700), (1100, 470, 1470, 700)]
for (x0, y0, x1, y1) in photo_boxes + [(1500, 470, 1580, 700)]:          # ô thứ 4 = sơ đồ hẹp (phải bị bỏ)
    px = bd.load()
    for x in range(x0, x1):
        for y in range(y0, y1):
            px[x, y] = (random.randint(60, 230), random.randint(60, 230), random.randint(60, 230))
for x0 in (395, 945):                                                   # ô chữ: vài dòng trắng mảnh
    for i in range(9):
        d.rectangle((x0, 500 + i * 22, x0 + 140 - (i % 3) * 30, 504 + i * 22), fill=(240, 240, 240))
d.rectangle((20, 60, 1580, 420), fill=(120, 110, 100))                   # vùng 1+2 (ảnh lớn phía trên, ngoài cửa sổ dò)
bd.save(TMP / "board_gpt.png")
boxes = panorama.detect_cut_boxes(bd, 3)
ok(boxes and len(boxes) == 3 and all(abs(b[0] - e[0]) <= 4 and abs(b[2] - e[2]) <= 4 and abs(b[1] - e[1]) <= 4 and abs(b[3] - e[3]) <= 4
   for b, e in zip(boxes, photo_boxes)), "detect_cut_boxes: 3 ô ảnh đúng vị trí, bỏ ô chữ + sơ đồ hẹp", boxes)
cuts_g = panorama.split_cuts(str(TMP / "board_gpt.png"), 3, "chatgpt", str(TMP / "cuts_g"))
_sz = _Im.open(cuts_g[1]).size if len(cuts_g) == 3 else (0, 0)
ok(len(cuts_g) == 3 and abs(_sz[0] - 366) <= 4 and abs(_sz[1] - 226) <= 4, "split_cuts dùng ô dò được (không theo khuôn chatgpt)", _sz)
ok(panorama.detect_cut_boxes(_Im.new("RGB", (800, 500), (10, 22, 40)), 3) is None, "bảng trơn → None")
ok(panorama.split_cuts(str(TMP / "nope.png"), 3, "chatgpt", str(TMP / "x")) == [], "ảnh hỏng → []")
from fastapi import FastAPI
from fastapi.testclient import TestClient
import ref_video_routes as R
created = {}
class FakeCM:
    def create_task(self, **kw): created.update(kw); return {"id": "task-1", "seq": 7, "status": "backlog" if kw.get("hold") else "queued"}
    def append_event(self, tid, kind, msg, actor="", data=None): created["event"] = data
sys.modules.setdefault("tubecli.extensions.codex", types.ModuleType("tubecli.extensions.codex"))
cm_mod = types.ModuleType("tubecli.extensions.codex.manager"); cm_mod.codex_manager = FakeCM()
sys.modules["tubecli.extensions.codex.manager"] = cm_mod
app = FastAPI(); app.include_router(R.router); c = TestClient(app)
r = c.post("/api/v1/pod_studio/ref-video/run", json={"model_images": [{"filepath": model_img}], "request": "x «hi»", "format": "drama", "clips": "4", "queue": True})
ok(r.status_code == 200 and r.json()["task"]["id"] == "task-1" and created["lane"] == "video" and created["hold"] is True
   and created["event"]["kind"] == "pod_studio.video" and created["event"]["clips"] == 4 and created["event"]["format"] == "drama"
   and "«hi»" in created["goal"], "POST /run → task làn video + event kind", (r.status_code, r.text[:200]))
ok(c.post("/api/v1/pod_studio/ref-video/run", json={"model_images": [], "request": "x"}).status_code == 400, "thiếu ảnh → 400")
ok(c.get("/api/v1/pod_studio/ref-video/kind").json()["id"] == "pod_studio.video", "GET /kind")

print(f"\n{PASS} passed, {FAIL} failed")
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if FAIL else 0)
