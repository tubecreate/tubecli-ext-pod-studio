import sys
import json
import urllib.request

try:
    req = urllib.request.Request("http://127.0.0.1:5295/api/v1/tts/batch/status/check")
    # Actually we don't have a list of all tasks. 
    # Let's read the tubecli log if we can.
except Exception as e:
    print(e)
