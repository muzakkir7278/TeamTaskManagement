import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = resolve('.');
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || join(ROOT, 'data');
const DB_PATH = join(DATA_DIR, 'app.db');
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'local-dev-secret-change-before-deploy';

const resetDatabase = process.argv.includes('--reset-db');

if (resetDatabase && existsSync(DB_PATH)) {
  rmSync(DB_PATH);
}

mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
initializeDatabase();

if (resetDatabase) {
  console.log(`Database reset at ${DB_PATH}`);
  process.exit(0);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith('/api/')) {
      await routeApi(req, res, url);
      return;
    }

    serveStatic(res, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: 'Unexpected server error' });
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the old server or run with PORT=3001 npm start.`);
    process.exit(1);
  }

  console.error('Server failed to start:', error);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Team Task Management running at http://${displayHost}:${PORT}`);
});

async function routeApi(req, res, url) {
  const method = req.method || 'GET';
  const path = url.pathname;

  if (method === 'POST' && path === '/api/auth/signup') {
    return signup(req, res);
  }

  if (method === 'POST' && path === '/api/auth/login') {
    return login(req, res);
  }

  if (method === 'GET' && path === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'team-task-management' });
  }

  const user = authenticate(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Authentication required' });
  }

  if (method === 'GET' && path === '/api/me') {
    return sendJson(res, 200, { user });
  }

  if (method === 'GET' && path === '/api/projects') {
    return listProjects(res, user);
  }

  if (method === 'POST' && path === '/api/projects') {
    return createProject(req, res, user);
  }

  const projectMatch = path.match(/^\/api\/projects\/(\d+)$/);
  if (projectMatch && method === 'GET') {
    return getProject(res, user, Number(projectMatch[1]));
  }

  const membersMatch = path.match(/^\/api\/projects\/(\d+)\/members$/);
  if (membersMatch && method === 'POST') {
    return addMember(req, res, user, Number(membersMatch[1]));
  }

  const removeMemberMatch = path.match(/^\/api\/projects\/(\d+)\/members\/(\d+)$/);
  if (removeMemberMatch && method === 'DELETE') {
    return removeMember(res, user, Number(removeMemberMatch[1]), Number(removeMemberMatch[2]));
  }

  const tasksMatch = path.match(/^\/api\/projects\/(\d+)\/tasks$/);
  if (tasksMatch && method === 'GET') {
    return listTasks(res, user, Number(tasksMatch[1]));
  }

  if (tasksMatch && method === 'POST') {
    return createTask(req, res, user, Number(tasksMatch[1]));
  }

  const taskMatch = path.match(/^\/api\/tasks\/(\d+)$/);
  if (taskMatch && method === 'PATCH') {
    return updateTask(req, res, user, Number(taskMatch[1]));
  }

  if (taskMatch && method === 'DELETE') {
    return deleteTask(res, user, Number(taskMatch[1]));
  }

  const dashboardMatch = path.match(/^\/api\/projects\/(\d+)\/dashboard$/);
  if (dashboardMatch && method === 'GET') {
    return getDashboard(res, user, Number(dashboardMatch[1]));
  }

  sendJson(res, 404, { error: 'Route not found' });
}

async function signup(req, res) {
  const body = await readBody(req);
  const name = cleanText(body.name);
  const email = cleanEmail(body.email);
  const password = String(body.password || '');

  if (!name || name.length < 2) {
    return sendJson(res, 400, { error: 'Name must be at least 2 characters' });
  }

  if (!isValidEmail(email)) {
    return sendJson(res, 400, { error: 'A valid email is required' });
  }

  if (password.length < 8) {
    return sendJson(res, 400, { error: 'Password must be at least 8 characters' });
  }

  const existing = queryOne('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) {
    return sendJson(res, 409, { error: 'Email is already registered' });
  }

  const password_hash = hashPassword(password);
  const created = now();
  run(
    'INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
    [name, email, password_hash, created]
  );

  const user = queryOne('SELECT id, name, email, created_at FROM users WHERE email = ?', [email]);
  sendJson(res, 201, { token: signToken(user), user });
}

async function login(req, res) {
  const body = await readBody(req);
  const email = cleanEmail(body.email);
  const password = String(body.password || '');
  const record = queryOne('SELECT * FROM users WHERE email = ?', [email]);

  if (!record || !verifyPassword(password, record.password_hash)) {
    return sendJson(res, 401, { error: 'Invalid email or password' });
  }

  const user = {
    id: record.id,
    name: record.name,
    email: record.email,
    created_at: record.created_at
  };
  sendJson(res, 200, { token: signToken(user), user });
}

