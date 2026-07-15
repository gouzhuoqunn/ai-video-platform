FROM ghcr.io/gouzhuoqunn/ai-creative-comfy-runtime@sha256:187a7eb304075863dbd3f7a1b527530a06783ad8ea0fec5e51e2b9725d1bf137

USER root

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends openssh-server; \
    rm -rf /var/lib/apt/lists/*; \
    mkdir -p /run/sshd /root/.ssh; \
    chmod 0700 /root/.ssh

COPY sshd_config /etc/ssh/sshd_config
COPY --chmod=0755 entrypoint.sh /opt/runpod-bootstrap/entrypoint.sh

EXPOSE 22 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD /usr/bin/test -s /root/.ssh/authorized_keys && /usr/bin/pgrep -x sshd >/dev/null
ENTRYPOINT ["/opt/runpod-bootstrap/entrypoint.sh"]
