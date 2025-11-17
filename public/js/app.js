// API Configuration
const API_BASE = window.location.origin;
let authToken = localStorage.getItem('authToken');
let currentUser = null;

// DOM Elements
const authView = document.getElementById('auth-view');
const dashboardView = document.getElementById('dashboard-view');
const loginForm = document.getElementById('login');
const registerForm = document.getElementById('register');
const authError = document.getElementById('auth-error');
const showRegisterBtn = document.getElementById('show-register');
const showLoginBtn = document.getElementById('show-login');
const logoutBtn = document.getElementById('logout-btn');

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
  if (authToken) {
    showDashboard();
  } else {
    showAuth();
  }

  setupEventListeners();
});

// Event Listeners
function setupEventListeners() {
  // Auth form toggles
  showRegisterBtn.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('login-form').classList.remove('active');
    document.getElementById('register-form').classList.add('active');
    authError.classList.remove('show');
  });

  showLoginBtn.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('register-form').classList.remove('active');
    document.getElementById('login-form').classList.add('active');
    authError.classList.remove('show');
  });

  // Auth forms
  loginForm.addEventListener('submit', handleLogin);
  registerForm.addEventListener('submit', handleRegister);
  logoutBtn.addEventListener('click', handleLogout);

  // Quick search
  document.getElementById('quick-search-form').addEventListener('submit', handleQuickSearch);

  // Add favorite/schedule buttons
  document.getElementById('add-favorite-btn').addEventListener('click', () => openModal('favorite-modal'));
  document.getElementById('add-schedule-btn').addEventListener('click', () => openModal('schedule-modal'));

  // Modal close buttons
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      closeModal(e.target.closest('.modal').id);
    });
  });

  // Modal forms
  document.getElementById('favorite-form').addEventListener('submit', handleCreateFavorite);
  document.getElementById('schedule-form').addEventListener('submit', handleCreateSchedule);

  // Route type toggle in favorite form
  document.querySelectorAll('input[name="route-type"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const isBus = e.target.value === 'BUS';
      document.getElementById('bus-fields').style.display = isBus ? 'block' : 'none';
      document.getElementById('train-fields').style.display = isBus ? 'none' : 'block';
    });
  });

  // Bus route selection
  document.getElementById('bus-route').addEventListener('change', loadBusDirections);
  document.getElementById('bus-direction').addEventListener('change', loadBusStops);
}

// API Helper
async function apiCall(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  if (authToken && !options.noAuth) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Something went wrong');
  }

  return data;
}

// Auth Functions
async function handleLogin(e) {
  e.preventDefault();

  const phoneNumber = document.getElementById('login-phone').value;
  const password = document.getElementById('login-password').value;

  try {
    const data = await apiCall('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber, password }),
      noAuth: true
    });

    authToken = data.token;
    localStorage.setItem('authToken', authToken);
    showDashboard();
  } catch (error) {
    showError(error.message);
  }
}

async function handleRegister(e) {
  e.preventDefault();

  const phoneNumber = document.getElementById('register-phone').value;
  const password = document.getElementById('register-password').value;
  const confirmPassword = document.getElementById('register-confirm').value;

  if (password !== confirmPassword) {
    showError('Passwords do not match');
    return;
  }

  try {
    const data = await apiCall('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber, password }),
      noAuth: true
    });

    authToken = data.token;
    localStorage.setItem('authToken', authToken);
    showDashboard();
  } catch (error) {
    showError(error.message);
  }
}

function handleLogout() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('authToken');
  showAuth();
}

function showError(message) {
  authError.textContent = message;
  authError.classList.add('show');
}

// View Management
function showAuth() {
  authView.style.display = 'block';
  dashboardView.style.display = 'none';
}

async function showDashboard() {
  authView.style.display = 'none';
  dashboardView.style.display = 'block';

  await loadDashboardData();
}

async function loadDashboardData() {
  try {
    await Promise.all([
      loadFavorites(),
      loadSchedules()
    ]);
  } catch (error) {
    console.error('Error loading dashboard:', error);
    if (error.message.includes('Unauthorized')) {
      handleLogout();
    }
  }
}

