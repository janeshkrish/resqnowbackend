# Base image
FROM node:18-alpine

# Working directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy source code
COPY . .

# Expose API port
EXPOSE 3001

# Start the server
CMD ["npm", "start"]
