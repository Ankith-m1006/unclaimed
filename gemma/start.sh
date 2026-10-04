#!/bin/sh
# Serve Ollama, pull the Gemma model on first boot, keep the server in the foreground.
ollama serve &
PID=$!
until ollama list >/dev/null 2>&1; do sleep 1; done
ollama pull "${GEMMA_MODEL:-gemma3:4b}"
echo "model ready: ${GEMMA_MODEL:-gemma3:4b}"
wait $PID
