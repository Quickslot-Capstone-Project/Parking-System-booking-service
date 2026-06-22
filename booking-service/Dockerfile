# -------- BUILD STAGE --------
FROM node:20-alpine AS builder
 
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
 
# -------- RUN STAGE --------
FROM node:20-alpine
 
WORKDIR /app
 
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
 
COPY --from=builder /app /app
RUN chown -R appuser:appgroup /app
 
USER appuser
 
EXPOSE 4003
CMD ["npm", "start"]
