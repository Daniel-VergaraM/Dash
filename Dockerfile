FROM node:22-alpine

WORKDIR /app

# Deps first so a source edit does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js auth.js lib.js ./
COPY public ./public

# auth.json, tokens.json and the notes live here; the volume mounts over it.
RUN mkdir -p data/notes && chown -R node:node /app

USER node
EXPOSE 3000

# No --env-file: the environment comes from compose, not a file inside the image.
CMD ["node", "server.js"]
