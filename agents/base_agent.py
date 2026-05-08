"""
POD Studio Base Agent
OpenAI-compatible AI agent with SSE streaming support.
"""
import json
import logging
from typing import AsyncGenerator, List, Dict, Any, Optional

logger = logging.getLogger("PodStudio.Agent")

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
    """Base class for POD Studio AI agents.
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
        # Instead of hacking/neutering the campaign prompt, load a dedicated
        # skill template that REPLACES the system prompt entirely.
        if context:
            content_format = context.get("content_format", "Ad Campaign / Narrative")
            if content_format and "Ad Campaign" not in content_format and "Phim" not in content_format:
                skill_prompt = self._load_format_skill(content_format)
                if skill_prompt:
                    base_prompt = skill_prompt
                    logger.info(f"[{self.agent_type}] Loaded skill template for: {content_format}")
                else:
                    # Fallback: generic override if no skill file found
                    base_prompt += f"\n\n## CRITICAL FORMAT OVERRIDE\nThe user requested CONTENT FORMAT: [{content_format}]. ADAPT your output completely to this format instead of a standard campaign."
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
                        f"Type={gc.get('char_type','individual')}, Gender={gc.get('gender','')}, "
                        f"Tags={gc.get('tags','')}, "
                        f"Role={gc.get('role_type','')}, Age={gc.get('age_range','')}, "
                        f"Appearance=\"{gc.get('appearance_summary','')[:150]}\""
                    )
                roster_text = "\n".join(roster_lines)

                gallery_injection = (
                    "\n\n## GALLERY-FIRST CHARACTER SELECTION (HIGHEST PRIORITY)\n"
                    "You have a CHARACTER GALLERY with pre-defined characters. "
                    "You MUST follow this strict selection algorithm:\n\n"
                    "### Available Gallery Models & Products:\n"
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
                    "4. **TYPE MATCHING (CRITICAL)**:\n"
                    "   - `Type=individual` → single person/character.\n"
                    "   - `Type=duo` → a PAIR of characters (couple, two friends, two rivals).\n"
                    "   - `Type=group` → a GROUP of 3+ characters.\n"
                    "   - `Type=friend` → a pair/group of FRIENDS.\n"
                    "   When the script describes interactions between TWO characters (a couple, rivals, partners), "
                    "prefer a `duo` or `friend` gallery item over two separate `individual` items.\n"
                    "   When the script describes a group/team/class, prefer a `group` gallery item.\n"
                    "5. **CREATE NEW ONLY IF**: No gallery character remotely fits the role. "
                    "In that case, set `gallery_item_id` to null.\n"
                    "6. **NEVER DUPLICATE**: If a gallery character is already in `existing_characters`, "
                    "do NOT re-extract them.\n\n"
                    "### Required Output Fields for EVERY character:\n"
                    "```\n"
                    '"gallery_item_id": <int from gallery ID, or null if no match>,\n'
                    '"suitability_score": <int 0-100, or null>\n'
                    "```\n"
                )
                base_prompt += gallery_injection
                logger.info(f"[extractor] Injected GALLERY-FIRST rules ({len(gallery_chars)} gallery chars available)")

            # ── Graphic Template Injection (Presentation format) ──
            graphic_templates = context.get("available_graphic_templates")
            if graphic_templates:
                template_lines = []
                for gt in graphic_templates:
                    template_lines.append(
                        f"  - ID={gt['id']}, Name=\"{gt['name']}\", "
                        f"Type={gt.get('type','')}, Tags={gt.get('tags','')}, "
                        f"Style: {gt.get('style_description','')}"
                    )
                template_text = "\n".join(template_lines)

                graphic_injection = (
                    "\n\n## GRAPHIC TEMPLATE GALLERY (HIGHEST PRIORITY)\n"
                    "You have a GRAPHIC TEMPLATE GALLERY with pre-designed visual styles. "
                    "You MUST reference these templates when writing image prompts for each screen.\n\n"
                    "### Available Graphic Templates:\n"
                    f"{template_text}\n\n"
                    "### How to use:\n"
                    "1. For EACH screen, pick the BEST matching template from the gallery above.\n"
                    "2. In the screen's `prompt` field, describe the graphic using that template's STYLE "
                    "(colors, layout, icon style, typography) combined with the actual content.\n"
                    "3. Example: If template is '3D Pie Chart' with style 'colorful 3D segments on dark bg', "
                    "write: 'Flat 2D slide on dark gradient. A colorful 3D pie chart with 4 segments: "
                    "Context 40%, Role 30%, Style 20%, Output 10%. Bold white title: AI Prompt Components. "
                    "Same 3D glossy style as reference template.'\n"
                    "4. NEVER just write a generic description — always reference a specific template style.\n"
                )
                base_prompt += graphic_injection
                logger.info(f"[extractor] Injected GRAPHIC TEMPLATE rules ({len(graphic_templates)} templates available)")

        # ── Anatomy Safety Injection (for storyboard_breaker) ──
        # Appended to ALL storyboard prompts (default + skill-overridden)
        # to prevent AI image generators from creating mutated characters.
        if self.agent_type == "storyboard_breaker":
            anatomy_injection = (
                "\n\n## CHARACTER ANATOMY & COMPOSITION RULES (MANDATORY)\n"
                "When a shot contains characters/people/creatures, follow ALL these rules:\n\n"
                "### Rule 1: COMPOSITION — Prevent Body Duplication\n"
                "- Describe EXACTLY how many characters are in the shot.\n"
                "- For single-character shots, write: 'A single [character description]' — "
                "NEVER just '[character]' alone, always prefix with 'A single' or 'One'.\n"
                "- NEVER describe the same character twice in one prompt.\n"
                "- Specify the character's FULL pose in ONE clear sentence "
                "(e.g., 'standing with arms crossed' NOT 'upper body... lower body...').\n\n"
                "### Rule 2: ANATOMY SUFFIX — Append to image_prompt\n"
                "You MUST append this EXACT phrase to the END of every `image_prompt` that contains characters:\n"
                '", one single complete body, correct human proportions, '
                'five fingers on each hand, no duplicate body parts, no merged torsos, '
                'no extra limbs, no missing limbs, no deformed hands, '
                'anatomically correct, professional quality"\n\n'
                "### Rule 3: FRAMING — Reduce Defect Risk\n"
                "- Prefer medium shots (waist-up) or close-ups over full-body shots — "
                "fewer visible body parts = fewer defects.\n"
                "- If full-body is needed, keep the pose SIMPLE (standing, sitting, walking). "
                "Avoid complex poses like crossed legs, intertwined arms, or hands touching face.\n"
                "- For hands: prefer hands at sides, on hips, or holding a simple object. "
                "NEVER describe detailed finger positions.\n\n"
                "Do NOT add anatomy suffix to scenery-only shots (no characters)."
            )
            base_prompt += anatomy_injection

        # ── Video Length Mode Injection (ALL agents) ──
        # Inject duration-specific constraints based on video_length setting
        if context:
            vl = context.get("video_length", "standard")
            # Backwards compat: old "short" → "short_60s"
            if vl == "short":
                vl = "short_60s"
            
            length_rules = {}
            
            if vl == "short_60s":
                length_rules = {
                    "series_planner": (
                        "\n\n## ⚡ SHORT VIDEO MODE (< 60s) — CONTENT SELECTION\n"
                        "This is for SHORT-FORM video (TikTok/YouTube Shorts/Reels, < 60 seconds).\n"
                        "CRITICAL: Do NOT try to cover everything. Instead:\n"
                        "1. **SCAN** the entire premise for the single most SURPRISING, CONTROVERSIAL, or HIGH-VALUE insight.\n"
                        "2. Each episode = 1 SINGLE powerful idea that makes viewers say 'Wait, really?!'\n"
                        "3. Episode titles must be clickbait-worthy hooks, not summaries.\n"
                        "4. Plot outline for each episode: MAX 2-3 sentences focused on ONE angle.\n"
                        "5. Think like a viral content creator, not a textbook author."
                    ),
                    "novel_writer": (
                        "\n\n## ⚡ SHORT VIDEO MODE (< 60s) — HOOK-FIRST WRITING\n"
                        "This is a SHORT-FORM video (TikTok/YouTube Shorts/Reels, < 60 seconds).\n\n"
                        "### Step 1: ANALYZE (do this mentally, don't write it)\n"
                        "Read ALL the content and identify:\n"
                        "- The most SHOCKING or SURPRISING fact/insight\n"
                        "- The most CONTROVERSIAL or debate-worthy claim\n"
                        "- The most EMOTIONALLY resonant moment\n"
                        "Pick the ONE that would make someone stop scrolling.\n\n"
                        "### Step 2: WRITE using this exact structure\n"
                        "1. **HOOK (first 1-2 sentences)**: Lead with the insight from Step 1. "
                        "Use patterns like: 'Did you know...', 'Most people think X, but actually...'\n"
                        "2. **VALUE (3-5 sentences)**: Core message with concrete details. No repetition.\n"
                        "3. **PUNCHLINE (last 1-2 sentences)**: Twist, takeaway, or CTA.\n\n"
                        "### Hard Rules\n"
                        "- TOTAL: 100-150 words MAXIMUM.\n"
                        "- NO introductions, NO 'In this video...', NO background context.\n"
                        "- Write conversationally, like talking to a friend."
                    ),
                    "script_rewriter": (
                        "\n\n## ⚡ SHORT VIDEO MODE (< 60s) — SCRIPT FORMAT\n"
                        "Format for SHORT-FORM video (< 60 seconds):\n"
                        "- MAX 3-5 scenes. Scene 1 = HOOK (3-second attention grab).\n"
                        "- Last scene = PUNCHLINE or CTA.\n"
                        "- Each scene: MAX 2-3 lines. Total spoken: MAX 150 words.\n"
                        "- Fast cuts, high energy. No slow transitions."
                    ),
                    "storyboard_breaker": (
                        "\n\n## ⚡ SHORT VIDEO MODE (< 60s) — STORYBOARD\n"
                        "SHORT-FORM video (< 60 seconds):\n"
                        "- TOTAL duration: 40-55 seconds. Each shot: 3-5 seconds.\n"
                        "- Maximum 8-10 shots total.\n"
                        "- Shot #1 = THE HOOK. Most visually striking moment.\n"
                        "- Fast-paced transitions. Narration per shot: 1-2 sentences max.\n"
                        "- Last shot: memorable visual + punchline/CTA."
                    ),
                }
            elif vl == "short_3m":
                length_rules = {
                    "series_planner": (
                        "\n\n## 📱 SHORT VIDEO MODE (< 3 min) — CONTENT PLANNING\n"
                        "This is for SHORT video (YouTube Shorts/Reels, 1-3 minutes).\n"
                        "- Each episode = 1 focused topic with clear beginning, middle, end.\n"
                        "- Episode titles should be curiosity-driven hooks.\n"
                        "- Plot outline: 4-6 sentences covering 1 core argument/story arc.\n"
                        "- Include 2-3 supporting points or examples, not just surface-level."
                    ),
                    "novel_writer": (
                        "\n\n## 📱 SHORT VIDEO MODE (< 3 min) — WRITING STRATEGY\n"
                        "This is a SHORT video (1-3 minutes). Write with depth but concisely.\n\n"
                        "### Structure (300-450 words total)\n"
                        "1. **HOOK (2-3 sentences)**: Open with a surprising fact, question, or bold claim.\n"
                        "2. **CONTEXT (3-4 sentences)**: Brief setup — why this matters.\n"
                        "3. **CORE VALUE (8-12 sentences)**: Main content with 2-3 key points. "
                        "Each point gets 2-4 sentences with concrete examples or data.\n"
                        "4. **CONCLUSION (2-3 sentences)**: Memorable takeaway or call-to-action.\n\n"
                        "### Rules\n"
                        "- TOTAL: 300-450 words. NOT more.\n"
                        "- Start strong — no 'In this video...' or generic intros.\n"
                        "- Every paragraph must deliver new information.\n"
                        "- Conversational tone, but with substance."
                    ),
                    "script_rewriter": (
                        "\n\n## 📱 SHORT VIDEO MODE (< 3 min) — SCRIPT FORMAT\n"
                        "Format for SHORT video (1-3 minutes):\n"
                        "- 5-8 scenes total. Scene 1 = HOOK.\n"
                        "- Each scene: 3-5 lines of narration/dialogue.\n"
                        "- Total spoken content: 300-450 words.\n"
                        "- Good pacing — mix of fast and breathing moments.\n"
                        "- If input is too long, compress: keep strongest points, cut filler."
                    ),
                    "storyboard_breaker": (
                        "\n\n## 📱 SHORT VIDEO MODE (< 3 min) — STORYBOARD\n"
                        "SHORT video (1-3 minutes):\n"
                        "- TOTAL duration: 90-170 seconds.\n"
                        "- Each shot: 5-10 seconds. Target 15-25 shots total.\n"
                        "- Shot #1 = Visual HOOK. Grab attention immediately.\n"
                        "- Mix shot types: close-ups for emotion, wide for context.\n"
                        "- Narration per shot: 2-3 sentences.\n"
                        "- Last 2-3 shots: build to memorable conclusion."
                    ),
                }
            elif vl == "long_10m":
                length_rules = {
                    "series_planner": (
                        "\n\n## 📺 LONG VIDEO MODE (> 10 min) — DEEP CONTENT PLANNING\n"
                        "This is for LONG-FORM YouTube video (10-20 minutes).\n"
                        "- Each episode should be COMPREHENSIVE — cover the topic thoroughly.\n"
                        "- Plot outline: 8-15 sentences with detailed structure.\n"
                        "- Include multiple sections: intro hook, background, main argument, "
                        "examples/evidence, counter-arguments, conclusion.\n"
                        "- Break into natural chapters/segments for retention.\n"
                        "- Think like a documentary filmmaker or long-form essayist."
                    ),
                    "novel_writer": (
                        "\n\n## 📺 LONG VIDEO MODE (> 10 min) — DEEP WRITING\n"
                        "This is a LONG-FORM video (10-20 minutes). Write with depth and richness.\n\n"
                        "### Structure (1500-2500 words total)\n"
                        "1. **COLD OPEN / HOOK (3-5 sentences)**: Start with the most compelling moment.\n"
                        "2. **INTRO & CONTEXT (1-2 paragraphs)**: Set the stage, why this matters.\n"
                        "3. **MAIN BODY (5-8 sections)**: Deep exploration with:\n"
                        "   - Concrete examples and stories\n"
                        "   - Data, facts, or expert opinions\n"
                        "   - Analogies to make complex ideas accessible\n"
                        "   - Transitions between sections\n"
                        "4. **CLIMAX / KEY INSIGHT (1-2 paragraphs)**: The 'aha moment'.\n"
                        "5. **CONCLUSION (1 paragraph)**: Strong takeaway + CTA.\n\n"
                        "### Rules\n"
                        "- TOTAL: 1500-2500 words. Be thorough, not padded.\n"
                        "- Use storytelling techniques: tension, surprise, resolution.\n"
                        "- Include 'chapter markers' (section headings) for retention.\n"
                        "- Vary sentence length and rhythm to maintain engagement."
                    ),
                    "script_rewriter": (
                        "\n\n## 📺 LONG VIDEO MODE (> 10 min) — SCRIPT FORMAT\n"
                        "Format for LONG-FORM video (10-20 minutes):\n"
                        "- 15-30 scenes. Organized in 3-5 acts/chapters.\n"
                        "- Include scene headings that serve as chapter markers.\n"
                        "- Mix pacing: intense moments + breathing room.\n"
                        "- Total spoken content: 1500-2500 words.\n"
                        "- Use cliffhangers between chapters to maintain retention.\n"
                        "- Every 2-3 minutes, include a 're-hook' — a new question or surprising turn."
                    ),
                    "storyboard_breaker": (
                        "\n\n## 📺 LONG VIDEO MODE (> 10 min) — STORYBOARD\n"
                        "LONG-FORM video (10-20 minutes):\n"
                        "- TOTAL duration: 600-1200 seconds (10-20 minutes).\n"
                        "- Each shot: 8-15 seconds. Target 50-100 shots total.\n"
                        "- Organize shots into chapters/segments.\n"
                        "- Mix visual variety: talking head, B-roll, graphics, transitions.\n"
                        "- Shot #1 = Cold open hook.\n"
                        "- Include visual 're-hooks' every 15-20 shots.\n"
                        "- Narration per shot: 2-4 sentences."
                    ),
                }
            # else: standard → no injection needed
            
            if length_rules:
                injection = length_rules.get(self.agent_type)
                if injection:
                    base_prompt += injection
                    logger.info(f"[{self.agent_type}] Injected {vl.upper()} video length constraints")

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
        per-agent system prompts that REPLACE the default campaign prompts entirely.
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
            "Presentation / Screen": "presentation.json",
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

    async def chat_stream_with_vision(self, user_message: str, image_b64: str,
                                       language: str, base_url: str, api_key: str,
                                       model: str, temperature: float = 0.7,
                                       context: Optional[dict] = None,
                                       image_mime: str = "image/jpeg") -> AsyncGenerator[str, None]:
        """Stream AI response with vision (image input) support.
        Uses OpenAI-compatible multimodal message format."""
        import httpx

        messages = self._build_messages(user_message, language, context)

        # Convert the last user message to multimodal format with image
        for i in range(len(messages) - 1, -1, -1):
            if messages[i]["role"] == "user":
                text_content = messages[i]["content"]
                messages[i]["content"] = [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{image_mime};base64,{image_b64}"
                        }
                    },
                    {
                        "type": "text",
                        "text": text_content
                    }
                ]
                break

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
                        yield f"❌ [VISION ERROR] HTTP {response.status_code}: {body_text}"
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
        except Exception as e:
            logger.error(f"Vision streaming error: {e}")
            yield f"❌ [VISION ERROR] {str(e)[:300]}"