// Quick Search
async function handleQuickSearch(e) {
  e.preventDefault();

  const query = document.getElementById('quick-search').value.trim();
  const resultsDiv = document.getElementById('search-results');

  if (!query) return;

  resultsDiv.innerHTML = '<p style="text-align: center; color: #64748b;">Searching...</p>';

  try {
    const data = await apiCall(`/api/cta/transit/ask?query=${encodeURIComponent(query)}`);

    let html = `<div class="search-result">`;
    html += `<h3>Results for "${query}"</h3>`;
    html += `<div style="margin-top: 12px; white-space: pre-wrap;">${data.answer}</div>`;

    if (data.realTimeArrivals) {
      html += `<div class="arrivals" style="margin-top: 16px;">`;

      // Handle different response formats
      if (data.realTimeArrivals.routes) {
        // Multiple routes (transit directions)
        data.realTimeArrivals.routes.forEach(route => {
          html += `<div style="margin-bottom: 8px;">`;
          html += `<strong>${route.type === 'train' ? route.route + ' Line' : 'Route ' + route.route}</strong> at ${route.stopName}<br>`;
          route.arrivals.forEach(arr => {
            const time = arr.isApproaching ? 'Arriving NOW' : `${arr.minutesAway} min`;
            html += `<div class="arrival-time">`;
            html += `<span>${arr.destination}</span>`;
            html += `<span class="time">${time}</span>`;
            html += `</div>`;
          });
          html += `</div>`;
        });
      } else if (data.realTimeArrivals.stops) {
        // Single route arrivals
        data.realTimeArrivals.stops.forEach(stop => {
          html += `<div style="margin-bottom: 8px;">`;
          html += `<strong>${stop.stopName}</strong> (${stop.direction})<br>`;
          stop.arrivals.forEach(arr => {
            const time = arr.isApproaching ? 'Arriving NOW' : `${arr.minutesAway} min`;
            html += `<div class="arrival-time">`;
            html += `<span>${arr.destination}</span>`;
            html += `<span class="time">${time}${arr.isDelayed ? ' ⚠️' : ''}</span>`;
            html += `</div>`;
          });
          html += `</div>`;
        });
      }

      html += `</div>`;
    }

    html += `</div>`;
    resultsDiv.innerHTML = html;
  } catch (error) {
    resultsDiv.innerHTML = `<div class="search-result"><p style="color: #ef4444;">Error: ${error.message}</p></div>`;
  }
}

// Favorites
async function loadFavorites() {
  try {
    const data = await apiCall('/api/favorites');
    const listDiv = document.getElementById('favorites-list');

    if (!data.favorites || data.favorites.length === 0) {
      listDiv.innerHTML = '<p class="empty-state">No favorites yet. Add your frequent routes!</p>';
      return;
    }

    let html = '';
    data.favorites.forEach(fav => {
      const badge = fav.routeType === 'BUS' ? 'badge-bus' : 'badge-train';
      html += `
        <div class="favorite-item" data-id="${fav.id}">
          <div class="favorite-info">
            <h3>${fav.name}</h3>
            <div class="favorite-meta">
              <span class="badge ${badge}">${fav.routeType}</span>
              <span>${fav.routeId}</span>
              ${fav.direction ? `<span>${fav.direction}</span>` : ''}
            </div>
          </div>
          <div class="favorite-actions">
            <button class="btn btn-secondary" onclick="checkFavorite('${fav.id}')">Check</button>
            <button class="btn btn-danger" onclick="deleteFavorite('${fav.id}')">Delete</button>
          </div>
        </div>
      `;
    });

    listDiv.innerHTML = html;

    // Update schedule dropdown
    updateScheduleFavoriteDropdown(data.favorites);
  } catch (error) {
    console.error('Error loading favorites:', error);
  }
}

