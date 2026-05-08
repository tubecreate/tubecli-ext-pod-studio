"""
POD Studio JSON Store
File-per-project storage with atomic writes for multi-user concurrency.
Drop-in replacement for database.py (same method signatures).
"""
import os
import json
import logging
import threading
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from copy import deepcopy

logger = logging.getLogger("PodStudio.JsonStore")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class JsonStore:
    """JSON file-based storage with project-level isolation."""

    _instance: Optional["JsonStore"] = None
    _lock = threading.Lock()

    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.projects_dir = os.path.join(data_dir, "projects")
        self._file_locks: Dict[str, threading.Lock] = {}
        os.makedirs(self.projects_dir, exist_ok=True)

    @classmethod
    def get_instance(cls, data_dir: str = "") -> "JsonStore":
        if cls._instance is None:
            if not data_dir:
                raise ValueError("data_dir required for first initialization")
            cls._instance = cls(data_dir)
            cls._instance._init_meta()
            logger.info(f"JsonStore initialized: {data_dir}")
        return cls._instance

    def _get_lock(self, filepath: str) -> threading.Lock:
        if filepath not in self._file_locks:
            self._file_locks[filepath] = threading.Lock()
        return self._file_locks[filepath]

    def _read(self, filepath: str, default=None):
        """Read JSON file, return default if not exists."""
        if not os.path.exists(filepath):
            return deepcopy(default) if default is not None else None
        lock = self._get_lock(filepath)
        with lock:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)

    def _write(self, filepath: str, data):
        """Atomic write: write to temp then rename."""
        os.makedirs(os.path.dirname(filepath), exist_ok=True)
        lock = self._get_lock(filepath)
        with lock:
            tmp = filepath + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, filepath)

    def _init_meta(self):
        """Initialize global metadata file for ID generation."""
        meta_path = os.path.join(self.data_dir, "_meta.json")
        if not os.path.exists(meta_path):
            self._write(meta_path, {
                "next_campaign_id": 1,
                "next_episode_id": 1,
                "next_character_id": 1,
                "next_scene_id": 1,
                "next_storyboard_id": 1,
                "next_pipeline_job_id": 1,
                "next_channel_watcher_id": 1,
                "next_gallery_category_id": 1,
                "next_gallery_item_id": 1,
                "next_preset_id": 1,
                "next_export_id": 1,
            })

    def _next_id(self, key: str) -> int:
        """Get and increment next ID atomically."""
        meta_path = os.path.join(self.data_dir, "_meta.json")
        lock = self._get_lock(meta_path)
        with lock:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            nid = meta.get(key, 1)
            meta[key] = nid + 1
            tmp = meta_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
            os.replace(tmp, meta_path)
        return nid

    def _set_next_ids(self, updates: dict):
        """Set multiple next_id counters at once (for migration)."""
        meta_path = os.path.join(self.data_dir, "_meta.json")
        lock = self._get_lock(meta_path)
        with lock:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            meta.update(updates)
            tmp = meta_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
            os.replace(tmp, meta_path)

    # Helper to get project dir
    def _proj_dir(self, campaign_id: int) -> str:
        d = os.path.join(self.projects_dir, str(campaign_id))
        os.makedirs(d, exist_ok=True)
        return d

    # ── Ad Campaign CRUD ──────────────────────────────────────────

    def _campaigns_index_path(self) -> str:
        return os.path.join(self.data_dir, "campaigns_index.json")

    def _load_campaigns_index(self) -> List[dict]:
        return self._read(self._campaigns_index_path(), [])

    def _save_campaigns_index(self, index: List[dict]):
        self._write(self._campaigns_index_path(), index)

    def _campaign_path(self, campaign_id: int) -> str:
        return os.path.join(self._proj_dir(campaign_id), "project.json")

    def create_campaign(self, data: dict) -> dict:
        now = _now()
        campaign_id = self._next_id("next_campaign_id")
        campaign = {
            "id": campaign_id,
            "title": data.get("title", "Untitled"),
            "description": data.get("description", ""),
            "genre": data.get("genre", ""),
            "style": data.get("style", "realistic"),
            "language": data.get("language", "vi"),
            "total_episodes": data.get("total_episodes", 1),
            "total_duration": 0,
            "status": "draft",
            "thumbnail": "",
            "tags": data.get("tags", ""),
            "metadata": json.dumps(data.get("metadata", {})) if isinstance(data.get("metadata"), dict) else data.get("metadata", "{}"),
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
        }
        self._write(self._campaign_path(campaign_id), campaign)
        # Update index
        index = self._load_campaigns_index()
        index.append({"id": campaign_id, "title": campaign["title"], "updated_at": now})
        self._save_campaigns_index(index)
        # Init empty sub-collections
        self._write(os.path.join(self._proj_dir(campaign_id), "characters.json"), [])
        self._write(os.path.join(self._proj_dir(campaign_id), "scenes.json"), [])
        self._write(os.path.join(self._proj_dir(campaign_id), "episodes.json"), [])
        return campaign

    def get_campaign(self, campaign_id: int) -> Optional[dict]:
        campaign = self._read(self._campaign_path(campaign_id))
        if campaign and campaign.get("deleted_at") is None:
            return campaign
        return None

    def list_campaigns(self) -> List[dict]:
        """List all campaigns with episode count."""
        index = self._load_campaigns_index()
        results = []
        for entry in index:
            campaign = self.get_campaign(entry["id"])
            if campaign:
                eps = self._read(os.path.join(self._proj_dir(campaign["id"]), "episodes.json"), [])
                active_eps = [e for e in eps if e.get("deleted_at") is None]
                campaign["episode_count"] = len(active_eps)
                results.append(campaign)
        results.sort(key=lambda d: d.get("updated_at", ""), reverse=True)
        return results

    def get_campaign_full(self, campaign_id: int) -> Optional[dict]:
        d = self.get_campaign(campaign_id)
        if not d:
            return None
        eps = self._read(os.path.join(self._proj_dir(campaign_id), "episodes.json"), [])
        d["episodes"] = [
            {"id": e["id"], "episode_number": e["episode_number"], "title": e["title"],
             "status": e.get("status", "draft"), "metadata": e.get("metadata", "{}")}
            for e in eps if e.get("deleted_at") is None
        ]
        d["episodes"].sort(key=lambda e: e["episode_number"])
        chars = self._read(os.path.join(self._proj_dir(campaign_id), "characters.json"), [])
        d["characters"] = [
            {"id": c["id"], "name": c["name"], "role": c.get("role", "")}
            for c in chars if c.get("deleted_at") is None
        ]
        scenes = self._read(os.path.join(self._proj_dir(campaign_id), "scenes.json"), [])
        d["scenes"] = [
            {"id": s["id"], "location": s["location"], "time": s["time"]}
            for s in scenes if s.get("deleted_at") is None
        ]
        return d

    def update_campaign(self, campaign_id: int, data: dict) -> Optional[dict]:
        campaign = self.get_campaign(campaign_id)
        if not campaign:
            return None
        for key in ["title", "description", "genre", "style", "language",
                     "total_episodes", "status", "tags", "metadata"]:
            if key in data:
                campaign[key] = data[key]
        campaign["updated_at"] = _now()
        self._write(self._campaign_path(campaign_id), campaign)
        # Update index title
        index = self._load_campaigns_index()
        for entry in index:
            if entry["id"] == campaign_id:
                entry["title"] = campaign["title"]
                entry["updated_at"] = campaign["updated_at"]
        self._save_campaigns_index(index)
        return campaign

    def delete_campaign(self, campaign_id: int) -> bool:
        campaign = self.get_campaign(campaign_id)
        if campaign:
            campaign["deleted_at"] = _now()
            self._write(self._campaign_path(campaign_id), campaign)
        return True

    # ── Episode CRUD ────────────────────────────────────────

    def _episodes_path(self, campaign_id: int) -> str:
        return os.path.join(self._proj_dir(campaign_id), "episodes.json")

    def _load_episodes(self, campaign_id: int) -> List[dict]:
        return self._read(self._episodes_path(campaign_id), [])

    def _save_episodes(self, campaign_id: int, episodes: List[dict]):
        self._write(self._episodes_path(campaign_id), episodes)

    def create_episode(self, campaign_id: int, data: dict) -> dict:
        now = _now()
        episodes = self._load_episodes(campaign_id)
        active = [e for e in episodes if e.get("deleted_at") is None]
        next_num = max([e.get("episode_number", 0) for e in active], default=0) + 1
        ep_id = self._next_id("next_episode_id")
        ep = {
            "id": ep_id,
            "campaign_id": campaign_id,
            "episode_number": data.get("episode_number", next_num),
            "title": data.get("title", f"Episode {next_num}"),
            "content": data.get("content", ""),
            "script_content": data.get("script_content", ""),
            "description": data.get("description", ""),
            "duration": 0,
            "status": "draft",
            "video_url": "",
            "audio_url": "",
            "thumbnail": "",
            "metadata": data.get("metadata", "{}"),
            "created_at": now,
            "updated_at": now,
            "deleted_at": None,
        }
        episodes.append(ep)
        self._save_episodes(campaign_id, episodes)
        return ep

    def get_episode(self, episode_id: int) -> Optional[dict]:
        # Need to search across all projects - use reverse index
        index = self._load_campaigns_index()
        for entry in index:
            episodes = self._load_episodes(entry["id"])
            for ep in episodes:
                if ep["id"] == episode_id and ep.get("deleted_at") is None:
                    return ep
        return None

    def _find_campaign_for_episode(self, episode_id: int) -> Optional[int]:
        """Find which campaign contains this episode."""
        index = self._load_campaigns_index()
        for entry in index:
            episodes = self._load_episodes(entry["id"])
            for ep in episodes:
                if ep["id"] == episode_id:
                    return entry["id"]
        return None

    def list_episodes(self, campaign_id: int) -> List[dict]:
        episodes = self._load_episodes(campaign_id)
        result = [e for e in episodes if e.get("deleted_at") is None]
        result.sort(key=lambda e: e.get("episode_number", 0))
        return result

    def update_episode(self, episode_id: int, data: dict) -> Optional[dict]:
        campaign_id = self._find_campaign_for_episode(episode_id)
        if campaign_id is None:
            return None
        episodes = self._load_episodes(campaign_id)
        for ep in episodes:
            if ep["id"] == episode_id:
                for key in ["title", "content", "script_content", "description",
                             "status", "video_url", "audio_url", "metadata"]:
                    if key in data:
                        ep[key] = data[key]
                ep["updated_at"] = _now()
                self._save_episodes(campaign_id, episodes)
                return ep
        return None

    # ── Character CRUD ──────────────────────────────────────

    def _chars_path(self, campaign_id: int) -> str:
        return os.path.join(self._proj_dir(campaign_id), "characters.json")

    def _load_chars(self, campaign_id: int) -> List[dict]:
        return self._read(self._chars_path(campaign_id), [])

    def _save_chars(self, campaign_id: int, chars: List[dict]):
        self._write(self._chars_path(campaign_id), chars)

    def list_characters(self, campaign_id: int) -> List[dict]:
        chars = self._load_chars(campaign_id)
        result = [c for c in chars if c.get("deleted_at") is None]
        result.sort(key=lambda c: (c.get("sort_order", 0), c.get("id", 0)))
        return result

    def get_character(self, char_id: int) -> Optional[dict]:
        for entry in self._load_campaigns_index():
            for c in self._load_chars(entry["id"]):
                if c["id"] == char_id and c.get("deleted_at") is None:
                    return c
        return None

    def _find_campaign_for_character(self, char_id: int) -> Optional[int]:
        for entry in self._load_campaigns_index():
            for c in self._load_chars(entry["id"]):
                if c["id"] == char_id:
                    return entry["id"]
        return None

    def create_character(self, campaign_id: int, data: dict) -> dict:
        now = _now()
        char_id = self._next_id("next_character_id")
        char = {
            "id": char_id, "campaign_id": campaign_id,
            "name": data.get("name", ""), "role": data.get("role", ""),
            "description": data.get("description", ""),
            "appearance": data.get("appearance", ""),
            "personality": data.get("personality", ""),
            "voice_style": data.get("voice_style", ""),
            "image_url": data.get("image_url", ""),
            "reference_images": data.get("reference_images", "[]"),
            "sort_order": data.get("sort_order", 0),
            "voice_sample_url": data.get("voice_sample_url", ""),
            "voice_provider": data.get("voice_provider", ""),
            "created_at": now, "updated_at": now, "deleted_at": None,
        }
        chars = self._load_chars(campaign_id)
        chars.append(char)
        self._save_chars(campaign_id, chars)
        return char

    def update_character(self, char_id: int, data: dict) -> Optional[dict]:
        campaign_id = self._find_campaign_for_character(char_id)
        if campaign_id is None:
            return None
        chars = self._load_chars(campaign_id)
        for c in chars:
            if c["id"] == char_id:
                for key in ["name", "role", "description", "appearance", "personality",
                             "voice_style", "image_url", "reference_images", "voice_sample_url"]:
                    if key in data:
                        c[key] = data[key]
                c["updated_at"] = _now()
                self._save_chars(campaign_id, chars)
                return c
        return None

    def delete_character(self, char_id: int) -> bool:
        campaign_id = self._find_campaign_for_character(char_id)
        if campaign_id is None:
            return True
        chars = self._load_chars(campaign_id)
        for c in chars:
            if c["id"] == char_id:
                c["deleted_at"] = _now()
        self._save_chars(campaign_id, chars)
        return True

    # ── Scene CRUD ──────────────────────────────────────────

    def _scenes_path(self, campaign_id: int) -> str:
        return os.path.join(self._proj_dir(campaign_id), "scenes.json")

    def _load_scenes(self, campaign_id: int) -> List[dict]:
        return self._read(self._scenes_path(campaign_id), [])

    def _save_scenes(self, campaign_id: int, scenes: List[dict]):
        self._write(self._scenes_path(campaign_id), scenes)

    def list_scenes(self, campaign_id: int) -> List[dict]:
        scenes = self._load_scenes(campaign_id)
        return [s for s in scenes if s.get("deleted_at") is None]

    def get_scene(self, scene_id: int) -> Optional[dict]:
        for entry in self._load_campaigns_index():
            for s in self._load_scenes(entry["id"]):
                if s["id"] == scene_id and s.get("deleted_at") is None:
                    return s
        return None

    def _find_campaign_for_scene(self, scene_id: int) -> Optional[int]:
        for entry in self._load_campaigns_index():
            for s in self._load_scenes(entry["id"]):
                if s["id"] == scene_id:
                    return entry["id"]
        return None

    def update_scene(self, scene_id: int, data: dict) -> Optional[dict]:
        campaign_id = self._find_campaign_for_scene(scene_id)
        if campaign_id is None:
            return None
        scenes = self._load_scenes(campaign_id)
        for s in scenes:
            if s["id"] == scene_id:
                for key in ["location", "time", "prompt", "description", "image_url", "status",
                             "lighting_style", "color_palette", "material_refs", "mood"]:
                    if key in data:
                        s[key] = data[key]
                s["updated_at"] = _now()
                self._save_scenes(campaign_id, scenes)
                return s
        return None

    # ── Storyboard CRUD ─────────────────────────────────────

    def _sb_path(self, campaign_id: int, episode_id: int) -> str:
        d = os.path.join(self._proj_dir(campaign_id), "storyboards")
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, f"ep_{episode_id}.json")

    def _load_sbs(self, campaign_id: int, episode_id: int) -> List[dict]:
        return self._read(self._sb_path(campaign_id, episode_id), [])

    def _save_sbs(self, campaign_id: int, episode_id: int, sbs: List[dict]):
        self._write(self._sb_path(campaign_id, episode_id), sbs)

    def list_storyboards(self, episode_id: int) -> List[dict]:
        campaign_id = self._find_campaign_for_episode(episode_id)
        if campaign_id is None:
            return []
        sbs = self._load_sbs(campaign_id, episode_id)
        result = [sb for sb in sbs if sb.get("deleted_at") is None]
        result.sort(key=lambda sb: sb.get("storyboard_number", 0))
        for sb in result:
            if "character_ids" not in sb:
                sb["character_ids"] = []
        return result

    def get_storyboard(self, sb_id: int) -> Optional[dict]:
        for entry in self._load_campaigns_index():
            for ep in self._load_episodes(entry["id"]):
                for sb in self._load_sbs(entry["id"], ep["id"]):
                    if sb["id"] == sb_id and sb.get("deleted_at") is None:
                        return sb
        return None

    def _find_ctx_for_sb(self, sb_id: int):
        """Returns (campaign_id, episode_id) for a storyboard."""
        for entry in self._load_campaigns_index():
            for ep in self._load_episodes(entry["id"]):
                for sb in self._load_sbs(entry["id"], ep["id"]):
                    if sb["id"] == sb_id:
                        return entry["id"], ep["id"]
        return None, None

    def update_storyboard(self, sb_id: int, data: dict) -> Optional[dict]:
        campaign_id, episode_id = self._find_ctx_for_sb(sb_id)
        if campaign_id is None:
            return None
        sbs = self._load_sbs(campaign_id, episode_id)
        for sb in sbs:
            if sb["id"] == sb_id:
                for key in ["title", "location", "time", "shot_type", "angle", "movement",
                             "action", "result", "atmosphere", "image_prompt", "video_prompt",
                             "bgm_prompt", "sound_effect", "dialogue", "description",
                             "duration", "scene_id", "status", "composed_image",
                             "first_frame_image", "last_frame_image", "reference_images",
                             "video_url", "narration_text", "tts_audio_url", "metadata"]:
                    if key in data:
                        sb[key] = data[key]
                sb["updated_at"] = _now()
                self._save_sbs(campaign_id, episode_id, sbs)
                return sb
        return None

    def clear_storyboards(self, episode_id: int):
        """Soft-delete all storyboards for an episode."""
        campaign_id = self._find_campaign_for_episode(episode_id)
        if campaign_id is None:
            return
        now = _now()
        sbs = self._load_sbs(campaign_id, episode_id)
        for sb in sbs:
            if sb.get("deleted_at") is None:
                sb["deleted_at"] = now
        self._save_sbs(campaign_id, episode_id, sbs)

    def get_existing_storyboards_summary(self, episode_id: int) -> List[dict]:
        """Get minimal storyboard info for append mode."""
        campaign_id = self._find_campaign_for_episode(episode_id)
        if campaign_id is None:
            return []
        sbs = self._load_sbs(campaign_id, episode_id)
        return [
            {"storyboard_number": sb["storyboard_number"], "description": sb.get("description", "")}
            for sb in sbs if sb.get("deleted_at") is None
        ]

    # ── Bulk save helpers (for AI agents) ───────────────────

    def save_characters_dedup(self, campaign_id: int, episode_id: int, characters: List[dict]) -> List[dict]:
        """Save characters with smart dedup by name."""
        existing = {c["name"]: c for c in self.list_characters(campaign_id)}
        saved = []
        for ch in characters:
            name = ch.get("name", "").strip()
            if not name:
                continue
            if name in existing:
                update_data = dict(ch)
                ex = existing[name]
                if ex.get("image_url") and not update_data.get("image_url"):
                    update_data.pop("image_url", None)
                if ex.get("reference_images") and ex["reference_images"] != "[]" and not update_data.get("reference_images"):
                    update_data.pop("reference_images", None)
                self.update_character(ex["id"], update_data)
                saved.append(ex)
            else:
                new_ch = self.create_character(campaign_id, ch)
                existing[name] = new_ch
                saved.append(new_ch)
        return saved

    def save_scenes_dedup(self, campaign_id: int, episode_id: int, scenes: List[dict]) -> List[dict]:
        """Save scenes with smart dedup by location+time."""
        now = _now()
        existing = {f"{s['location']}|{s['time']}": s for s in self.list_scenes(campaign_id)}
        saved = []
        for sc in scenes:
            loc = sc.get("location", "").strip()
            time_s = sc.get("time", "").strip()
            key = f"{loc}|{time_s}"
            if not loc:
                continue
            if key in existing:
                self.update_scene(existing[key]["id"], sc)
                saved.append(existing[key])
            else:
                scene_id = self._next_id("next_scene_id")
                new_scene = {
                    "id": scene_id, "campaign_id": campaign_id, "episode_id": episode_id,
                    "location": loc, "time": time_s,
                    "prompt": sc.get("prompt", ""), "description": sc.get("description", ""),
                    "lighting_style": sc.get("lighting_style", ""),
                    "color_palette": sc.get("color_palette", ""),
                    "material_refs": sc.get("material_refs", ""),
                    "mood": sc.get("mood", ""),
                    "storyboard_count": 1, "image_url": "", "status": "pending",
                    "created_at": now, "updated_at": now, "deleted_at": None,
                }
                scenes_list = self._load_scenes(campaign_id)
                scenes_list.append(new_scene)
                self._save_scenes(campaign_id, scenes_list)
                existing[key] = new_scene
                saved.append(new_scene)
        return saved

    def save_storyboards_bulk(self, episode_id: int, storyboards: List[dict], append: bool = False) -> List[dict]:
        """Save complete storyboard set."""
        now = _now()
        campaign_id = self._find_campaign_for_episode(episode_id)
        if campaign_id is None:
            return []

        # Determine start number
        start_number = 1
        ep = self.get_episode(episode_id)
        if ep:
            ep_num = ep.get("episode_number", 1)
            # Check previous episodes for continuous numbering
            all_eps = self.list_episodes(campaign_id)
            for prev_ep in all_eps:
                if prev_ep["episode_number"] < ep_num:
                    prev_sbs = self._load_sbs(campaign_id, prev_ep["id"])
                    active = [s for s in prev_sbs if s.get("deleted_at") is None]
                    if active:
                        mx = max(s.get("storyboard_number", 0) for s in active)
                        if mx >= start_number:
                            start_number = mx + 1

        if not append:
            self.clear_storyboards(episode_id)
        else:
            existing = self._load_sbs(campaign_id, episode_id)
            active = [s for s in existing if s.get("deleted_at") is None]
            if active:
                mx = max(s.get("storyboard_number", 0) for s in active)
                if mx >= start_number:
                    start_number = mx + 1

        sbs = self._load_sbs(campaign_id, episode_id)
        saved = []
        for i, sb_data in enumerate(storyboards, start_number):
            sb_id = self._next_id("next_storyboard_id")
            sb = {
                "id": sb_id, "episode_id": episode_id,
                "scene_id": sb_data.get("scene_id"),
                "storyboard_number": i,
                "title": sb_data.get("title", ""),
                "location": sb_data.get("location", ""),
                "time": sb_data.get("time", ""),
                "shot_type": sb_data.get("shot_type", ""),
                "angle": sb_data.get("angle", ""),
                "movement": sb_data.get("movement", ""),
                "action": sb_data.get("action", ""),
                "result": sb_data.get("result", ""),
                "atmosphere": sb_data.get("atmosphere", ""),
                "image_prompt": sb_data.get("image_prompt", ""),
                "video_prompt": sb_data.get("video_prompt", ""),
                "bgm_prompt": sb_data.get("bgm_prompt", ""),
                "sound_effect": sb_data.get("sound_effect", ""),
                "dialogue": sb_data.get("dialogue", ""),
                "description": sb_data.get("description", ""),
                "narration_text": sb_data.get("narration_text", ""),
                "duration": sb_data.get("duration", 10),
                "composed_image": "", "first_frame_image": "", "last_frame_image": "",
                "reference_images": sb_data.get("reference_images", "[]"), "video_url": "",
                "tts_audio_url": "", "subtitle_url": "", "composed_video_url": "",
                "status": "pending",
                "character_ids": sb_data.get("character_ids", []),
                "metadata": json.dumps(sb_data.get("metadata", {})) if isinstance(sb_data.get("metadata"), dict) else sb_data.get("metadata", "{}"),
                "created_at": now, "updated_at": now, "deleted_at": None,
            }
            # Save metadata fields
            sb_meta = {}
            for mkey in ["reference_asset_names", "reference_effect_names", "illustrate_layout", "spatial_position"]:
                if sb_data.get(mkey):
                    sb_meta[mkey] = sb_data[mkey]
            if sb_meta:
                sb["metadata"] = json.dumps(sb_meta)
            sbs.append(sb)
            saved.append(sb)
        self._save_sbs(campaign_id, episode_id, sbs)
        return saved

    # ── Pipeline Jobs CRUD ──────────────────────────────────

    def _jobs_path(self) -> str:
        return os.path.join(self.data_dir, "pipeline_jobs.json")

    def _load_jobs(self) -> List[dict]:
        return self._read(self._jobs_path(), [])

    def _save_jobs(self, jobs: List[dict]):
        self._write(self._jobs_path(), jobs)

    def create_pipeline_job(self, data: dict) -> dict:
        now = _now()
        job_id = self._next_id("next_pipeline_job_id")
        job = {
            "id": job_id,
            "source_type": data.get("source_type", "youtube_link"),
            "source_url": data.get("source_url", ""),
            "source_title": data.get("source_title", ""),
            "status": "pending", "error_message": "",
            "preset_name": data.get("preset_name", ""),
            "pipeline_template": data.get("pipeline_template", "campaign_scene"),
            "content_format": data.get("content_format", "Educational / Learning"),
            "visual_style": data.get("visual_style", "Default"),
            "max_episodes": data.get("max_episodes", 1),
            "language": data.get("language", "vi"),
            "voice_preset": data.get("voice_preset", ""),
            "browser_profiles": json.dumps(data.get("browser_profiles", [])) if isinstance(data.get("browser_profiles"), list) else data.get("browser_profiles", "[]"),
            "aspect_ratio": data.get("aspect_ratio", "16:9"),
            "narration_source": data.get("narration_source", "prose"),
            "video_length": data.get("video_length", "standard"),
            "seo_mode": data.get("seo_mode", "ai_generate"),
            "seo_title_template": data.get("seo_title_template", ""),
            "seo_description_template": data.get("seo_description_template", ""),
            "seo_tags": json.dumps(data.get("seo_tags", [])) if isinstance(data.get("seo_tags"), list) else data.get("seo_tags", "[]"),
            "upload_targets": json.dumps(data.get("upload_targets", [])) if isinstance(data.get("upload_targets"), list) else data.get("upload_targets", "[]"),
            "upload_privacy": data.get("upload_privacy", "private"),
            "gallery_category_id": data.get("gallery_category_id"),
            "campaign_id": data.get("campaign_id"),
            "episode_ids": data.get("episode_ids", "[]"),
            "uploaded_video_ids": data.get("uploaded_video_ids", "[]"),
            "output_video_path": data.get("output_video_path", ""),
            "extracted_text": data.get("extracted_text", ""),
            "created_at": now, "updated_at": now,
        }
        jobs = self._load_jobs()
        jobs.append(job)
        self._save_jobs(jobs)
        return job

    def list_pipeline_jobs(self, status: str = None, limit: int = 100) -> List[dict]:
        jobs = self._load_jobs()
        if status:
            jobs = [j for j in jobs if j.get("status") == status]
        jobs.sort(key=lambda j: j.get("created_at", ""), reverse=True)
        return jobs[:limit]

    def get_pipeline_job(self, job_id: int) -> Optional[dict]:
        for j in self._load_jobs():
            if j["id"] == job_id:
                return j
        return None

    def update_pipeline_job(self, job_id: int, data: dict) -> Optional[dict]:
        jobs = self._load_jobs()
        for j in jobs:
            if j["id"] == job_id:
                for key in ["source_title", "status", "error_message", "campaign_id",
                             "episode_ids", "uploaded_video_ids", "output_video_path", "extracted_text",
                             "preset_name", "pipeline_template", "content_format", "visual_style",
                             "max_episodes", "language", "voice_preset", "browser_profiles",
                             "aspect_ratio", "narration_source", "video_length", "gallery_category_id",
                             "seo_mode", "seo_title_template", "seo_description_template", "seo_tags",
                             "upload_targets", "upload_privacy"]:
                    if key in data:
                        val = data[key]
                        j[key] = json.dumps(val) if isinstance(val, (list, dict)) else val
                j["updated_at"] = _now()
                self._save_jobs(jobs)
                return j
        return None

    def delete_pipeline_job(self, job_id: int) -> bool:
        jobs = self._load_jobs()
        jobs = [j for j in jobs if j["id"] != job_id]
        self._save_jobs(jobs)
        return True

    def get_next_pending_job(self) -> Optional[dict]:
        jobs = self._load_jobs()
        pending = [j for j in jobs if j.get("status") == "pending"]
        pending.sort(key=lambda j: j.get("created_at", ""))
        return pending[0] if pending else None

    # ── Channel Watchers CRUD ────────────────────────────────

    def _watchers_path(self) -> str:
        return os.path.join(self.data_dir, "channel_watchers.json")

    def _load_watchers(self) -> List[dict]:
        return self._read(self._watchers_path(), [])

    def _save_watchers(self, watchers: List[dict]):
        self._write(self._watchers_path(), watchers)

    def create_channel_watcher(self, data: dict) -> dict:
        now = _now()
        wid = self._next_id("next_channel_watcher_id")
        w = {
            "id": wid,
            "platform": data.get("platform", "youtube"),
            "channel_url": data.get("channel_url", ""),
            "channel_id": data.get("channel_id", ""),
            "channel_name": data.get("channel_name", ""),
            "preset_name": data.get("preset_name", ""),
            "pipeline_template": data.get("pipeline_template", "campaign_scene"),
            "content_format": data.get("content_format", "Educational / Learning"),
            "visual_style": data.get("visual_style", "Default"),
            "max_episodes": data.get("max_episodes", 1),
            "language": data.get("language", "vi"),
            "voice_preset": data.get("voice_preset", ""),
            "browser_profiles": json.dumps(data.get("browser_profiles", [])) if isinstance(data.get("browser_profiles"), list) else data.get("browser_profiles", "[]"),
            "seo_mode": data.get("seo_mode", "ai_generate"),
            "upload_targets": json.dumps(data.get("upload_targets", [])) if isinstance(data.get("upload_targets"), list) else data.get("upload_targets", "[]"),
            "upload_privacy": data.get("upload_privacy", "private"),
            "last_checked_at": None, "last_video_id": "",
            "known_video_ids": "[]",
            "check_interval_minutes": data.get("check_interval_minutes", 30),
            "is_active": 1,
            "created_at": now, "updated_at": now,
        }
        watchers = self._load_watchers()
        watchers.append(w)
        self._save_watchers(watchers)
        return w

    def list_channel_watchers(self) -> List[dict]:
        return self._load_watchers()

    def get_channel_watcher(self, watcher_id: int) -> Optional[dict]:
        for w in self._load_watchers():
            if w["id"] == watcher_id:
                return w
        return None

    def update_channel_watcher(self, watcher_id: int, data: dict) -> Optional[dict]:
        watchers = self._load_watchers()
        for w in watchers:
            if w["id"] == watcher_id:
                for key in ["channel_name", "channel_id", "last_checked_at", "last_video_id",
                             "known_video_ids", "check_interval_minutes", "is_active",
                             "preset_name", "pipeline_template", "content_format", "visual_style",
                             "max_episodes", "language", "voice_preset", "browser_profiles",
                             "seo_mode", "upload_targets", "upload_privacy"]:
                    if key in data:
                        val = data[key]
                        w[key] = json.dumps(val) if isinstance(val, (list, dict)) else val
                w["updated_at"] = _now()
                self._save_watchers(watchers)
                return w
        return None

    def delete_channel_watcher(self, watcher_id: int) -> bool:
        watchers = self._load_watchers()
        watchers = [w for w in watchers if w["id"] != watcher_id]
        self._save_watchers(watchers)
        return True

    # ── Gallery Categories ───────────────────────────────────

    def _gallery_cats_path(self) -> str:
        return os.path.join(self.data_dir, "gallery_categories.json")

    def _load_gallery_cats(self) -> List[dict]:
        return self._read(self._gallery_cats_path(), [])

    def _save_gallery_cats(self, cats: List[dict]):
        self._write(self._gallery_cats_path(), cats)

    def create_gallery_category(self, data: dict) -> dict:
        now = _now()
        cat_id = self._next_id("next_gallery_category_id")
        cat = {
            "id": cat_id, "name": data.get("name", "Untitled"),
            "description": data.get("description", ""),
            "visual_style": data.get("visual_style", ""),
            "thumbnail": data.get("thumbnail", ""),
            "sort_order": data.get("sort_order", 0),
            "created_at": now, "updated_at": now, "deleted_at": None,
        }
        cats = self._load_gallery_cats()
        cats.append(cat)
        self._save_gallery_cats(cats)
        return self.get_gallery_category(cat_id)

    def list_gallery_categories(self) -> List[dict]:
        cats = self._load_gallery_cats()
        items = self._load_gallery_items_all()
        result = []
        for c in cats:
            if c.get("deleted_at") is not None:
                continue
            count = sum(1 for i in items if c["id"] in i.get("category_ids", []) and i.get("deleted_at") is None)
            c["item_count"] = count
            result.append(c)
        result.sort(key=lambda c: (c.get("sort_order", 0), c.get("name", "")))
        return result

    def get_gallery_category(self, cat_id: int) -> Optional[dict]:
        for c in self._load_gallery_cats():
            if c["id"] == cat_id and c.get("deleted_at") is None:
                return c
        return None

    def update_gallery_category(self, cat_id: int, data: dict) -> Optional[dict]:
        cats = self._load_gallery_cats()
        for c in cats:
            if c["id"] == cat_id:
                for key in ["name", "description", "visual_style", "thumbnail", "sort_order"]:
                    if key in data:
                        c[key] = data[key]
                c["updated_at"] = _now()
                self._save_gallery_cats(cats)
                return c
        return None

    def delete_gallery_category(self, cat_id: int) -> bool:
        cats = self._load_gallery_cats()
        for c in cats:
            if c["id"] == cat_id:
                c["deleted_at"] = _now()
        self._save_gallery_cats(cats)
        # Remove from items
        items = self._load_gallery_items_all()
        for i in items:
            if cat_id in i.get("category_ids", []):
                i["category_ids"].remove(cat_id)
        self._save_gallery_items_all(items)
        return True

    # ── Gallery Items ────────────────────────────────────────

    def _gallery_items_path(self) -> str:
        return os.path.join(self.data_dir, "gallery_items.json")

    def _load_gallery_items_all(self) -> List[dict]:
        return self._read(self._gallery_items_path(), [])

    def _save_gallery_items_all(self, items: List[dict]):
        self._write(self._gallery_items_path(), items)

    def create_gallery_item(self, data: dict) -> dict:
        now = _now()
        item_id = self._next_id("next_gallery_item_id")
        item = {
            "id": item_id, "name": data.get("name", ""),
            "char_type": data.get("char_type", "individual"),
            "gender": data.get("gender", ""), "age_range": data.get("age_range", ""),
            "role_type": data.get("role_type", ""),
            "appearance": data.get("appearance", ""),
            "personality": data.get("personality", ""),
            "voice_style": data.get("voice_style", ""),
            "image_url": data.get("image_url", ""),
            "reference_images": json.dumps(data.get("reference_images", [])) if isinstance(data.get("reference_images"), list) else data.get("reference_images", "[]"),
            "tags": data.get("tags", ""),
            "fabric_material": data.get("fabric_material", ""),
            "accessory_material": data.get("accessory_material", ""),
            "is_primary": data.get("is_primary", 0),
            "metadata": json.dumps(data.get("metadata", {})) if isinstance(data.get("metadata"), dict) else data.get("metadata", "{}"),
            "sort_order": data.get("sort_order", 0),
            "category_ids": data.get("category_ids", []),
            "created_at": now, "updated_at": now, "deleted_at": None,
        }
        items = self._load_gallery_items_all()
        items.append(item)
        self._save_gallery_items_all(items)
        return self.get_gallery_item(item_id)

    def list_gallery_items(self, category_id: int = None) -> List[dict]:
        items = self._load_gallery_items_all()
        result = [i for i in items if i.get("deleted_at") is None]
        if category_id:
            result = [i for i in result if category_id in i.get("category_ids", [])]
        result.sort(key=lambda i: (i.get("sort_order", 0), i.get("name", "")))
        return result

    def get_gallery_item(self, item_id: int) -> Optional[dict]:
        for i in self._load_gallery_items_all():
            if i["id"] == item_id and i.get("deleted_at") is None:
                return i
        return None

    def update_gallery_item(self, item_id: int, data: dict) -> Optional[dict]:
        items = self._load_gallery_items_all()
        for i in items:
            if i["id"] == item_id:
                for key in ["name", "char_type", "gender", "age_range", "role_type",
                             "appearance", "personality", "voice_style", "image_url",
                             "tags", "sort_order", "fabric_material", "accessory_material", "is_primary"]:
                    if key in data:
                        i[key] = data[key]
                for key in ["reference_images", "metadata"]:
                    if key in data:
                        i[key] = json.dumps(data[key]) if isinstance(data[key], (list, dict)) else data[key]
                if "category_ids" in data:
                    i["category_ids"] = data["category_ids"]
                i["updated_at"] = _now()
                self._save_gallery_items_all(items)
                return i
        return None

    def delete_gallery_item(self, item_id: int) -> bool:
        items = self._load_gallery_items_all()
        for i in items:
            if i["id"] == item_id:
                i["deleted_at"] = _now()
        self._save_gallery_items_all(items)
        return True

    def search_gallery_items(self, query: str = "", gender: str = "",
                              age_range: str = "", visual_style: str = "") -> List[dict]:
        items = [i for i in self._load_gallery_items_all() if i.get("deleted_at") is None]
        if query:
            q = query.lower()
            items = [i for i in items if q in (i.get("name", "") + i.get("appearance", "") + i.get("tags", "") + i.get("role_type", "")).lower()]
        if gender:
            items = [i for i in items if i.get("gender") == gender]
        if age_range:
            items = [i for i in items if i.get("age_range") == age_range]
        if visual_style:
            vs = visual_style.lower()
            cats = self._load_gallery_cats()
            matching_cat_ids = {c["id"] for c in cats if vs in (c.get("visual_style", "") or "").lower()}
            items = [i for i in items if any(cid in matching_cat_ids for cid in i.get("category_ids", []))]
        items.sort(key=lambda i: (i.get("sort_order", 0), i.get("name", "")))
        return items

    # ── Presets ──────────────────────────────────────────────

    def _presets_path(self) -> str:
        return os.path.join(self.data_dir, "presets.json")

    def _load_presets(self) -> List[dict]:
        return self._read(self._presets_path(), [])

    def _save_presets(self, presets: List[dict]):
        self._write(self._presets_path(), presets)

    def get_preset(self, name: str) -> Optional[dict]:
        for p in self._load_presets():
            if p.get("name") == name:
                return p
        return None

    def save_preset(self, name: str, data: dict) -> dict:
        now = _now()
        presets = self._load_presets()
        for p in presets:
            if p.get("name") == name:
                p["data"] = json.dumps(data) if isinstance(data, dict) else data
                p["updated_at"] = now
                self._save_presets(presets)
                return p
        preset = {
            "id": self._next_id("next_preset_id"),
            "name": name,
            "data": json.dumps(data) if isinstance(data, dict) else data,
            "created_at": now, "updated_at": now,
        }
        presets.append(preset)
        self._save_presets(presets)
        return preset

    def list_presets(self) -> List[dict]:
        return self._load_presets()

    def delete_preset(self, name: str) -> bool:
        presets = self._load_presets()
        presets = [p for p in presets if p.get("name") != name]
        self._save_presets(presets)
        return True

    # ── Backward-compat helpers ──────────────────────────────

    def _dict(self, row) -> Optional[dict]:
        """Compat with SQLite Row objects — JSON store already returns dicts."""
        return dict(row) if row else None
