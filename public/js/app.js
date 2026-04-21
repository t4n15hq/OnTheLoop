/* ================= CONFIG ================= */
const API_BASE = window.location.origin;
const LINE_COLORS = {
  'Red': 'var(--cta-red)', 'Blue': 'var(--cta-blue)', 'Brown': 'var(--cta-brown)',
  'Green': 'var(--cta-green)', 'Orange': 'var(--cta-orange)', 'Purple': 'var(--cta-purple)',
  'Pink': 'var(--cta-pink)', 'Yellow': 'var(--cta-yellow)', 'BUS': 'var(--text-primary)'
};

// Authentic CTA line colors (transitchicago.com)
const LINE_HEX = {
  'Red': '#C60C30', 'Blue': '#00A1DE', 'Brown': '#62361B',
  'Green': '#009B3A', 'Orange': '#F9461C', 'Purple': '#522398',
  'Pink': '#E27EA6', 'Yellow': '#F9E300', 'BUS': '#337EA9'
};

let authToken = localStorage.getItem('authToken');
let currentUser = null;
let cachedFavorites = [];

/* ================= DOM ================= */
const landingView = document.getElementById('landing-view');
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
  const savedTheme = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateThemeIcons(savedTheme);

  applyRoute();
  setupEventListeners();
  startLandingClock();
  registerServiceWorker();

  // React to back/forward or anchor navigation
  window.addEventListener('hashchange', applyRoute);
});

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Only register over HTTPS or on localhost; browsers reject it otherwise.
  const secure = window.isSecureContext || location.hostname === 'localhost';
  if (!secure) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

function startLandingClock() {
  const tickerEl = document.getElementById('lv-ticker-time');
  const boardEl = document.getElementById('lv-board-time');
  if (!tickerEl && !boardEl) return;
  const tick = () => {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const hh24 = String(h).padStart(2, '0');
    const mm = String(m).padStart(2, '0');
    const hh12 = ((h % 12) || 12);
    const ampm = h >= 12 ? 'PM' : 'AM';
    if (tickerEl) tickerEl.textContent = `${hh24}:${mm}`;
    if (boardEl) boardEl.textContent = `${hh12}:${mm} ${ampm}`;
  };
  tick();
  setInterval(tick, 1000);
}

