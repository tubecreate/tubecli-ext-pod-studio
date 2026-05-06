"""
Content Studio Extension — AI Drama/Novel Content Writer for TubeCLI.
Script rewriting, character extraction, storyboard breaking, multi-language.
"""
import os
import sys
import logging
import importlib.util

try:
    from tubecli.core.extension_manager import Extension
except ImportError:
    from TubeCLI.core.extension_manager import Extension

logger = logging.getLogger("ContentStudio")


class ContentStudioExtension(Extension):
    name = "content_studio"
    version = "1.0.0"
    description = "AI Content Studio — Drama/Novel script writing with AI"
    author = "TubeCreate"
    extension_type = "external"

    def on_enable(self):
        logger.info("Content Studio extension enabled")
        self._ensure_httpx()
        self._init_database()
        self._init_settings()
        self._register_skill()

    def _ensure_httpx(self):
        """Ensure httpx is installed."""
        try:
            import httpx
        except ImportError:
            logger.info("Installing httpx...")
            import subprocess
            try:
                subprocess.check_call(
                    [sys.executable, "-m", "pip", "install", "httpx", "-q"]
                )
                logger.info("httpx installed successfully.")
            except Exception as e:
                logger.warning(f"Failed to install httpx: {e}")

    def _init_database(self):
        """Initialize JSON file store (migrated from SQLite)."""
        try:
            from tubecli.config import DATA_DIR
            data_dir = os.path.join(str(DATA_DIR), "content_studio")
            os.makedirs(data_dir, exist_ok=True)

            # Dynamic import from extension dir
            ext_dir = self.extension_dir or os.path.dirname(os.path.abspath(__file__))
            if ext_dir not in sys.path:
                sys.path.insert(0, ext_dir)

            from db.json_store import JsonStore
            JsonStore.get_instance(data_dir)
            logger.info(f"JsonStore initialized: {data_dir}")

            # Auto-migrate from SQLite if old DB exists AND migration hasn't completed
            old_db = os.path.join(data_dir, "content_studio.db")
            index_file = os.path.join(data_dir, "dramas_index.json")
            if os.path.exists(old_db) and not os.path.exists(index_file):
                logger.info("Found old SQLite DB, starting migration...")
                from db.migrate_db_to_json import migrate
                migrate(old_db, data_dir)
            elif os.path.exists(old_db) and os.path.exists(index_file):
                # Migration already done but DB wasn't renamed — try again
                for ext in ["-shm", "-wal"]:
                    wal = old_db + ext
                    if os.path.exists(wal):
                        try:
                            os.remove(wal)
                        except Exception:
                            pass
                try:
                    os.rename(old_db, old_db + ".migrated")
                    logger.info("Old SQLite DB renamed to .migrated")
                except Exception:
                    logger.warning("Could not rename old DB — migration already complete, ignoring.")
        except Exception as e:
            logger.error(f"Failed to init store: {e}")
            import traceback
            traceback.print_exc()

    def _init_settings(self):
        """Initialize extension settings."""
        try:
            from tubecli.config import DATA_DIR
            data_dir = os.path.join(str(DATA_DIR), "content_studio")
            os.makedirs(data_dir, exist_ok=True)

            ext_dir = self.extension_dir or os.path.dirname(os.path.abspath(__file__))
            if ext_dir not in sys.path:
                sys.path.insert(0, ext_dir)

            from config.settings_manager import StudioSettings
            self._studio_settings = StudioSettings(data_dir)
            logger.info("Settings initialized")
        except Exception as e:
            logger.error(f"Failed to init settings: {e}")

    def _register_skill(self):
        """Register Content Studio skill for chatbot routing."""
        try:
            from tubecli.core.skill import skill_manager
            existing = skill_manager.find_by_name("Content Studio")
            if existing:
                logger.info("Content Studio skill already registered, skipping.")
                return

            skill_manager.create(
                name="Content Studio",
                description=(
                    "AI Content Studio — Viết kịch bản drama/novel bằng AI. "
                    "Hỗ trợ chuyển đổi tiểu thuyết → kịch bản, trích xuất nhân vật/bối cảnh, "
                    "tạo phân cảnh chi tiết, gợi ý giọng nói, tạo prompt hình ảnh. "
                    "Hỗ trợ đa ngôn ngữ: Tiếng Việt, English, 中文, 한국어, 日本語."
                ),
                skill_type="Extension Skill",
                commands=[
                    "viết kịch bản", "viết drama", "write script", "drama writer",
                    "content studio", "tạo nhân vật", "trích xuất nhân vật",
                    "extract characters", "phân cảnh", "storyboard", "tách cảnh",
                    "viết tiểu thuyết", "write novel", "tạo kịch bản",
                ],
                workflow_data={
                    "extension": "content_studio",
                    "action": "write_content",
                    "sop": (
                        "1. Mở Content Studio tại /content-studio\n"
                        "2. Tạo dự án drama mới\n"
                        "3. Tạo episode, paste nội dung tiểu thuyết\n"
                        "4. Sử dụng AI Agent để rewrite → extract → storyboard\n"
                        "5. Export kịch bản ra MD/TXT/DOCX hoặc Google Drive"
                    ),
                },
            )
            logger.info("✅ Content Studio skill registered successfully.")
        except Exception as e:
            logger.warning(f"Could not register Content Studio skill: {e}")

    def get_routes(self):
        """Load and return FastAPI router."""
        try:
            ext_dir = self.extension_dir or os.path.dirname(os.path.abspath(__file__))
            if ext_dir not in sys.path:
                sys.path.insert(0, ext_dir)

            routes_file = os.path.join(ext_dir, "studio_routes.py")
            spec = importlib.util.spec_from_file_location("studio_ext_routes", routes_file)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            router = getattr(mod, "router", None)
            logger.info(f"Content Studio: loaded router, {len(router.routes) if router else 0} routes")
            return router
        except Exception as e:
            logger.error(f"Failed to load Content Studio routes: {e}")
            import traceback
            traceback.print_exc()
            return None

    def get_telegram_actions(self):
        return {
            "write_content": self._action_write_content,
        }

    async def _action_write_content(self, action_data: dict, context: dict) -> str:
        """Telegram action stub: direct user to Content Studio UI."""
        return (
            "🎬 **Content Studio**\n\n"
            "Mở Content Studio để viết kịch bản drama bằng AI:\n"
            "📎 `/content-studio`\n\n"
            "Các tính năng:\n"
            "• Chuyển đổi tiểu thuyết → kịch bản drama\n"
            "• Trích xuất nhân vật & bối cảnh\n"
            "• Tạo phân cảnh chi tiết\n"
            "• Hỗ trợ đa ngôn ngữ (VI/EN/ZH/KO/JA)"
        )
