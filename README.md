# Team Task Management Web App

A full-stack collaborative task management application for teams. It includes secure signup/login, JWT-style token auth, project membership, Admin/Member roles, task assignment, task status updates, and project dashboards.

## Tech Stack

- Frontend: HTML, CSS, vanilla JavaScript
- Backend: Node.js HTTP server with REST APIs
- Database: SQLite
- Auth: Signed bearer tokens and scrypt password hashing

No npm packages are required. The app uses Node.js built-ins and the local `sqlite3` command.

## Run

```bash
npm start
```

Open:

```text
http://localhost:3000
```

The database is created automatically at `data/app.db`.

## Demo Accounts

The first run creates two demo users:

- Admin: `admin@example.com` / `Password123!`
- Member: `member@example.com` / `Password123!`

## Reset Database

```bash
npm run reset-db
```

## API Overview

- `POST /api/auth/signup`
- `POST /api/auth/login`
- `GET /api/me`
- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:id`
- `POST /api/projects/:id/members`
- `DELETE /api/projects/:id/members/:userId`
- `GET /api/projects/:id/tasks`
- `POST /api/projects/:id/tasks`
- `PATCH /api/tasks/:id`
- `DELETE /api/tasks/:id`
- `GET /api/projects/:id/dashboard`

Admins can manage project members and all tasks. Members can view projects they belong to and update only tasks assigned to them.