function listProjects(res, user) {
  const projects = queryAll(
    `SELECT p.id, p.name, p.description, p.created_by, p.created_at, pm.role,
            COUNT(DISTINCT t.id) AS task_count,
            COUNT(DISTINCT CASE WHEN t.status = 'Done' THEN t.id END) AS done_count
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
  LEFT JOIN tasks t ON t.project_id = p.id
      WHERE pm.user_id = ?
   GROUP BY p.id, pm.role
   ORDER BY p.created_at DESC`,
    [user.id]
  );
  sendJson(res, 200, { projects });
}

async function createProject(req, res, user) {
  const body = await readBody(req);
  const name = cleanText(body.name);
  const description = cleanText(body.description || '');

  if (!name || name.length < 3) {
    return sendJson(res, 400, { error: 'Project name must be at least 3 characters' });
  }

  const created = now();
  run(
    'INSERT INTO projects (name, description, created_by, created_at) VALUES (?, ?, ?, ?)',
    [name, description, user.id, created]
  );
  const project = queryOne(
    'SELECT * FROM projects WHERE created_by = ? AND created_at = ? ORDER BY id DESC LIMIT 1',
    [user.id, created]
  );
  run(
    'INSERT INTO project_members (project_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
    [project.id, user.id, 'Admin', created]
  );
  sendJson(res, 201, { project: { ...project, role: 'Admin' } });
}

function getProject(res, user, projectId) {
  const membership = requireMembership(res, user.id, projectId);
  if (!membership) return;

  const project = queryOne(
    `SELECT p.*, ? AS role
       FROM projects p
      WHERE p.id = ?`,
    [membership.role, projectId]
  );
  const members = projectMembers(projectId);
  sendJson(res, 200, { project, members });
}

async function addMember(req, res, user, projectId) {
  const admin = requireAdmin(res, user.id, projectId);
  if (!admin) return;

  const body = await readBody(req);
  const email = cleanEmail(body.email);
  const role = body.role === 'Admin' ? 'Admin' : 'Member';

  if (!isValidEmail(email)) {
    return sendJson(res, 400, { error: 'A valid user email is required' });
  }

  const member = queryOne('SELECT id FROM users WHERE email = ?', [email]);
  if (!member) {
    return sendJson(res, 404, { error: 'No registered user found with that email' });
  }

  const existing = queryOne(
    'SELECT id FROM project_members WHERE project_id = ? AND user_id = ?',
    [projectId, member.id]
  );
  if (existing) {
    return sendJson(res, 409, { error: 'User is already a project member' });
  }

  run(
    'INSERT INTO project_members (project_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
    [projectId, member.id, role, now()]
  );

  sendJson(res, 201, { members: projectMembers(projectId) });
}

function removeMember(res, user, projectId, memberId) {
  const admin = requireAdmin(res, user.id, projectId);
  if (!admin) return;

  const project = queryOne('SELECT created_by FROM projects WHERE id = ?', [projectId]);
  if (project?.created_by === memberId) {
    return sendJson(res, 400, { error: 'The project creator cannot be removed' });
  }

  run('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', [projectId, memberId]);
  run('UPDATE tasks SET assignee_id = NULL WHERE project_id = ? AND assignee_id = ?', [projectId, memberId]);
  sendJson(res, 200, { members: projectMembers(projectId) });
}

function listTasks(res, user, projectId) {
  const membership = requireMembership(res, user.id, projectId);
  if (!membership) return;

  const tasks = tasksForProject(projectId, membership.role === 'Admin' ? null : user.id);
  sendJson(res, 200, { tasks });
}

async function createTask(req, res, user, projectId) {
  const admin = requireAdmin(res, user.id, projectId);
  if (!admin) return;

  const body = await readBody(req);
  const title = cleanText(body.title);
  const description = cleanText(body.description || '');
  const dueDate = cleanDate(body.due_date);
  const priority = normalizePriority(body.priority);
  const assigneeId = Number(body.assignee_id || 0) || null;

  if (!title || title.length < 3) {
    return sendJson(res, 400, { error: 'Task title must be at least 3 characters' });
  }

  if (!dueDate) {
    return sendJson(res, 400, { error: 'A valid due date is required' });
  }

  if (assigneeId && !requireProjectUser(res, projectId, assigneeId)) {
    return;
  }

  run(
    `INSERT INTO tasks
       (project_id, title, description, due_date, priority, status, assignee_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'To Do', ?, ?, ?, ?)`,
    [projectId, title, description, dueDate, priority, assigneeId, user.id, now(), now()]
  );

  sendJson(res, 201, { tasks: tasksForProject(projectId) });
}

