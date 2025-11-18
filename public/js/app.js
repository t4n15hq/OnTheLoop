// API Configuration
const API_BASE = window.location.origin;
let authToken = localStorage.getItem('authToken');
let currentUser = null;

// DOM Elements
const authView = document.getElementById('auth-view');
const dashboardView = document.getElementById('dashboard-view');
const loginForm = document.getElementById('login');
const authError = document.getElementById('auth-error');
const logoutBtn = document.getElementById('logout-btn');
const userMenuBtn = document.getElementById('user-menu-btn');
const userMenuDropdown = document.getElementById('user-menu-dropdown');

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
  loginForm.addEventListener('submit', handleLogin);
  logoutBtn.addEventListener('click', handleLogout);
  userMenuBtn.addEventListener('click', (e) => { e.stopPropagation(); userMenuDropdown.classList.toggle('show'); });
  document.addEventListener('click', () => { userMenuDropdown.classList.remove('show'); });
  document.getElementById('chat-form').addEventListener('submit', handleChatMessage);
  document.getElementById('add-favorite-btn').addEventListener('click', () => openModal('favorite-modal'));
  document.getElementById('add-schedule-btn').addEventListener('click', () => openModal('schedule-modal'));
  document.querySelectorAll('.modal-close').forEach(btn => { btn.addEventListener('click', (e) => closeModal(e.target.closest('.modal').id)); });
  document.getElementById('favorite-form').addEventListener('submit', handleCreateFavorite);
  document.getElementById('schedule-form').addEventListener('submit', handleCreateSchedule);
  document.querySelectorAll('input[name="route-type"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const isBus = e.target.value === 'BUS';
      document.getElementById('bus-fields').style.display = isBus ? 'block' : 'none';
      document.getElementById('train-fields').style.display = isBus ? 'none' : 'block';
    });
  });
  document.getElementById('bus-route').addEventListener('change', loadBusDirections);
  document.getElementById('bus-direction').addEventListener('change', loadBusStops);
  document.getElementById('train-line').addEventListener('change', loadTrainStations);

  document.getElementById('favorites-list').addEventListener('click', (e) => {
    const checkBtn = e.target.closest('.btn-check-favorite');
    const deleteBtn = e.target.closest('.btn-delete-favorite');
    if (checkBtn) checkFavorite(checkBtn.dataset.id);
    if (deleteBtn) deleteFavorite(deleteBtn.dataset.id);
  });

  document.getElementById('schedules-list').addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.btn-delete-schedule');
    if (deleteBtn) deleteSchedule(deleteBtn.dataset.id);
  });

  document.getElementById('schedules-list').addEventListener('change', (e) => {
    const toggle = e.target.closest('.toggle-schedule');
    if (toggle) toggleSchedule(toggle.dataset.id, toggle.checked);
  });
}

// API Helper
async function apiCall(endpoint, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const response = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });

  if (!response.ok) {
    if (response.status === 401) {
        console.error("Unauthorized request, logging out.");
        handleLogout();
    }
    const data = await response.json().catch(() => ({ error: `HTTP Error: ${response.statusText}` }));
    throw new Error(data.error || 'Something went wrong');
  }

  // Handle cases where the response might be empty (e.g., DELETE 204 No Content)
  const contentType = response.headers.get("content-type");
  if (contentType && contentType.indexOf("application/json") !== -1) {
    return response.json();
  } else {
    return; // Return undefined for non-JSON responses
  }
}

// Auth Functions
async function handleLogin(e) {
  e.preventDefault();
  const phoneNumber = document.getElementById('login-phone').value;
  authError.style.display = 'none'; // Hide error on new attempt
  try {
    // Try to login, if it fails (user not found), then register
    const data = await apiCall('/api/auth/login', { method: 'POST', body: JSON.stringify({ phoneNumber }) })
      .catch(() => apiCall('/api/auth/register', { method: 'POST', body: JSON.stringify({ phoneNumber }) }));

    authToken = data.token;
    currentUser = data.user;
    localStorage.setItem('authToken', authToken);
    await showDashboard();
  } catch (error) {
    authError.textContent = error.message;
    authError.style.display = 'block';
  }
}

function handleLogout() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('authToken');
  userMenuDropdown.classList.remove('show');
  showAuth();
}

// View Management
function showAuth() {
  authView.style.display = 'flex';
  dashboardView.style.display = 'none';
}

