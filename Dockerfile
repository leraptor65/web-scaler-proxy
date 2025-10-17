# Use a lightweight Node.js image
FROM node:20-slim

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and install dependencies
COPY package.json ./
RUN npm install

# Copy the rest of the application code
COPY . .

# FIX: Change ownership of the app directory to the node user
# This allows the app to write the config.json file to the mounted volume.
RUN chown -R node:node /usr/src/app

# This directory will hold our persistent configuration
VOLUME /usr/src/app/data

# Switch to the non-root node user for better security
USER node

# Expose the port the app runs on
EXPOSE 1337

# The command to start the application
CMD ["node", "app.js"]