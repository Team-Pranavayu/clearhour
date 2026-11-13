import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'ClearHour – cleanest hour to step outside',
        short_name: 'ClearHour',
        description:
          'Find the cleanest hours to go outside in the next 24 hours, with simple advice in 11 Indian languages.',
        lang: 'en-IN',
        theme_color: '#0f766e',
        background_color: '#f7f8f6',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        runtimeCaching: [
          {
            // Forecast + city search: try network first, fall back to the last answer when offline.
            urlPattern: /^https:\/\/(air-quality-api|geocoding-api)\.open-meteo\.com\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'open-meteo',
              networkTimeoutSeconds: 8,
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 }
            }
          }
        ]
      }
    })
  ]
});
