"""
Content Studio Database Schema
SQLite tables for drama projects, episodes, characters, scenes, storyboards.
Ported from Huobao Drama (Drizzle/TypeScript) to Python sqlite3.
"""

SCHEMA_SQL = """
-- Drama projects
CREATE TABLE IF NOT EXISTS dramas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    genre TEXT DEFAULT '',
    style TEXT DEFAULT 'realistic',
    language TEXT DEFAULT 'vi',
    total_episodes INTEGER DEFAULT 1,
    total_duration INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',
    thumbnail TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

-- Episodes / Chapters
CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT DEFAULT '',
    script_content TEXT DEFAULT '',
    description TEXT DEFAULT '',
    duration INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft',
    video_url TEXT DEFAULT '',
    thumbnail TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    FOREIGN KEY (drama_id) REFERENCES dramas(id)
);

-- Characters
CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT '',
    description TEXT DEFAULT '',
    appearance TEXT DEFAULT '',
    personality TEXT DEFAULT '',
    voice_style TEXT DEFAULT '',
    image_url TEXT DEFAULT '',
    reference_images TEXT DEFAULT '[]',
    sort_order INTEGER DEFAULT 0,
    voice_sample_url TEXT DEFAULT '',
    voice_provider TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    FOREIGN KEY (drama_id) REFERENCES dramas(id)
);

-- Episode-Character (M:N)
CREATE TABLE IF NOT EXISTS episode_characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (episode_id) REFERENCES episodes(id),
    FOREIGN KEY (character_id) REFERENCES characters(id)
);

-- Scenes
CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER NOT NULL,
    episode_id INTEGER,
    location TEXT NOT NULL,
    time TEXT NOT NULL,
    prompt TEXT DEFAULT '',
    description TEXT DEFAULT '',
    storyboard_count INTEGER DEFAULT 1,
    image_url TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    FOREIGN KEY (drama_id) REFERENCES dramas(id)
);

-- Episode-Scene (M:N)
CREATE TABLE IF NOT EXISTS episode_scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    scene_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (episode_id) REFERENCES episodes(id),
    FOREIGN KEY (scene_id) REFERENCES scenes(id)
);

-- Storyboards (shot breakdown)
CREATE TABLE IF NOT EXISTS storyboards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL,
    scene_id INTEGER,
    storyboard_number INTEGER NOT NULL,
    title TEXT DEFAULT '',
    location TEXT DEFAULT '',
    time TEXT DEFAULT '',
    shot_type TEXT DEFAULT '',
    angle TEXT DEFAULT '',
    movement TEXT DEFAULT '',
    action TEXT DEFAULT '',
    result TEXT DEFAULT '',
    atmosphere TEXT DEFAULT '',
    image_prompt TEXT DEFAULT '',
    video_prompt TEXT DEFAULT '',
    bgm_prompt TEXT DEFAULT '',
    sound_effect TEXT DEFAULT '',
    dialogue TEXT DEFAULT '',
    description TEXT DEFAULT '',
    duration INTEGER DEFAULT 10,
    composed_image TEXT DEFAULT '',
    first_frame_image TEXT DEFAULT '',
    last_frame_image TEXT DEFAULT '',
    reference_images TEXT DEFAULT '[]',
    video_url TEXT DEFAULT '',
    narration_text TEXT DEFAULT '',
    tts_audio_url TEXT DEFAULT '',
    subtitle_url TEXT DEFAULT '',
    composed_video_url TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    FOREIGN KEY (episode_id) REFERENCES episodes(id)
);

-- Storyboard-Character (M:N)
CREATE TABLE IF NOT EXISTS storyboard_characters (
    storyboard_id INTEGER NOT NULL,
    character_id INTEGER NOT NULL,
    PRIMARY KEY (storyboard_id, character_id),
    FOREIGN KEY (storyboard_id) REFERENCES storyboards(id),
    FOREIGN KEY (character_id) REFERENCES characters(id)
);

-- Export history
CREATE TABLE IF NOT EXISTS export_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    drama_id INTEGER,
    episode_id INTEGER,
    format TEXT NOT NULL,
    file_path TEXT DEFAULT '',
    drive_url TEXT DEFAULT '',
    drive_id TEXT DEFAULT '',
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL
);

-- Auto Pipeline Jobs (batch queue for automated content creation)
CREATE TABLE IF NOT EXISTS auto_pipeline_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL DEFAULT 'youtube_link',
    source_url TEXT NOT NULL,
    source_title TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    error_message TEXT DEFAULT '',

    -- Config snapshot
    preset_name TEXT DEFAULT '',
    pipeline_template TEXT DEFAULT 'drama_scene',
    content_format TEXT DEFAULT 'Educational / Learning',
    visual_style TEXT DEFAULT 'Default',
    max_episodes INTEGER DEFAULT 1,
    language TEXT DEFAULT 'vi',
    voice_preset TEXT DEFAULT '',
    browser_profiles TEXT DEFAULT '[]',
    aspect_ratio TEXT DEFAULT '16:9',
    narration_source TEXT DEFAULT 'prose',

    -- SEO config
    seo_mode TEXT DEFAULT 'ai_generate',
    seo_title_template TEXT DEFAULT '',
    seo_description_template TEXT DEFAULT '',
    seo_tags TEXT DEFAULT '[]',

    -- Upload config
    upload_targets TEXT DEFAULT '[]',
    upload_privacy TEXT DEFAULT 'private',

    -- Result references
    drama_id INTEGER,
    episode_ids TEXT DEFAULT '[]',
    uploaded_video_ids TEXT DEFAULT '[]',
    output_video_path TEXT DEFAULT '',

    -- Extracted content
    extracted_text TEXT DEFAULT '',

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (drama_id) REFERENCES dramas(id)
);

-- Channel Watchers (monitor channels for new videos)
CREATE TABLE IF NOT EXISTS channel_watchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL DEFAULT 'youtube',
    channel_url TEXT NOT NULL,
    channel_id TEXT DEFAULT '',
    channel_name TEXT DEFAULT '',

    -- Config
    preset_name TEXT DEFAULT '',
    pipeline_template TEXT DEFAULT 'drama_scene',
    content_format TEXT DEFAULT 'Educational / Learning',
    visual_style TEXT DEFAULT 'Default',
    max_episodes INTEGER DEFAULT 1,
    language TEXT DEFAULT 'vi',
    voice_preset TEXT DEFAULT '',
    browser_profiles TEXT DEFAULT '[]',
    seo_mode TEXT DEFAULT 'ai_generate',
    upload_targets TEXT DEFAULT '[]',
    upload_privacy TEXT DEFAULT 'private',

    -- Tracking
    last_checked_at TEXT,
    last_video_id TEXT DEFAULT '',
    known_video_ids TEXT DEFAULT '[]',
    check_interval_minutes INTEGER DEFAULT 30,
    is_active INTEGER DEFAULT 1,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- ═══════════════════════════════════════════════════
-- Character Gallery — reusable character templates
-- ═══════════════════════════════════════════════════

-- Gallery Categories (groups of characters)
CREATE TABLE IF NOT EXISTS char_gallery_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    visual_style TEXT DEFAULT '',
    thumbnail TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

-- Gallery Items (template characters)
CREATE TABLE IF NOT EXISTS char_gallery_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    char_type TEXT DEFAULT 'individual',
    gender TEXT DEFAULT '',
    age_range TEXT DEFAULT '',
    role_type TEXT DEFAULT '',
    appearance TEXT DEFAULT '',
    personality TEXT DEFAULT '',
    voice_style TEXT DEFAULT '',
    image_url TEXT DEFAULT '',
    reference_images TEXT DEFAULT '[]',
    tags TEXT DEFAULT '',
    metadata TEXT DEFAULT '{}',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

-- Gallery Category-Item junction (M:N)
CREATE TABLE IF NOT EXISTS char_gallery_category_items (
    category_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    PRIMARY KEY (category_id, item_id),
    FOREIGN KEY (category_id) REFERENCES char_gallery_categories(id),
    FOREIGN KEY (item_id) REFERENCES char_gallery_items(id)
);

-- ═══════════════════════════════════════════════════
-- Presets — server-side storage for wizard presets
-- ═══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    data TEXT DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""
