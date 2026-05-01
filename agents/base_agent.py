"""
Content Studio Base Agent
OpenAI-compatible AI agent with SSE streaming support.
"""
import json
import logging
from typing import AsyncGenerator, List, Dict, Any, Optional

logger = logging.getLogger("ContentStudio.Agent")

# Language-specific system prompt appendages
LANGUAGE_PROMPTS = {
    "vi": "CRITICAL: VIẾT TOÀN BỘ NỘI DUNG BẰNG TIẾNG VIỆT (VIETNAMESE). Dịch tất cả nội dung gốc sang tiếng Việt. Giữ nguyên đúng định dạng yêu cầu.",
    "en": "CRITICAL: Write all content in English. Translate original content to English if needed. Keep the exact format structure.",
    "zh": "CRITICAL: 必须使用中文撰写所有内容。将原始内容翻译为中文。保持严格的格式。",
    "ko": "CRITICAL: 모든 콘텐츠를 한국어로 작성하세요. 원본 콘텐츠를 한국어로 번역하세요. 형식을 엄격하게 유지하세요.",
    "ja": "CRITICAL: すべてのコンテンツを日本語で作成してください。元のコンテンツを日本語に翻訳してください。フォーマットを厳密に維持してください。",
    "th": "CRITICAL: เขียนเนื้อหาทั้งหมดเป็นภาษาไทย แปลเนื้อหาต้นฉบับเป็นภาษาไทยหากจำเป็น รักษารูปแบบที่กำหนดอย่างเคร่งครัด",
    "id": "CRITICAL: Tulis semua konten dalam Bahasa Indonesia. Terjemahkan konten asli ke Bahasa Indonesia jika perlu. Pertahankan struktur format.",
}


