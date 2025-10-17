#!/bin/bash
# Exit immediately if a command exits with a non-zero status.
set -e

# --- Configuration ---
IMAGE_NAME="web-scaler-proxy"
CONTAINER_NAME="web-scaler-proxy-instance"
VOLUME_NAME="web-scaler-proxy-data" # Name for our persistent data volume
HOST_PORT="1337"

# --- Docker Reset with Sudo ---
echo "--- Stopping and removing old container... ---"
sudo docker stop $CONTAINER_NAME || true
sudo docker rm $CONTAINER_NAME || true

echo "--- Removing old image... ---"
sudo docker rmi $IMAGE_NAME || true

# FIX: Forcefully remove the old volume to reset permissions on a clean run.
# This ensures the new volume is created with the correct ownership.
echo "--- Removing old Docker volume to reset permissions... ---"
sudo docker volume rm $VOLUME_NAME || true

# --- Volume Creation ---
# Create the volume. If it already exists, this command does nothing.
echo "--- Ensuring Docker volume '$VOLUME_NAME' exists... ---"
sudo docker volume create $VOLUME_NAME

# --- Build and Deploy with Sudo ---
echo "--- Building new Docker image: $IMAGE_NAME ---"
sudo docker build -t $IMAGE_NAME .

echo "--- Running new container: $CONTAINER_NAME ---"
sudo docker run \
  -d \
  --restart always \
  -p $HOST_PORT:1337 \
  -v $VOLUME_NAME:/usr/src/app/data \
  --name $CONTAINER_NAME \
  $IMAGE_NAME

echo "--- ✅ Deployment Complete! ---"
echo "Access the scaled webpage at: http://10.25.1.203:$HOST_PORT"
echo "Configure the URL and scale at: http://10.25.1.203:$HOST_PORT/config"
