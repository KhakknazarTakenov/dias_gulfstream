# Use official Node.js LTS (Alpine) image
FROM node:20-alpine as base

# Set Kazakhstan (Almaty) timezone
ENV TZ=Asia/Almaty

# Install tzdata and configure timezone
RUN apk add --no-cache tzdata \
    && cp /usr/share/zoneinfo/${TZ} /etc/localtime \
    && echo "${TZ}" > /etc/timezone \
    && apk del tzdata

# Create app directory
WORKDIR /app

# Copy only package files first to leverage Docker cache
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Expose application port
EXPOSE 4671

# Start the server
CMD ["node", "index.js"]
