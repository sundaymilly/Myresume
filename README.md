# Naphtali Sunday – Portfolio with database + admin

Edit documents and write-ups on `/admin`; visitors see the changes immediately. Everything is stored in one SQLite file.

## Run it
Requires **Node.js 22.13 or newer** (no npm install needed).

    ADMIN_PASSWORD="choose-a-strong-password" node server.js

Windows (PowerShell):

    $env:ADMIN_PASSWORD="choose-a-strong-password"; node server.js

- Site:  http://localhost:3000
- Admin: http://localhost:3000/admin

Settings (environment variables): `ADMIN_PASSWORD` (required for a stable password), `PORT` (default 3000), `DB_PATH` (default `data/portfolio.db`).

## Put your photo in
Copy `milly.jpeg` into the `public` folder.

## Hosting
This needs a host that runs Node.js (Render, Railway, Fly.io, a VPS, etc.). It will **not** run on plain static hosting (GitHub Pages, basic cPanel).
Make sure the database file sits on a **persistent disk/volume** (set `DB_PATH` to it), otherwise it resets on each deploy. Put the site behind HTTPS.

## Backup
Copy `data/portfolio.db` – it contains all text and uploaded documents.

## Files
- `server.js` – web server, API and database
- `public/portfolio.html` – the public site
- `public/admin.html` – the admin page (password protected)
