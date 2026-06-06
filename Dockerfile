FROM node:22-alpine
WORKDIR /app
COPY server.js .
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q --spider http://127.0.0.1:8080/health || exit 1
CMD ["node","server.js"]
