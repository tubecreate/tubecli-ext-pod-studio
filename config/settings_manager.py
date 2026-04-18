"""
Content Studio Settings Manager
Extension-specific settings with global TubeCLI fallback.
"""
import os
import json
import logging
from typing import Optional, Tuple

logger = logging.getLogger("ContentStudio.Settings")

DEFAULT_SETTINGS = {
    "ai_provider": {
        "source": "global",
        "cloud_provider": "",
        "cloud_key_label": "default",
        "cloud_model": "",
        "ollama_model": "",
        "custom_base_url": "",
        "custom_api_key": "",
        "custom_model": "",
        "temperature": 0.7,
        "max_tokens": 8192,
    },
    "script_language": {
        "default": "vi",
        "available": [
            {"code": "vi", "name": "Tiếng Việt", "flag": "🇻🇳"},
            {"code": "en", "name": "English", "flag": "🇺🇸"},
            {"code": "zh", "name": "中文", "flag": "🇨🇳"},
            {"code": "ko", "name": "한국어", "flag": "🇰🇷"},
            {"code": "ja", "name": "日本語", "flag": "🇯🇵"},
            {"code": "th", "name": "ภาษาไทย", "flag": "🇹🇭"},
            {"code": "id", "name": "Bahasa Indonesia", "flag": "🇮🇩"},
        ],
        "custom_languages": [],
    },
    "drive_export": {
        "enabled": False,
        "auth_type": "service_account",
        "credentials_file": "",
        "default_folder_id": "",
        "export_formats": ["google_sheets", "docx", "txt", "md", "json"],
    },
    "agent_configs": {
        "script_rewriter": {"enabled": True, "temperature": 0.7},
        "extractor": {"enabled": True, "temperature": 0.3},
        "storyboard_breaker": {"enabled": True, "temperature": 0.5},
        "voice_assigner": {"enabled": True, "temperature": 0.3},
        "prompt_generator": {"enabled": True, "temperature": 0.7},
    },
}


