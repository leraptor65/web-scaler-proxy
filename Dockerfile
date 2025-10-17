# Use a lightweight Node.js image
FROM node:20-slim

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./
RUN npm install

# Copy the rest of the application code
COPY . .

# FIX: Create the data directory and set ownership before mounting the volume.
# This ensures the 'node' user can write to the volume from the start.
RUN mkdir -p /usr/src/app/data && chown -R node:node /usr/src/app

# This directory will hold our persistent configuration
VOLUME /usr/src/app/data

# Switch to the non-root node user for better security
USER node

# Expose the port the app runs on
EXPOSE 1337

# The command to start the application
CMD ["node", "app.js"]