function setupEventListeners() {
  themeToggleBtn.addEventListener('click', toggleTheme);
  document.getElementById('landing-theme-toggle')?.addEventListener('click', toggleTheme);
  authForm.addEventListener('submit', handleAuthSubmit);
  authToggleBtn.addEventListener('click', handleAuthToggle);
  logoutBtn.addEventListener('click', handleLogout);

  // Landing footer → open legal modals
  document.querySelectorAll('[data-open-modal]').forEach((btn) => {
    btn.addEventListener('click', () => openModal(btn.dataset.openModal));
  });

  // Backdrop click closes any open modal
  document.getElementById('modal-backdrop')?.addEventListener('click', () => {
    document.querySelectorAll('.modal.show, .modal:not(.hidden)').forEach((m) => {
      m.classList.add('hidden');
      m.classList.remove('show');
    });
    document.getElementById('modal-backdrop').classList.add('hidden');
  });

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

      if (tab === 'delivery') loadDeliveryLog();
    });
  });

  changePasswordForm.addEventListener('submit', handleChangePassword);
  document.getElementById('profile-update-form').addEventListener('submit', handleProfileUpdate);
  document.getElementById('link-telegram-btn')?.addEventListener('click', handleLinkTelegram);
  document.getElementById('unlink-telegram-btn')?.addEventListener('click', handleUnlinkTelegram);

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

  // Quick-ask chips: click → fill input → submit the form for you.
  document.querySelectorAll('#quick-asks .quick-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const q = chip.dataset.q;
      if (!q) return;
      const input = document.getElementById('chat-input');
      input.value = q;
      input.focus();
      document.getElementById('chat-form').requestSubmit();
    });
  });

  // Smart route-suggest: as the user types, fuzzy-match against saved routes
  // and surface a single suggestion chip.
  const chatInputEl = document.getElementById('chat-input');
  if (chatInputEl) {
    chatInputEl.addEventListener('input', updateRouteSuggestion);
    chatInputEl.addEventListener('focus', updateRouteSuggestion);
    chatInputEl.addEventListener('blur', () => setTimeout(hideRouteSuggestion, 120));
  }

  // Keyboard shortcut: `/` focuses the chat input (unless already typing).
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/') return;
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
    const input = document.getElementById('chat-input');
    if (input) { e.preventDefault(); input.focus(); }
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
    const testBtn = e.target.closest('.test-btn');

    if (toggle) {
      e.preventDefault();
      const id = toggle.dataset.id;
      const currentState = toggle.classList.contains('active');
      toggleSchedule(id, !currentState);
    } else if (testBtn) {
      e.preventDefault();
      testSchedule(testBtn.dataset.id, testBtn);
    } else if (delBtn) {
      e.preventDefault();
      deleteSchedule(delBtn.dataset.id);
    }
  });

  // Pause-notifications controls in the Delivery tab.
  document.querySelectorAll('[data-pause-hours]').forEach((btn) => {
    btn.addEventListener('click', () => pauseNotifications(parseInt(btn.dataset.pauseHours, 10)));
  });
  document.getElementById('pause-resume-btn')?.addEventListener('click', resumeNotifications);
  document.getElementById('refresh-log-btn')?.addEventListener('click', loadDeliveryLog);
  document.getElementById('save-quiet-hours-btn')?.addEventListener('click', saveQuietHours);
  document.getElementById('clear-quiet-hours-btn')?.addEventListener('click', clearQuietHours);
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
  document.querySelectorAll('.sun').forEach((el) => {
    el.style.display = theme === 'dark' ? 'inline' : 'none';
  });
  document.querySelectorAll('.moon').forEach((el) => {
    el.style.display = theme === 'dark' ? 'none' : 'inline';
  });
}

function loadProfile() {
  if (!currentUser) return;
  document.getElementById('profile-email-display').textContent = currentUser.email;

  document.getElementById('profile-name').value = currentUser.name || '';
  document.getElementById('profile-email').value = currentUser.email || '';
  document.getElementById('profile-email-notifications').checked = Boolean(currentUser.emailNotifications);

  try {
    const date = new Date(currentUser.createdAt);
    if (!isNaN(date.getTime())) {
      document.getElementById('profile-joined-display').textContent = `Member since ${date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`;
    } else {
      document.getElementById('profile-joined-display').textContent = '';
    }
  } catch (e) {
    document.getElementById('profile-joined-display').textContent = '';
  }

  renderTelegramStatus();
  renderPauseStatus();
  renderQuietHours();
}

function renderQuietHours() {
  const startEl = document.getElementById('quiet-hours-start');
  const endEl = document.getElementById('quiet-hours-end');
  if (!startEl || !endEl) return;
  startEl.value = currentUser?.quietHoursStart || '';
  endEl.value = currentUser?.quietHoursEnd || '';
}

function showQuietHoursMsg(text, ok) {
  const msg = document.getElementById('quiet-hours-msg');
  if (!msg) return;
  msg.textContent = text;
  msg.style.display = 'block';
  msg.style.background = ok ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';
  msg.style.color = ok ? 'var(--cta-green)' : 'var(--cta-red)';
  setTimeout(() => { msg.style.display = 'none'; }, 2800);
}

async function saveQuietHours() {
  const start = document.getElementById('quiet-hours-start')?.value || '';
  const end = document.getElementById('quiet-hours-end')?.value || '';
  if ((start && !end) || (!start && end)) {
    showQuietHoursMsg('Set both start and end, or leave both blank.', false);
    return;
  }
  try {
    const res = await apiCall('/api/auth/profile', {
      method: 'PUT',
      body: JSON.stringify({
        quietHoursStart: start || null,
        quietHoursEnd: end || null,
      }),
    });
    currentUser = { ...currentUser, ...res.user };
    renderQuietHours();
    showQuietHoursMsg(start && end ? `Quiet hours saved: ${start}–${end}.` : 'Quiet hours disabled.', true);
  } catch (e) {
    showQuietHoursMsg(e.message || 'Failed to save quiet hours', false);
  }
}

