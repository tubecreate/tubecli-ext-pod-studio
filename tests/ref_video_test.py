# -*- coding: utf-8 -*-
"""Pipe «Video từ ảnh tham chiếu» (ref_video_pipeline.py) — chạy trọn với mọi thứ bên ngoài giả lập:
Muse (mô tả / ảnh / clip), LLM (chia cảnh), engine vẽ bảng; ffmpeg THẬT (clip màu 10 s) để ghép thật.

Kiểm:
  A. extract_lines / template_shots / speak_block / identity_block / task_kind_spec
  B. plan_shots: LLM trả JSON → dùng; LLM hỏng → khuôn mẫu; trả thiếu → bù đủ n
  C. run(): 7 bước báo đúng tên, campaign/nhân vật/tập/storyboard ghi vào Pod Studio, clip + video cuối tồn tại,
     chạy lại = tiếp từ checkpoint (không vẽ lại clip), huỷ giữa chừng → Cancelled
  D. route /ref-video/run tạo task Codex kind pod_studio.video

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
import tubecli.config as _cfg  # noqa: E402
_cfg.DATA_DIR = TMP                # kho mẫu chung của lõi (tubecli.core.templates) ghi vào thư mục tạm, không đụng kho thật
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
ok(P.art_style("1. FACE: oval … 11. ART STYLE: 2D anime illustration.") == "anime"
   and P.art_style("… 11. ART STYLE: real photograph.") == "photo"
   and P.art_style("… 11. ART STYLE: semi-realistic 3D CG render.") == "3d"
   and P.art_style("… 11. ART STYLE: anime-styled 3D render.") == "3d"
   and P.art_style("a stylized 3D render of a girl with cat-ear headphones") == "3d"
   and P.art_style("a young woman in a cream vest, realistic look") == "photo" and P.art_style("") == "photo",
   "art_style: mục 11 ưu tiên (3D thắng anime), rồi từ khoá, mặc định ảnh thật")
ok(P.resolve_style("3d", "anime") == "3d" and P.resolve_style("auto", "anime") == "anime" and P.resolve_style("", "") == "photo"
   and P.resolve_style("weird", "3d") == "3d", "resolve_style: chọn trong form thắng, auto → kiểu dò được")
ok("NOT flat 2D anime" in P.style_block("3d") and "semi-realistic 3D CG render" in P.style_block("3d")
   and "real photograph" in P.style_block("photo") and P.style_name("nope") == "photorealistic", "style_block / style_name")
_sf = next(f for f in P.task_kind_spec()["fields"] if f["key"] == "style")
ok(_sf["default"] == "auto" and [o["value"] for o in _sf["options"]] == ["auto", "3d", "anime", "photo", "painting"], "form có ô Kiểu hình", _sf["options"])
ok(P.guess_gender("cyberpunk techwear anime heroine") == "female" and P.guess_gender("a young man") == "male"
   and P.guess_gender("the person") == "", "guess_gender: heroine → nữ")
_old_describe = P.describe
P.describe = lambda imgs, prompt, say, max_len=900: json.dumps({"environment": "studio " * 200, "lighting": "neon", "spatial_map": "m",
                                                                "cuts": [{"cut": 1, "camera": "wide", "position": "center", "background": "wall"}]})[:max_len]
rb = P.read_board("board.png", 3, lambda m: None)
ok(rb.get("environment", "").startswith("studio studio") and rb["cuts"][0]["camera"] == "wide", "read_board: JSON dài > 900 ký tự vẫn parse (#160 từng rơi về raw)", list(rb.keys()))
P.describe = _old_describe
spec = P.task_kind_spec()
ok(spec["id"] == "pod_studio.video" and spec["submit_url"].startswith("/api/v1/pod_studio/ref-video/")
   and [f["key"] for f in spec["fields"]][:4] == ["template", "model_images", "product_images", "request"], "task_kind_spec")

print("B. plan_shots")
P._llm = lambda messages, max_tokens=1800: json.dumps({"title": "T", "environment": "a hall", "shots": [
    {"title": "Hook", "scene": "s1", "camera": "wide", "action": "a", "start": "by the door", "end": "she stops by the window, camera close", "speaker": "Model", "dialogue": "Xin chào"},
    {"title": "Pay", "scene": "s2", "camera": "close", "action": "", "end": "she smiles at the window", "speaker": "", "dialogue": ""}]})
plan = P.plan_shots(fmt="ad", request="r «Xin chào»", characters=[{"name": "Model"}], products=[], n=3, say=lambda m: None)
ok(len(plan["shots"]) == 3 and plan["shots"][0]["dialogue"] == "Xin chào" and plan["shots"][2]["dialogue"] == "" and plan["title"] == "T",
   "LLM trả 2/3 → bù đủ 3, giữ thoại", plan["shots"])
ok(plan["shots"][1]["start"] == "she stops by the window, camera close" and plan["shots"][2]["start"] == "she smiles at the window",
   "END cảnh k = START cảnh k+1 (LLM bỏ trống start → chép end cảnh trước; cảnh bù đứng yên ở end)", [(s["start"], s["end"]) for s in plan["shots"]])
tpl = P.template_shots("short", "x", "M", "", 3)
ok(all(s["start"] and s["end"] for s in tpl["shots"]) and tpl["shots"][1]["start"] == tpl["shots"][0]["end"], "khuôn mẫu cũng có start/end nối nhau")
P._llm = lambda messages, max_tokens=1800: (_ for _ in ()).throw(RuntimeError("down"))
said = []
plan = P.plan_shots(fmt="short", request="r «câu a»", characters=[{"name": "M"}], products=[], n=2, say=said.append)
ok(len(plan["shots"]) == 2 and plan["shots"][0]["dialogue"] == "câu a" and said, "LLM hỏng → khuôn mẫu + báo", said)

print("C. run()")
# giả lập Muse
import types
muse = types.SimpleNamespace()
muse.settings = lambda: {"profile": "chayagent"}
BOARD_NOTES = {"environment": "a sunlit school hall with tall arched windows and wooden benches", "lighting": "golden morning light from the left",
               "spatial_map": "the hall runs left to right; lockers behind, windows on the right; camera 1 in front, camera 2 tracks backward",
               "cuts": [{"cut": 1, "camera": "close-up, slow tilt", "position": "by the window, facing camera", "background": "arched window"},
                        {"cut": 2, "camera": "medium, tracking backward", "position": "walking down the hall", "background": "lockers"}]}
def fake_ask(prompt, files=None, timeout=0, **k):
    if "PRODUCTION DESIGN BOARD" in prompt:           # đọc bảng → JSON bối cảnh/góc máy
        return {"text": json.dumps(BOARD_NOTES)}
    return {"text": "1. FACE: oval. 2. EYES: brown. A young woman with long dark hair, lilac sweater, white skirt, platform shoes, dreamy mood. " * 2}
muse.ask = fake_ask
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
# giả lập engine vẽ bảng: trả một ảnh thật (bảng đính nguyên vào clip)
def fake_draw(prompt, refs, out_png, **kw):
    kw["say"]("fake engine") if kw.get("say") else None
    jpg(out_png, (30, 40, 90), (1280, 720)); return {"ok": True, "engine": "fake", "path": out_png, "layout": "chatgpt", "seconds": 1, "tried": []}
panorama.draw_board = fake_draw
P._llm = lambda messages, max_tokens=1800: json.dumps({"title": "Campus", "environment": "a sunlit hall", "shots": [
    {"title": "Hook", "scene": "walks", "camera": "wide", "action": "", "start": "at the window, facing the hall", "end": "she turns to the camera by the bench", "speaker": "", "dialogue": ""},
    {"title": "Line", "scene": "talks", "camera": "close", "action": "", "start": "she turns to the camera by the bench", "end": "she smiles, camera close", "speaker": "Model", "dialogue": "Tôi được tạo từ tubecli.app"}]})
model_img = jpg(TMP / "model.jpg")
prod_img = jpg(TMP / "prod.jpg", (50, 50, 200), (300, 300))
reports = []
payload = {"task_id": "t-abc", "model_images": [{"url": "", "filepath": model_img}], "product_images": [prod_img],
           "request": "Quảng cáo áo. «Tôi được tạo từ tubecli.app»", "format": "ad", "clips": 2, "aspect": "9:16", "subtitles": True}
text = P.run(payload, lambda name, status, msg="", label="", progress=None: reports.append((name, status, msg)), lambda: False)
steps = [r[0] for r in reports]
ok([s for s, _ in P.STEPS if s in steps] == [s for s, _ in P.STEPS], "7 bước đều báo", sorted(set(steps)))
ok(all(any(r[0] == s and r[1] == "success" for r in reports) for s in ("intake", "character", "shots", "board", "clips", "render")), "mỗi bước có success", [r for r in reports if r[1] not in ("running", "success")])
st = P.load_state("t-abc")
ok(st.get("campaign_id") and st.get("episode_id") and len(st["models"]) == 1 and len(st["products"]) == 1, "campaign + nhân vật + sản phẩm", st.keys())
ok(st["models"][0]["appearance"].startswith("1. FACE") and st["models"][0]["gender"] == "female", "appearance từ Muse + giới tính", st["models"][0].get("gender"))
ok(st["board"]["ok"] and os.path.isfile(st["board"]["path"]) and "cuts" not in st, "bảng vẽ xong, không cắt cut", st.get("board"))
ok(len(clip_calls) == 2 and clip_calls[1]["thread"] == "T-1" and "tubecli.app" in clip_calls[1]["prompt"] and "IDENTITY LOCK" in clip_calls[1]["prompt"]
   and "Nobody speaks" in clip_calls[0]["prompt"], "clip 1 im, clip 2 nói; cùng chat; khối IDENTITY", [c["prompt"][:80] for c in clip_calls])
ok(len(clip_calls[1]["refs"]) == 3 and clip_calls[1]["refs"][0].endswith("clip1_last.jpg") and clip_calls[1]["refs"][1] == model_img
   and clip_calls[1]["refs"][2].endswith("board_ref.jpg"), "clip 2 refs = KHUNG CUỐI clip 1 (nguyên, không vẽ lại) + chân dung + BẢNG nguyên (bản JPEG nhẹ)", clip_calls[1]["refs"])
ok(len(img_calls) == 1 and img_calls[0][2][0] == model_img and img_calls[0][2][1] == prod_img and img_calls[0][2][2].endswith("board_ref.jpg"),
   "chỉ khung đầu clip 1 vẽ: chân dung + sản phẩm + bảng", [c[2] for c in img_calls])
from PIL import Image as _ImS
_big = TMP / "big.png"; _ImS.new("RGB", (3200, 1800), (9, 20, 40)).save(_big)
_small = P.shrink_image(str(_big), str(TMP / "big_ref.jpg"))
ok(_small.endswith("big_ref.jpg") and _ImS.open(_small).size == (1600, 900) and _ImS.open(_small).format == "JPEG", "shrink_image: 3200 px → 1600 px JPEG", _ImS.open(_small).size)
ok(P.shrink_image(str(TMP / "nope.png"), str(TMP / "x.jpg")) == str(TMP / "nope.png"), "shrink_image lỗi → trả nguyên bản")
ok("Make this shot from CUT 1 of the storyboard" in clip_calls[0]["prompt"] and "Make this shot from CUT 2" in clip_calls[1]["prompt"]
   and "Do NOT render the board" in img_calls[0][0], "câu «làm clip từ CUT i» trong clip + khung đầu", clip_calls[1]["prompt"][:120])
ok("START (0 s): at the window, facing the hall" in clip_calls[0]["prompt"] and "END (10 s): she turns to the camera by the bench — hold exactly" in clip_calls[0]["prompt"]
   and "START (0 s): she turns to the camera by the bench" in clip_calls[1]["prompt"] and "END (10 s): she smiles, camera close" in clip_calls[1]["prompt"]
   and "hold exactly" not in clip_calls[1]["prompt"].split("END (10 s)")[1], "mỗi clip có START 0 s / END 10 s, END clip 1 = START clip 2", clip_calls[1]["prompt"][-400:])
ok(img_calls[0][0].startswith("A single photorealistic 9:16 frame") and "RENDERING STYLE: photorealistic" in img_calls[0][0]
   and "RENDERING STYLE: photorealistic" in clip_calls[0]["prompt"] and st["models"][0]["style"] == "photo",
   "kiểu vẽ ảnh thật ghim vào khung đầu + clip", img_calls[0][0][:60])
ok(st["board_notes"]["environment"].startswith("a sunlit school hall") and len(st["board_notes"]["cuts"]) == 2, "đọc bảng → bối cảnh + 2 cut", st.get("board_notes"))
ok("arched windows" in clip_calls[0]["prompt"] and "close-up, slow tilt" in clip_calls[0]["prompt"] and "opening shot" in clip_calls[0]["prompt"]
   and "final frame of the previous shot" not in clip_calls[0]["prompt"], "clip 1: bối cảnh + góc máy cut 1 + timeline mở màn", clip_calls[0]["prompt"][:200])
ok("tracking backward" in clip_calls[1]["prompt"] and "final frame of the previous shot" in clip_calls[1]["prompt"] and "lockers" in clip_calls[1]["prompt"]
   and "final shot" in clip_calls[1]["prompt"] and "arched windows" in img_calls[0][0],
   "clip 2: góc máy cut 2 + bắt đầu ĐÚNG khung cuối; khung đầu clip 1 có bối cảnh bảng", clip_calls[1]["prompt"][-300:])
sb = P.scene_block({"environment": "a plain room", "shots": [{"title": "A", "camera": "wide"}]}, {}, 1, 1)
ok("ENVIRONMENT: a plain room" in sb and "CAMERA FOR THIS SHOT: wide" in sb and "final shot" in sb and "(read from" not in sb, "scene_block không bảng → từ kế hoạch", sb)
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

print("C1b. Muse lỡ một lượt → thử lại một lần")
P._data_dir = lambda: str(TMP / "pod_retry")
_gen_ok = muse.generate_video_clip
_fails = {"n": 0}
def flaky_clip(*a, **k):
    _fails["n"] += 1
    if _fails["n"] == 1:
        raise RuntimeError("locator.click: Timeout 30000ms exceeded")
    return _gen_ok(*a, **k)
muse.generate_video_clip = flaky_clip
P.RETRY_WAIT = 0
said_retry = []
P.run({**payload, "task_id": "t-retry", "clips": 1}, lambda name, status, msg="", label="", progress=None: said_retry.append(msg), lambda: False)
ok(_fails["n"] == 2 and any("retrying once" in m for m in said_retry) and "1" in P.load_state("t-retry")["clips"], "lỗi driver lần 1 → báo + gọi lại → clip có", said_retry[-3:])
class _Refused(Exception):
    kind = "refused"
muse.generate_video_clip = lambda *a, **k: (_ for _ in ()).throw(_Refused("no"))
try:
    P.run({**payload, "task_id": "t-refused", "clips": 1}, lambda *a, **k: None, lambda: False); ok(False, "refused → không thử lại")
except _Refused:
    ok(True, "Muse từ chối → không thử lại, nổi lỗi ngay")
muse.generate_video_clip = _gen_ok
# chọn «3D CG» trong form → thắng kiểu dò được (ảnh giả được tả là ảnh thật)
P._data_dir = lambda: str(TMP / "pod_style")
n_img, n_clip = len(img_calls), len(clip_calls)
P.run({**payload, "task_id": "t-3d", "clips": 1, "style": "3d"}, lambda *a, **k: None, lambda: False)
ok(img_calls[n_img][0].startswith("A single semi-realistic 3D CG render 9:16 frame") and "NOT flat 2D anime" in clip_calls[n_clip]["prompt"]
   and P.load_state("t-3d")["models"][0]["style"] == "photo", "style=3d trong form: khung đầu + clip theo 3D, kiểu dò được vẫn lưu", img_calls[n_img][0][:70])
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

print("D. route /ref-video/run")
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

print("E. mẫu dùng chung (kho mẫu của lõi)")
import templates_routes as TR  # noqa: E402
from tubecli.core import templates as CT  # noqa: E402
app.include_router(TR.router)
c = TestClient(app)
spec = P.task_kind_spec()
ok(spec["fields"][0]["key"] == "template" and spec["template_save_url"] == "/api/v1/pod_studio/ref-video/templates"
   and spec["template_keys"] == list(P.TEMPLATE_KEYS) and any(f["key"] == "style_custom" for f in spec["fields"]),
   "form: ô Mẫu đầu tiên + ô mô tả kiểu hình + khai «Lưu thành mẫu»", [f["key"] for f in spec["fields"]])
# mẫu Content Studio (phần wizard) → hiện ở ô Mẫu với fills dựng từ phần chung
CT.save_section("Edo Nhật", "wizard", {"wizAspectRatio": "16:9", "wizStyle": "Japanese Edo Watercolor", "wizVideoLength": "short_60s",
                                       "wizPipelineTemplate": "explainer", "wizSubtitleStyle": "jp_telop", "wizSceneKit": "edo"}, origin="content_studio")
opts = c.get("/api/v1/pod_studio/ref-video/options/templates").json()["options"]
edo = next((o for o in opts if o["value"] == "Edo Nhật"), None)
ok(opts[0]["value"] == "" and edo and edo["origin"] == "content_studio"
   and edo["fills"] == {"aspect": "16:9", "style": "painting", "style_custom": "Japanese Edo Watercolor", "format": "short", "clips": 6, "subtitles": True},
   "mẫu CS hiện ở ô Mẫu, fills dựng từ phần chung", edo)
r = c.post("/api/v1/pod_studio/ref-video/templates", json={"name": "Tóc xanh 3D", "values": {"format": "short", "clips": "3", "aspect": "9:16",
           "style": "3d", "style_custom": "", "subtitles": False, "request": "KHÔNG được lưu"}})
ok(r.status_code == 200 and r.json()["template"]["fills"]["style"] == "3d", "«Lưu thành mẫu» từ form", r.text[:200])
tv = CT.get_template("Tóc xanh 3D")
ok(tv["sections"]["ref_video"]["data"] == {"format": "short", "clips": 3, "aspect": "9:16", "style": "3d", "style_custom": "", "subtitles": False},
   "chỉ lưu các ô mẫu quản (không lưu yêu cầu/ảnh), ép kiểu số", tv["sections"]["ref_video"]["data"])
ok(c.post("/api/v1/pod_studio/ref-video/templates", json={"name": "x", "values": {}}).status_code == 400
   and c.post("/api/v1/pod_studio/ref-video/templates", json={"name": " ", "values": {"format": "ad"}}).status_code == 400
   and c.post("/api/v1/pod_studio/ref-video/templates", json={"name": "x", "values": {"clips": "abc"}}).status_code == 400, "lỗi đầu vào → 400")
wiz = CT.section_view(CT.get_template("Tóc xanh 3D"), "wizard")
ok(wiz.get("wizStyle") == "Semi-realistic 3D CG render" and wiz.get("wizAspectRatio") == "9:16", "Content Studio thấy mẫu Pod (khoá wiz* dựng sẵn)", wiz)
# preset của trình hướng dẫn Pod (cùng khoá wiz*) — route trước đây không có
r = c.post("/api/v1/pod_studio/presets", json={"name": " Pod wiz ", "data": {"wizStyle": "Pixar", "wizVideoEngine": "grok"}})
ok(r.json() == {"success": True, "saved": ["Pod wiz"]}, "POST /presets lưu preset trình hướng dẫn", r.text[:200])
pres = c.get("/api/v1/pod_studio/presets").json()["presets"]
ok(pres.get("Pod wiz") == {"wizStyle": "Pixar", "wizVideoEngine": "grok"} and pres.get("Edo Nhật", {}).get("wizSceneKit") == "edo"
   and "Tóc xanh 3D" in pres, "GET /presets: preset Pod + mẫu CS + mẫu pipe đều có", sorted(pres))
ok(c.post("/api/v1/pod_studio/presets", json={"presets": {"ok": {}, "": {}}}).status_code == 400 and CT.get_template("ok") is None, "lô có tên rỗng → không ghi gì")
ok(c.delete("/api/v1/pod_studio/presets/Pod wiz").json()["success"] and CT.get_template("Pod wiz") is None, "DELETE /presets")
# chạy bằng TÊN mẫu (agent/API): ô không gửi lấy theo mẫu, ô đã gửi thắng
created.clear()
r = c.post("/api/v1/pod_studio/ref-video/run", json={"model_images": [{"filepath": model_img}], "request": "x «hi»", "template": "Tóc xanh 3D", "aspect": "16:9"})
ev = created.get("event") or {}
ok(r.status_code == 200 and ev.get("style") == "3d" and ev.get("format") == "short" and ev.get("clips") == 3 and ev.get("aspect") == "16:9"
   and ev.get("template") == "Tóc xanh 3D", "run với template: lấy kiểu/thể loại/số clip từ mẫu, khung hình đã gửi thắng", ev)
ok(c.post("/api/v1/pod_studio/ref-video/run", json={"model_images": [{"filepath": model_img}], "request": "x", "template": "không có"}).status_code == 404, "mẫu không có → 404")
# khách workspace chia sẻ không ghi được mẫu
gapp = FastAPI()


@gapp.middleware("http")
async def _as_guest(request, call_next):
    request.state.guest_scope = {"id": "g"}
    return await call_next(request)
gapp.include_router(TR.router)
cg = TestClient(gapp)
ok(cg.post("/api/v1/pod_studio/ref-video/templates", json={"name": "g", "values": {"format": "ad"}}).status_code == 403
   and cg.post("/api/v1/pod_studio/presets", json={"name": "g", "data": {}}).status_code == 403
   and cg.delete("/api/v1/pod_studio/presets/Edo Nhật").status_code == 403 and CT.get_template("Edo Nhật") is not None, "khách: ghi/xoá mẫu → 403")
# câu tả kiểu riêng (từ mẫu) đi vào prompt
ok(P.style_name("painting", "Japanese Edo Watercolor") == "Japanese Edo Watercolor" and "RENDERING STYLE: Japanese Edo Watercolor (painted illustration" in P.style_block("painting", "Japanese Edo Watercolor"),
   "style_custom vào RENDERING STYLE + khung đầu")

print(f"\n{PASS} passed, {FAIL} failed")
shutil.rmtree(TMP, ignore_errors=True)
sys.exit(1 if FAIL else 0)
