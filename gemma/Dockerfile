FROM ollama/ollama:latest
ENV OLLAMA_HOST=[::]:11434
ENV OLLAMA_KEEP_ALIVE=24h
COPY start.sh /start.sh
ENTRYPOINT ["/bin/sh", "/start.sh"]
