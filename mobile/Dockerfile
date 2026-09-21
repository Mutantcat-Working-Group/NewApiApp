FROM node:22-bookworm-slim AS build

WORKDIR /app

ARG VERSION=1.0.20260923
ENV APP_VERSION=${VERSION}

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN mkdir -p dist && npx react-native bundle \
    --platform android \
    --dev false \
    --entry-file index.js \
    --bundle-output dist/index.android.bundle \
    --assets-dest dist/assets

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ARG VERSION=1.0.20260923
ENV APP_VERSION=${VERSION}

COPY --from=build /app/package.json /app/package-lock.json /app/app.json /app/babel.config.js /app/index.js /app/jest.config.js /app/metro.config.js /app/tsconfig.json /app/App.tsx ./
COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist
COPY --from=build /app/android ./android
COPY --from=build /app/ios ./ios

CMD ["sh", "-c", "echo 'NewApiApp mobile image ready (version ${APP_VERSION})' && ls -la dist"]
