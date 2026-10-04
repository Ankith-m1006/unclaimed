# Unclaimed

Find open-source issues nobody has taken yet.

During Hacktoberfest, a fresh `good first issue` can get its first "can I work on this?" within 20 minutes. By the time you open it, it may be assigned, already have a pull request, carry a "not ready for contributions" banner, or have five people asking for it in the comments. Unclaimed checks all of that for you.

## How it works

1. **Hard facts from the GitHub API.** For each open issue with the label you choose, it checks the assignees, linked pull requests (open or merged, from the issue timeline), and the "not ready for contributions" banner some projects add. Any of these settles the verdict without asking the model.
2. **Gemma reads the thread.** When nothing hard blocks the issue, the comment thread decides. Gemma 3 (4B), an open-weight model, runs on our own Ollama server and reads the issue and its latest comments. It returns structured JSON: who asked to be assigned or says they are working on it, what a maintainer decided, a one-sentence summary of the work, and a difficulty estimate.
3. **Guard rails.** Only usernames that actually commented in the thread are kept, so the model can't invent claimants. If Gemma is unreachable, a keyword fallback answers and the card says so.

Verdicts: **Available**, **Claimed**, **Assigned**, **Has a PR**, **Not ready**, **Closed**.

## Run it yourself

You need Node 20+ and [Ollama](https://ollama.com).

```bash
ollama pull gemma3:4b
git clone https://github.com/Ankith-m1006/unclaimed && cd unclaimed
GITHUB_TOKEN=<optional read-only token> node server.js
# open http://localhost:3000
```

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434` | Where Ollama is running |
| `GEMMA_MODEL` | `gemma3:4b` | `gemma3:1b` is faster but misses claims in long threads |
| `GEMMA_THREADS` | `8` | CPU threads for inference |
| `GITHUB_TOKEN` | none | Fine-grained, public-repositories read-only token. Without it GitHub allows 60 requests an hour. |
| `MAX_ISSUES` | `15` | Newest issues checked per scan |

`gemma/` contains the Dockerfile used to host Ollama with Gemma on a small CPU server.

## Built by

[Ankith-m1006](https://github.com/Ankith-m1006), for and with [SanjanaG-01](https://github.com/SanjanaG-01).

MIT licence.