async function clearQuietHours() {
  try {
    const res = await apiCall('/api/auth/profile', {
      method: 'PUT',
      body: JSON.stringify({ quietHoursStart: null, quietHoursEnd: null }),
    });
    currentUser = { ...currentUser, ...res.user };
    renderQuietHours();
    showQuietHoursMsg('Quiet hours disabled.', true);
  } catch (e) {
    showQuietHoursMsg(e.message || 'Failed to clear quiet hours', false);
  }
}

function renderPauseStatus() {
  const status = document.getElementById('pause-status');
  const resume = document.getElementById('pause-resume-btn');
  if (!status || !resume) return;

  const until = currentUser?.notificationsPausedUntil;
  const paused = until && new Date(until) > new Date();
  if (paused) {
    const d = new Date(until);
    const when = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    status.textContent = `Paused until ${when}. Scheduled alerts won't be sent. Test deliveries still work.`;
    resume.classList.remove('hidden');
  } else {
    status.textContent = 'Notifications are active.';
    resume.classList.add('hidden');
  }
}

async function pauseNotifications(hours) {
  const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  try {
    const res = await apiCall('/api/auth/profile', {
      method: 'PUT',
      body: JSON.stringify({ notificationsPausedUntil: until }),
    });
    currentUser = { ...currentUser, ...res.user };
    renderPauseStatus();
  } catch (e) { alert(e.message || 'Failed to pause notifications'); }
}

async function resumeNotifications() {
  try {
    const res = await apiCall('/api/auth/profile', {
      method: 'PUT',
      body: JSON.stringify({ notificationsPausedUntil: null }),
    });
    currentUser = { ...currentUser, ...res.user };
    renderPauseStatus();
  } catch (e) { alert(e.message || 'Failed to resume notifications'); }
}

async function loadDeliveryLog() {
  const list = document.getElementById('delivery-log-list');
  if (!list) return;
  list.innerHTML = '<p style="color: var(--ink-3); font-size: 0.85rem; margin: 0;">Loading…</p>';
  try {
    const data = await apiCall('/api/notifications/log?limit=25');
    if (!data.logs || data.logs.length === 0) {
      list.innerHTML = '<p style="color: var(--ink-3); font-size: 0.85rem; margin: 0;">No deliveries yet. Tap ▶ on a schedule to send a test.</p>';
      return;
    }
    list.innerHTML = data.logs.map(entry => {
      const when = new Date(entry.createdAt).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      const statusColor = entry.status === 'SENT' ? 'var(--cta-green)'
        : entry.status === 'FAILED' ? 'var(--cta-red)'
        : 'var(--ink-3)';
      const routeName = entry.schedule?.favorite?.name ? ` — ${escapeHtml(entry.schedule.favorite.name)}` : '';
      const detail = entry.detail ? `<div style="color: var(--ink-3); font-size: 0.75rem; margin-top: 2px;">${escapeHtml(entry.detail)}</div>` : '';
      const kindTag = entry.kind === 'TEST' ? ' <span style="font-size:0.7rem; color: var(--ink-3);">(test)</span>' : '';
      return `
        <div style="padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
            <span style="color: ${statusColor}; font-weight: 600; font-size: 0.78rem;">${entry.status}</span>
            <span style="color: var(--ink-3); font-size: 0.72rem;">${when}</span>
          </div>
          <div style="font-size: 0.82rem; color: var(--ink-2); margin-top: 2px;">${entry.channel.toLowerCase()}${routeName}${kindTag}</div>
          ${detail}
        </div>
      `;
    }).join('');
  } catch (e) {
    list.innerHTML = `<p style="color: var(--cta-red); font-size: 0.85rem; margin: 0;">Failed to load: ${escapeHtml(e.message || 'unknown error')}</p>`;
  }
}

