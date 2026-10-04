# Iris

Four agents (Researcher, Skeptic, Fact-checker, Devil's advocate) check a statement, then a judge writes the answer, confidence and open doubts.

## Open it
Double-click `index.html`. No install, no internet needed for Demo mode.

Modes (top right):
- Demo: saved Einstein run, works offline. Use this for the presentation.
- Live: pick a provider and model for each seat under "Configure models" (click "Load available models" to see what Gemini and Ollama really offer). Ollama needs `OLLAMA_ORIGINS=* ollama serve`; Gemini needs a key from Google AI Studio and internet.

## Optional Python backend
`backend/` is a FastAPI version of the same pipeline. See `backend/.env.example`, then `pip install -r requirements.txt` and `uvicorn main:app --reload`.
