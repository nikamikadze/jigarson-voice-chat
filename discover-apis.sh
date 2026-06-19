#!/usr/bin/env bash
# Lists EVERYTHING your API keys can access (models + capabilities).
# Listing is free — works even when generation credits are depleted.
# Run:  bash discover-apis.sh
cd "$(dirname "$0")"
set -a; [ -f .env ] && . ./.env; set +a

echo "================= GOOGLE / GEMINI (AI Studio) ================="
if [ -n "${GEMINI_API_KEY:-}" ]; then
  curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY&pageSize=300" \
  | python3 -c '
import sys,json
try: d=json.load(sys.stdin)
except Exception as e: print("  parse error:",e); sys.exit()
if "error" in d: print("  ERROR:",d["error"].get("message","")[:200]); sys.exit()
def tag(ms):
  t=[]
  if "generateContent" in ms: t.append("chat")
  if "bidiGenerateContent" in ms: t.append("LIVE")
  if "embedContent" in ms: t.append("embed")
  if "predict" in ms: t.append("img/predict")
  if "countTokens" in ms: t.append("")
  return ",".join(x for x in t if x)
rows=[]
for m in d.get("models",[]):
  n=m.get("name","").replace("models/","")
  rows.append((n, tag(m.get("supportedGenerationMethods",[]))))
for n,t in sorted(rows):
  print(f"  {n:46s} {t}")
print(f"\n  TOTAL: {len(rows)} models")
'
else echo "  (no GEMINI_API_KEY in .env)"; fi

echo
echo "================= OPENAI ================="
if [ -n "${OPENAI_API_KEY:-}" ]; then
  curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" \
  | python3 -c '
import sys,json
try: d=json.load(sys.stdin)
except Exception as e: print("  parse error:",e); sys.exit()
if "error" in d: print("  ERROR:",d["error"].get("message","")[:200]); sys.exit()
ids=sorted(m["id"] for m in d.get("data",[]))
# group by family for readability
def fam(i):
  for k in ("gpt-5","gpt-4o","gpt-4","o3","o4","o1","dall-e","gpt-image","tts","whisper","transcribe","embedding","realtime","sora"):
    if k in i: return k
  return "other"
from collections import defaultdict
g=defaultdict(list)
for i in ids: g[fam(i)].append(i)
for k in sorted(g):
  print(f"  [{k}]")
  for i in g[k]: print("     "+i)
print(f"\n  TOTAL: {len(ids)} models")
'
else echo "  (no OPENAI_API_KEY in .env — add it in PROVIDER KEYS, then rerun)"; fi

echo
echo "Done. Paste this whole output back."
