#!/bin/bash
set -e

echo "🚀 Starting Achichiz API Deployment..."

# 1. Pull the latest code (assuming you are running this in the cloned directory)
echo "📦 Pulling latest code..."
git pull origin main

# 2. Build the Docker image
echo "🔨 Building Docker image (achichiz-api:latest)..."
docker build -t achichiz-api:latest .

# 3. Apply database migrations
# We run the migrations using a temporary container from the new image before we swap the live containers.
# The image contains /app/dist/db/migrate.js as built by the Dockerfile.
echo "🗄️ Running database migrations..."
docker run --rm --env-file .env achichiz-api:latest node dist/db/migrate.js

# 4. Restart the containers with zero-downtime recreation
echo "🔄 Restarting API and Worker containers..."
docker compose -f docker-compose.production.yml up -d

# 5. Clean up dangling/old images to prevent disk space exhaustion
echo "🧹 Cleaning up old Docker images..."
docker image prune -f

echo "✅ Deployment complete! The API is now running."
