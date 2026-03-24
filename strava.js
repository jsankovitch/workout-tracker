const Strava = (() => {
  const KEY = 'strava_config';

  function getConfig() {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  }

  function saveConfig(cfg) {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  }

  function isConnected() {
    const c = getConfig();
    return !!(c.accessToken && c.refreshToken);
  }

  function getAthleteDisplay() {
    return getConfig().athleteName || 'Connected';
  }

  // Called when user taps Connect after entering credentials
  function initiateAuth(clientId, clientSecret) {
    saveConfig({ ...getConfig(), clientId, clientSecret });
    const redirectUri = encodeURIComponent(window.location.origin + window.location.pathname);
    window.location.href =
      `https://www.strava.com/oauth/authorize` +
      `?client_id=${clientId}` +
      `&response_type=code` +
      `&redirect_uri=${redirectUri}` +
      `&approval_prompt=auto` +
      `&scope=activity%3Awrite`;
  }

  // Called on page load when ?code= is present in the URL
  async function handleCallback(code) {
    const c = getConfig();
    try {
      const res = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: c.clientId,
          client_secret: c.clientSecret,
          code,
          grant_type: 'authorization_code',
        }),
      });
      const data = await res.json();
      if (data.access_token) {
        saveConfig({
          ...c,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: data.expires_at,
          athleteName: data.athlete
            ? `${data.athlete.firstname} ${data.athlete.lastname || ''}`.trim()
            : 'Connected',
        });
        return true;
      }
    } catch (e) { /* network error */ }
    return false;
  }

  async function ensureValidToken() {
    const c = getConfig();
    if (!c.refreshToken) return false;
    if (c.expiresAt > Date.now() / 1000 + 300) return true; // valid for 5+ more min
    try {
      const res = await fetch('https://www.strava.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: c.clientId,
          client_secret: c.clientSecret,
          refresh_token: c.refreshToken,
          grant_type: 'refresh_token',
        }),
      });
      const data = await res.json();
      if (data.access_token) {
        saveConfig({
          ...c,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: data.expires_at,
        });
        return true;
      }
    } catch (e) { /* network error */ }
    return false;
  }

  function buildDescription(session, includeComments) {
    const workout = PROGRAM.workouts.find(w => w.id === session.workoutId);
    if (!workout) return '';
    const lines = [];
    workout.exercises.forEach(ex => {
      const sets = session.sets
        .filter(s => s.exerciseId === ex.id)
        .sort((a, b) => a.setNumber - b.setNumber);
      if (sets.length === 0) return;
      const parts = sets.map(s => {
        if (s.weight != null && s.reps != null) return `${s.weight}×${s.reps}`;
        if (s.weight != null && s.time != null) return `${s.weight} lb, ${s.time}s`;
        if (s.reps != null && s.time != null) return `${s.reps} reps, ${s.time}s`;
        if (s.reps != null) return `${s.reps} reps`;
        if (s.time != null) return `${s.time}s`;
        if (s.band != null && s.reps != null) return `${s.band}×${s.reps}`;
        return '—';
      });
      lines.push(`${ex.name}: ${parts.join(', ')}`);
      if (includeComments && session.comments?.[ex.id]) {
        lines.push(`  ↳ ${session.comments[ex.id]}`);
      }
    });
    return lines.join('\n');
  }

  async function uploadActivity(session, title, description, includeComments) {
    const valid = await ensureValidToken();
    if (!valid) return { ok: false, error: 'Not authenticated — reconnect Strava.' };

    const c = getConfig();
    const elapsed = (session.completedAt && session.startedAt)
      ? Math.round((new Date(session.completedAt) - new Date(session.startedAt)) / 1000)
      : 3600;

    const desc = description.trim() || buildDescription(session, includeComments);

    const body = {
      name: title || 'Strength Training',
      type: 'WeightTraining',
      sport_type: 'WeightTraining',
      start_date_local: session.startedAt,
      elapsed_time: elapsed,
      trainer: 1,
    };
    if (desc) body.description = desc;

    try {
      const res = await fetch('https://www.strava.com/api/v3/activities', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${c.accessToken}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) return { ok: true, activityId: data.id };
      return { ok: false, error: data.message || data.error || `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: 'Network error — check your connection.' };
    }
  }

  function disconnect() {
    const c = getConfig();
    // Keep credentials so user doesn't have to re-enter them
    saveConfig({ clientId: c.clientId, clientSecret: c.clientSecret });
  }

  return {
    isConnected, getAthleteDisplay, initiateAuth,
    handleCallback, uploadActivity, disconnect, getConfig,
  };
})();