async function showDashboard() {
  authView.style.display = 'none';
  dashboardView.style.display = 'block';
  // If we don't have currentUser yet (e.g., page reload with saved token), fetch it
  if (!currentUser && authToken) {
    await loadCurrentUser();
  }
  updateWelcomeMessage();
  await loadDashboardData();
}

async function loadCurrentUser() {
    if (!authToken) return;
    try {
        // Note: We need to create /api/users/me endpoint in the backend
        // For now, if this fails, we'll handle it gracefully
        const data = await apiCall('/api/users/me');
        currentUser = data.user;
    } catch(error) {
        console.error("Could not fetch user, token might be invalid.", error);
        handleLogout(); // If we can't get the user, the token is bad.
    }
}

function updateWelcomeMessage() {
  const hour = new Date().getHours();
  let greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  document.getElementById('welcome-greeting').textContent = greeting;
  if (currentUser && currentUser.phoneNumber) {
    const phoneDisplay = currentUser.phoneNumber.slice(-4);
    document.getElementById('user-phone-display').textContent = `•••• ${phoneDisplay}`;
  }
}

async function loadDashboardData() {
  await Promise.all([loadFavorites(), loadSchedules()]).catch(console.error);
}

// Chat Functions
async function handleChatMessage(e) {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const query = input.value.trim();
  if (!query) return;

  addChatMessage(query, 'user');
  input.value = '';
  const typingId = addTypingIndicator();

  try {
    const data = await apiCall(`/api/cta/transit/ask?query=${encodeURIComponent(query)}`);
    addChatMessage(data.answer, 'bot', data.realTimeArrivals);
  } catch (error) {
    addChatMessage(`Sorry, I encountered an error: ${error.message}`, 'bot');
  } finally {
    removeTypingIndicator(typingId);
  }
}

function addChatMessage(text, type) {
  const messagesDiv = document.getElementById('chat-messages');
  const messageDiv = document.createElement('div');
  messageDiv.className = `chat-message ${type}-message`;
  const avatar = type === 'user' ? '👤' : '🚇';
  let formattedText = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');

  messageDiv.innerHTML = `<div class="message-avatar">${avatar}</div><div class="message-content"><p>${formattedText}</p></div>`;

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
      <span></span><span></span><span></span>
    </div>
  `;
  messagesDiv.appendChild(typingDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
  return id;
}

function removeTypingIndicator(id) {
  const typingDiv = document.getElementById(id);
  if (typingDiv) typingDiv.remove();
}

// Favorites
async function loadFavorites() {
  try {
    const data = await apiCall('/api/favorites');
    const listDiv = document.getElementById('favorites-list');
    if (!data.favorites || data.favorites.length === 0) {
      listDiv.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📍</div><p>No favorites yet</p><small>Add your frequent routes to get started!</small></div>`;
      updateScheduleFavoriteDropdown([]); // Clear dropdown
      return;
    }
    let html = '<div class="favorites-grid">';
    data.favorites.forEach(fav => {
      const journeyHtml = fav.boardingStopName && fav.alightingStopName ? `<div class="favorite-journey">📍 ${fav.boardingStopName} → ${fav.alightingStopName}</div>` : '';
      html += `
        <div class="favorite-item">
          <div class="favorite-info">
            <h3>${fav.name}</h3>
            <div class="favorite-meta">
              <span class="badge ${fav.routeType === 'BUS' ? 'badge-bus' : 'badge-train'}">${fav.routeType}</span>
              <span>${fav.routeId}</span>
            </div>
            ${journeyHtml}
          </div>
          <div class="favorite-actions">
            <button class="btn btn-secondary btn-check-favorite" data-id="${fav.id}">Check</button>
            <button class="btn btn-danger btn-sm btn-delete-favorite" data-id="${fav.id}">Delete</button>
          </div>
        </div>`;
    });
    html += '</div>';
    listDiv.innerHTML = html;
    updateScheduleFavoriteDropdown(data.favorites);
  } catch(error) {
    console.error("Error loading favorites:", error);
    document.getElementById('favorites-list').innerHTML = `<div class="empty-state"><p>Could not load favorites.</p></div>`;
  }
}

