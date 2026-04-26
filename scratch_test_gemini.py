import os
import sys
sys.path.append(r'C:\tubecreate-vue')
from tubecli.data.extensions_external.content_studio.studio_routes import _batch_tts_worker_gemini
import asyncio

async def test():
    shots = [
        {"id": 100, "narration_text": "Hello world this is a test.", "tts_audio_url": ""},
        {"id": 101, "narration_text": "This is another test for the second shot.", "tts_audio_url": ""}
    ]
    task_id = "test_task_123"
    from tubecli.data.extensions_external.content_studio.studio_routes import _tts_tasks
    _tts_tasks[task_id] = {"status": "running", "done": 0, "total": 2, "success": 0, "failed": 0, "results": []}
    
    # We just want to test the ALIGNMENT part. So let's mock whisper and full_audio_path
    pass

if __name__ == "__main__":
    asyncio.run(test())
