
segments = [
    {"start": 1, "text": "A B"},
    {"start": 2, "text": "C D"},
    {"start": 3, "text": "E F"},
    {"start": 4, "text": "G H"}
]
def clean(t): return t.replace(" ", "").lower()

def W(i, n):
    return clean("".join([s["text"] for s in segments[i:i+n]]))

anchor = "cdef"
for i in range(len(segments)):
    w_curr = W(i, 3)
    w_next = W(i+1, 2)
    print(f"i={i}, W(i,3)={w_curr}, W(i+1,2)={w_next}")
    if anchor in w_curr and anchor not in w_next:
        print(f"-> Anchor starts at segment {i}")
