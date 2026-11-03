# pigeon-whatsapp: one static binary (pure-Go SQLite, no cgo) on distroless, as non-root (65532).
FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /pigeon-whatsapp . && mkdir /data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /pigeon-whatsapp /pigeon-whatsapp
# the session's directory, the non-root user's (a fresh Docker volume takes its owner from here)
COPY --from=build --chown=65532:65532 /data /data
ENV WHATSAPP_DATA=/data WHATSAPP_BIND=:8080
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/pigeon-whatsapp"]
