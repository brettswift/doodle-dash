'use strict';
// Public static allowlist and security headers shared by the Node and Cloudflare hosts.
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/geom.js': ['geom.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/admin/dashboard.js': ['admin.js', 'text/javascript; charset=utf-8'],
  '/privacy': ['privacy.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/social-preview.png': ['social-preview.png', 'image/png'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/fonts/Schoolbell-400.woff2': ['fonts/Schoolbell-400.woff2', 'font/woff2'],
  '/fonts/PatrickHand-400.woff2': ['fonts/PatrickHand-400.woff2', 'font/woff2'],
};
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' wss: ws:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" };
module.exports = { FILES, SEC };
