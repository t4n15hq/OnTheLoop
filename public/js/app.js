/* ================= CONFIG ================= */
const API_BASE = window.location.origin;
const LINE_COLORS = {
  'Red': 'var(--cta-red)', 'Blue': 'var(--cta-blue)', 'Brown': 'var(--cta-brown)',
  'Green': 'var(--cta-green)', 'Orange': 'var(--cta-orange)', 'Purple': 'var(--cta-purple)',
  'Pink': 'var(--cta-pink)', 'Yellow': 'var(--cta-yellow)', 'BUS': 'var(--text-primary)'
};

// Hex values for gradients (since we can't easily get computed var values for gradients in inline styles without more work)
const LINE_HEX = {
  'Red': '#FF2E2E', 'Blue': '#2E9CFF', 'Brown': '#C98A68',
  'Green': '#00FF66', 'Orange': '#FF7B2E', 'Purple': '#B92EFF',
  'Pink': '#FF2E93', 'Yellow': '#FFE600', 'BUS': '#EDEDED'
};

let authToken = localStorage.getItem('authToken');
let currentUser = null;

/* ================= DOM ================= */
const authView = document.getElementById('auth-view');
const dashboardView = document.getElementById('dashboard-view');
const authForm = document.getElementById('auth-form');
const authError = document.getElementById('auth-error');
const authToggleBtn = document.getElementById('auth-toggle-btn');
const logoutBtn = document.getElementById('logout-btn');
const userMenuBtn = document.getElementById('user-menu-btn');
const userMenuDropdown = document.getElementById('user-menu-dropdown');
const themeToggleBtn = document.getElementById('theme-toggle');

const profileBtn = document.getElementById('profile-btn');
const changePasswordForm = document.getElementById('change-password-form');

/* ================= INIT ================= */
document.addEventListener('DOMContentLoaded', () => {
  const savedTheme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcons(savedTheme);

  if (authToken) showDashboard(); else showAuth();
  setupEventListeners();
});

function setupEventListeners() {
  themeToggleBtn.addEventListener('click', toggleTheme);
  authForm.addEventListener('submit', handleAuthSubmit);
  authToggleBtn.addEventListener('click', handleAuthToggle);
  logoutBtn.addEventListener('click', handleLogout);

  profileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    console.log('Profile button clicked');
    loadProfile();
    openModal('profile-modal');
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tab = e.target.dataset.tab;

      // Update buttons
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('active');
        b.style.color = 'var(--text-secondary)';
      });
      e.target.classList.add('active');
      e.target.style.color = 'var(--text-primary)';

      // Update content
      document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
      document.getElementById(`tab-${tab}`).classList.remove('hidden');
    });
  });

  changePasswordForm.addEventListener('submit', handleChangePassword);
  document.getElementById('profile-update-form').addEventListener('submit', handleProfileUpdate);

  userMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    console.log('User menu clicked, toggling dropdown');
    userMenuDropdown.classList.toggle('hidden');
  });
  document.addEventListener('click', () => {
    if (userMenuDropdown) userMenuDropdown.classList.add('hidden');
  });

  document.getElementById('chat-form').addEventListener('submit', handleChatMessage);
  document.getElementById('clear-terminal-btn').addEventListener('click', () => {
    document.getElementById('chat-messages').innerHTML = '<div class="chat-bubble bot">System ready. Awaiting input...</div>';
  });
  document.getElementById('add-favorite-btn').addEventListener('click', () => openModal('favorite-modal'));
  document.getElementById('add-schedule-btn').addEventListener('click', () => openModal('schedule-modal'));
  document.querySelectorAll('.modal-close').forEach(btn => btn.addEventListener('click', (e) => closeModal(e.target.closest('.modal').id)));

  document.getElementById('favorite-form').addEventListener('submit', handleCreateFavorite);
  document.getElementById('schedule-form').addEventListener('submit', handleCreateSchedule);
  document.getElementById('magic-fill-btn').addEventListener('click', handleMagicFill);

  document.querySelectorAll('input[name="route-type"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const isBus = e.target.value === 'BUS';
      const busFields = document.getElementById('bus-fields');
      const trainFields = document.getElementById('train-fields');
      if (isBus) {
        busFields.classList.remove('hidden');
        trainFields.classList.add('hidden');
      } else {
        busFields.classList.add('hidden');
        trainFields.classList.remove('hidden');
      }
    });
  });

  document.getElementById('bus-route').addEventListener('change', loadBusDirections);
  document.getElementById('bus-direction').addEventListener('change', () => {
    loadBusStops();
    loadBusAlightingStops();
  });
  document.getElementById('train-line').addEventListener('change', () => {
    loadTrainStations();
    loadTrainAlightingStations();
  });

  document.getElementById('favorites-list').addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.delete-fav-btn');
    if (deleteBtn) {
      e.stopPropagation();
      deleteFavorite(deleteBtn.dataset.id);
      return;
    }

    const card = e.target.closest('.fav-card');
    if (card) checkFavorite(card.dataset.id);
  });
  document.getElementById('schedules-list').addEventListener('click', (e) => {
    const toggle = e.target.closest('.pill-toggle');
    const delBtn = e.target.closest('.delete-btn');

    if (toggle) {
      e.preventDefault();
      const id = toggle.dataset.id;
      const currentState = toggle.classList.contains('active');
      toggleSchedule(id, !currentState);
    } else if (delBtn) {
      e.preventDefault();
      deleteSchedule(delBtn.dataset.id);
    }
  });
}