class ContentAgent:
    """Base class for Content Studio AI agents.
    Uses httpx to call OpenAI-compatible API with SSE streaming."""

    def __init__(self, agent_type: str, system_prompt: str):
        self.agent_type = agent_type
        self.system_prompt = system_prompt

    def _build_messages(self, user_message: str, language: str = "vi",
                        context: Optional[dict] = None) -> List[dict]:
        """Build messages array with system prompt + language instructions."""
        lang_prompt = LANGUAGE_PROMPTS.get(language, LANGUAGE_PROMPTS["en"])
        
        base_prompt = self.system_prompt

        # ── Skill-based Format Override ──
        # Instead of hacking/neutering the drama prompt, load a dedicated
        # skill template that REPLACES the system prompt entirely.
        if context:
            content_format = context.get("content_format", "Drama / Narrative")
            if content_format and "Drama" not in content_format and "Phim" not in content_format:
                skill_prompt = self._load_format_skill(content_format)
                if skill_prompt:
                    base_prompt = skill_prompt
                    logger.info(f"[{self.agent_type}] Loaded skill template for: {content_format}")
                else:
                    # Fallback: generic override if no skill file found
                    base_prompt += f"\n\n## CRITICAL FORMAT OVERRIDE\nThe user requested CONTENT FORMAT: [{content_format}]. ADAPT your output completely to this format instead of a standard drama."
                    logger.warning(f"[{self.agent_type}] No skill file for '{content_format}', using generic override")

        # ── Gallery-First Injection ──
        # When gallery characters are available, FORCE the AI to select from them
        # instead of inventing new characters. This is appended to ANY extractor
        # prompt (default or skill-based).
        if context and self.agent_type == "extractor":
            gallery_chars = context.get("available_gallery_characters")
            if gallery_chars:
                # Build a concise roster for the prompt
                roster_lines = []
                for gc in gallery_chars:
                    roster_lines.append(
                        f"  - ID={gc['id']}, Name=\"{gc['name']}\", "
                        f"Type={gc.get('char_type','')}, Tags={gc.get('tags','')}, "
                        f"Role={gc.get('role_type','')}, Age={gc.get('age_range','')}"
                    )
                roster_text = "\n".join(roster_lines)

                gallery_injection = (
                    "\n\n## GALLERY-FIRST CHARACTER SELECTION (HIGHEST PRIORITY)\n"
                    "You have a CHARACTER GALLERY with pre-defined characters. "
                    "You MUST follow this strict selection algorithm:\n\n"
                    "### Available Gallery Characters:\n"
                    f"{roster_text}\n\n"
                    "### Selection Rules:\n"
                    "1. **GALLERY FIRST**: For EVERY character or visual actor in the script, "
                    "FIRST check if a gallery character can represent them. "
                    "Use the gallery character's EXACT `name` and set `gallery_item_id` to their ID.\n"
                    "2. **CONSOLIDATE VARIATIONS**: If the script mentions the same character "
                    "in different poses/emotions (e.g. 'Chibi crying', 'Chibi smiling', "
                    "'Chibi thinking'), these are ALL the SAME character. "
                    "Output ONE character entry using the gallery name, NOT separate entries.\n"
                    "3. **FUZZY MATCHING**: A gallery character named 'Nhân vật Chibi' can "
                    "represent 'Nhân vật Chibi đang khóc', 'Chibi character', 'Cute character', etc. "
                    "Match by the BASE character identity, ignoring emotional/action suffixes.\n"
                    "4. **CREATE NEW ONLY IF**: No gallery character remotely fits the role. "
                    "In that case, set `gallery_item_id` to null.\n"
                    "5. **NEVER DUPLICATE**: If a gallery character is already in `existing_characters`, "
                    "do NOT re-extract them.\n\n"
                    "### Required Output Fields for EVERY character:\n"
                    "```\n"
                    '"gallery_item_id": <int from gallery ID, or null if no match>,\n'
                    '"suitability_score": <int 0-100, or null>\n'
                    "```\n"
                )
                base_prompt += gallery_injection
                logger.info(f"[extractor] Injected GALLERY-FIRST rules ({len(gallery_chars)} gallery chars available)")

        # ── Anatomy Safety Injection (for storyboard_breaker) ──
        # Appended to ALL storyboard prompts (default + skill-overridden)
        # to prevent AI image generators from creating mutated characters.
        if self.agent_type == "storyboard_breaker":
            anatomy_injection = (
                "\n\n## ANATOMY SAFETY RULES (MANDATORY)\n"
                "When a shot contains characters/people/creatures, you MUST append this EXACT phrase "
                "to the END of the `image_prompt`:\n"
                '", perfect anatomy, highly detailed, no mutations, no extra limbs, no missing limbs, '
                'exactly two arms, exactly two legs, single head, high quality"\n'
                "Do NOT add this to scenery-only shots (no characters). "
                "This is CRITICAL to prevent AI from generating deformed characters with extra heads, "
                "multiple arms, or missing limbs."
            )
            base_prompt += anatomy_injection

        full_system = f"{base_prompt}\n\n## Language Requirement\n{lang_prompt}"

        messages = [{"role": "system", "content": full_system}]

        # Add context as assistant knowledge if provided
        if context:
            ctx_text = json.dumps(context, ensure_ascii=False, indent=2)
            messages.append({
                "role": "system",
                "content": f"## Current Context Data\n```json\n{ctx_text}\n```"
            })

        messages.append({"role": "user", "content": user_message})
        return messages

    def _load_format_skill(self, content_format: str) -> Optional[str]:
        """Load a dedicated system prompt from a format skill JSON file.
        
        Skill files live in agents/format_skills/*.json and contain
        per-agent system prompts that REPLACE the default drama prompts entirely.
        """
        import os
        
        # Map content_format to skill file name
        FORMAT_TO_FILE = {
            "Educational / Learning": "educational.json",
            "Commercial / Advertisement": "commercial.json",
            "Podcast / Talkshow": "podcast.json",
            "Health & Wellness": "health.json",
            "Faith & Religion": "faith.json",
            "Xianxia Donghua": "xianxia.json",
        }
        
        filename = FORMAT_TO_FILE.get(content_format)
        if not filename:
            return None
        
        skill_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "format_skills",
            filename
        )
        
        if not os.path.exists(skill_path):
            logger.warning(f"Skill file not found: {skill_path}")
            return None
        
        try:
            with open(skill_path, "r", encoding="utf-8") as f:
                skill_data = json.load(f)
            
            # Map agent_type to skill key
            AGENT_TO_KEY = {
                "series_planner": "series_planner",
                "novel_writer": "novel_writer",
                "script_rewriter": "script_rewriter",
                "extractor": "extractor",
                "storyboard_breaker": "storyboard_breaker",
            }
            
            key = AGENT_TO_KEY.get(self.agent_type)
            if key and key in skill_data:
                return skill_data[key]
            
            return None
        except Exception as e:
            logger.error(f"Error loading skill file {filename}: {e}")
            return None

    async def chat_stream(self, user_message: str, language: str,
                          base_url: str, api_key: str, model: str,
                          temperature: float = 0.7,
                          context: Optional[dict] = None) -> AsyncGenerator[str, None]:
        """Stream AI response via SSE using httpx."""
        import httpx

        messages = self._build_messages(user_message, language, context)

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }

        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": 16384,
            "stream": True,
        }

        try:
            # High timeout (10 mins) for long novel generation
            t = httpx.Timeout(connect=60.0, read=600.0, write=60.0, pool=60.0)
            async with httpx.AsyncClient(timeout=t) as client:
                async with client.stream(
                    "POST",
                    f"{base_url}/chat/completions",
                    headers=headers,
                    json=payload,
                ) as response:
                    if response.status_code != 200:
                        body = await response.aread()
                        body_text = body.decode(errors="replace")[:500]
                        # Detect specific API errors
                        if response.status_code == 429:
                            error_msg = f"[AI QUOTA] Model '{model}' has exceeded rate limit or quota. Please wait or switch to another model/API key.\n\nDetails: {body_text}"
                        elif response.status_code in (401, 403):
                            error_msg = f"[AI AUTH] Authentication failed for model '{model}'. Please check your API key in Settings.\n\nDetails: {body_text}"
                        elif response.status_code == 404:
                            error_msg = f"[AI MODEL] Model '{model}' not found at {base_url}. Please check model name in Settings.\n\nDetails: {body_text}"
                        elif response.status_code >= 500:
                            error_msg = f"[AI SERVER] AI server error (HTTP {response.status_code}) for model '{model}'. The AI provider may be down.\n\nDetails: {body_text}"
                        else:
                            error_msg = f"[AI ERROR] HTTP {response.status_code} from model '{model}': {body_text}"
                        logger.error(error_msg)
                        yield f"❌ {error_msg}"
                        return

                    async for line in response.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        data = line[6:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                            delta = chunk.get("choices", [{}])[0].get("delta", {})
                            content = delta.get("content", "")
                            reasoning = delta.get("reasoning_content", "")
                            
                            if reasoning:
                                yield "\x00REASONING\x00"
                            if content:
                                yield content
                        except json.JSONDecodeError:
                            continue
        except httpx.ConnectError as e:
            yield f"❌ [CONNECTION] Cannot connect to AI API at {base_url}. Model: '{model}'. Is the server running?\n\nError: {e}"
        except httpx.TimeoutException as e:
            yield f"❌ [TIMEOUT] AI request timed out for model '{model}'. The model may be overloaded or the content is too long.\n\nError: {e}"
        except Exception as e:
            logger.error(f"Agent streaming error: {e}")
            yield f"❌ [ERROR] Model '{model}': {str(e)[:300]}"

    async def chat_complete(self, user_message: str, language: str,
                            base_url: str, api_key: str, model: str,
                            temperature: float = 0.7,
                            context: Optional[dict] = None) -> str:
        """Non-streaming call, collects full response."""
        result = []
        async for chunk in self.chat_stream(
            user_message, language, base_url, api_key, model, temperature, context
        ):
            if chunk != "\x00REASONING\x00":
                result.append(chunk)
        return "".join(result)
