"""
Migrate Content Studio data from SQLite to JSON file storage.
Run this once after upgrading to JSON-based storage.
Optimized: uses direct file writes instead of per-record API calls.
"""
import os
import sys
import json
import sqlite3
import logging

logger = logging.getLogger("ContentStudio.Migration")


def migrate(db_path: str, json_data_dir: str):
    """Migrate all data from SQLite DB to JSON file structure."""
    if not os.path.exists(db_path):
        logger.info(f"No SQLite DB found at {db_path}, skipping migration.")
        return False

    logger.info(f"Starting migration: {db_path} → {json_data_dir}")
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    ext_dir = os.path.dirname(os.path.abspath(__file__))
    if ext_dir not in sys.path:
        sys.path.insert(0, ext_dir)
    from json_store import JsonStore

    store = JsonStore(json_data_dir)
    projects_dir = os.path.join(json_data_dir, "projects")
    os.makedirs(projects_dir, exist_ok=True)

    def _write(filepath, data):
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        tmp = filepath + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, filepath)

    # ID counters — we'll assign new sequential IDs
    id_counters = {
        "drama": 0, "episode": 0, "character": 0,
        "scene": 0, "storyboard": 0, "pipeline_job": 0,
        "channel_watcher": 0, "gallery_category": 0,
        "gallery_item": 0, "preset": 0,
    }
    drama_map = {}
    episode_map = {}
    char_map = {}
    scene_map = {}

    # ── 1. Dramas ──
    dramas = [dict(r) for r in conn.execute(
        "SELECT * FROM dramas WHERE deleted_at IS NULL"
    ).fetchall()]
    logger.info(f"Migrating {len(dramas)} dramas...")
    dramas_index = []

    for d in dramas:
        old_id = d["id"]
        id_counters["drama"] += 1
        new_id = id_counters["drama"]
        drama_map[old_id] = new_id

        proj_dir = os.path.join(projects_dir, str(new_id))
        os.makedirs(proj_dir, exist_ok=True)

        drama = {
            "id": new_id, "title": d.get("title", "Untitled"),
            "description": d.get("description", ""),
            "genre": d.get("genre", ""), "style": d.get("style", "realistic"),
            "language": d.get("language", "vi"),
            "total_episodes": d.get("total_episodes", 1),
            "total_duration": d.get("total_duration", 0),
            "status": d.get("status", "draft"),
            "thumbnail": d.get("thumbnail", ""),
            "tags": d.get("tags", ""),
            "metadata": d.get("metadata", "{}"),
            "created_at": d["created_at"], "updated_at": d["updated_at"],
            "deleted_at": None,
        }
        _write(os.path.join(proj_dir, "project.json"), drama)
        dramas_index.append({"id": new_id, "title": drama["title"], "updated_at": drama["updated_at"]})

    _write(os.path.join(json_data_dir, "dramas_index.json"), dramas_index)

    # ── 2. Episodes ──
    episodes = [dict(r) for r in conn.execute(
        "SELECT * FROM episodes WHERE deleted_at IS NULL ORDER BY drama_id, episode_number"
    ).fetchall()]
    logger.info(f"Migrating {len(episodes)} episodes...")

    # Group by drama
    eps_by_drama = {}
    for e in episodes:
        new_drama_id = drama_map.get(e["drama_id"])
        if not new_drama_id:
            continue
        id_counters["episode"] += 1
        new_id = id_counters["episode"]
        episode_map[e["id"]] = new_id

        ep = {
            "id": new_id, "drama_id": new_drama_id,
            "episode_number": e["episode_number"],
            "title": e.get("title", ""), "content": e.get("content", ""),
            "script_content": e.get("script_content", ""),
            "description": e.get("description", ""),
            "duration": e.get("duration", 0), "status": e.get("status", "draft"),
            "video_url": e.get("video_url", ""), "audio_url": e.get("audio_url", ""),
            "thumbnail": e.get("thumbnail", ""),
            "metadata": e.get("metadata", "{}"),
            "created_at": e["created_at"], "updated_at": e["updated_at"],
            "deleted_at": None,
        }
        eps_by_drama.setdefault(new_drama_id, []).append(ep)

    for did, eps in eps_by_drama.items():
        _write(os.path.join(projects_dir, str(did), "episodes.json"), eps)
    # Write empty episodes for dramas with none
    for did in drama_map.values():
        ep_path = os.path.join(projects_dir, str(did), "episodes.json")
        if not os.path.exists(ep_path):
            _write(ep_path, [])

    # ── 3. Characters ──
    chars = [dict(r) for r in conn.execute(
        "SELECT * FROM characters WHERE deleted_at IS NULL"
    ).fetchall()]
    logger.info(f"Migrating {len(chars)} characters...")

    chars_by_drama = {}
    for c in chars:
        new_drama_id = drama_map.get(c["drama_id"])
        if not new_drama_id:
            continue
        id_counters["character"] += 1
        new_id = id_counters["character"]
        char_map[c["id"]] = new_id

        char = {
            "id": new_id, "drama_id": new_drama_id,
            "name": c.get("name", ""), "role": c.get("role", ""),
            "description": c.get("description", ""),
            "appearance": c.get("appearance", ""),
            "personality": c.get("personality", ""),
            "voice_style": c.get("voice_style", ""),
            "image_url": c.get("image_url", ""),
            "reference_images": c.get("reference_images", "[]"),
            "sort_order": c.get("sort_order", 0),
            "voice_sample_url": c.get("voice_sample_url", ""),
            "voice_provider": c.get("voice_provider", ""),
            "created_at": c["created_at"], "updated_at": c["updated_at"],
            "deleted_at": None,
        }
        chars_by_drama.setdefault(new_drama_id, []).append(char)

    for did in drama_map.values():
        _write(os.path.join(projects_dir, str(did), "characters.json"),
               chars_by_drama.get(did, []))

    # ── 4. Scenes ──
    scenes = [dict(r) for r in conn.execute(
        "SELECT * FROM scenes WHERE deleted_at IS NULL"
    ).fetchall()]
    logger.info(f"Migrating {len(scenes)} scenes...")

    scenes_by_drama = {}
    for s in scenes:
        new_drama_id = drama_map.get(s["drama_id"])
        if not new_drama_id:
            continue
        id_counters["scene"] += 1
        new_id = id_counters["scene"]
        scene_map[s["id"]] = new_id

        scene = {
            "id": new_id, "drama_id": new_drama_id,
            "episode_id": episode_map.get(s.get("episode_id")),
            "location": s["location"], "time": s["time"],
            "prompt": s.get("prompt", ""), "description": s.get("description", ""),
            "storyboard_count": s.get("storyboard_count", 1),
            "image_url": s.get("image_url", ""), "status": s.get("status", "pending"),
            "created_at": s["created_at"], "updated_at": s["updated_at"],
            "deleted_at": None,
        }
        scenes_by_drama.setdefault(new_drama_id, []).append(scene)

    for did in drama_map.values():
        _write(os.path.join(projects_dir, str(did), "scenes.json"),
               scenes_by_drama.get(did, []))

    # ── 5. Storyboards ──
    storyboards = [dict(r) for r in conn.execute(
        "SELECT * FROM storyboards WHERE deleted_at IS NULL ORDER BY episode_id, storyboard_number"
    ).fetchall()]
    logger.info(f"Migrating {len(storyboards)} storyboards...")

    # Get character links
    sb_chars = {}
    for row in conn.execute("SELECT storyboard_id, character_id FROM storyboard_characters").fetchall():
        sb_chars.setdefault(row["storyboard_id"], []).append(row["character_id"])

    # Group by (drama_id, episode_id)
    sbs_by_ep = {}
    for sb in storyboards:
        new_ep_id = episode_map.get(sb["episode_id"])
        if not new_ep_id:
            continue
        # Find drama for this episode
        new_drama_id = None
        for old_did, new_did in drama_map.items():
            ep_path = os.path.join(projects_dir, str(new_did), "episodes.json")
            if os.path.exists(ep_path):
                with open(ep_path, "r", encoding="utf-8") as f:
                    eps = json.load(f)
                if any(e["id"] == new_ep_id for e in eps):
                    new_drama_id = new_did
                    break
        if not new_drama_id:
            continue

        id_counters["storyboard"] += 1
        new_id = id_counters["storyboard"]

        old_char_ids = sb_chars.get(sb["id"], [])
        new_char_ids = [char_map[cid] for cid in old_char_ids if cid in char_map]

        new_sb = {
            "id": new_id, "episode_id": new_ep_id,
            "scene_id": scene_map.get(sb.get("scene_id")),
            "storyboard_number": sb["storyboard_number"],
            "character_ids": new_char_ids,
            "created_at": sb["created_at"], "updated_at": sb["updated_at"],
            "deleted_at": None,
        }
        for key in ["title", "location", "time", "shot_type", "angle", "movement",
                     "action", "result", "atmosphere", "image_prompt", "video_prompt",
                     "bgm_prompt", "sound_effect", "dialogue", "description",
                     "duration", "composed_image", "first_frame_image", "last_frame_image",
                     "reference_images", "video_url", "narration_text", "tts_audio_url",
                     "subtitle_url", "composed_video_url", "status", "metadata"]:
            new_sb[key] = sb.get(key) if sb.get(key) is not None else ""

        sbs_by_ep.setdefault((new_drama_id, new_ep_id), []).append(new_sb)

    for (did, eid), sbs in sbs_by_ep.items():
        sb_dir = os.path.join(projects_dir, str(did), "storyboards")
        os.makedirs(sb_dir, exist_ok=True)
        _write(os.path.join(sb_dir, f"ep_{eid}.json"), sbs)

    # ── 6. Pipeline Jobs ──
    try:
        jobs = [dict(r) for r in conn.execute("SELECT * FROM auto_pipeline_jobs").fetchall()]
        logger.info(f"Migrating {len(jobs)} pipeline jobs...")
        new_jobs = []
        for j in jobs:
            id_counters["pipeline_job"] += 1
            j_new = dict(j)
            j_new["id"] = id_counters["pipeline_job"]
            if j.get("drama_id") and j["drama_id"] in drama_map:
                j_new["drama_id"] = drama_map[j["drama_id"]]
            new_jobs.append(j_new)
        _write(os.path.join(json_data_dir, "pipeline_jobs.json"), new_jobs)
    except Exception as e:
        logger.warning(f"Pipeline jobs migration: {e}")

    # ── 7. Channel Watchers ──
    try:
        watchers = [dict(r) for r in conn.execute("SELECT * FROM channel_watchers").fetchall()]
        logger.info(f"Migrating {len(watchers)} channel watchers...")
        new_watchers = []
        for w in watchers:
            id_counters["channel_watcher"] += 1
            w_new = dict(w)
            w_new["id"] = id_counters["channel_watcher"]
            new_watchers.append(w_new)
        _write(os.path.join(json_data_dir, "channel_watchers.json"), new_watchers)
    except Exception as e:
        logger.warning(f"Channel watchers migration: {e}")

    # ── 8. Gallery ──
    cat_map = {}
    try:
        cats = [dict(r) for r in conn.execute("SELECT * FROM char_gallery_categories WHERE deleted_at IS NULL").fetchall()]
        logger.info(f"Migrating {len(cats)} gallery categories...")
        new_cats = []
        for c in cats:
            id_counters["gallery_category"] += 1
            new_id = id_counters["gallery_category"]
            cat_map[c["id"]] = new_id
            c_new = dict(c)
            c_new["id"] = new_id
            c_new["deleted_at"] = None
            new_cats.append(c_new)
        _write(os.path.join(json_data_dir, "gallery_categories.json"), new_cats)

        items = [dict(r) for r in conn.execute("SELECT * FROM char_gallery_items WHERE deleted_at IS NULL").fetchall()]
        logger.info(f"Migrating {len(items)} gallery items...")
        new_items = []
        for item in items:
            id_counters["gallery_item"] += 1
            cat_links = conn.execute(
                "SELECT category_id FROM char_gallery_category_items WHERE item_id = ?",
                (item["id"],)
            ).fetchall()
            i_new = dict(item)
            i_new["id"] = id_counters["gallery_item"]
            i_new["category_ids"] = [cat_map[r["category_id"]] for r in cat_links if r["category_id"] in cat_map]
            i_new["deleted_at"] = None
            new_items.append(i_new)
        _write(os.path.join(json_data_dir, "gallery_items.json"), new_items)
    except Exception as e:
        logger.warning(f"Gallery migration: {e}")

    # ── 9. Presets ──
    try:
        presets = [dict(r) for r in conn.execute("SELECT * FROM presets").fetchall()]
        logger.info(f"Migrating {len(presets)} presets...")
        new_presets = []
        for p in presets:
            id_counters["preset"] += 1
            p_new = dict(p)
            p_new["id"] = id_counters["preset"]
            new_presets.append(p_new)
        _write(os.path.join(json_data_dir, "presets.json"), new_presets)
    except Exception as e:
        logger.warning(f"Presets migration: {e}")

    conn.close()

    # ── Update ID counters in _meta.json (one write) ──
    store._set_next_ids({
        "next_drama_id": id_counters["drama"] + 1,
        "next_episode_id": id_counters["episode"] + 1,
        "next_character_id": id_counters["character"] + 1,
        "next_scene_id": id_counters["scene"] + 1,
        "next_storyboard_id": id_counters["storyboard"] + 1,
        "next_pipeline_job_id": id_counters["pipeline_job"] + 1,
        "next_channel_watcher_id": id_counters["channel_watcher"] + 1,
        "next_gallery_category_id": id_counters["gallery_category"] + 1,
        "next_gallery_item_id": id_counters["gallery_item"] + 1,
        "next_preset_id": id_counters["preset"] + 1,
    })

    # Rename old DB
    backup_path = db_path + ".migrated"
    try:
        os.rename(db_path, backup_path)
        logger.info(f"SQLite DB backed up to: {backup_path}")
    except Exception:
        logger.warning(f"Could not rename old DB, please manually remove: {db_path}")

    logger.info(f"✅ Migration complete! {len(drama_map)} dramas, {len(episode_map)} episodes, "
                f"{len(char_map)} characters, {len(scene_map)} scenes, {id_counters['storyboard']} storyboards")
    return True


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    db = sys.argv[1] if len(sys.argv) > 1 else r"C:\tubecreate-vue\tubecli\data\content_studio\content_studio.db"
    out = sys.argv[2] if len(sys.argv) > 2 else r"C:\tubecreate-vue\tubecli\data\content_studio"
    migrate(db, out)
