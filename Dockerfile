FROM texlive/texlive:latest-full

RUN apt-get update \
    && apt-get install -y --no-install-recommends unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY texdiff.sh /usr/local/bin/texdiff
RUN chmod +x /usr/local/bin/texdiff

ENTRYPOINT ["/usr/local/bin/texdiff"]
