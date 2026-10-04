# Iris

Four agents (Researcher, Skeptic, Fact-checker, Devil's advocate) check a statement, then a judge writes the answer, confidence and open doubts.

## Open it
Double-click `index.html`. No install, no internet needed for Demo mode.

Modes (top right):
- Demo: saved Einstein run, works offline. Use this for the presentation.
- Ollama: local models. Start with `OLLAMA_ORIGINS=* ollama serve`, then `ollama pull llama3.1`.
- Gemini: paste a key from Google AI Studio under Settings. Needs internet.

## Optional Python backend
`backend/` is a FastAPI version of the same pipeline. See `backend/.env.example`, then `pip install -r requirements.txt` and `uvicorn main:app --reload`.
