const state = {
  token: localStorage.getItem('task_token') || '',
  user: null,
  projects: [],
  project: null,
  members: [],
  tasks: [],
  dashboard: null,
  statusFilter: ''
};

const $ = (selector) => document.querySelector(selector);
const authPanel = $('#auth-panel');
const sessionPanel = $('#session-panel');
const projectPanel = $('#project-panel');
const projectView = $('#project-view');
const emptyState = $('#empty-state');
const toast = $('#toast');

document.addEventListener('DOMContentLoaded', init);

function init() {
  bindEvents();
  if (state.token) {
    refreshSession();
  }
}

function bindEvents() {
  document.querySelectorAll('[data-auth-tab]').forEach((button) => {
    button.addEventListener('click', () => switchAuthTab(button.dataset.authTab));
  });

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await authenticate('/api/auth/login', new FormData(event.currentTarget));
  });

  $('#signup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await authenticate('/api/auth/signup', new FormData(event.currentTarget));
  });

  $('#logout-button').addEventListener('click', logout);
  $('#new-project-button').addEventListener('click', () => $('#project-dialog').showModal());
  $('#create-task-button').addEventListener('click', openTaskDialog);

  document.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => button.closest('dialog').close());
  });

  $('#project-form').addEventListener('submit', createProject);
  $('#task-form').addEventListener('submit', createTask);
  $('#member-form').addEventListener('submit', addMember);
  $('#status-filter').addEventListener('change', (event) => {
    state.statusFilter = event.target.value;
    renderTasks();
  });
}

async function authenticate(endpoint, formData) {
  const payload = Object.fromEntries(formData.entries());
  const data = await api(endpoint, { method: 'POST', body: payload }, false);
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('task_token', state.token);
  await loadProjects();
  renderShell();
  notify(`Welcome, ${state.user.name}`);
}

async function refreshSession() {
  try {
    const data = await api('/api/me');
    state.user = data.user;
    await loadProjects();
    renderShell();
  } catch {
    logout();
  }
}

function logout() {
  localStorage.removeItem('task_token');
  Object.assign(state, {
    token: '',
    user: null,
    projects: [],
    project: null,
    members: [],
    tasks: [],
    dashboard: null
  });
  renderShell();
}

async function loadProjects(selectId = null) {
  const data = await api('/api/projects');
  state.projects = data.projects;
  const targetId = selectId || state.project?.id || state.projects[0]?.id;
  if (targetId) {
    await loadProject(targetId);
  }
}

async function loadProject(projectId) {
  const projectData = await api(`/api/projects/${projectId}`);
  const taskData = await api(`/api/projects/${projectId}/tasks`);
  const dashboardData = await api(`/api/projects/${projectId}/dashboard`);
  state.project = projectData.project;
  state.members = projectData.members;
  state.tasks = taskData.tasks;
  state.dashboard = dashboardData.dashboard;
  renderShell();
}

async function createProject(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  const data = await api('/api/projects', { method: 'POST', body: payload });
  form.reset();
  $('#project-dialog').close();
  await loadProjects(data.project.id);
  notify('Project created');
}

async function addMember(event) {
  event.preventDefault();
  if (!state.project) return;

  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  const data = await api(`/api/projects/${state.project.id}/members`, { method: 'POST', body: payload });
  state.members = data.members;
  form.reset();
  renderMembers();
  refreshProjectData();
  notify('Member added');
}

async function removeMember(userId) {
  const data = await api(`/api/projects/${state.project.id}/members/${userId}`, { method: 'DELETE' });
  state.members = data.members;
  await refreshProjectData();
  notify('Member removed');
}

function openTaskDialog() {
  renderAssigneeSelect();
  const date = new Date();
  date.setDate(date.getDate() + 3);
  $('#task-form').elements.due_date.value = date.toISOString().slice(0, 10);
  $('#task-dialog').showModal();
}

async function createTask(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  if (!payload.assignee_id) delete payload.assignee_id;
  const data = await api(`/api/projects/${state.project.id}/tasks`, { method: 'POST', body: payload });
  state.tasks = data.tasks;
  form.reset();
  $('#task-dialog').close();
  await refreshProjectData();
  notify('Task created');
}

async function updateTaskStatus(taskId, status) {
  const data = await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { status } });
  state.tasks = data.tasks;
  await refreshProjectData();
  notify('Task updated');
}

async function deleteTask(taskId) {
  const data = await api(`/api/tasks/${taskId}`, { method: 'DELETE' });
  state.tasks = data.tasks;
  await refreshProjectData();
  notify('Task deleted');
}

async function refreshProjectData() {
  if (!state.project) return;
  const dashboardData = await api(`/api/projects/${state.project.id}/dashboard`);
  const projectData = await api(`/api/projects/${state.project.id}`);
  const taskData = await api(`/api/projects/${state.project.id}/tasks`);
  state.dashboard = dashboardData.dashboard;
  state.project = projectData.project;
  state.members = projectData.members;
  state.tasks = taskData.tasks;
  renderProject();
}

function renderShell() {
  const loggedIn = Boolean(state.user);
  authPanel.classList.toggle('hidden', loggedIn);
  sessionPanel.classList.toggle('hidden', !loggedIn);
  projectPanel.classList.toggle('hidden', !loggedIn);
  emptyState.classList.toggle('hidden', loggedIn && state.project);
  projectView.classList.toggle('hidden', !loggedIn || !state.project);

  if (!loggedIn) return;

  $('#user-name').textContent = state.user.name;
  $('#user-email').textContent = state.user.email;
  $('#user-avatar').textContent = initials(state.user.name);
  renderProjects();
  renderProject();
}

