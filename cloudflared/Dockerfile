# Single-container, health-gated Cloudflare Tunnel connector.
#
# The official cloudflare/cloudflared image is distroless (no shell), so an
# in-process supervisor can't run inside it. We copy just the static binary
# onto Alpine, which gives us /bin/sh + wget for the health loop. The
# supervisor runs cloudflared as a child and SIGTERMs it when the backend is
# unhealthy (draining + deregistering from the Cloudflare edge), so traffic
# fails over to other connectors. No Docker socket needed.
FROM cloudflare/cloudflared:latest AS cf

FROM alpine:3.20
# ca-certificates: cloudflared needs the system trust store to dial the edge.
# wget is already provided by busybox in the base image.
RUN apk add --no-cache ca-certificates tini
COPY --from=cf /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
# tini reaps the cloudflared child and forwards signals cleanly.
ENTRYPOINT ["/sbin/tini", "--", "/bin/sh", "/entrypoint.sh"]
