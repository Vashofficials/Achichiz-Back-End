#!/bin/bash
# ==============================================================================
# Achichiz API - Docker Installation Script for Ubuntu
# ==============================================================================
# This script installs Docker Engine and Docker Compose on a fresh Ubuntu 
# server (like AWS Lightsail or EC2).
# ==============================================================================

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== Installing Docker & Docker Compose ===${NC}\n"

echo "1. Updating apt package index and installing dependencies..."
sudo apt-get update
sudo apt-get install -y ca-certificates curl

echo "2. Adding Docker's official GPG key..."
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "3. Setting up the Docker repository..."
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

echo "4. Installing Docker Engine..."
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "5. Configuring user permissions..."
# This allows the 'ubuntu' user to run docker commands without typing 'sudo'
sudo usermod -aG docker $USER

echo -e "\n${GREEN}=== Docker Installation Complete ===${NC}"
echo -e "IMPORTANT: You must refresh your user group permissions to use Docker without sudo."
echo -e "Please run this command right now:"
echo -e "${BLUE}newgrp docker${NC}"
echo -e "\nAfter running that command, you can run your deployment script:"
echo -e "${BLUE}bash scripts/deploy-docker.sh${NC}"
