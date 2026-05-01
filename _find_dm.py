f=open('data/extensions_external/content_studio/studio_routes.py','r',encoding='utf-8')
for i,l in enumerate(f):
    if 'drama_meta' in l and 1960 <= i+1 <= 2250:
        print(f'{i+1}: {l.rstrip()}')