async function handleCreateFavorite(e) {
  e.preventDefault();
  const form = e.target;
  const routeType = form.elements['route-type'].value;
  const payload = {
    name: form.elements['favorite-name'].value,
    routeType,
    boardingStopName: form.elements['boarding-stop-name'].value,
    alightingStopName: form.elements['alighting-stop-name'].value,
    routeId: routeType === 'BUS' ? form.elements['bus-route'].value : form.elements['train-line'].value,
    direction: routeType === 'BUS' ? form.elements['bus-direction'].value : form.elements['train-direction'].value,
    stopId: routeType === 'BUS' ? form.elements['bus-stop'].value : null,
    stationId: routeType === 'TRAIN' ? form.elements['train-station'].value : null,
  };

  try {
    await apiCall('/api/favorites', { method: 'POST', body: JSON.stringify(payload) });
    closeModal('favorite-modal');
    form.reset();
    document.getElementById('bus-fields').style.display = 'block'; // Reset to default
    document.getElementById('train-fields').style.display = 'none';
    await loadFavorites();
  } catch (error) {
    alert('Error creating favorite: ' + error.message);
  }
}

async function checkFavorite(id) {
    try {
        const { favorite: fav } = await apiCall(`/api/favorites/${id}`);
        const query = fav.routeType === 'BUS'
            ? `Next ${fav.routeId} bus at ${fav.boardingStopName}`
            : `Next ${fav.routeId} line train at ${fav.boardingStopName}`;

        addChatMessage(`Checking arrivals for "${fav.name}"...`, 'user');
        const typingId = addTypingIndicator();

        try {
            const data = await apiCall(`/api/cta/transit/ask?query=${encodeURIComponent(query)}`);
            addChatMessage(data.answer, 'bot');
        } catch (error) {
            addChatMessage(`Error checking "${fav.name}": ${error.message}`, 'bot');
        } finally {
            removeTypingIndicator(typingId);
        }
    } catch (error) {
        console.error("Error fetching favorite details:", error);
        addChatMessage("Could not fetch favorite details to check arrivals.", 'bot');
    }
}

