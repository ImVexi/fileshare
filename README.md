# Fileshare

A self-hosted file sharing server with automatic video transcoding, Discord embeds, and a web admin panel.

## Features
- **TUS resumable uploads** — reliable uploads that can pause and resume, even on flaky connections
- **Automatic video transcoding** — HEVC → H.264 conversion for broad compatibility
- **Discord embeds** — shared links render rich previews in Discord
- **Web admin panel** — manage uploads through a browser UI
- **Cross-platform** — run natively on Windows with Node.js, or containerized on Linux with Docker

## Tech Stack
- Node.js / JavaScript
- HTML (admin panel / frontend)
- Docker (Dockerfile + docker-compose.yml included)

## Getting Started

### Windows (Node.js)
```bash
npm install
node server.js
```
Or just run `start.bat`.

### Linux (Docker)
```bash
docker-compose up -d
```

## Project Structure
- `server.js` — main server logic
- `public/` — frontend/admin panel assets
- `Dockerfile` / `docker-compose.yml` — container setup
