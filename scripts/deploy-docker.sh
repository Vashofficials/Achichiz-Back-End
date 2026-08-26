#!/bin/bash
# ==============================================================================
# Achichiz API - Docker Deployment Script
# ==============================================================================
# This script builds the production Docker image, spins up Postgres and Redis, 
# runs database migrations, and then starts the API and Worker containers.
# ==============================================================================

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}=== Achichiz API Docker Deployment ===${NC}\n"

# 1. Check if .env exists
if [ ! -f ".env" ]; then
  echo -e "${RED}Error: .env file not found!${NC}"
  echo "Please create a .env file based on the required variables before deploying."
  exit 1
fi

# 2. Build the Node.js API image (compiles TS, prunes devDependencies)
echo -e "${GREEN}Step 1/4: Building Docker images...${NC}"
docker compose -f docker-compose.prod.yml build

# 3. Start infrastructure (Redis) and wait for healthchecks
echo -e "${GREEN}Step 2/4: Starting infrastructure (Redis)...${NC}"
docker compose -f docker-compose.prod.yml up -d redis

echo "Waiting for databases to become healthy..."
sleep 5 # Give it a few seconds before depending on the healthcheck loop

# 4. Run Migrations using the built image
echo -e "${GREEN}Step 3/4: Running database migrations...${NC}"
# We spin up a temporary API container just to run the migrate script
docker compose -f docker-compose.prod.yml run --rm api dist/db/migrate.js

# 5. Start the actual application (API + Worker)
echo -e "${GREEN}Step 4/4: Starting API and Worker services...${NC}"
docker compose -f docker-compose.prod.yml up -d api worker

echo -e "\n${BLUE}=== Deployment Complete ===${NC}"
echo -e "API is now running on port 4000 (or the port defined in your .env)."
echo -e "View live logs with: ${GREEN}docker compose -f docker-compose.prod.yml logs -f${NC}"
