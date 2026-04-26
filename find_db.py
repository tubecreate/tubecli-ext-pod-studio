
import os
import glob
import sys

# Change default encoding to utf-8 for stdout
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

dbs = glob.glob('C:/tubecreate-vue/tubecli/data/**/*.db', recursive=True)
for db in dbs:
    if 'studio' in db.lower() or 'content' in db.lower():
        print(f"Found DB: {db}")