async function deleteFavorite(id) {
  if (!confirm('Are you sure you want to delete this favorite? This may also affect some schedules.')) return;
  try {
    await apiCall(`/api/favorites/${id}`, { method: 'DELETE' });
    // Reload both favorites and schedules as a schedule might have been deleted
    await Promise.all([loadFavorites(), loadSchedules()]);
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
      listDiv.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⏰</div><p>No scheduled alerts</p><small>Set up notifications for your daily routine!</small></div>`;
      await loadNextUpcomingTrip(); // Ensure card is hidden
      return;
    }
    let html = '';
    data.schedules.forEach(schedule => {
      const days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
      const daysHtml = days.map((day, i) => `<span class="day-badge ${schedule.daysOfWeek.includes(i) ? 'active' : ''}">${day}</span>`).join('');
      html += `
        <div class="schedule-item">
          <div class="schedule-info">
            <h3>${schedule.favorite.name}</h3>
            <div class="schedule-meta">
              <div class="schedule-time">${formatTime(schedule.time)}</div>
              <div class="schedule-days">${daysHtml}</div>
            </div>
          </div>
          <div class="schedule-actions">
            <label class="toggle-switch"><input type="checkbox" class="toggle-schedule" data-id="${schedule.id}" ${schedule.enabled ? 'checked' : ''}><span class="toggle-slider"></span></label>
            <button class="btn btn-danger btn-sm btn-delete-schedule" data-id="${schedule.id}">Delete</button>
          </div>
        </div>`;
    });
    listDiv.innerHTML = html;
    await loadNextUpcomingTrip();
  } catch (error) {
      console.error("Error loading schedules", error);
      document.getElementById('schedules-list').innerHTML = `<div class="empty-state"><p>Could not load schedules.</p></div>`;
  }
}

async function handleCreateSchedule(e) {
  e.preventDefault();
  const form = e.target;
  const payload = {
    favoriteId: form.elements['schedule-favorite'].value,
    time: form.elements['schedule-time'].value,
    daysOfWeek: Array.from(form.elements['day']).filter(cb => cb.checked).map(cb => parseInt(cb.value)),
  };
  if (!payload.favoriteId || !payload.time || payload.daysOfWeek.length === 0) {
    alert('Please fill in all fields and select at least one day.'); return;
  }
  try {
    await apiCall('/api/schedules', { method: 'POST', body: JSON.stringify(payload) });
    closeModal('schedule-modal');
    form.reset();
    await loadSchedules();
  } catch (error) {
    alert('Error creating schedule: ' + error.message);
  }
}

async function toggleSchedule(id, enabled) {
  try {
    await apiCall(`/api/schedules/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
    await loadNextUpcomingTrip();
  } catch (error) {
    alert('Error updating schedule: ' + error.message);
    await loadSchedules(); // Revert toggle on failure
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

// CTA Data Helpers
async function loadBusDirections() {
  const routeId = document.getElementById('bus-route').value;
  if (!routeId) return;
  const select = document.getElementById('bus-direction');
  select.innerHTML = '<option value="">Loading...</option>';
  try {
    const data = await apiCall(`/api/cta/bus/${routeId}/directions`);
    select.innerHTML = '<option value="">Select direction...</option>' + data.directions.map(d => `<option value="${d}">${d}</option>`).join('');
  } catch(e) { select.innerHTML = '<option value="">Error</option>'; }
}
async function loadBusStops() {
  const routeId = document.getElementById('bus-route').value;
  const direction = document.getElementById('bus-direction').value;
  if (!routeId || !direction) return;
  const select = document.getElementById('bus-stop');
  select.innerHTML = '<option value="">Loading...</option>';
  try {
    const data = await apiCall(`/api/cta/bus/${routeId}/stops?direction=${encodeURIComponent(direction)}`);
    select.innerHTML = '<option value="">Select stop...</option>' + data.stops.map(s => `<option value="${s.stpid}">${s.stpnm}</option>`).join('');
  } catch(e) { select.innerHTML = '<option value="">Error</option>'; }
}
async function loadTrainStations() {
  const line = document.getElementById('train-line').value;
  if (!line) return;
  const select = document.getElementById('train-station');
  select.innerHTML = '<option value="">Loading...</option>';
  try {
    const data = await apiCall(`/api/cta/train/${line}/stations`);
    select.innerHTML = '<option value="">Select station...</option>' + data.stations.map(s => `<option value="${s.map_id}">${s.station_name}</option>`).join('');
  } catch(e) { select.innerHTML = '<option value="">Error</option>'; }
}

// Next Trip Card
async function loadNextUpcomingTrip() {
  const card = document.getElementById('next-trip-card');
  try {
    const data = await apiCall('/api/schedules');
    if (!data.schedules || data.schedules.length === 0) {
      card.style.display = 'none'; return;
    }
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const upcomingSchedules = data.schedules
      .filter(s => s.enabled && s.daysOfWeek.includes(now.getDay()) && s.time >= currentTime)
      .sort((a, b) => a.time.localeCompare(b.time));

    if (upcomingSchedules.length > 0) {
      const nextSchedule = upcomingSchedules[0];
      const [hours, minutes] = nextSchedule.time.split(':').map(Number);
      const scheduleTime = new Date();
      scheduleTime.setHours(hours, minutes, 0, 0);
      const minutesUntil = Math.round((scheduleTime - now) / 60000);

      if (minutesUntil >= 0) {
        document.getElementById('next-trip-info').innerHTML = `
          <div class="trip-details">
            <h3>${nextSchedule.favorite.name}</h3>
            <div class="trip-route">
              <span>${nextSchedule.favorite.routeType === 'BUS' ? '🚌' : '🚊'} ${nextSchedule.favorite.routeId}</span>
            </div>
          </div>
          <div class="trip-countdown">
            <div class="countdown-time">${minutesUntil}</div>
            <div class="countdown-label">minutes</div>
          </div>`;
        card.style.display = 'block';
        return;
      }
    }
    card.style.display = 'none';
  } catch (error) {
    console.error("Error loading next trip:", error);
    card.style.display = 'none';
  }
}

// Modal & Misc Helpers
function openModal(modalId) { document.getElementById(modalId).classList.add('show'); }
function closeModal(modalId) { document.getElementById(modalId).classList.remove('show'); }
function updateScheduleFavoriteDropdown(favorites) {
  const select = document.getElementById('schedule-favorite');
  select.innerHTML = '<option value="">Select a favorite...</option>' + favorites.map(fav => `<option value="${fav.id}">${fav.name}</option>`).join('');
}
function formatTime(time) {
  const [hours, minutes] = time.split(':');
  const h = parseInt(hours);
  return `${h % 12 || 12}:${minutes} ${h >= 12 ? 'PM' : 'AM'}`;
}