class StudioSettings:
    """Extension-specific settings with global fallback."""

    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.settings_file = os.path.join(data_dir, "settings.json")
        self._settings = {}
        self._load()

    def _load(self):
        try:
            if os.path.exists(self.settings_file):
                with open(self.settings_file, "r", encoding="utf-8") as f:
                    self._settings = json.load(f)
        except Exception:
            self._settings = {}
        # Merge with defaults
        for key, default_val in DEFAULT_SETTINGS.items():
            if key not in self._settings:
                self._settings[key] = default_val
            elif isinstance(default_val, dict):
                for k2, v2 in default_val.items():
                    if k2 not in self._settings[key]:
                        self._settings[key][k2] = v2

    def _save(self):
        os.makedirs(os.path.dirname(self.settings_file), exist_ok=True)
        with open(self.settings_file, "w", encoding="utf-8") as f:
            json.dump(self._settings, f, indent=2, ensure_ascii=False)

    def get_all(self) -> dict:
        return self._settings

    def update(self, data: dict):
        for key, val in data.items():
            if key in self._settings:
                if isinstance(val, dict) and isinstance(self._settings[key], dict):
                    self._settings[key].update(val)
                else:
                    self._settings[key] = val
        self._save()
        return self._settings

    def get_script_language(self) -> str:
        return self._settings.get("script_language", {}).get("default", "vi")

    def get_ai_config(self) -> dict:
        return self._settings.get("ai_provider", DEFAULT_SETTINGS["ai_provider"])

    def get_agent_config(self, agent_type: str) -> dict:
        agents = self._settings.get("agent_configs", {})
        return agents.get(agent_type, {"enabled": True, "temperature": 0.7})

    # ── Provider base URL mapping ──
    PROVIDER_BASE_URLS = {
        "openai": "https://api.openai.com/v1",
        "gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
        "claude": "https://api.anthropic.com/v1",
        "deepseek": "https://api.deepseek.com/v1",
        "grok": "https://api.x.ai/v1",
        "github": "https://models.inference.ai.azure.com",
    }

    PROVIDER_DEFAULT_MODELS = {
        "openai": "gpt-4o-mini",
        "gemini": "gemini-2.5-flash",
        "claude": "claude-sonnet-4-20250514",
        "deepseek": "deepseek-chat",
        "grok": "grok-2",
        "github": "gpt-4o-mini",
    }

    def get_ai_client_params(self) -> Tuple[str, str, str, float]:
        """Resolve AI provider → (base_url, api_key, model, temperature).
        Priority: extension config → cloud_api keys → global fallback."""
        ai = self.get_ai_config()
        source = ai.get("source", "global")
        temp = ai.get("temperature", 0.7)

        if source == "custom":
            return (
                ai.get("custom_base_url", ""),
                ai.get("custom_api_key", ""),
                ai.get("custom_model", ""),
                temp,
            )

        if source == "ollama":
            return (
                "http://localhost:11434/v1",
                "ollama",
                ai.get("ollama_model", "qwen2.5:latest"),
                temp,
            )

        if source == "cloud_api":
            provider = ai.get("cloud_provider", "openai")
            label = ai.get("cloud_key_label", "default")
            model = ai.get("cloud_model", "") or self.PROVIDER_DEFAULT_MODELS.get(provider, "")
            base_url, api_key = self._get_cloud_api_key(provider, label)
            if api_key:
                return (base_url, api_key, model, temp)
            # Fallback: label mismatch → try any active key for this provider
            base_url, api_key = self._get_any_active_key(provider)
            if api_key:
                return (base_url, api_key, model, temp)

        # Default: source == "global" → auto-detect from cloud_api keys
        return self._get_global_ai_params(temp)

    def _get_global_ai_params(self, temperature: float) -> Tuple[str, str, str, float]:
        """Auto-detect AI config: try global_settings first, then auto-find active cloud key."""
        try:
            from tubecli.config import DATA_DIR

            # 1) Check global_settings.json for explicit api_key
            gs_path = os.path.join(str(DATA_DIR), "global_settings.json")
            if os.path.exists(gs_path):
                with open(gs_path, "r", encoding="utf-8") as f:
                    gs = json.load(f)
                api_key = gs.get("api_key", "")
                model = gs.get("default_model", "")
                api_base = gs.get("api_base_url", "")

                # Only use global if it has a real api_key (not the TubeCLI server URL)
                if api_key and api_base and "localhost" not in api_base:
                    return (api_base, api_key, model, temperature)

            # 2) Fallback: auto-detect from cloud_api_keys.json
            #    Find the first active key from any provider
            keys_file = os.path.join(str(DATA_DIR), "cloud_api_keys.json")
            if os.path.exists(keys_file):
                with open(keys_file, "r", encoding="utf-8") as f:
                    all_keys = json.load(f)

                # Try default_model's provider first
                model = gs.get("default_model", "") if os.path.exists(gs_path) else ""
                preferred_provider = self._infer_provider_from_model(model)
                if preferred_provider:
                    base_url, key = self._get_any_active_key(preferred_provider, all_keys)
                    if key:
                        pmodel = model or self.PROVIDER_DEFAULT_MODELS.get(preferred_provider, "")
                        logger.info(f"Auto-detected AI: {preferred_provider}/{pmodel}")
                        return (base_url, key, pmodel, temperature)

                # Try any active provider
                for provider in ["deepseek", "openai", "gemini", "grok", "github", "claude"]:
                    base_url, key = self._get_any_active_key(provider, all_keys)
                    if key:
                        pmodel = self.PROVIDER_DEFAULT_MODELS.get(provider, "")
                        logger.info(f"Auto-detected AI fallback: {provider}/{pmodel}")
                        return (base_url, key, pmodel, temperature)

        except Exception as e:
            logger.warning(f"Could not resolve global AI params: {e}")

        return ("https://api.openai.com/v1", "", "gpt-4o-mini", temperature)

    def _get_cloud_api_key(self, provider: str, label: str) -> Tuple[str, str]:
        """Read a specific API key by provider+label from cloud_api key store."""
        try:
            from tubecli.config import DATA_DIR
            keys_file = os.path.join(str(DATA_DIR), "cloud_api_keys.json")
            if os.path.exists(keys_file):
                with open(keys_file, "r", encoding="utf-8") as f:
                    keys = json.load(f)
                entry = keys.get(provider, {}).get(label, {})
                api_key = entry.get("key", "")
                if api_key and entry.get("active", True):
                    base_url = self.PROVIDER_BASE_URLS.get(provider, "https://api.openai.com/v1")
                    return (base_url, api_key)
        except Exception as e:
            logger.warning(f"Could not read cloud_api keys: {e}")
        return ("", "")

    def _get_any_active_key(self, provider: str, all_keys: dict = None) -> Tuple[str, str]:
        """Find ANY active key for a given provider."""
        try:
            if all_keys is None:
                from tubecli.config import DATA_DIR
                keys_file = os.path.join(str(DATA_DIR), "cloud_api_keys.json")
                if not os.path.exists(keys_file):
                    return ("", "")
                with open(keys_file, "r", encoding="utf-8") as f:
                    all_keys = json.load(f)

            provider_keys = all_keys.get(provider, {})
            for label, entry in provider_keys.items():
                if entry.get("key") and entry.get("active", True):
                    base_url = self.PROVIDER_BASE_URLS.get(provider, "https://api.openai.com/v1")
                    return (base_url, entry["key"])
        except Exception as e:
            logger.warning(f"Could not find active key for {provider}: {e}")
        return ("", "")

    @staticmethod
    def _infer_provider_from_model(model: str) -> Optional[str]:
        """Infer provider name from model string."""
        if not model:
            return None
        m = model.lower()
        if "deepseek" in m:
            return "deepseek"
        if "gpt" in m or "o1" in m or "o3" in m:
            return "openai"
        if "gemini" in m:
            return "gemini"
        if "claude" in m:
            return "claude"
        if "grok" in m:
            return "grok"
        return None
