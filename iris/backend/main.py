import json

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from agents import FALLBACK, SEATS, run_check

app = FastAPI(title="Iris")

# Open for local development. Restrict allow_origins before deploying anywhere public.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class CheckIn(BaseModel):
    question: str = Field(min_length=3, max_length=1000)


@app.get("/api/health")
def health():
    return {"ok": True, "seats": SEATS, "fallback": FALLBACK or None}


@app.post("/api/check")
async def check(body: CheckIn):
    async def stream():
        try:
            async for event in run_check(body.question.strip()):
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as e:  # last-resort guard so the stream always ends cleanly
            yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
    )
