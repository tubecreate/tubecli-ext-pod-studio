"""
Content Studio Database Manager
Singleton SQLite connection with CRUD helpers.
"""
import os
import sqlite3
import json
import logging
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

from db.schema import SCHEMA_SQL

logger = logging.getLogger("ContentStudio.DB")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Database:
    """SQLite database manager for Content Studio."""

    _instance: Optional["Database"] = None

    def __init__(self, db_path: str):
        self.db_path = db_path
        self.conn: Optional[sqlite3.Connection] = None

    @classmethod
    def get_instance(cls, db_path: str = "") -> "Database":
        if cls._instance is None:
            if not db_path:
                raise ValueError("db_path required for first initialization")
            cls._instance = cls(db_path)
            cls._instance._connect()
        return cls._instance

    def _connect(self):
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self._init_tables()
        logger.info(f"Database connected: {self.db_path}")

    def _init_tables(self):
        self.conn.executescript(SCHEMA_SQL)
        self.conn.commit()
        # Migrations for existing databases
        self._migrate()

    def _migrate(self):
        """Add missing columns to existing tables."""
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(storyboards)").fetchall()}
        if "narration_text" not in cols:
            self.conn.execute("ALTER TABLE storyboards ADD COLUMN narration_text TEXT DEFAULT ''")
            self.conn.commit()
            logger.info("Migration: added narration_text to storyboards")

    def _dict(self, row: sqlite3.Row) -> dict:
        if row is None:
            return None
        return dict(row)

    def _dicts(self, rows) -> List[dict]:
        return [dict(r) for r in rows]

    # ── Drama CRUD ──────────────────────────────────────────

    def create_drama(self, data: dict) -> dict:
        now = _now()
        cur = self.conn.execute(
            """INSERT INTO dramas (title, description, genre, style, language,
               total_episodes, status, tags, metadata, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                data.get("title", "Untitled"),
                data.get("description", ""),
                data.get("genre", ""),
                data.get("style", "realistic"),
                data.get("language", "vi"),
                data.get("total_episodes", 1),
                "draft",
                data.get("tags", ""),
                json.dumps(data.get("metadata", {})),
                now, now,
            ),
        )
        self.conn.commit()
        return self.get_drama(cur.lastrowid)

    def get_drama(self, drama_id: int) -> Optional[dict]:
        row = self.conn.execute(
            "SELECT * FROM dramas WHERE id = ? AND deleted_at IS NULL",
            (drama_id,),
        ).fetchone()
        return self._dict(row)

    def list_dramas(self) -> List[dict]:
        """Lightweight listing: only drama metadata + episode count for sidebar."""
        rows = self.conn.execute(
            """SELECT d.*, 
                      (SELECT COUNT(*) FROM episodes e WHERE e.drama_id = d.id AND e.deleted_at IS NULL) as episode_count
               FROM dramas d 
               WHERE d.deleted_at IS NULL 
               ORDER BY d.updated_at DESC"""
        ).fetchall()
        dramas = self._dicts(rows)
        return dramas

    def get_drama_full(self, drama_id: int) -> Optional[dict]:
        """Full drama with episodes, characters, scenes (used when selecting a project)."""
        d = self.get_drama(drama_id)
        if not d:
            return None
        d["episodes"] = self._dicts(self.conn.execute(
            "SELECT id, episode_number, title, status FROM episodes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY episode_number",
            (d["id"],),
        ).fetchall())
        d["characters"] = self._dicts(self.conn.execute(
            "SELECT id, name, role FROM characters WHERE drama_id = ? AND deleted_at IS NULL",
            (d["id"],),
        ).fetchall())
        d["scenes"] = self._dicts(self.conn.execute(
            "SELECT id, location, time FROM scenes WHERE drama_id = ? AND deleted_at IS NULL",
            (d["id"],),
        ).fetchall())
        return d

    def update_drama(self, drama_id: int, data: dict) -> Optional[dict]:
        fields = []
        values = []
        for key in ["title", "description", "genre", "style", "language",
                     "total_episodes", "status", "tags", "metadata"]:
            if key in data:
                fields.append(f"{key} = ?")
                values.append(data[key])
        if not fields:
            return self.get_drama(drama_id)
        fields.append("updated_at = ?")
        values.append(_now())
        values.append(drama_id)
        self.conn.execute(
            f"UPDATE dramas SET {', '.join(fields)} WHERE id = ?", values
        )
        self.conn.commit()
        return self.get_drama(drama_id)

    def delete_drama(self, drama_id: int) -> bool:
        self.conn.execute(
            "UPDATE dramas SET deleted_at = ? WHERE id = ?", (_now(), drama_id)
        )
        self.conn.commit()
        return True

    # ── Episode CRUD ────────────────────────────────────────

    def create_episode(self, drama_id: int, data: dict) -> dict:
        now = _now()
        # Get next episode number
        row = self.conn.execute(
            "SELECT MAX(episode_number) as mx FROM episodes WHERE drama_id = ? AND deleted_at IS NULL",
            (drama_id,),
        ).fetchone()
        next_num = (row["mx"] or 0) + 1 if row else 1

        cur = self.conn.execute(
            """INSERT INTO episodes (drama_id, episode_number, title, content,
               script_content, description, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                drama_id, next_num,
                data.get("title", f"Episode {next_num}"),
                data.get("content", ""),
                data.get("script_content", ""),
                data.get("description", ""),
                "draft", now, now,
            ),
        )
        self.conn.commit()
        return self.get_episode(cur.lastrowid)

    def get_episode(self, episode_id: int) -> Optional[dict]:
        row = self.conn.execute(
            "SELECT * FROM episodes WHERE id = ? AND deleted_at IS NULL",
            (episode_id,),
        ).fetchone()
        return self._dict(row)

    def list_episodes(self, drama_id: int) -> List[dict]:
        rows = self.conn.execute(
            "SELECT * FROM episodes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY episode_number",
            (drama_id,),
        ).fetchall()
        return self._dicts(rows)

    def update_episode(self, episode_id: int, data: dict) -> Optional[dict]:
        fields = []
        values = []
        for key in ["title", "content", "script_content", "description", "status", "video_url", "audio_url", "metadata"]:
            if key in data:
                fields.append(f"{key} = ?")
                values.append(data[key])
        if not fields:
            return self.get_episode(episode_id)
        fields.append("updated_at = ?")
        values.append(_now())
        values.append(episode_id)
        self.conn.execute(
            f"UPDATE episodes SET {', '.join(fields)} WHERE id = ?", values
        )
        self.conn.commit()
        return self.get_episode(episode_id)

    # ── Character CRUD ──────────────────────────────────────

    def list_characters(self, drama_id: int) -> List[dict]:
        rows = self.conn.execute(
            "SELECT * FROM characters WHERE drama_id = ? AND deleted_at IS NULL ORDER BY sort_order, id",
            (drama_id,),
        ).fetchall()
        return self._dicts(rows)

    def create_character(self, drama_id: int, data: dict) -> dict:
        now = _now()
        cur = self.conn.execute(
            """INSERT INTO characters (drama_id, name, role, description, appearance,
               personality, voice_style, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (drama_id, data.get("name", ""), data.get("role", ""),
             data.get("description", ""), data.get("appearance", ""),
             data.get("personality", ""), data.get("voice_style", ""),
             now, now),
        )
        self.conn.commit()
        return self._dict(self.conn.execute("SELECT * FROM characters WHERE id = ?", (cur.lastrowid,)).fetchone())

    def update_character(self, char_id: int, data: dict) -> Optional[dict]:
        fields = []
        values = []
        for key in ["name", "role", "description", "appearance", "personality",
                     "voice_style", "image_url", "reference_images", "voice_sample_url"]:
            if key in data:
                fields.append(f"{key} = ?")
                values.append(data[key])
        if not fields:
            return self._dict(self.conn.execute("SELECT * FROM characters WHERE id = ?", (char_id,)).fetchone())
        fields.append("updated_at = ?")
        values.append(_now())
        values.append(char_id)
        self.conn.execute(f"UPDATE characters SET {', '.join(fields)} WHERE id = ?", values)
        self.conn.commit()
        return self._dict(self.conn.execute("SELECT * FROM characters WHERE id = ?", (char_id,)).fetchone())

    def delete_character(self, char_id: int) -> bool:
        self.conn.execute("UPDATE characters SET deleted_at = ? WHERE id = ?", (_now(), char_id))
        self.conn.commit()
        return True

    # ── Scene CRUD ──────────────────────────────────────────

    def list_scenes(self, drama_id: int) -> List[dict]:
        rows = self.conn.execute(
            "SELECT * FROM scenes WHERE drama_id = ? AND deleted_at IS NULL ORDER BY id",
            (drama_id,),
        ).fetchall()
        return self._dicts(rows)

    def update_scene(self, scene_id: int, data: dict) -> Optional[dict]:
        fields = []
        values = []
        for key in ["location", "time", "prompt", "description", "image_url", "status"]:
            if key in data:
                fields.append(f"{key} = ?")
                values.append(data[key])
        if not fields:
            return self._dict(self.conn.execute("SELECT * FROM scenes WHERE id = ?", (scene_id,)).fetchone())
        fields.append("updated_at = ?")
        values.append(_now())
        values.append(scene_id)
        self.conn.execute(f"UPDATE scenes SET {', '.join(fields)} WHERE id = ?", values)
        self.conn.commit()
        return self._dict(self.conn.execute("SELECT * FROM scenes WHERE id = ?", (scene_id,)).fetchone())

    # ── Storyboard CRUD ─────────────────────────────────────

    def list_storyboards(self, episode_id: int) -> List[dict]:
        rows = self.conn.execute(
            "SELECT * FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL ORDER BY storyboard_number",
            (episode_id,),
        ).fetchall()
        sbs = self._dicts(rows)
        for sb in sbs:
            char_rows = self.conn.execute(
                "SELECT character_id FROM storyboard_characters WHERE storyboard_id = ?",
                (sb["id"],),
            ).fetchall()
            sb["character_ids"] = [r["character_id"] for r in char_rows]
        return sbs

    def update_storyboard(self, sb_id: int, data: dict) -> Optional[dict]:
        fields = []
        values = []
        for key in ["title", "location", "time", "shot_type", "angle", "movement",
                     "action", "result", "atmosphere", "image_prompt", "video_prompt",
                     "bgm_prompt", "sound_effect", "dialogue", "description",
                     "duration", "scene_id", "status", "composed_image",
                     "first_frame_image", "last_frame_image", "video_url",
                     "narration_text", "tts_audio_url"]:
            if key in data:
                fields.append(f"{key} = ?")
                values.append(data[key])
        if fields:
            fields.append("updated_at = ?")
            values.append(_now())
            values.append(sb_id)
            self.conn.execute(f"UPDATE storyboards SET {', '.join(fields)} WHERE id = ?", values)
            self.conn.commit()
        return self._dict(self.conn.execute("SELECT * FROM storyboards WHERE id = ?", (sb_id,)).fetchone())

    # ── Bulk save helpers (for AI agents) ───────────────────

    def save_characters_dedup(self, drama_id: int, episode_id: int, characters: List[dict]) -> List[dict]:
        """Save characters with smart dedup by name. Returns saved characters."""
        now = _now()
        existing = {c["name"]: c for c in self.list_characters(drama_id)}
        saved = []
        for ch in characters:
            name = ch.get("name", "").strip()
            if not name:
                continue
            if name in existing:
                # Update existing
                self.update_character(existing[name]["id"], ch)
                saved.append(existing[name])
            else:
                # Create new
                new_ch = self.create_character(drama_id, ch)
                existing[name] = new_ch
                saved.append(new_ch)
            # Link to episode
            link_exists = self.conn.execute(
                "SELECT 1 FROM episode_characters WHERE episode_id = ? AND character_id = ?",
                (episode_id, saved[-1]["id"]),
            ).fetchone()
            if not link_exists:
                self.conn.execute(
                    "INSERT INTO episode_characters (episode_id, character_id, created_at) VALUES (?, ?, ?)",
                    (episode_id, saved[-1]["id"], now),
                )
        self.conn.commit()
        return saved

    def save_scenes_dedup(self, drama_id: int, episode_id: int, scenes: List[dict]) -> List[dict]:
        """Save scenes with smart dedup by location+time."""
        now = _now()
        existing = {f"{s['location']}|{s['time']}": s for s in self.list_scenes(drama_id)}
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
                cur = self.conn.execute(
                    """INSERT INTO scenes (drama_id, episode_id, location, time, prompt,
                       description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (drama_id, episode_id, loc, time_s,
                     sc.get("prompt", ""), sc.get("description", ""),
                     "pending", now, now),
                )
                new_sc = self._dict(self.conn.execute("SELECT * FROM scenes WHERE id = ?", (cur.lastrowid,)).fetchone())
                existing[key] = new_sc
                saved.append(new_sc)
            link_exists = self.conn.execute(
                "SELECT 1 FROM episode_scenes WHERE episode_id = ? AND scene_id = ?",
                (episode_id, saved[-1]["id"]),
            ).fetchone()
            if not link_exists:
                self.conn.execute(
                    "INSERT INTO episode_scenes (episode_id, scene_id, created_at) VALUES (?, ?, ?)",
                    (episode_id, saved[-1]["id"], now),
                )
        self.conn.commit()
        return saved

    def save_storyboards_bulk(self, episode_id: int, storyboards: List[dict], append: bool = False) -> List[dict]:
        """Save complete storyboard set. Replaces existing unless append is True."""
        now = _now()
        start_number = 1
        
        # Determine continuous starting number across episodes
        ep_row = self.conn.execute("SELECT drama_id, episode_number FROM episodes WHERE id = ?", (episode_id,)).fetchone()
        if ep_row:
            drama_id, ep_num = ep_row["drama_id"], ep_row["episode_number"]
            # Get max storyboard_number from all previous episodes
            prev_mx_row = self.conn.execute("""
                SELECT MAX(s.storyboard_number) as mx
                FROM storyboards s
                JOIN episodes e ON s.episode_id = e.id
                WHERE e.drama_id = ? AND e.episode_number < ? AND s.deleted_at IS NULL
            """, (drama_id, ep_num)).fetchone()
            if prev_mx_row and prev_mx_row["mx"] is not None:
                start_number = prev_mx_row["mx"] + 1

        if not append:
            # Soft-delete old shots for CURRENT episode
            self.conn.execute(
                "UPDATE storyboards SET deleted_at = ? WHERE episode_id = ? AND deleted_at IS NULL",
                (now, episode_id),
            )
        else:
            row = self.conn.execute("SELECT MAX(storyboard_number) as mx FROM storyboards WHERE episode_id = ? AND deleted_at IS NULL", (episode_id,)).fetchone()
            if row and row["mx"] is not None:
                start_number = row["mx"] + 1

        saved = []
        for i, sb in enumerate(storyboards, start_number):
            cur = self.conn.execute(
                """INSERT INTO storyboards (episode_id, scene_id, storyboard_number,
                   title, location, time, shot_type, angle, movement, action, result,
                   atmosphere, image_prompt, video_prompt, bgm_prompt, sound_effect,
                   dialogue, description, narration_text, duration, status, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    episode_id, sb.get("scene_id"), i,
                    sb.get("title", ""), sb.get("location", ""), sb.get("time", ""),
                    sb.get("shot_type", ""), sb.get("angle", ""), sb.get("movement", ""),
                    sb.get("action", ""), sb.get("result", ""), sb.get("atmosphere", ""),
                    sb.get("image_prompt", ""), sb.get("video_prompt", ""),
                    sb.get("bgm_prompt", ""), sb.get("sound_effect", ""),
                    sb.get("dialogue", ""), sb.get("description", ""),
                    sb.get("narration_text", ""),
                    sb.get("duration", 10), "pending", now, now,
                ),
            )
            sb_id = cur.lastrowid
            # Link characters
            for char_id in sb.get("character_ids", []):
                try:
                    self.conn.execute(
                        "INSERT OR IGNORE INTO storyboard_characters (storyboard_id, character_id) VALUES (?, ?)",
                        (sb_id, char_id),
                    )
                except Exception:
                    pass
            saved.append(self._dict(self.conn.execute("SELECT * FROM storyboards WHERE id = ?", (sb_id,)).fetchone()))
        self.conn.commit()
        return saved

    # ── Auto Pipeline Jobs CRUD ──────────────────────────────

    def create_pipeline_job(self, data: dict) -> dict:
        now = _now()
        cur = self.conn.execute(
            """INSERT INTO auto_pipeline_jobs (source_type, source_url, source_title, status,
               preset_name, pipeline_template, content_format, visual_style, max_episodes,
               language, voice_preset, browser_profiles,
               seo_mode, seo_title_template, seo_description_template, seo_tags,
               upload_targets, upload_privacy, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                data.get("source_type", "youtube_link"),
                data.get("source_url", ""),
                data.get("source_title", ""),
                "pending",
                data.get("preset_name", ""),
                data.get("pipeline_template", "drama_scene"),
                data.get("content_format", "Educational / Learning"),
                data.get("visual_style", "Default"),
                data.get("max_episodes", 1),
                data.get("language", "vi"),
                data.get("voice_preset", ""),
                json.dumps(data.get("browser_profiles", [])),
                data.get("seo_mode", "ai_generate"),
                data.get("seo_title_template", ""),
                data.get("seo_description_template", ""),
                json.dumps(data.get("seo_tags", [])),
                json.dumps(data.get("upload_targets", [])),
                data.get("upload_privacy", "private"),
                now, now,
            ),
        )
        self.conn.commit()
        return self._dict(self.conn.execute("SELECT * FROM auto_pipeline_jobs WHERE id = ?", (cur.lastrowid,)).fetchone())

    def list_pipeline_jobs(self, status: str = None, limit: int = 100) -> List[dict]:
        if status:
            rows = self.conn.execute(
                "SELECT * FROM auto_pipeline_jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?",
                (status, limit),
            ).fetchall()
        else:
            rows = self.conn.execute(
                "SELECT * FROM auto_pipeline_jobs ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return self._dicts(rows)

    def get_pipeline_job(self, job_id: int) -> Optional[dict]:
        row = self.conn.execute("SELECT * FROM auto_pipeline_jobs WHERE id = ?", (job_id,)).fetchone()
        return self._dict(row)

    def update_pipeline_job(self, job_id: int, data: dict) -> Optional[dict]:
        fields = []
        values = []
        for key in ["source_title", "status", "error_message", "drama_id",
                     "episode_ids", "uploaded_video_ids", "output_video_path", "extracted_text",
                     "preset_name", "pipeline_template", "content_format", "visual_style", 
                     "max_episodes", "language", "voice_preset", "browser_profiles",
                     "seo_mode", "seo_title_template", "seo_description_template", "seo_tags",
                     "upload_targets", "upload_privacy"]:
            if key in data:
                fields.append(f"{key} = ?")
                values.append(data[key] if not isinstance(data[key], (list, dict)) else json.dumps(data[key]))
        if not fields:
            return self.get_pipeline_job(job_id)
        fields.append("updated_at = ?")
        values.append(_now())
        values.append(job_id)
        self.conn.execute(f"UPDATE auto_pipeline_jobs SET {', '.join(fields)} WHERE id = ?", values)
        self.conn.commit()
        return self.get_pipeline_job(job_id)

    def delete_pipeline_job(self, job_id: int) -> bool:
        self.conn.execute("DELETE FROM auto_pipeline_jobs WHERE id = ?", (job_id,))
        self.conn.commit()
        return True

    def get_next_pending_job(self) -> Optional[dict]:
        """Get the oldest pending job for queue processing."""
        row = self.conn.execute(
            "SELECT * FROM auto_pipeline_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1"
        ).fetchone()
        return self._dict(row)

    # ── Channel Watchers CRUD ────────────────────────────────

    def create_channel_watcher(self, data: dict) -> dict:
        now = _now()
        cur = self.conn.execute(
            """INSERT INTO channel_watchers (platform, channel_url, channel_id, channel_name,
               preset_name, pipeline_template, content_format, visual_style, max_episodes,
               language, voice_preset, browser_profiles, seo_mode,
               upload_targets, upload_privacy, check_interval_minutes,
               is_active, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                data.get("platform", "youtube"),
                data.get("channel_url", ""),
                data.get("channel_id", ""),
                data.get("channel_name", ""),
                data.get("preset_name", ""),
                data.get("pipeline_template", "drama_scene"),
                data.get("content_format", "Educational / Learning"),
                data.get("visual_style", "Default"),
                data.get("max_episodes", 1),
                data.get("language", "vi"),
                data.get("voice_preset", ""),
                json.dumps(data.get("browser_profiles", [])),
                data.get("seo_mode", "ai_generate"),
                json.dumps(data.get("upload_targets", [])),
                data.get("upload_privacy", "private"),
                data.get("check_interval_minutes", 30),
                1, now, now,
            ),
        )
        self.conn.commit()
        return self._dict(self.conn.execute("SELECT * FROM channel_watchers WHERE id = ?", (cur.lastrowid,)).fetchone())

    def list_channel_watchers(self) -> List[dict]:
        rows = self.conn.execute("SELECT * FROM channel_watchers ORDER BY created_at DESC").fetchall()
        return self._dicts(rows)

    def get_channel_watcher(self, watcher_id: int) -> Optional[dict]:
        row = self.conn.execute("SELECT * FROM channel_watchers WHERE id = ?", (watcher_id,)).fetchone()
        return self._dict(row)

    def update_channel_watcher(self, watcher_id: int, data: dict) -> Optional[dict]:
        fields = []
        values = []
        for key in ["channel_name", "channel_id", "last_checked_at", "last_video_id",
                     "known_video_ids", "check_interval_minutes", "is_active",
                     "preset_name", "pipeline_template", "content_format", "visual_style",
                     "max_episodes", "language", "voice_preset", "browser_profiles",
                     "seo_mode", "upload_targets", "upload_privacy"]:
            if key in data:
                fields.append(f"{key} = ?")
                val = data[key]
                values.append(json.dumps(val) if isinstance(val, (list, dict)) else val)
        if not fields:
            return self.get_channel_watcher(watcher_id)
        fields.append("updated_at = ?")
        values.append(_now())
        values.append(watcher_id)
        self.conn.execute(f"UPDATE channel_watchers SET {', '.join(fields)} WHERE id = ?", values)
        self.conn.commit()
        return self.get_channel_watcher(watcher_id)

    def delete_channel_watcher(self, watcher_id: int) -> bool:
        self.conn.execute("DELETE FROM channel_watchers WHERE id = ?", (watcher_id,))
        self.conn.commit()
        return True

