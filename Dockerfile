# Base image
FROM node:22-alpine

# Working directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source code
COPY . .

# Expose API port
EXPOSE 3001

# Start the server
CMD ["npm", "start"]
