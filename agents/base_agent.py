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
    "vi": "Viết toàn bộ nội dung bằng tiếng Việt. Sử dụng văn phong tự nhiên, phù hợp drama/novel Việt Nam.",
    "en": "Write all content in English. Use natural screenwriting conventions.",
    "zh": "使用中文撰写所有内容。遵循中文短剧编剧规范。",
    "ko": "한국어로 모든 콘텐츠를 작성하세요. 한국 드라마 대본 형식을 따르세요.",
    "ja": "すべてのコンテンツを日本語で作成してください。日本のドラマ脚本の形式に従ってください。",
    "th": "เขียนเนื้อหาทั้งหมดเป็นภาษาไทย ใช้รูปแบบบทละครไทย",
    "id": "Tulis semua konten dalam Bahasa Indonesia. Gunakan format penulisan skenario drama.",
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
        full_system = f"{self.system_prompt}\n\n## Language Requirement\n{lang_prompt}"

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
            "max_tokens": 4096,
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
                        error_msg = f"AI API error {response.status_code}: {body.decode()[:500]}"
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
                            if content:
                                yield content
                        except json.JSONDecodeError:
                            continue
        except httpx.ConnectError as e:
            yield f"❌ Cannot connect to AI API: {e}"
        except Exception as e:
            logger.error(f"Agent streaming error: {e}")
            yield f"❌ Error: {str(e)[:300]}"

    async def chat_complete(self, user_message: str, language: str,
                            base_url: str, api_key: str, model: str,
                            temperature: float = 0.7,
                            context: Optional[dict] = None) -> str:
        """Non-streaming call, collects full response."""
        result = []
        async for chunk in self.chat_stream(
            user_message, language, base_url, api_key, model, temperature, context
        ):
            result.append(chunk)
        return "".join(result)