async function updateTask(req, res, user, taskId) {
  const task = taskWithProject(taskId);
  if (!task) {
    return sendJson(res, 404, { error: 'Task not found' });
  }

  const membership = requireMembership(res, user.id, task.project_id);
  if (!membership) return;

  const body = await readBody(req);
  const updates = [];
  const values = [];

  if (membership.role === 'Admin') {
    if ('title' in body) {
      const title = cleanText(body.title);
      if (!title || title.length < 3) return sendJson(res, 400, { error: 'Task title must be at least 3 characters' });
      updates.push('title = ?');
      values.push(title);
    }
    if ('description' in body) {
      updates.push('description = ?');
      values.push(cleanText(body.description || ''));
    }
    if ('due_date' in body) {
      const dueDate = cleanDate(body.due_date);
      if (!dueDate) return sendJson(res, 400, { error: 'A valid due date is required' });
      updates.push('due_date = ?');
      values.push(dueDate);
    }
    if ('priority' in body) {
      updates.push('priority = ?');
      values.push(normalizePriority(body.priority));
    }
    if ('assignee_id' in body) {
      const assigneeId = Number(body.assignee_id || 0) || null;
      if (assigneeId && !requireProjectUser(res, task.project_id, assigneeId)) return;
      updates.push('assignee_id = ?');
      values.push(assigneeId);
    }
  } else if (task.assignee_id !== user.id) {
    return sendJson(res, 403, { error: 'Members can update only their assigned tasks' });
  }

  if ('status' in body) {
    const status = normalizeStatus(body.status);
    if (!status) return sendJson(res, 400, { error: 'Invalid task status' });
    updates.push('status = ?');
    values.push(status);
  }

  if (!updates.length) {
    return sendJson(res, 400, { error: 'No valid fields to update' });
  }

  updates.push('updated_at = ?');
  values.push(now(), taskId);
  run(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`, values);
  sendJson(res, 200, { tasks: tasksForProject(task.project_id, membership.role === 'Admin' ? null : user.id) });
}

function deleteTask(res, user, taskId) {
  const task = taskWithProject(taskId);
  if (!task) {
    return sendJson(res, 404, { error: 'Task not found' });
  }

  const admin = requireAdmin(res, user.id, task.project_id);
  if (!admin) return;

  run('DELETE FROM tasks WHERE id = ?', [taskId]);
  sendJson(res, 200, { tasks: tasksForProject(task.project_id) });
}

function getDashboard(res, user, projectId) {
  const membership = requireMembership(res, user.id, projectId);
  if (!membership) return;

  const scope = membership.role === 'Admin' ? '' : 'AND t.assignee_id = ?';
  const params = membership.role === 'Admin' ? [projectId] : [projectId, user.id];

  const totals = queryOne(
    `SELECT COUNT(*) AS total_tasks,
            COUNT(CASE WHEN t.status = 'To Do' THEN 1 END) AS todo_tasks,
            COUNT(CASE WHEN t.status = 'In Progress' THEN 1 END) AS progress_tasks,
            COUNT(CASE WHEN t.status = 'Done' THEN 1 END) AS done_tasks,
            COUNT(CASE WHEN t.status != 'Done' AND date(t.due_date) < date('now') THEN 1 END) AS overdue_tasks
       FROM tasks t
      WHERE t.project_id = ? ${scope}`,
    params
  );

  const byUser = queryAll(
    `SELECT COALESCE(u.name, 'Unassigned') AS name, COUNT(t.id) AS count
       FROM tasks t
  LEFT JOIN users u ON u.id = t.assignee_id
      WHERE t.project_id = ? ${scope}
   GROUP BY COALESCE(u.name, 'Unassigned')
   ORDER BY count DESC, name ASC`,
    params
  );

  sendJson(res, 200, { dashboard: { totals, by_user: byUser } });
}

function initializeDatabase() {
  run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);

  run(`CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`);

  run(`CREATE TABLE IF NOT EXISTS project_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('Admin', 'Member')),
    joined_at TEXT NOT NULL,
    UNIQUE(project_id, user_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    due_date TEXT NOT NULL,
    priority TEXT NOT NULL CHECK(priority IN ('Low', 'Medium', 'High')),
    status TEXT NOT NULL CHECK(status IN ('To Do', 'In Progress', 'Done')),
    assignee_id INTEGER,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (assignee_id) REFERENCES users(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`);

  seedDemoData();
}

function seedDemoData() {
  const userCount = queryOne('SELECT COUNT(*) AS count FROM users').count;
  if (userCount > 0) return;

  const created = now();
  run(
    'INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
    ['Avery Admin', 'admin@example.com', hashPassword('Password123!'), created]
  );
  run(
    'INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
    ['Mina Member', 'member@example.com', hashPassword('Password123!'), created]
  );

  const admin = queryOne('SELECT id FROM users WHERE email = ?', ['admin@example.com']);
  const member = queryOne('SELECT id FROM users WHERE email = ?', ['member@example.com']);

  run(
    'INSERT INTO projects (name, description, created_by, created_at) VALUES (?, ?, ?, ?)',
    ['Product Launch', 'Coordinate marketing, engineering, and release readiness.', admin.id, created]
  );
  const project = queryOne('SELECT id FROM projects WHERE name = ?', ['Product Launch']);

  run(
    'INSERT INTO project_members (project_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
    [project.id, admin.id, 'Admin', created]
  );
  run(
    'INSERT INTO project_members (project_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
    [project.id, member.id, 'Member', created]
  );
  run(
    `INSERT INTO tasks
       (project_id, title, description, due_date, priority, status, assignee_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [project.id, 'Draft launch checklist', 'Capture release gates and owners.', '2026-05-08', 'High', 'In Progress', member.id, admin.id, created, created]
  );
  run(
    `INSERT INTO tasks
       (project_id, title, description, due_date, priority, status, assignee_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [project.id, 'Confirm stakeholder review', 'Schedule the final approval meeting.', '2026-05-04', 'Medium', 'To Do', admin.id, admin.id, created, created]
  );
}

function authenticate(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;

  const payload = verifyToken(token);
  if (!payload?.id) return null;

  return queryOne('SELECT id, name, email, created_at FROM users WHERE id = ?', [payload.id]);
}

function requireMembership(res, userId, projectId) {
  const membership = queryOne(
    'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
    [projectId, userId]
  );
  if (!membership) {
    sendJson(res, 403, { error: 'You do not have access to this project' });
    return null;
  }
  return membership;
}

function requireAdmin(res, userId, projectId) {
  const membership = requireMembership(res, userId, projectId);
  if (!membership) return null;
  if (membership.role !== 'Admin') {
    sendJson(res, 403, { error: 'Admin access required' });
    return null;
  }
  return membership;
}

function requireProjectUser(res, projectId, userId) {
  const membership = queryOne(
    'SELECT id FROM project_members WHERE project_id = ? AND user_id = ?',
    [projectId, userId]
  );
  if (!membership) {
    sendJson(res, 400, { error: 'Assignee must be a project member' });
    return false;
  }
  return true;
}

function projectMembers(projectId) {
  return queryAll(
    `SELECT u.id, u.name, u.email, pm.role, pm.joined_at
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = ?
   ORDER BY pm.role ASC, u.name ASC`,
    [projectId]
  );
}

function tasksForProject(projectId, assignedUserId = null) {
  const filter = assignedUserId ? 'AND t.assignee_id = ?' : '';
  const params = assignedUserId ? [projectId, assignedUserId] : [projectId];
  return queryAll(
    `SELECT t.*, assignee.name AS assignee_name, creator.name AS creator_name
       FROM tasks t
  LEFT JOIN users assignee ON assignee.id = t.assignee_id
       JOIN users creator ON creator.id = t.created_by
      WHERE t.project_id = ? ${filter}
   ORDER BY CASE t.status WHEN 'To Do' THEN 1 WHEN 'In Progress' THEN 2 ELSE 3 END,
            date(t.due_date) ASC,
            CASE t.priority WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END`,
    params
  );
}

function taskWithProject(taskId) {
  return queryOne('SELECT * FROM tasks WHERE id = ?', [taskId]);
}

function signToken(user) {
  const payload = base64Url(JSON.stringify({
    id: user.id,
    email: user.email,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24
  }));
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyToken(token) {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (data.exp < Math.floor(Date.now() / 1000)) return null;
  return data;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, 64).toString('base64url');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [, salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString('base64url');
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(hash));
}

function queryAll(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function queryOne(sql, params = []) {
  return db.prepare(sql).get(...params) || null;
}

function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function serveStatic(res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const file = resolve(join(PUBLIC_DIR, safePath));
  if (!file.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, 'Forbidden');
  }

  if (!existsSync(file)) {
    return sendText(res, 404, 'Not found');
  }

  const type = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
  }[extname(file)] || 'application/octet-stream';

  res.writeHead(200, { 'Content-Type': type });
  res.end(readFileSync(file));
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function cleanText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function cleanDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? null : text;
}

function normalizePriority(value) {
  return ['Low', 'Medium', 'High'].includes(value) ? value : 'Medium';
}

function normalizeStatus(value) {
  return ['To Do', 'In Progress', 'Done'].includes(value) ? value : null;
}

function now() {
  return new Date().toISOString();
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}
