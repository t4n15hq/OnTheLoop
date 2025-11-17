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
  // Auth form
  loginForm.addEventListener('submit', handleLogin);
  logoutBtn.addEventListener('click', handleLogout);

  // Chat
  document.getElementById('chat-form').addEventListener('submit', handleChatMessage);

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

  try {
    // Try to login first
    let data;
    try {
      data = await apiCall('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ phoneNumber }),
        noAuth: true
      });
    } catch (loginError) {
      // If login fails (user doesn't exist), register them
      try {
        data = await apiCall('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ phoneNumber }),
          noAuth: true
        });
      } catch (registerError) {
        throw registerError;
      }
    }

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

// Chat Functions
async function handleChatMessage(e) {
  e.preventDefault();

  const input = document.getElementById('chat-input');
  const query = input.value.trim();

  if (!query) return;

  // Add user message
  addChatMessage(query, 'user');
  input.value = '';

  // Show typing indicator
  const typingId = addTypingIndicator();

  try {
    const data = await apiCall(`/api/cta/transit/ask?query=${encodeURIComponent(query)}`);

    // Remove typing indicator
    removeTypingIndicator(typingId);

    // Add bot response
    addChatMessage(data.answer, 'bot', data.realTimeArrivals);
  } catch (error) {
    removeTypingIndicator(typingId);
    addChatMessage(`Sorry, I encountered an error: ${error.message}`, 'bot');
  }
}

function addChatMessage(text, type, arrivals = null) {
  const messagesDiv = document.getElementById('chat-messages');
  const messageDiv = document.createElement('div');
  messageDiv.className = `chat-message ${type}-message`;

  const avatar = type === 'user' ? '👤' : '🚇';

  let contentHtml = `<div class="message-avatar">${avatar}</div><div class="message-content">`;

  // Format the text - convert markdown to HTML and clean up
  let formattedText = text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') // Bold **text**
    .replace(/\*(.*?)\*/g, '<em>$1</em>') // Italic *text*
    .replace(/\n/g, '<br>'); // Line breaks

  contentHtml += `<p>${formattedText}</p>`;

  // Add arrivals if present
  if (arrivals) {
    contentHtml += `<div class="arrivals">`;

    if (arrivals.routes) {
      // Multiple routes (transit directions)
      arrivals.routes.forEach(route => {
        const icon = route.type === 'train' ? '🚊' : '🚌';
        contentHtml += `<div class="arrival-item">`;
        contentHtml += `<div class="route-name">${icon} ${route.type === 'train' ? route.route + ' Line' : 'Route ' + route.route}</div>`;
        contentHtml += `<div style="font-size: 0.875rem; margin-bottom: 4px;">${route.stopName}</div>`;
        contentHtml += `<div class="arrival-times">`;
        route.arrivals.forEach(arr => {
          const time = arr.isApproaching ? 'NOW' : `${arr.minutesAway} min`;
          contentHtml += `<span class="arrival-time-badge">${time}</span>`;
        });
        contentHtml += `</div></div>`;
      });
    } else if (arrivals.stops) {
      // Single route arrivals
      arrivals.stops.forEach(stop => {
        contentHtml += `<div class="arrival-item">`;
        contentHtml += `<div class="route-name">🚌 ${stop.stopName}</div>`;
        contentHtml += `<div style="font-size: 0.875rem; margin-bottom: 4px;">${stop.direction}</div>`;
        contentHtml += `<div class="arrival-times">`;
        stop.arrivals.forEach(arr => {
          const time = arr.isApproaching ? 'NOW' : `${arr.minutesAway} min`;
          const delayed = arr.isDelayed ? ' ⚠️' : '';
          contentHtml += `<span class="arrival-time-badge">${time}${delayed}</span>`;
        });
        contentHtml += `</div></div>`;
      });
    }

    contentHtml += `</div>`;
  }

  contentHtml += `</div>`;
  messageDiv.innerHTML = contentHtml;

  messagesDiv.appendChild(messageDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function addTypingIndicator() {
  const messagesDiv = document.getElementById('chat-messages');
  const typingDiv = document.createElement('div');
  const id = 'typing-' + Date.now();
  typingDiv.id = id;
  typingDiv.className = 'chat-message bot-message';
  typingDiv.innerHTML = `
    <div class="message-avatar">🚇</div>
    <div class="message-content typing-indicator">
      <span></span>
      <span></span>
      <span></span>
    </div>
  `;
  messagesDiv.appendChild(typingDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  return id;
}

function removeTypingIndicator(id) {
  const typingDiv = document.getElementById(id);
  if (typingDiv) {
    typingDiv.remove();
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
