#!/usr/bin/env bash
# POST interview.mov to the local API, then poll until COMPLETED or FAILED.
# Usage (from repo): cd server && npm run test:api:mov
# Override: API_BASE=http://127.0.0.1:3010 VIDEO=/path/to/other.mov npm run test:api:mov

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_BASE="${API_BASE:-http://127.0.0.1:3001}"

if [[ -z "${VIDEO:-}" ]]; then
  for cand in "$ROOT/media/interview.mov" "$ROOT/media/Interview.mov"; do
    if [[ -f "$cand" ]]; then
      VIDEO="$cand"
      break
    fi
  done
fi

if [[ -z "${VIDEO:-}" ]] || [[ ! -f "$VIDEO" ]]; then
  echo "Missing video file. Set VIDEO=/path/to/file.mov or place interview.mov / Interview.mov under server/media/"
  exit 1
fi

echo "POST $API_BASE/api/interviews  file=$VIDEO"
RESP_FILE="$(mktemp)"
HTTP_CODE="$(curl -sS -o "$RESP_FILE" -w "%{http_code}" -X POST "$API_BASE/api/interviews" \
  -F "file=@${VIDEO};type=video/quicktime;filename=interview.mov")"

BODY="$(cat "$RESP_FILE")"
rm -f "$RESP_FILE"

echo "HTTP $HTTP_CODE"
echo "$BODY"

if [[ "$HTTP_CODE" != "201" ]]; then
  exit 1
fi

ID="$(node -e "const j=JSON.parse(process.argv[1]); if(!j.id) process.exit(2); console.log(j.id)" "$BODY")"

echo ""
echo "Polling GET $API_BASE/api/interviews/$ID (every 5s, max ~30 min)…"
for i in $(seq 1 360); do
  sleep 5
  G="$(curl -sS "$API_BASE/api/interviews/$ID")"
  STATUS="$(node -e "try{console.log(JSON.parse(process.argv[1]).status)}catch{process.exit(3)}" "$G")"
  echo "[$i] status=$STATUS"
  if [[ "$STATUS" == "COMPLETED" ]] || [[ "$STATUS" == "FAILED" ]]; then
    node -e "
      const j = JSON.parse(process.argv[1]);
      const ev = j.result?.evaluation;
      console.log(JSON.stringify({
        status: j.status,
        hasResult: !!j.result,
        evaluationStatus: ev?.status,
        transcriptSegments: j.transcripts?.length,
        errorMessage: j.errorMessage,
      }, null, 2));
    " "$G"
    if [[ "$STATUS" == "FAILED" ]]; then
      exit 1
    fi
    exit 0
  fi
done

echo "Timeout waiting for job to finish."
exit 1