function renderProjects() {
  $('#project-list').innerHTML = state.projects.map((project) => `
    <button class="project-button ${state.project?.id === project.id ? 'active' : ''}" data-project-id="${project.id}">
      <strong>${escapeHtml(project.name)}</strong>
      <span>${project.role} · ${project.task_count} tasks · ${project.done_count} done</span>
    </button>
  `).join('') || '<p class="muted">No projects yet</p>';

  document.querySelectorAll('[data-project-id]').forEach((button) => {
    button.addEventListener('click', () => loadProject(button.dataset.projectId));
  });
}

function renderProject() {
  if (!state.project) return;

  const isAdmin = state.project.role === 'Admin';
  $('#project-title').textContent = state.project.name;
  $('#project-description').textContent = state.project.description || 'No description provided.';
  $('#role-pill').textContent = state.project.role;
  $('#create-task-button').classList.toggle('hidden', !isAdmin);
  $('#member-form').classList.toggle('hidden', !isAdmin);

  renderDashboard();
  renderMembers();
  renderTasks();
  renderAssigneeSelect();
}

function renderDashboard() {
  const totals = state.dashboard?.totals || {};
  $('#metric-total').textContent = totals.total_tasks || 0;
  $('#metric-todo').textContent = totals.todo_tasks || 0;
  $('#metric-progress').textContent = totals.progress_tasks || 0;
  $('#metric-done').textContent = totals.done_tasks || 0;
  $('#metric-overdue').textContent = totals.overdue_tasks || 0;

  const rows = state.dashboard?.by_user || [];
  const max = Math.max(1, ...rows.map((row) => row.count));
  $('#tasks-per-user').innerHTML = rows.map((row) => `
    <div class="bar-item">
      <strong>${escapeHtml(row.name)}</strong>
      <span>${row.count} task${row.count === 1 ? '' : 's'}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(row.count / max) * 100}%"></div></div>
    </div>
  `).join('') || '<p>No task assignments yet.</p>';
}

function renderMembers() {
  const isAdmin = state.project?.role === 'Admin';
  $('#member-list').innerHTML = state.members.map((member) => `
    <div class="member-item">
      <div>
        <strong>${escapeHtml(member.name)}</strong>
        <span>${escapeHtml(member.email)} · ${member.role}</span>
      </div>
      ${isAdmin && member.id !== state.project.created_by ? `<button class="remove-member" data-remove-member="${member.id}" title="Remove member">Remove</button>` : ''}
    </div>
  `).join('');

  document.querySelectorAll('[data-remove-member]').forEach((button) => {
    button.addEventListener('click', () => removeMember(button.dataset.removeMember));
  });
}

function renderTasks() {
  const statuses = ['To Do', 'In Progress', 'Done'];
  const visibleTasks = state.statusFilter
    ? state.tasks.filter((task) => task.status === state.statusFilter)
    : state.tasks;

  $('#task-board').innerHTML = statuses.map((status) => {
    const tasks = visibleTasks.filter((task) => task.status === status);
    return `
      <section class="column">
        <h3>${status}</h3>
        <div class="task-list">
          ${tasks.map(renderTaskCard).join('') || '<p>No tasks here.</p>'}
        </div>
      </section>
    `;
  }).join('');

  document.querySelectorAll('[data-status-task]').forEach((select) => {
    select.addEventListener('change', () => updateTaskStatus(select.dataset.statusTask, select.value));
  });

  document.querySelectorAll('[data-delete-task]').forEach((button) => {
    button.addEventListener('click', () => deleteTask(button.dataset.deleteTask));
  });
}

function renderTaskCard(task) {
  const isAdmin = state.project.role === 'Admin';
  const canUpdate = isAdmin || task.assignee_id === state.user.id;
  const due = new Date(`${task.due_date}T00:00:00`);
  const overdue = task.status !== 'Done' && due < startOfToday();
  const statusClass = task.status === 'Done' ? 'done' : task.status === 'In Progress' ? 'progress' : 'todo';

  return `
    <article class="task-card" data-priority="${task.priority}">
      <h4>${escapeHtml(task.title)}</h4>
      <p>${escapeHtml(task.description || 'No description')}</p>
      <div class="task-meta">
        <span class="status-pill ${statusClass}">${task.status}</span>
        <span class="priority-pill">${task.priority}</span>
        <span class="${overdue ? 'overdue' : ''}">Due ${formatDate(task.due_date)}</span>
        <span>${escapeHtml(task.assignee_name || 'Unassigned')}</span>
      </div>
      <div class="task-actions">
        ${canUpdate ? statusSelect(task) : ''}
        ${isAdmin ? `<button class="delete-task" data-delete-task="${task.id}" title="Delete task">Delete</button>` : ''}
      </div>
    </article>
  `;
}

function statusSelect(task) {
  return `
    <select data-status-task="${task.id}" aria-label="Update task status">
      ${['To Do', 'In Progress', 'Done'].map((status) => `
        <option ${task.status === status ? 'selected' : ''}>${status}</option>
      `).join('')}
    </select>
  `;
}

function renderAssigneeSelect() {
  const select = $('#assignee-select');
  if (!select) return;

  select.innerHTML = '<option value="">Unassigned</option>' + state.members.map((member) => `
    <option value="${member.id}">${escapeHtml(member.name)} (${member.role})</option>
  `).join('');
}

function switchAuthTab(tab) {
  document.querySelectorAll('[data-auth-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.authTab === tab);
  });
  $('#login-form').classList.toggle('hidden', tab !== 'login');
  $('#signup-form').classList.toggle('hidden', tab !== 'signup');
}

async function api(endpoint, options = {}, requireAuth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (requireAuth && state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  const response = await fetch(endpoint, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    notify(data.error || 'Request failed');
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

function notify(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.add('hidden'), 2600);
}

function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[char]);
}

function formatDate(date) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${date}T00:00:00`));
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}
