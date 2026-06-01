FROM rust:slim AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install cargo-watch for hot reloading
RUN cargo install cargo-watch

WORKDIR /app

EXPOSE 8080

CMD ["cargo", "watch", "-x", "run"]