function renderTelegramStatus() {
  const status = document.getElementById('telegram-status');
  const linkBtn = document.getElementById('link-telegram-btn');
  const unlinkBtn = document.getElementById('unlink-telegram-btn');
  if (!status || !linkBtn || !unlinkBtn) return;

  if (currentUser?.telegramLinked) {
    status.textContent = 'Linked. You\'ll receive scheduled alerts on Telegram.';
    linkBtn.textContent = 'Re-link Telegram';
    unlinkBtn.classList.remove('hidden');
  } else {
    status.textContent = 'Not linked yet. Link to receive alerts and chat with the bot.';
    linkBtn.textContent = 'Link Telegram';
    unlinkBtn.classList.add('hidden');
  }
}

async function handleLinkTelegram() {
  const btn = document.getElementById('link-telegram-btn');
  const original = btn.textContent;
  btn.textContent = 'Generating…';
  btn.disabled = true;
  try {
    const res = await apiCall('/api/auth/telegram/link', { method: 'POST' });
    showTelegramLinkModal(res);
  } catch (e) {
    alert(e.message || 'Failed to generate link');
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

function showTelegramLinkModal({ token, deepLink, botUsername }) {
  const ready = document.getElementById('telegram-link-ready');
  const unavailable = document.getElementById('telegram-link-unavailable');
  const startCmd = `/start ${token}`;

  if (botUsername && deepLink) {
    const handle = botUsername.startsWith('@') ? botUsername : `@${botUsername}`;
    document.getElementById('telegram-bot-handle').textContent = handle;
    document.getElementById('telegram-bot-handle-btn').textContent = handle;
    document.getElementById('telegram-open-link').href = deepLink;
    document.getElementById('telegram-start-cmd').textContent = startCmd;

    const copyBtn = document.getElementById('telegram-copy-btn');
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(startCmd);
        copyBtn.textContent = 'Copied';
        setTimeout(() => (copyBtn.textContent = 'Copy'), 1800);
      } catch {
        copyBtn.textContent = 'Copy failed';
      }
    };

    ready.classList.remove('hidden');
    unavailable.classList.add('hidden');
  } else {
    ready.classList.add('hidden');
    unavailable.classList.remove('hidden');
  }

  openModal('telegram-link-modal');
}

async function handleUnlinkTelegram() {
  if (!confirm('Disconnect Telegram from this account?')) return;
  try {
    await apiCall('/api/auth/telegram/link', { method: 'DELETE' });
    currentUser = { ...currentUser, telegramLinked: false };
    renderTelegramStatus();
  } catch (e) {
    alert(e.message || 'Failed to unlink');
  }
}