async function handleCreateFavorite(e) {
  e.preventDefault();

  const routeType = document.querySelector('input[name="route-type"]:checked').value;
  const name = document.getElementById('favorite-name').value;

  let payload = { name, routeType };

  if (routeType === 'BUS') {
    const routeId = document.getElementById('bus-route').value;
    const direction = document.getElementById('bus-direction').value;
    const stopId = document.getElementById('bus-stop').value;

    if (!routeId || !direction || !stopId) {
      alert('Please fill in all bus fields');
      return;
    }

    payload.routeId = routeId;
    payload.direction = direction;
    payload.stopId = stopId;
  } else {
    const routeId = document.getElementById('train-line').value;
    const stationId = document.getElementById('train-station').value;
    const direction = document.getElementById('train-direction').value;

    if (!routeId || !stationId) {
      alert('Please fill in all train fields');
      return;
    }

    payload.routeId = routeId;
    payload.stationId = stationId;
    payload.direction = direction;
  }

  try {
    await apiCall('/api/favorites', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    closeModal('favorite-modal');
    document.getElementById('favorite-form').reset();
    await loadFavorites();
  } catch (error) {
    alert('Error creating favorite: ' + error.message);
  }
}

async function checkFavorite(id) {
  // This would trigger a real-time check of the favorite
  const resultsDiv = document.getElementById('search-results');
  resultsDiv.scrollIntoView({ behavior: 'smooth' });

  try {
    const fav = await apiCall(`/api/favorites/${id}`);
    const query = `Next arrivals for ${fav.favorite.name}`;

    document.getElementById('quick-search').value = `${fav.favorite.routeId} ${fav.favorite.direction || ''}`;
    document.getElementById('quick-search-form').dispatchEvent(new Event('submit'));
  } catch (error) {
    alert('Error checking favorite: ' + error.message);
  }
}

async function deleteFavorite(id) {
  if (!confirm('Are you sure you want to delete this favorite?')) return;

  try {
    await apiCall(`/api/favorites/${id}`, { method: 'DELETE' });
    await loadFavorites();
  } catch (error) {
    alert('Error deleting favorite: ' + error.message);
  }
}

// Schedules
async function loadSchedules() {
  try {
    const data = await apiCall('/api/schedules');
    const listDiv = document.getElementById('schedules-list');

    if (!data.schedules || data.schedules.length === 0) {
      listDiv.innerHTML = '<p class="empty-state">No scheduled alerts. Set up notifications for your routine!</p>';
      return;
    }

    let html = '';
    data.schedules.forEach(schedule => {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const daysHtml = days.map((day, i) => {
        const active = schedule.daysOfWeek.includes(i) ? 'active' : '';
        return `<span class="day-badge ${active}">${day[0]}</span>`;
      }).join('');

      html += `
        <div class="schedule-item" data-id="${schedule.id}">
          <div class="schedule-info">
            <h3>${schedule.favorite.name}</h3>
            <div class="schedule-meta">
              <div class="schedule-time">${formatTime(schedule.time)}</div>
              <div class="schedule-days">${daysHtml}</div>
            </div>
          </div>
          <div class="schedule-actions">
            <label class="toggle-switch">
              <input type="checkbox" ${schedule.enabled ? 'checked' : ''}
                     onchange="toggleSchedule('${schedule.id}', this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <button class="btn btn-danger" onclick="deleteSchedule('${schedule.id}')">Delete</button>
          </div>
        </div>
      `;
    });

    listDiv.innerHTML = html;
  } catch (error) {
    console.error('Error loading schedules:', error);
  }
}

async function handleCreateSchedule(e) {
  e.preventDefault();

  const favoriteId = document.getElementById('schedule-favorite').value;
  const time = document.getElementById('schedule-time').value;
  const daysOfWeek = Array.from(document.querySelectorAll('input[name="day"]:checked'))
    .map(cb => parseInt(cb.value));

  if (!favoriteId || !time || daysOfWeek.length === 0) {
    alert('Please fill in all fields and select at least one day');
    return;
  }

  try {
    await apiCall('/api/schedules', {
      method: 'POST',
      body: JSON.stringify({ favoriteId, time, daysOfWeek })
    });

    closeModal('schedule-modal');
    document.getElementById('schedule-form').reset();
    await loadSchedules();
  } catch (error) {
    alert('Error creating schedule: ' + error.message);
  }
}

async function toggleSchedule(id, enabled) {
  try {
    const schedule = await apiCall(`/api/schedules/${id}`);
    await apiCall(`/api/schedules/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        favoriteId: schedule.schedule.favoriteId,
        time: schedule.schedule.time,
        daysOfWeek: schedule.schedule.daysOfWeek,
        enabled
      })
    });
  } catch (error) {
    alert('Error updating schedule: ' + error.message);
    await loadSchedules();
  }
}

async function deleteSchedule(id) {
  if (!confirm('Are you sure you want to delete this schedule?')) return;

  try {
    await apiCall(`/api/schedules/${id}`, { method: 'DELETE' });
    await loadSchedules();
  } catch (error) {
    alert('Error deleting schedule: ' + error.message);
  }
}

// Bus Route Helpers
async function loadBusDirections() {
  const routeId = document.getElementById('bus-route').value;
  const directionSelect = document.getElementById('bus-direction');

  if (!routeId) return;

  try {
    const data = await apiCall(`/api/cta/bus/${routeId}/directions`);

    directionSelect.innerHTML = '<option value="">Select direction...</option>';
    data.directions.forEach(dir => {
      directionSelect.innerHTML += `<option value="${dir}">${dir}</option>`;
    });
  } catch (error) {
    console.error('Error loading directions:', error);
  }
}

async function loadBusStops() {
  const routeId = document.getElementById('bus-route').value;
  const direction = document.getElementById('bus-direction').value;
  const stopSelect = document.getElementById('bus-stop');

  if (!routeId || !direction) return;

  try {
    const data = await apiCall(`/api/cta/bus/${routeId}/stops?direction=${encodeURIComponent(direction)}`);

    stopSelect.innerHTML = '<option value="">Select stop...</option>';
    data.stops.forEach(stop => {
      stopSelect.innerHTML += `<option value="${stop.stpid}">${stop.stpnm}</option>`;
    });
  } catch (error) {
    console.error('Error loading stops:', error);
  }
}

// Modal Helpers
function openModal(modalId) {
  document.getElementById(modalId).classList.add('show');
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('show');
}

// Update schedule favorite dropdown
function updateScheduleFavoriteDropdown(favorites) {
  const select = document.getElementById('schedule-favorite');
  select.innerHTML = '<option value="">Select a favorite...</option>';

  favorites.forEach(fav => {
    select.innerHTML += `<option value="${fav.id}">${fav.name}</option>`;
  });
}

// Utility
function formatTime(time) {
  const [hours, minutes] = time.split(':');
  const h = parseInt(hours);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const displayHours = h % 12 || 12;
  return `${displayHours}:${minutes} ${ampm}`;
}