/* ================= THEME ================= */
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeIcons(next);
}
function updateThemeIcons(theme) {
  document.querySelector('.sun').style.display = theme === 'dark' ? 'inline' : 'none';
  document.querySelector('.moon').style.display = theme === 'dark' ? 'none' : 'inline';
}

function loadProfile() {
  if (!currentUser) return;
  document.getElementById('profile-phone-display').textContent = currentUser.phoneNumber;

  // Populate form fields
  document.getElementById('profile-name').value = currentUser.name || '';
  document.getElementById('profile-email').value = currentUser.email || '';

  // Fix date parsing
  try {
    const date = new Date(currentUser.createdAt);
    if (!isNaN(date.getTime())) {
      document.getElementById('profile-joined-display').textContent = `Member since ${date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`;
    } else {
      document.getElementById('profile-joined-display').textContent = 'Member since 2024';
    }
  } catch (e) {
    console.error('Date parsing error:', e);
    document.getElementById('profile-joined-display').textContent = 'Member since 2024';
  }
}

async function handleProfileUpdate(e) {
  e.preventDefault();
  const name = document.getElementById('profile-name').value;
  const email = document.getElementById('profile-email').value;
  const msgEl = document.getElementById('profile-msg');
  const btn = e.target.querySelector('button');

  const originalText = btn.textContent;
  btn.textContent = 'Saving...';
  btn.disabled = true;

  try {
    const response = await apiCall('/api/auth/profile', {
      method: 'PUT',
      body: JSON.stringify({ name, email })
    });

    // Update local user data
    currentUser = { ...currentUser, ...response.user };

    msgEl.textContent = 'Profile updated successfully!';
    msgEl.style.color = 'var(--cta-green)';
    msgEl.style.background = 'rgba(0, 255, 102, 0.1)';
    msgEl.style.display = 'block';

    // Refresh display
    loadProfile();

    setTimeout(() => {
      msgEl.style.display = 'none';
    }, 3000);
  } catch (error) {
    msgEl.textContent = error.message || 'Failed to update profile';
    msgEl.style.color = 'var(--cta-red)';
    msgEl.style.background = 'rgba(255, 46, 46, 0.1)';
    msgEl.style.display = 'block';
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

async function handleChangePassword(e) {
  e.preventDefault();
  const newPassword = document.getElementById('new-password').value;
  const msgEl = document.getElementById('password-msg');

  if (newPassword.length < 6) {
    msgEl.textContent = 'Password must be at least 6 characters';
    msgEl.style.color = 'var(--cta-red)';
    msgEl.style.background = 'rgba(255, 46, 46, 0.1)';
    msgEl.style.display = 'block';
    return;
  }

  const btn = e.target.querySelector('button');
  const originalText = btn.textContent;
  btn.textContent = 'Updating...';
  btn.disabled = true;

  try {
    await apiCall('/api/auth/password', {
      method: 'PUT',
      body: JSON.stringify({ password: newPassword })
    });

    msgEl.textContent = 'Password updated successfully!';
    msgEl.style.color = 'var(--cta-green)';
    msgEl.style.background = 'rgba(0, 255, 102, 0.1)';
    msgEl.style.display = 'block';
    e.target.reset();

    setTimeout(() => {
      msgEl.style.display = 'none';
    }, 3000);
  } catch (error) {
    msgEl.textContent = error.message || 'Failed to update password';
    msgEl.style.color = 'var(--cta-red)';
    msgEl.style.background = 'rgba(255, 46, 46, 0.1)';
    msgEl.style.display = 'block';
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

/* ================= API ================= */
async function apiCall(endpoint, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const response = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  if (!response.ok) {
    if (response.status === 401) handleLogout();
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Request failed');
  }
  const contentType = response.headers.get("content-type");
  if (contentType && contentType.indexOf("application/json") !== -1) return response.json();
}

/* ================= AUTH ================= */
let isRegistering = false;

function handleAuthToggle(e) {
  e.preventDefault();
  isRegistering = !isRegistering;

  const subtitle = document.getElementById('auth-subtitle');
  const submitBtn = document.getElementById('auth-submit-btn');
  const toggleBtn = document.getElementById('auth-toggle-btn');
  const passwordInput = document.getElementById('auth-password');

  if (isRegistering) {
    subtitle.textContent = 'CREATE ACCOUNT';
    submitBtn.textContent = 'Register';
    toggleBtn.textContent = 'Already have an account? Login';
    passwordInput.autocomplete = 'new-password';
  } else {
    subtitle.textContent = 'ENTER CREDENTIALS';
    submitBtn.textContent = 'Login';
    toggleBtn.textContent = 'Need an account? Register';
    passwordInput.autocomplete = 'current-password';
  }

  authError.style.display = 'none';
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const phoneNumber = document.getElementById('auth-phone').value;
  const password = document.getElementById('auth-password').value;
  const endpoint = isRegistering ? '/api/auth/register' : '/api/auth/login';

  // Basic validation
  if (!phoneNumber || !password) {
    authError.textContent = 'Please fill in all fields';
    authError.style.display = 'block';
    return;
  }

  if (password.length < 6) {
    authError.textContent = 'Password must be at least 6 characters';
    authError.style.display = 'block';
    return;
  }

  const btn = document.getElementById('auth-submit-btn');
  const originalText = btn.textContent;
  btn.textContent = 'Processing...';
  btn.disabled = true;

  try {
    const data = await apiCall(endpoint, {
      method: 'POST',
      body: JSON.stringify({ phoneNumber, password })
    });

    authToken = data.token;
    currentUser = data.user;
    localStorage.setItem('authToken', authToken);
    await showDashboard();
  } catch (error) {
    authError.textContent = error.message || 'Authentication failed';
    authError.style.display = 'block';
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}
function handleLogout() { authToken = null; localStorage.removeItem('authToken'); showAuth(); }
function showAuth() {
  authView.classList.remove('hidden');
  dashboardView.classList.add('hidden');
}
async function showDashboard() {
  authView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  if (!currentUser && authToken) await loadCurrentUser();
  updateWelcomeMessage();
  await loadDashboardData();
}
async function loadCurrentUser() { try { const data = await apiCall('/api/users/me'); currentUser = data.user; } catch (e) { handleLogout(); } }
function updateWelcomeMessage() {
  if (currentUser && currentUser.phoneNumber) document.getElementById('user-phone-display').textContent = currentUser.phoneNumber.slice(-4);
}
async function loadDashboardData() { await Promise.all([loadFavorites(), loadSchedules()]); }

/* ================= FEATURES ================= */
async function handleChatMessage(e) {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const query = input.value.trim();
  if (!query) return;
  addChatMessage(query, 'user'); input.value = '';
  const typingId = 't' + Date.now();
  document.getElementById('chat-messages').insertAdjacentHTML('beforeend', `<div id="${typingId}" class="chat-bubble bot" style="opacity:0.5">...</div>`);
  try {
    const data = await apiCall(`/api/cta/transit/ask?query=${encodeURIComponent(query)}`);
    document.getElementById(typingId).remove(); addChatMessage(data.answer, 'bot');
  } catch (e) { document.getElementById(typingId).remove(); addChatMessage("Error.", 'bot'); }
}
function addChatMessage(text, type) {
  const div = document.createElement('div'); div.className = `chat-bubble ${type}`;
  div.innerHTML = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  const c = document.getElementById('chat-messages'); c.appendChild(div); c.scrollTop = c.scrollHeight;
}

async function loadFavorites() {
  try {
    const data = await apiCall('/api/favorites');
    const list = document.getElementById('favorites-list');
    if (!data.favorites.length) { list.innerHTML = '<div style="grid-column:1/-1; opacity:0.5; font-family:monospace;">NO DATA</div>'; updateDropdown([]); return; }

    list.innerHTML = data.favorites.map(fav => {
      let color = fav.routeType === 'TRAIN' ? (LINE_COLORS[fav.routeId] || 'white') : 'var(--text-primary)';
      let icon = fav.routeType === 'TRAIN' ? '🚇' : '🚌';
      return `
        <div class="card fav-card" data-id="${fav.id}" style="position: relative;">
          <button class="icon-btn delete-fav-btn" data-id="${fav.id}" title="Delete Favorite" style="position: absolute; top: 4px; right: 4px; opacity: 0.5; transition: opacity 0.2s; font-size: 18px; width: 24px; height: 24px; padding: 0;">×</button>
          <div class="fav-icon">${icon}</div>
          <div class="fav-name">${fav.name}</div>
        </div>`;
    }).join('');
    updateDropdown(data.favorites);
  } catch (e) { console.error(e); }
}

async function loadSchedules() {
  try {
    const data = await apiCall('/api/schedules');
    const list = document.getElementById('schedules-list');
    if (!data.schedules.length) { list.innerHTML = '<div style="opacity:0.5; font-family:monospace;">NO ALERTS</div>'; updateNextTrip([]); return; }

    list.innerHTML = data.schedules.map(s => `
      <div class="alert-row">
        <div class="alert-info">
          <h4>${s.favorite.name}</h4>
          <div class="alert-meta">${formatTime(s.time)} // ${formatDays(s.daysOfWeek)}</div>
        </div>
        <div class="flex items-center gap-4">
          <button class="icon-btn delete-btn" data-id="${s.id}" title="Delete Alert">×</button>
          <div class="pill-toggle ${s.enabled ? 'active' : ''}" data-id="${s.id}"></div>
        </div>
      </div>
    `).join('');
    updateNextTrip(data.schedules);
  } catch (e) { console.error(e); }
}

// Add delete handler
async function deleteSchedule(id) {
  if (!confirm('Delete this alert?')) return;
  try {
    await apiCall(`/api/schedules/${id}`, { method: 'DELETE' });
    await loadSchedules();
  } catch (e) { alert('Error deleting alert'); }
}

async function deleteFavorite(id) {
  if (!confirm('Delete this favorite route? This will also delete any alerts using this route.')) return;
  try {
    await apiCall(`/api/favorites/${id}`, { method: 'DELETE' });
    await loadFavorites();
    await loadSchedules(); // Reload schedules in case any were deleted
  } catch (e) {
    alert('Error deleting favorite: ' + e.message);
  }
}

async function updateNextTrip(schedules) {
  const card = document.getElementById('next-trip-card');
  const now = new Date();
  const today = now.getDay();

  // Find next active schedule
  const next = schedules
    .filter(s => s.enabled && s.daysOfWeek.includes(today))
    .map(s => {
      const [h, m] = s.time.split(':');
      const d = new Date(); d.setHours(h, m, 0);
      if (d < now) d.setDate(d.getDate() + 1);
      return { ...s, date: d };
    })
    .sort((a, b) => a.date - b.date)[0];

  if (!next) { card.classList.add('hidden'); return; }

  const alertDiff = Math.ceil((next.date - now) / 60000);

  // Set static card details
  document.getElementById('nt-name').innerText = next.favorite.routeId + (next.favorite.routeType === 'BUS' ? ' Bus' : ' Line');
  document.getElementById('nt-name').style.color = next.favorite.routeType === 'BUS' ? 'var(--text-primary)' : LINE_COLORS[next.favorite.routeId];

  // Default state: Show Alert Countdown if no live data
  let mainTime = alertDiff;
  let timeLabel = "MINUTES TO ALERT";
  let subText = `<span style="color: var(--text-secondary);">Scheduled for ${formatTime(next.time)}</span>`;
  let badgeHtml = `<span style="font-size: 0.8rem; color: var(--text-secondary); border: 1px solid var(--surface-border); padding: 4px 8px; border-radius: 4px; display: inline-flex; align-items: center; gap: 6px;">
         <span style="color: var(--cta-blue);">●</span> ALERT SET
       </span>`;

  let followingArrivals = [];

  // Fetch LIVE data
  try {
    const stopId = next.favorite.routeType === 'TRAIN'
      ? (next.favorite.stationId || next.favorite.boardingStopId)
      : (next.favorite.stopId || next.favorite.boardingStopId);

    if (stopId) {
      const liveData = await apiCall(`/api/cta/arrivals?type=${next.favorite.routeType}&routeId=${next.favorite.routeId}&stopId=${stopId}`);

      if (liveData.arrivals && liveData.arrivals.length > 0) {
        // We have live data! Override the display.
        const nextArrival = liveData.arrivals[0];
        followingArrivals = liveData.arrivals.slice(1, 3);

        // 1. Update Main Time to Live Arrival
        mainTime = nextArrival.minutesAway;
        timeLabel = "MINUTES AWAY";

        // 2. Update Badge
        if (nextArrival.isScheduled) {
          badgeHtml = `<span style="font-size: 0.8rem; color: var(--text-secondary); border: 1px solid var(--surface-border); padding: 4px 8px; border-radius: 4px; display: inline-flex; align-items: center; gap: 6px;">
            <span style="opacity: 0.7;">⚠</span> GHOST
          </span>`;
        } else {
          badgeHtml = `<span style="font-size: 0.8rem; color: var(--cta-green); border: 1px solid rgba(0, 255, 102, 0.2); background: rgba(0, 255, 102, 0.1); padding: 4px 8px; border-radius: 4px; display: inline-flex; align-items: center; gap: 6px;">
            <span style="animation: pulse 2s infinite;">●</span> LIVE
          </span>`;
        }
      }
    }
  } catch (e) { console.error('Error fetching live status:', e); }

  // Render
  document.getElementById('nt-time').style.display = 'none'; // Hide original big number container to use custom layout
  document.querySelector('.arrival-unit').style.display = 'none'; // Hide original unit label

  const destEl = document.getElementById('nt-dest');
  destEl.innerHTML = `
    <div style="display: flex; flex-direction: column; align-items: flex-end; text-align: right;">
      <!-- Destination -->
      <div style="font-size: 0.85rem; letter-spacing: 0.05em; color: var(--text-secondary); margin-bottom: 12px; text-transform: uppercase;">
        ${next.favorite.alightingStopName || 'Loop'}
      </div>

      <!-- Main Time & Badge Group -->
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 4px;">
        ${badgeHtml}
        <div style="font-size: 5rem; font-weight: 700; line-height: 1; letter-spacing: -0.03em; color: var(--text-primary);">
          ${mainTime}
        </div>
      </div>
      
      <!-- Unit Label -->
      <div style="font-size: 0.9rem; font-weight: 500; color: var(--text-secondary); margin-bottom: 12px;">
        ${timeLabel}
      </div>

      <!-- Upcoming Arrivals (The "Then" list) -->
      ${followingArrivals.length > 0 ?
      `<div style="font-family: var(--font-mono); font-size: 0.9rem; color: var(--text-primary); margin-bottom: 16px;">
           Following: <span style="opacity: 0.7;">${followingArrivals.map(a => a.minutesAway + 'm').join(', ')}</span>
         </div>`
      : ''
    }

      <!-- Alert Footer (Distinctly separated) -->
      <div style="border-top: 1px solid var(--surface-border); padding-top: 8px; margin-top: 4px;">
        <div style="font-size: 0.8rem; color: var(--text-tertiary); display: flex; align-items: center; gap: 6px;">
          <span>🔔</span> Alert set for ${formatTime(next.time)} (${alertDiff}m)
        </div>
      </div>
    </div>
  `;

  card.classList.remove('hidden');
}

/* --- HELPERS (Standard) --- */
async function loadBusDirections() {
  const id = document.getElementById('bus-route').value; if (!id) return;
  const s = document.getElementById('bus-direction'); s.innerHTML = '<option>...</option>';
  try { const d = await apiCall(`/api/cta/bus/${id}/directions`); s.innerHTML = '<option value="">Select...</option>' + d.directions.map(o => `<option value="${o}">${o}</option>`).join(''); } catch (e) { s.innerHTML = '<option>Err</option>'; }
}
async function loadBusStops() {
  const id = document.getElementById('bus-route').value; const dir = document.getElementById('bus-direction').value; if (!id || !dir) return;
  const s = document.getElementById('bus-stop'); s.innerHTML = '<option>...</option>';
  try { const d = await apiCall(`/api/cta/bus/${id}/stops?direction=${encodeURIComponent(dir)}`); s.innerHTML = '<option value="">Select...</option>' + d.stops.map(o => `<option value="${o.stpid}">${o.stpnm}</option>`).join(''); } catch (e) { s.innerHTML = '<option>Err</option>'; }
}
async function loadBusAlightingStops() {
  const id = document.getElementById('bus-route').value; const dir = document.getElementById('bus-direction').value; if (!id || !dir) return;
  const s = document.getElementById('bus-alighting-stop'); s.innerHTML = '<option>...</option>';
  try { const d = await apiCall(`/api/cta/bus/${id}/stops?direction=${encodeURIComponent(dir)}`); s.innerHTML = '<option value="">Select (Optional)...</option>' + d.stops.map(o => `<option value="${o.stpid}">${o.stpnm}</option>`).join(''); } catch (e) { s.innerHTML = '<option>Err</option>'; }
}
const TRAIN_DIRECTIONS = {
  'Red': ['Northbound', 'Southbound'],
  'Blue': ['Northbound', 'Southbound'],
  'Brown': ['Northbound', 'Southbound'],
  'Green': ['Eastbound', 'Westbound'],
  'Orange': ['Northbound', 'Southbound'],
  'Pink': ['Eastbound', 'Westbound'],
  'Purple': ['Northbound', 'Southbound'],
  'Yellow': ['Northbound', 'Southbound']
};

async function loadTrainStations() {
  const line = document.getElementById('train-line').value; if (!line) return;
  const s = document.getElementById('train-station'); s.innerHTML = '<option>...</option>';
  loadTrainDirections(); // Also load directions
  try { const d = await apiCall(`/api/cta/train/${line}/stations`); s.innerHTML = '<option value="">Select...</option>' + d.stations.map(o => `<option value="${o.map_id}">${o.station_name}</option>`).join(''); } catch (e) { s.innerHTML = '<option>Err</option>'; }
}

async function loadTrainAlightingStations() {
  const line = document.getElementById('train-line').value; if (!line) return;
  const s = document.getElementById('train-alighting-station'); s.innerHTML = '<option>...</option>';
  try { const d = await apiCall(`/api/cta/train/${line}/stations`); s.innerHTML = '<option value="">Select (Optional)...</option>' + d.stations.map(o => `<option value="${o.map_id}">${o.station_name}</option>`).join(''); } catch (e) { s.innerHTML = '<option>Err</option>'; }
}

function loadTrainDirections() {
  const line = document.getElementById('train-line').value;
  const s = document.getElementById('train-direction');

  if (!line || !TRAIN_DIRECTIONS[line]) {
    s.innerHTML = '<option value="">Select Direction</option>';
    return;
  }

  s.innerHTML = '<option value="">Select...</option>' + TRAIN_DIRECTIONS[line].map(d => `<option value="${d}">${d}</option>`).join('');
}
async function handleCreateFavorite(e) {
  e.preventDefault();
  const form = e.target;
  const routeType = document.querySelector('input[name="route-type"]:checked').value;

  // Validate required fields
  const name = form.elements['favorite-name'].value.trim();
  const boardingStopName = form.elements['boarding-stop-name'].value.trim();
  const alightingStopName = form.elements['alighting-stop-name'].value.trim();

  if (!name) {
    alert('Please enter a friendly name for this route (e.g., "To Work")');
    return;
  }

  if (!boardingStopName) {
    alert('Please enter a label for your boarding location (e.g., "Home", "Gym")');
    return;
  }

  if (!alightingStopName) {
    alert('Please enter a label for your destination (e.g., "Work", "School")');
    return;
  }

  const routeId = routeType === 'BUS' ? form.elements['bus-route'].value : form.elements['train-line'].value;
  const direction = routeType === 'BUS' ? form.elements['bus-direction'].value : form.elements['train-direction'].value;
  const stopId = routeType === 'BUS' ? form.elements['bus-stop'].value : null;
  const stationId = routeType === 'TRAIN' ? form.elements['train-station'].value : null;

  if (!routeId) {
    alert(`Please select a ${routeType === 'BUS' ? 'route number' : 'train line'}`);
    return;
  }

  if (!direction) {
    alert('Please select a direction');
    return;
  }

  if (routeType === 'BUS' && !stopId) {
    alert('Please select a boarding stop');
    return;
  }

  if (routeType === 'TRAIN' && !stationId) {
    alert('Please select a boarding station');
    return;
  }

  const p = {
    name,
    routeType,
    boardingStopName,
    alightingStopName,
    routeId,
    direction,
    stopId,
    stationId
  };

  try {
    await apiCall('/api/favorites', { method: 'POST', body: JSON.stringify(p) });
    closeModal('favorite-modal');
    form.reset();
    await loadFavorites();
  } catch (e) {
    alert('Error saving favorite: ' + e.message);
  }
}
async function handleCreateSchedule(e) {
  e.preventDefault(); const form = e.target; const days = Array.from(form.elements['day']).filter(c => c.checked).map(c => parseInt(c.value));
  const p = { favoriteId: form.elements['schedule-favorite'].value, time: form.elements['schedule-time'].value, daysOfWeek: days };
  try { await apiCall('/api/schedules', { method: 'POST', body: JSON.stringify(p) }); closeModal('schedule-modal'); form.reset(); await loadSchedules(); } catch (e) { alert(e.message); }
}
async function toggleSchedule(id, enabled) {
  // Optimistic UI update
  const toggleBtn = document.querySelector(`.pill-toggle[data-id="${id}"]`);
  if (toggleBtn) {
    if (enabled) toggleBtn.classList.add('active');
    else toggleBtn.classList.remove('active');
  }

  try {
    await apiCall(`/api/schedules/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
    // Reload data to ensure consistency
    await loadSchedules();
  } catch (e) {
    console.error('Toggle error:', e);
    // Revert on error
    await loadSchedules();
  }
}

function openModal(id) {
  const modal = document.getElementById(id);
  const backdrop = document.getElementById('modal-backdrop');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('show'); // Ensure show class is added
  }
  if (backdrop) backdrop.classList.remove('hidden');
}

function closeModal(id) {
  const modal = document.getElementById(id);
  const backdrop = document.getElementById('modal-backdrop');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('show');
  }
  if (backdrop) backdrop.classList.add('hidden');
}

async function checkFavorite(id) {
  try {
    // 1. Fetch the favorite
    const { favorite: f } = await apiCall(`/api/favorites/${id}`);

    if (!f) {
      addChatMessage('⚠️ Favorite not found.', 'bot');
      return;
    }

    addChatMessage(`Checking ${f.name}...`, 'user');

    const t = 't' + Date.now();
    document.getElementById('chat-messages').insertAdjacentHTML('beforeend', `<div id="${t}" class="chat-bubble bot">...</div>`);

    try {
      // 2. Validate favorite has required data
      const stopId = f.routeType === 'TRAIN' ? f.stationId : f.stopId;
      const type = f.routeType;
      const routeId = f.routeId;
      const stopName = f.boardingStopName;

      if (!stopId) {
        document.getElementById(t).remove();
        addChatMessage(`⚠️ "${f.name}" is missing stop information. Please delete and re-create this favorite.`, 'bot');
        return;
      }

      if (!routeId) {
        document.getElementById(t).remove();
        addChatMessage(`⚠️ "${f.name}" is missing route information. Please delete and re-create this favorite.`, 'bot');
        return;
      }

      // 3. Fetch arrivals directly with exact IDs
      let apiUrl = `/api/cta/arrivals?type=${encodeURIComponent(type)}&stopId=${encodeURIComponent(stopId)}&routeId=${encodeURIComponent(routeId)}`;

      if (type === 'TRAIN' && f.direction) {
        apiUrl += `&direction=${encodeURIComponent(f.direction)}`;
      }

      const arrivals = await apiCall(apiUrl);

      document.getElementById(t).remove();

      // 4. Validate arrivals data
      if (!arrivals || !Array.isArray(arrivals) || arrivals.length === 0) {
        addChatMessage(`No upcoming arrivals for ${f.name} at ${stopName || 'this stop'}.\n\nThis could mean:\n• No vehicles are currently scheduled\n• The route is not running right now\n• There's a service disruption`, 'bot');
        return;
      }

      // 5. Format the response with validation
      const next = arrivals[0];

      if (!next) {
        addChatMessage(`⚠️ Received invalid arrival data for ${f.name}. Please try again.`, 'bot');
        return;
      }

      const timeText = next.isApproaching ? 'DUE' : `${next.minutesAway} min`;
      const delayedFlag = next.isDelayed ? ' ⚠️ DELAYED' : '';
      const scheduledFlag = next.isScheduled ? ' 👻 GHOST' : '';
      const following = arrivals.slice(1, 3)
        .filter(a => a && (a.isApproaching || (typeof a.minutesAway === 'number' && !isNaN(a.minutesAway))))
        .map(a => a.isApproaching ? 'DUE' : `${a.minutesAway}m`)
        .join(', ');

      const icon = type === 'TRAIN' ? '🚆' : '🚌';

      let response = `${icon} ${f.name}\n`;
      response += `📍 ${stopName || 'Unknown Stop'}\n`;
      response += `⏱️ Next: ${timeText} → ${next.destination || 'Unknown'}${delayedFlag}${scheduledFlag}`;
      if (following) response += `\nFollowing: ${following}`;

      addChatMessage(response, 'bot');

    } catch (apiError) {
      document.getElementById(t)?.remove();
      console.error('API Error:', apiError);

      // Provide helpful error message based on error type
      if (apiError.message?.includes('404')) {
        addChatMessage(`⚠️ Could not find route ${f.routeId}. The route might have changed. Please re-create this favorite.`, 'bot');
      } else if (apiError.message?.includes('500')) {
        addChatMessage(`⚠️ CTA service is temporarily unavailable. Please try again in a moment.`, 'bot');
      } else {
        addChatMessage(`⚠️ Could not fetch arrival times for ${f.name}. Please check your connection and try again.`, 'bot');
      }
    }
  } catch (outerError) {
    console.error('Favorite Check Error:', outerError);
    addChatMessage('⚠️ An error occurred. Please try again.', 'bot');
  }
}
function closeModal(id) { document.getElementById(id).classList.remove('show'); }
async function handleMagicFill() {
  const input = document.getElementById('magic-route-input');
  const btn = document.getElementById('magic-fill-btn');
  const query = input.value.trim();

  if (!query) {
    alert('Please enter a route description (e.g., "Red Line from Howard to Loop")');
    return;
  }

  const originalText = btn.innerText;
  btn.innerText = 'Analyzing...';
  btn.disabled = true;

  try {
    const { config } = await apiCall('/api/cta/parse-route', {
      method: 'POST',
      body: JSON.stringify({ query })
    });

    if (!config) {
      throw new Error('Could not understand your query. Please try rephrasing or use manual entry.');
    }

    console.log('Magic Fill Config:', config);

    // Cleanup: Strip " Line" or " Bus" from routeId if present
    if (config.routeId) {
      config.routeId = config.routeId.replace(/\s+(Line|line|Bus|bus)$/g, '').trim();
      console.log(`Cleaned routeId: ${config.routeId}`);
    }

    // Validate config has required fields
    if (!config.routeType || !config.routeId) {
      throw new Error(`AI did not provide complete route information. Got: ${JSON.stringify(config)}`);
    }

    console.log(`Route Type: ${config.routeType}, Route ID: ${config.routeId}, Direction: ${config.direction}, Stop: ${config.stopName}`);

    btn.innerText = 'Filling...';

    // Helper to wait for dropdowns to populate
    const waitForOptions = async (id) => {
      const el = document.getElementById(id);
      console.log(`Waiting for ${id} to populate...`);
      for (let i = 0; i < 30; i++) { // Wait up to 3s
        if (el.options.length > 1 && el.options[1].text !== '...') {
          console.log(`${id} populated with ${el.options.length} options`);
          return true;
        }
        await new Promise(r => setTimeout(r, 100));
      }
      console.warn(`${id} did not populate in time`);
      return false;
    };

    // Helper to match direction smartly
    const matchDirection = (id, target) => {
      const el = document.getElementById(id);
      const t = target.toLowerCase();
      console.log(`matchDirection: Looking for "${target}" in ${id}`);
      console.log(`Available options:`, Array.from(el.options).map(o => `"${o.value}"`));

      // 1. Direct match
      for (let opt of el.options) {
        if (!opt.value) continue; // Skip empty options
        if (opt.value.toLowerCase().includes(t) || t.includes(opt.value.toLowerCase())) {
          console.log(`Direct match found: "${opt.value}"`);
          el.value = opt.value;
          console.log(`Set ${id} value to: "${el.value}"`);
          return true;
        }
      }
      // 2. Cardinal match
      const cardinals = ['north', 'south', 'east', 'west'];
      for (let c of cardinals) {
        if (t.includes(c)) {
          for (let opt of el.options) {
            if (!opt.value) continue; // Skip empty options
            if (opt.value.toLowerCase().includes(c)) {
              console.log(`Cardinal match found: "${opt.value}" (via "${c}")`);
              el.value = opt.value;
              console.log(`Set ${id} value to: "${el.value}"`);
              return true;
            }
          }
        }
      }

      // 3. Fallback: Map cardinal directions for diagonal lines
      // Blue Line runs NW-SE, so East→North, West→South
      if (t.includes('east') && !t.includes('west')) {
        for (let opt of el.options) {
          if (!opt.value) continue;
          if (opt.value.toLowerCase().includes('north')) {
            console.log(`Mapped Eastbound → Northbound for diagonal line`);
            el.value = opt.value;
            return true;
          }
        }
      } else if (t.includes('west') && !t.includes('east')) {
        for (let opt of el.options) {
          if (!opt.value) continue;
          if (opt.value.toLowerCase().includes('south')) {
            console.log(`Mapped Westbound → Southbound for diagonal line`);
            el.value = opt.value;
            return true;
          }
        }
      }

      console.warn(`No match found for "${target}" in ${id}`);
      return false;
    };

    // 1. Set Route Type
    const radio = document.querySelector(`input[name="route-type"][value="${config.routeType}"]`);
    if (radio) {
      console.log(`Selecting route type: ${config.routeType}`);
      radio.checked = true;
      radio.dispatchEvent(new Event('change'));
    } else {
      console.error(`Could not find radio button for route type: ${config.routeType}`);
    }

    // Wait for UI switch
    await new Promise(r => setTimeout(r, 100));

    if (config.routeType === 'TRAIN') {
      console.log('Processing TRAIN route...');
      const lineSelect = document.getElementById('train-line');
      console.log(`Setting train line to: ${config.routeId}`);
      console.log(`Available options:`, Array.from(lineSelect.options).map(o => o.value));

      lineSelect.value = config.routeId;
      console.log(`Train line value after setting: ${lineSelect.value}`);
      lineSelect.dispatchEvent(new Event('change'));

      // Wait for directions (should be fast/sync but good to be safe)
      await waitForOptions('train-direction');

      // Set Direction
      console.log(`Attempting to match direction: ${config.direction}`);
      if (config.direction && matchDirection('train-direction', config.direction)) {
        console.log('Direction matched successfully');
        // Trigger station load if needed (though line change usually triggers it)
        // But we need to wait for stations to load before selecting one
        await waitForOptions('train-station');

        // Set Station
        const stationSelect = document.getElementById('train-station');
        let bestStation = '';
        let maxScore = 0;
        const targetName = config.stopName.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
        const targetTokens = targetName.split(/\s+/).filter(t => t.length > 2);

        for (let opt of stationSelect.options) {
          if (!opt.value) continue;
          const optName = opt.text.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
          const optTokens = optName.split(/\s+/).filter(t => t.length > 2);

          // Count matching tokens
          let score = 0;
          for (let tt of targetTokens) {
            for (let ot of optTokens) {
              if (tt === ot || tt.includes(ot) || ot.includes(tt)) {
                score++;
              }
            }
          }

          if (score > maxScore) {
            maxScore = score;
            bestStation = opt.value;
          }
        }

        if (bestStation) {
          stationSelect.value = bestStation;
          console.info(`Matched station: ${config.stopName} -> ${stationSelect.options[stationSelect.selectedIndex].text}`);
        } else {
          console.warn(`Could not match station: ${config.stopName}`);
        }
      }

    } else {
      // BUS Logic
      const routeInput = document.getElementById('bus-route');
      routeInput.value = config.routeId;
      routeInput.dispatchEvent(new Event('change'));

      // Wait for directions API
      await waitForOptions('bus-direction');

      // Set Direction
      const dirSelect = document.getElementById('bus-direction');
      if (matchDirection('bus-direction', config.direction)) {
        dirSelect.dispatchEvent(new Event('change'));

        // Wait for stops API
        await waitForOptions('bus-stop');

        const stopSelect = document.getElementById('bus-stop');
        let bestStop = '';
        const targetName = config.stopName.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
        const targetTokens = targetName.split(/\s+/).filter(t => t.length > 2);

        for (let opt of stopSelect.options) {
          if (!opt.value) continue;
          const optName = opt.text.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
          const optTokens = optName.split(/\s+/).filter(t => t.length > 2);

          let score = 0;
          for (let tt of targetTokens) {
            for (let ot of optTokens) {
              if (tt === ot || tt.includes(ot) || ot.includes(tt)) {
                score++;
              }
            }
          }

          if (score > 0 && score > (bestStop ? 0 : -1)) {
            bestStop = opt.value;
            if (score >= targetTokens.length) break; // Perfect match
          }
        }

        if (bestStop) {
          stopSelect.value = bestStop;
          console.info(`Matched stop: ${config.stopName} -> ${stopSelect.options[stopSelect.selectedIndex].text}`);
        } else {
          console.warn(`Could not match stop: ${config.stopName}`);
        }
      }
    }

    // Set Friendly Name
    const nameInput = document.getElementById('favorite-name');
    if (config.alightingName) {
      nameInput.value = `To ${config.alightingName}`;
    } else {
      nameInput.value = `${config.routeId} ${config.direction}`;
    }

    // Set Labels
    if (config.stopName) document.getElementById('boarding-stop-name').value = config.stopName;
    if (config.alightingName) document.getElementById('alighting-stop-name').value = config.alightingName;

    // Success feedback
    btn.innerText = '✓ Done';
    input.value = '';
    setTimeout(() => {
      btn.innerText = originalText;
    }, 2000);

  } catch (e) {
    console.error(e);
    alert(e.message || 'Could not auto-fill. Please try rephrasing your query or use manual entry.');
  } finally {
    btn.disabled = false;
    if (btn.innerText !== '✓ Done') {
      btn.innerText = originalText;
    }
  }
}

function updateDropdown(f) { document.getElementById('schedule-favorite').innerHTML = '<option value="">Select...</option>' + f.map(x => `<option value="${x.id}">${x.name}</option>`).join(''); }
function formatTime(t) { const [h, m] = t.split(':'); return `${h % 12 || 12}:${m} ${h >= 12 ? 'PM' : 'AM'}`; }
function formatDays(d) { const m = ['S', 'M', 'T', 'W', 'Th', 'F', 'S']; return d.map(x => m[x]).join(' '); }