async function handleProfileUpdate(e) {
  e.preventDefault();
  const name = document.getElementById('profile-name').value;
  const email = document.getElementById('profile-email').value;
  const emailNotifications = document.getElementById('profile-email-notifications').checked;
  const msgEl = document.getElementById('profile-msg');
  const btn = e.target.querySelector('button');

  const originalText = btn.textContent;
  btn.textContent = 'Saving...';
  btn.disabled = true;

  try {
    const response = await apiCall('/api/auth/profile', {
      method: 'PUT',
      body: JSON.stringify({ name, email, emailNotifications })
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
  setAuthMode(!isRegistering);
  // Keep URL in sync with the mode toggle (doesn't re-trigger routing for auth→auth)
  const newHash = isRegistering ? '#register' : '#login';
  if (location.hash !== newHash) {
    history.replaceState(null, '', newHash);
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const name = document.getElementById('auth-name')?.value?.trim();
  const endpoint = isRegistering ? '/api/auth/register' : '/api/auth/login';

  if (!email || !password) {
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
    const payload = isRegistering ? { email, password, name } : { email, password };
    const data = await apiCall(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload)
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
function handleLogout() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('authToken');
  // Drop them on the sign-in screen so they can quickly log back in.
  setAuthMode(false);
  showAuth();
  if (location.hash !== '#login') {
    history.replaceState(null, '', '#login');
  }
}
function showLanding() {
  if (landingView) landingView.classList.remove('hidden');
  authView.classList.add('hidden');
  dashboardView.classList.add('hidden');
}
function showAuth() {
  if (landingView) landingView.classList.add('hidden');
  authView.classList.remove('hidden');
  dashboardView.classList.add('hidden');
}
async function showDashboard() {
  if (landingView) landingView.classList.add('hidden');
  authView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  if (!currentUser && authToken) await loadCurrentUser();
  updateWelcomeMessage();
  await loadDashboardData();
}

function applyRoute() {
  const hash = (location.hash || '').replace(/^#/, '').toLowerCase();

  if (authToken) {
    showDashboard();
    return;
  }

  if (hash === 'login' || hash === 'register') {
    setAuthMode(hash === 'register');
    showAuth();
    return;
  }

  showLanding();
}

function setAuthMode(registerMode) {
  if (isRegistering === registerMode) return;
  isRegistering = registerMode;

  const subtitle = document.getElementById('auth-subtitle');
  const submitBtn = document.getElementById('auth-submit-btn');
  const toggleBtn = document.getElementById('auth-toggle-btn');
  const passwordInput = document.getElementById('auth-password');
  const nameWrap = document.getElementById('auth-name-wrap');

  if (isRegistering) {
    subtitle.textContent = 'Create your account';
    submitBtn.textContent = 'Register';
    toggleBtn.textContent = 'Already have an account? Login';
    passwordInput.autocomplete = 'new-password';
    nameWrap?.classList.remove('hidden');
  } else {
    subtitle.textContent = 'Sign in to continue';
    submitBtn.textContent = 'Sign In';
    toggleBtn.textContent = 'Need an account? Register';
    passwordInput.autocomplete = 'current-password';
    nameWrap?.classList.add('hidden');
  }
  authError.style.display = 'none';
}
async function loadCurrentUser() { try { const data = await apiCall('/api/users/me'); currentUser = data.user; } catch (e) { handleLogout(); } }
function updateWelcomeMessage() {
  const el = document.getElementById('user-display');
  if (!el || !currentUser) return;
  const label = currentUser.name || currentUser.email || 'USER';
  el.textContent = label.length > 16 ? label.slice(0, 14) + '…' : label;
}
async function loadDashboardData() {
  startWelcomeClock();
  await Promise.all([loadFavorites(), loadSchedules(), loadServiceAlerts()]);
  startServiceAlertsPolling();
}

/* ================= SERVICE ALERTS ================= */
let serviceAlertsInterval = null;

async function loadServiceAlerts() {
  const container = document.getElementById('service-alerts');
  if (!container) return;
  try {
    const data = await apiCall('/api/cta/alerts');
    renderServiceAlerts(data.alerts || []);
  } catch (e) {
    // Silent: a stale CTA feed shouldn't break the dashboard.
    console.warn('Alerts fetch failed:', e.message);
  }
}

function startServiceAlertsPolling() {
  if (serviceAlertsInterval) return;
  serviceAlertsInterval = setInterval(loadServiceAlerts, 3 * 60 * 1000);
}

function renderServiceAlerts(alerts) {
  const container = document.getElementById('service-alerts');
  if (!container) return;

  if (!alerts.length) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  // Stable, compact state: remember which alerts the user dismissed this session.
  const dismissed = new Set(JSON.parse(sessionStorage.getItem('dismissedAlerts') || '[]'));
  const visible = alerts.filter((a) => !dismissed.has(a.id));
  if (!visible.length) {
    container.classList.add('hidden');
    container.innerHTML = '';
    return;
  }

  const majorCount = visible.filter((a) => a.majorAlert).length;
  const tone = majorCount > 0 ? 'major' : 'minor';
  const summaryIcon = majorCount > 0 ? '⚠' : 'ⓘ';
  const summaryText =
    visible.length === 1
      ? '1 service alert'
      : `${visible.length} service alerts`;

  container.classList.remove('hidden');
  container.dataset.tone = tone;
  container.innerHTML = `
    <details class="service-alerts-details" ${majorCount > 0 ? 'open' : ''}>
      <summary class="service-alerts-summary">
        <span class="service-alerts-icon">${summaryIcon}</span>
        <span class="service-alerts-title">${summaryText} affecting your routes</span>
        <span class="service-alerts-chevron" aria-hidden="true">▾</span>
      </summary>
      <div class="service-alerts-body">
        ${visible
          .slice(0, 6)
          .map(
            (a) => `
            <article class="service-alert" data-id="${escapeAttr(a.id)}">
              <header class="service-alert-head">
                <span class="service-alert-headline">${escapeHtml(a.headline || 'Service alert')}</span>
                <button class="service-alert-dismiss icon-btn" data-dismiss="${escapeAttr(a.id)}" title="Dismiss" aria-label="Dismiss">×</button>
              </header>
              ${a.shortDescription ? `<p class="service-alert-body">${escapeHtml(a.shortDescription)}</p>` : ''}
              <div class="service-alert-meta">
                ${a.services
                  .map((s) => `<span class="service-alert-chip">${escapeHtml(s.name || s.id)}</span>`)
                  .join('')}
                ${a.url ? `<a href="${escapeAttr(a.url)}" target="_blank" rel="noopener" class="service-alert-link">Details →</a>` : ''}
              </div>
            </article>
          `
          )
          .join('')}
      </div>
    </details>
  `;

  container.querySelectorAll('[data-dismiss]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.dismiss;
      dismissed.add(id);
      sessionStorage.setItem('dismissedAlerts', JSON.stringify([...dismissed]));
      renderServiceAlerts(alerts);
    });
  });
}

function escapeAttr(s) {
  return String(s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/* ================= WELCOME HERO (live clock + greeting) ================= */
let welcomeClockInterval = null;

function startWelcomeClock() {
  renderWelcome();
  if (welcomeClockInterval) clearInterval(welcomeClockInterval);
  // Update every 20s — enough for the minute to tick without burning CPU.
  welcomeClockInterval = setInterval(renderWelcome, 20_000);
}

function renderWelcome() {
  const now = new Date();
  const chicagoFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(now);
  // chicagoFmt: "9:42 PM"
  const [time, meridiem] = chicagoFmt.split(' ');
  const timeEl = document.getElementById('welcome-time');
  const meridiemEl = document.getElementById('welcome-meridiem');
  if (timeEl) timeEl.textContent = time;
  if (meridiemEl) meridiemEl.textContent = meridiem;

  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'long',
  }).format(now);
  const weekdayEl = document.getElementById('welcome-weekday');
  if (weekdayEl) weekdayEl.textContent = weekday;

  const greetingEl = document.getElementById('welcome-greeting');
  if (greetingEl) {
    const hour = parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago', hour: 'numeric', hour12: false,
      }).format(now),
      10
    );
    const first = (currentUser?.name || currentUser?.email || '').split(/[\s@]/)[0];
    const greet = hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    greetingEl.textContent = first ? `${greet}, ${first}` : greet;
  }
}

function syncWelcomeVisibility() {
  const next = document.getElementById('next-trip-card');
  const welcome = document.getElementById('welcome-card');
  if (!next || !welcome) return;
  // Show welcome only when the up-next hero is hidden.
  if (next.classList.contains('hidden')) welcome.classList.remove('hidden');
  else welcome.classList.add('hidden');
}

/* ================= FEATURES ================= */
async function handleChatMessage(e) {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const query = input.value.trim();
  if (!query) return;
  addChatMessage(query, 'user'); input.value = '';
  const typingId = 't' + Date.now();
  document.getElementById('chat-messages').insertAdjacentHTML(
    'beforeend',
    `<div id="${typingId}" class="chat-bubble bot typing-bubble"><span class="typing-label">Thinking</span><span class="typing-dots"><span></span><span></span><span></span></span><div class="typing-hint">Checking CTA live data — this can take up to 30s</div></div>`
  );
  const c = document.getElementById('chat-messages'); c.scrollTop = c.scrollHeight;
  try {
    const data = await apiCall(`/api/cta/transit/ask?query=${encodeURIComponent(query)}`);
    document.getElementById(typingId)?.remove();
    addChatMessage(data.answer || 'No response. Try rephrasing your question.', 'bot');
  } catch (err) {
    document.getElementById(typingId)?.remove();
    addChatMessage(`Couldn't reach the assistant — ${err.message || 'please try again'}.`, 'bot');
  }
}
function addChatMessage(text, type) {
  const div = document.createElement('div'); div.className = `chat-bubble ${type}`;
  div.innerHTML = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  const c = document.getElementById('chat-messages'); c.appendChild(div); c.scrollTop = c.scrollHeight;
}

async function loadFavorites() {
  try {
    const data = await apiCall('/api/favorites');
    cachedFavorites = data.favorites || [];
    const list = document.getElementById('favorites-list');
    if (!data.favorites.length) {
      list.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1;">
          <div class="icon">＋</div>
          <h5>No routes saved yet</h5>
          <p>Save a route to pin it here — tap once for live arrivals, or set a recurring alert.</p>
        </div>`;
      updateDropdown([]);
      return;
    }

    list.innerHTML = data.favorites.map(fav => {
      const isTrain = fav.routeType === 'TRAIN';
      const color = isTrain ? (LINE_HEX[fav.routeId] || '#787774') : '#337EA9';
      const chipText = isTrain ? `${fav.routeId} Line` : `Route ${fav.routeId}`;
      const chipClass = isTrain && fav.routeId === 'Yellow' ? 'fav-chip on-yellow' : 'fav-chip';
      return `
        <div class="card fav-card" data-id="${fav.id}" style="--line-color: ${color};">
          <button class="icon-btn delete-fav-btn" data-id="${fav.id}" title="Delete route" aria-label="Delete route">×</button>
          <div class="${chipClass}">${chipText}</div>
          <div class="fav-name">${escapeHtml(fav.name)}</div>
        </div>`;
    }).join('');
    updateDropdown(data.favorites);
  } catch (e) { console.error(e); }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ================= SMART ROUTE SUGGESTIONS ================= */
function updateRouteSuggestion() {
  const input = document.getElementById('chat-input');
  const box = document.getElementById('chat-suggestion');
  if (!input || !box) return;
  const raw = (input.value || '').trim();
  if (raw.length < 2 || !cachedFavorites.length) return hideRouteSuggestion();

  const q = raw.toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);

  const scored = cachedFavorites.map((fav) => {
    const hay = [
      fav.name, fav.routeId, fav.routeType,
      fav.routeType === 'TRAIN' ? `${fav.routeId} line` : `bus ${fav.routeId}`,
    ].filter(Boolean).join(' ').toLowerCase();
    const hits = tokens.filter((t) => hay.includes(t)).length;
    return { fav, score: hits };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score);

  if (!scored.length) return hideRouteSuggestion();

  const best = scored[0].fav;
  const isTrain = best.routeType === 'TRAIN';
  const color = isTrain ? (LINE_HEX[best.routeId] || '#787774') : '#337EA9';
  const icon = isTrain ? '🚇' : '🚌';
  const suggested = isTrain
    ? `Next ${best.routeId} Line arrival at ${best.name}`
    : `Next ${best.routeId} bus at ${best.name}`;

  box.innerHTML = `
    <span class="chat-suggestion-label">Try saved:</span>
    <button type="button" class="chat-suggestion-chip" data-q="${escapeHtml(suggested)}" style="--line-color: ${color};">
      <span class="chat-suggestion-dot" aria-hidden="true"></span>
      <span>${icon} ${escapeHtml(best.name)}</span>
    </button>
  `;
  box.classList.remove('hidden');

  const chip = box.querySelector('.chat-suggestion-chip');
  if (chip) {
    chip.addEventListener('click', () => {
      input.value = chip.dataset.q;
      hideRouteSuggestion();
      document.getElementById('chat-form').requestSubmit();
    });
  }
}

function hideRouteSuggestion() {
  const box = document.getElementById('chat-suggestion');
  if (box) {
    box.classList.add('hidden');
    box.innerHTML = '';
  }
}

async function loadSchedules() {
  try {
    const data = await apiCall('/api/schedules');
    const list = document.getElementById('schedules-list');
    if (!data.schedules.length) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="icon">🔔</div>
          <h5>No alerts scheduled</h5>
          <p>Tap + to get notified at a recurring time — e.g. weekday mornings before your commute.</p>
        </div>`;
      updateNextTrip([]);
      return;
    }

    list.innerHTML = data.schedules.map(s => {
      const leadLabel = s.leadMinutes > 0 ? ` · ${s.leadMinutes}m early` : '';
      const channelLabel = s.channel && s.channel !== 'AUTO' ? ` · ${s.channel.toLowerCase()}` : '';
      return `
      <div class="alert-row">
        <div class="alert-info">
          <h4>${escapeHtml(s.favorite.name)}</h4>
          <div class="alert-meta">${formatTime(s.time)} · ${formatDays(s.daysOfWeek)}${leadLabel}${channelLabel}</div>
        </div>
        <div class="flex items-center gap-4">
          <button class="icon-btn test-btn" data-id="${s.id}" title="Send test now" aria-label="Send test now" style="font-size: 0.9rem;">▶</button>
          <button class="icon-btn delete-btn" data-id="${s.id}" title="Delete alert" aria-label="Delete alert">×</button>
          <div class="pill-toggle ${s.enabled ? 'active' : ''}" data-id="${s.id}" role="switch" aria-checked="${s.enabled}"></div>
        </div>
      </div>
    `;}).join('');
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

  if (!next) { card.classList.add('hidden'); syncWelcomeVisibility(); return; }

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
  syncWelcomeVisibility();
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
  e.preventDefault();
  const form = e.target;
  const days = Array.from(form.elements['day']).filter(c => c.checked).map(c => parseInt(c.value));
  if (days.length === 0) {
    alert('Pick at least one day of the week.');
    return;
  }
  const leadMinutes = parseInt(document.getElementById('schedule-lead').value, 10) || 0;
  const channel = document.getElementById('schedule-channel').value || 'AUTO';
  const p = {
    favoriteId: document.getElementById('schedule-favorite').value,
    time: document.getElementById('schedule-time').value,
    daysOfWeek: days,
    leadMinutes,
    channel,
  };
  try {
    const res = await apiCall('/api/schedules', { method: 'POST', body: JSON.stringify(p) });
    closeModal('schedule-modal');
    form.reset();
    await loadSchedules();
    if (res?.emailAutoEnabled) {
      // Refresh local user snapshot so the Profile toggle reflects reality.
      await loadCurrentUser();
      alert('Email notifications turned on so you actually receive this alert. You can change this in Profile → General.');
    }
  } catch (e) { alert(e.message); }
}

async function testSchedule(id, btn) {
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = '…';
  try {
    await apiCall(`/api/schedules/${id}/test`, { method: 'POST' });
    btn.textContent = '✓';
    setTimeout(() => {
      btn.textContent = originalLabel;
      btn.disabled = false;
    }, 1500);
  } catch (e) {
    btn.textContent = originalLabel;
    btn.disabled = false;
    alert(e.message || 'Failed to queue test notification');
  }
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

      const arrivalsResp = await apiCall(apiUrl);
      const arrivals = Array.isArray(arrivalsResp) ? arrivalsResp : arrivalsResp?.arrivals;

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