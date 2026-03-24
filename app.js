// ── State ──────────────────────────────────────────────────────────────────
const state = {
  view: 'home',              // 'home' | 'pre-session' | 'session' | 'complete'
  workout: null,
  session: null,
  week: 1,
  restDuration: 90,
  expandedId: null,
  skipped: new Set(),
  extraSets: {},
  setOverrides: {},
  repsOverrides: {},
  exitModal: null,           // null | 'main' | 'discard'
  deleteModal: null,         // null | sessionId — confirmation before deleting a session
  detailSession: null,
  editing: null,             // { exerciseId, setNumber } — set being re-edited
  editingComment: null,      // exerciseId whose comment sheet is open
  editingPriorSession: false,
  uploadSheet: {
    open: false,
    uploading: false,
    error: null,
    sessionId: null,
    title: 'Strength Training',
    description: '',
    includeComments: true,
    platforms: { strava: false, trainingpeaks: false },
  },
  stravaConnectSheet: false,
  // Rest timer (bottom bar)
  timer: {
    active: false,
    remaining: 0,
    total: 0,
    startTime: null,
    interval: null,
    label: '',
  },
  // Exercise timer (in-set countdown for timed exercises)
  exTimer: {
    active: false,
    paused: false,
    exerciseId: null,
    setNumber: null,
    remaining: 0,
    total: 0,
    startTime: null,
    interval: null,
    data: {},
  },
};

// ── Audio ──────────────────────────────────────────────────────────────────
let audioCtx = null;

function ensureAudio() {
  if (audioCtx) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (Ctx) audioCtx = new Ctx();
}

function beep(freq = 880) {
  if (!audioCtx) return;
  try {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t = audioCtx.currentTime;
    gain.gain.setValueAtTime(0.4, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    osc.start(t);
    osc.stop(t + 0.5);
  } catch (e) { /* ignore */ }
}

// ── Rest timer (bottom bar) ────────────────────────────────────────────────
function startTimer(seconds, label) {
  if (state.timer.interval) clearInterval(state.timer.interval);
  const startTime = Date.now();
  state.timer.active = true;
  state.timer.total = seconds;
  state.timer.remaining = seconds;
  state.timer.startTime = startTime;
  state.timer.label = label || 'Rest';
  updateTimerBar();
  state.timer.interval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    state.timer.remaining = Math.max(0, seconds - elapsed);
    if (state.timer.remaining === 0) {
      clearInterval(state.timer.interval);
      state.timer.interval = null;
      beep();
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      updateTimerBar();
      return;
    }
    updateTimerBar();
  }, 1000);
}

function stopTimer() {
  if (state.timer.interval) clearInterval(state.timer.interval);
  state.timer.active = false;
  state.timer.remaining = 0;
  document.getElementById('timer-bar')?.remove();
  document.querySelector('.content')?.classList.remove('timer-active');
}

function advanceToNextExercise() {
  if (state.view !== 'session' || !state.workout || state.editingPriorSession) return;
  const next = state.workout.exercises.find(e => {
    const s = exerciseStatus(e);
    return s === 'pending' || s === 'in-progress';
  });
  if (!next || state.expandedId === next.id) return;
  state.expandedId = next.id;
  render();
  requestAnimationFrame(() => {
    document.getElementById(`card-${next.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

function skipRest() {
  stopTimer();
  advanceToNextExercise();
}

function updateTimerBar() {
  let bar = document.getElementById('timer-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'timer-bar';
    document.getElementById('app').appendChild(bar);
    document.querySelector('.content')?.classList.add('timer-active');
  }
  const done = state.timer.remaining === 0;
  const m = Math.floor(state.timer.remaining / 60);
  const s = String(state.timer.remaining % 60).padStart(2, '0');
  bar.innerHTML = `
    <span class="timer-label">${state.timer.label}</span>
    <span class="timer-value ${done ? 'is-done' : ''}">${done ? 'Go!' : `${m}:${s}`}</span>
    <button class="btn-timer-skip" onclick="skipRest()">${done ? 'Dismiss' : 'Skip Rest'}</button>
  `;
}

// ── Exercise timer (in-set countdown) ─────────────────────────────────────
function tickExTimer() {
  const elapsed = Math.floor((Date.now() - state.exTimer.startTime) / 1000);
  state.exTimer.remaining = Math.max(0, state.exTimer.total - elapsed);
  if (state.exTimer.remaining === 0) {
    clearInterval(state.exTimer.interval);
    state.exTimer.interval = null;
    beep(660);
    if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
    autoLogTimedSet();
  } else {
    const el = document.getElementById(`ex-timer-val-${state.exTimer.exerciseId}-${state.exTimer.setNumber}`);
    if (el) {
      const m = Math.floor(state.exTimer.remaining / 60);
      const s = String(state.exTimer.remaining % 60).padStart(2, '0');
      el.textContent = `${m}:${s}`;
    }
  }
}

function beginExerciseTimer(exerciseId, setNumber, button) {
  ensureAudio();
  const row = button.closest('.set-row');
  const inputs = row.querySelectorAll('.set-input');
  const data = { setNumber };
  inputs.forEach(input => {
    const val = input.value.trim();
    if (!val) return;
    const field = input.dataset.field;
    data[field] = field === 'band' ? val : parseFloat(val);
  });
  const seconds = data.time || getTargetTime(state.workout.exercises.find(e => e.id === exerciseId)) || 60;
  data.time = seconds;

  if (state.exTimer.interval) clearInterval(state.exTimer.interval);
  Object.assign(state.exTimer, {
    active: true, paused: false, exerciseId, setNumber,
    remaining: seconds, total: seconds, startTime: Date.now(), data,
  });
  render();
  state.exTimer.interval = setInterval(tickExTimer, 1000);
}

function pauseExerciseTimer() {
  clearInterval(state.exTimer.interval);
  state.exTimer.interval = null;
  state.exTimer.paused = true;
  render();
}

function resumeExerciseTimer() {
  state.exTimer.startTime = Date.now();
  state.exTimer.total = state.exTimer.remaining;
  state.exTimer.paused = false;
  state.exTimer.interval = setInterval(tickExTimer, 1000);
  render();
}

function autoLogTimedSet() {
  const { exerciseId, setNumber, data } = state.exTimer;
  state.exTimer.active = false;
  state.exTimer.paused = false;
  state.session = Store.logSet(state.session.id, exerciseId, data);
  if (!state.editingPriorSession) {
    startTimer(state.restDuration, `Rest — set ${setNumber} done`);
  }
  render();
}

function stopExerciseTimer() {
  if (state.exTimer.interval) clearInterval(state.exTimer.interval);
  state.exTimer.active = false;
  state.exTimer.paused = false;
  render();
}

// ── Data helpers ────────────────────────────────────────────────────────────
function getTargetSets(exercise) {
  return state.setOverrides[exercise.id] ?? exercise.targetSets[state.week - 1] ?? 2;
}

function getTargetTime(exercise) {
  if (exercise.targetTimeByWeek) return exercise.targetTimeByWeek[state.week - 1];
  return exercise.targetTime || null;
}

function upperReps(repsStr) {
  if (!repsStr) return null;
  const parts = repsStr.split(/[–\-]/);
  return parseInt(parts[parts.length - 1].trim()) || null;
}

function getTargetReps(exercise) {
  if (state.repsOverrides[exercise.id] != null) return state.repsOverrides[exercise.id];
  return upperReps(exercise.targetReps) || getTargetTime(exercise);
}

function programDefault(exercise) {
  const sets = exercise.targetSets[state.week - 1] ?? 2;
  if (exercise.targetReps) return `${sets} × ${exercise.targetReps}`;
  if (exercise.targetTimeByWeek) return `${sets} × ${getTargetTime(exercise)}s`;
  if (exercise.targetTime) return `${sets} × ${exercise.targetTime}s`;
  return `${sets} sets`;
}

function getLoggedSets(exerciseId) {
  return (state.session?.sets || []).filter(s => s.exerciseId === exerciseId);
}

function getEffectiveSetCount(exercise) {
  const base = getTargetSets(exercise);
  const extra = state.extraSets[exercise.id] || 0;
  const logged = getLoggedSets(exercise.id).length;
  return Math.max(base + extra, logged);
}

function exerciseStatus(exercise) {
  if (state.skipped.has(exercise.id)) return 'skipped';
  const logged = getLoggedSets(exercise.id).length;
  const effective = getEffectiveSetCount(exercise);
  if (logged >= effective) return 'completed';
  if (logged > 0) return 'in-progress';
  return 'pending';
}

function sessionProgress() {
  const exercises = state.workout.exercises;
  const done = exercises.filter(e => exerciseStatus(e) === 'completed').length;
  return { done, total: exercises.length };
}

function targetDisplay(exercise) {
  const sets = getTargetSets(exercise);
  if (exercise.targetReps) return `${sets} × ${exercise.targetReps}`;
  if (exercise.targetTimeByWeek) return `${sets} × ${getTargetTime(exercise)}s`;
  if (exercise.targetTime) return `${sets} × ${exercise.targetTime}s`;
  return `${sets} sets`;
}

// ── Render: set inputs ───────────────────────────────────────────────────────
function renderSetInputs(exercise, loggedSet, prevSet, isEditing = false) {
  const m = exercise.metric;
  const ro = (loggedSet && !isEditing) ? 'readonly' : '';
  const v = loggedSet || {};
  const targetReps = getTargetReps(exercise);
  const targetTime = getTargetTime(exercise);
  let html = '';

  if (m === 'weight_reps' || m === 'weight_time') {
    const lastWeight = prevSet?.weight != null ? `${prevSet.weight} lb` : '—';
    html += `<div class="input-group">
      <span class="input-label">Weight (lb)</span>
      <input type="number" inputmode="decimal" class="set-input" data-field="weight"
        placeholder="0" value="${v.weight ?? ''}" ${ro}>
      <span class="input-hint">Last ${lastWeight}</span>
    </div>`;
  }

  if (m === 'weight_reps' || m === 'reps_only' || m === 'time_reps') {
    const lastReps = prevSet?.reps != null ? `${prevSet.reps}` : '—';
    html += `<div class="input-group">
      <span class="input-label">Reps</span>
      <input type="number" inputmode="numeric" class="set-input" data-field="reps"
        placeholder="0" value="${v.reps ?? (targetReps != null ? targetReps : '')}" ${ro}>
      <span class="input-hint">Last ${lastReps}</span>
    </div>`;
  }

  if (m === 'weight_time' || m === 'time_only' || m === 'time_reps') {
    const lastTime = prevSet?.time != null ? `${prevSet.time}s` : '—';
    html += `<div class="input-group">
      <span class="input-label">Time (s)</span>
      <input type="number" inputmode="numeric" class="set-input" data-field="time"
        placeholder="${targetTime || 0}" value="${v.time ?? (targetTime || '')}" ${ro}>
      <span class="input-hint">Last ${lastTime}</span>
    </div>`;
  }

  if (m === 'band_reps') {
    const lastBand = prevSet?.band ?? '—';
    const lastReps = prevSet?.reps != null ? `${prevSet.reps}` : '—';
    html += `<div class="input-group">
      <span class="input-label">${exercise.bandLabel || 'Band'}</span>
      <input type="text" class="set-input is-text" data-field="band"
        placeholder="color" value="${v.band ?? ''}" ${ro}>
      <span class="input-hint">Last ${lastBand}</span>
    </div>
    <div class="input-group">
      <span class="input-label">Reps</span>
      <input type="number" inputmode="numeric" class="set-input" data-field="reps"
        placeholder="0" value="${v.reps ?? (targetReps != null ? targetReps : '')}" ${ro}>
      <span class="input-hint">Last ${lastReps}</span>
    </div>`;
  }

  return html;
}

// ── Render: views ─────────────────────────────────────────────────────────────
function renderHome() {
  const sessions = Store.allCompleted();
  const sessionList = sessions.length === 0
    ? `<div class="sessions-empty">No sessions yet</div>`
    : sessions.map(s => {
        const workout = PROGRAM.workouts.find(w => w.id === s.workoutId);
        const d = new Date(s.date + 'T12:00:00');
        const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const exerciseIds = [...new Set(s.sets.map(x => x.exerciseId))];
        const totalExercises = workout?.exercises.length || 0;
        return `<div class="session-item" onclick="viewSession('${s.id}')">
          <div class="session-date">${dateStr}</div>
          <div class="session-workout">${workout?.name || s.workoutId} · ${exerciseIds.length}/${totalExercises} exercises</div>
        </div>`;
      }).join('');

  return `<div class="screen">
    <div class="home-header">
      <div class="home-title">Gym</div>
    </div>
    <div class="content">
      <div class="workout-btns">
        ${PROGRAM.workouts.map(w => `
          <button class="workout-btn" onclick="selectWorkout('${w.id}')">
            <span class="workout-btn-name">${w.name}</span>
            <span class="workout-btn-day">${w.day}</span>
          </button>`).join('')}
      </div>

      <div class="section-label">Prior Sessions</div>
      <div class="sessions-list">${sessionList}</div>

      <div class="connections-section">
        <div class="section-label">Connections</div>
        ${Strava.isConnected()
          ? `<div class="connection-item">
               <div class="connection-info">
                 <span class="connection-name">Strava</span>
                 <span class="connection-status">${Strava.getAthleteDisplay()}</span>
               </div>
               <button class="btn-connection-action" onclick="disconnectStrava()">Disconnect</button>
             </div>`
          : `<button class="connection-btn" onclick="openStravaConnect()">
               <span class="connection-btn-name">Strava</span>
               <span class="connection-btn-action">Connect →</span>
             </button>`
        }
      </div>
    </div>
  </div>`;
}

function renderPreSession() {
  const w = state.workout;
  return `<div class="screen">
    <div class="header">
      <button class="btn-icon" onclick="goHome()">← Back</button>
      <div class="header-title">${w.name} · Week ${state.week}</div>
    </div>
    <div class="content">
      <div class="settings-card">
        <div>
          <div class="settings-label">Rest between sets</div>
          <div class="settings-sub">Default — tap to change</div>
        </div>
        <div class="rest-input-row">
          <input type="number" inputmode="numeric" class="rest-input"
            value="${state.restDuration}"
            onchange="state.restDuration = Math.max(10, parseInt(this.value) || 90)">
          <span style="color:var(--text2);font-size:13px">sec</span>
        </div>
      </div>

      <div class="section-label">Exercises</div>
      <div class="preview-list">
        ${w.exercises.map(e => {
          const hasReps = ['weight_reps', 'reps_only', 'band_reps', 'time_reps'].includes(e.metric);
          const hasTime = ['weight_time', 'time_only', 'time_reps'].includes(e.metric);
          const repsLabel = hasTime && !hasReps ? 'Time (s)' : 'Reps';
          const repsVal = getTargetReps(e);
          return `<div class="preview-item preview-item--editable">
            <div class="preview-name">${e.name}</div>
            <div class="preview-inputs">
              <div class="preview-input-group">
                <label class="preview-input-label">Sets</label>
                <input type="number" inputmode="numeric" class="preview-input"
                  value="${getTargetSets(e)}"
                  onchange="state.setOverrides['${e.id}'] = Math.max(1, parseInt(this.value) || 1)">
              </div>
              <span class="preview-times">×</span>
              <div class="preview-input-group">
                <label class="preview-input-label">${repsLabel}</label>
                <input type="number" inputmode="numeric" class="preview-input"
                  value="${repsVal ?? ''}"
                  onchange="state.repsOverrides['${e.id}'] = parseInt(this.value) || null">
              </div>
              <div class="preview-rec">rec: ${programDefault(e)}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
      <button class="btn-primary" onclick="startSession()">Start Workout</button>
    </div>
  </div>`;
}

function renderSession() {
  const w = state.workout;
  const p = sessionProgress();
  const pct = Math.round((p.done / p.total) * 100);
  const allDone = p.done === p.total;

  let bottomContent = '';
  if (state.editingPriorSession) {
    bottomContent = `<div class="finish-btn-row">
      <button class="btn-primary" onclick="closeSessionEdit()">Save Changes</button>
    </div>`;
  } else {
    bottomContent = `<div class="finish-btn-row">
      ${allDone ? `<button class="btn-primary" onclick="finishSession()" style="margin-bottom:10px">Finish Workout</button>` : ''}
      <button class="${allDone ? 'btn-primary' : 'btn-end-workout'}" onclick="goHome()">End Workout</button>
    </div>`;
  }

  return `<div class="screen">
    <div class="header">
      <button class="btn-icon" onclick="${state.editingPriorSession ? 'closeSessionEdit()' : 'goHome()'}">←</button>
      <div class="header-title">${w.name}</div>
      <span style="font-size:13px;color:var(--text2)">${p.done}/${p.total}</span>
    </div>
    <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    <div class="content ${state.timer.active ? 'timer-active' : ''}">
      ${w.exercises.map(e => renderExerciseCard(e)).join('')}
      ${bottomContent}
    </div>
  </div>`;
}

function renderExerciseCard(exercise) {
  const status = exerciseStatus(exercise);
  const isExpanded = state.expandedId === exercise.id;
  const isSkipped = status === 'skipped';
  const logged = getLoggedSets(exercise.id);
  const targetSets = getTargetSets(exercise);
  const setCount = getEffectiveSetCount(exercise);
  const lastSession = Store.lastCompleted(state.workout.id);
  const isTimed = ['weight_time', 'time_only', 'time_reps'].includes(exercise.metric);
  const existingComment = state.session?.comments?.[exercise.id] || '';

  const dotClass = status === 'pending' ? '' : status;
  const cardClass = [
    status === 'completed' ? 'is-completed' : '',
    status === 'skipped' ? 'is-skipped' : '',
    isExpanded ? 'is-expanded' : '',
  ].filter(Boolean).join(' ');

  let detail = '';
  if (isExpanded) {
    let setsHtml = '';
    for (let i = 1; i <= setCount; i++) {
      const ls = logged.find(s => s.setNumber === i);
      const prevSet = lastSession?.sets.find(s => s.exerciseId === exercise.id && s.setNumber === i) || null;
      const isLogged = !!ls;
      const isEditing = state.editing?.exerciseId === exercise.id && state.editing?.setNumber === i;
      const isActiveTimer = state.exTimer.active && state.exTimer.exerciseId === exercise.id && state.exTimer.setNumber === i;
      const isExtra = i > targetSets;
      const isDeletable = (isLogged || isExtra) && !isActiveTimer;

      if (isActiveTimer) {
        const m = Math.floor(state.exTimer.remaining / 60);
        const s = String(state.exTimer.remaining % 60).padStart(2, '0');
        const isPaused = state.exTimer.paused;
        setsHtml += `<div class="set-row" id="setrow-${exercise.id}-${i}">
          <div class="set-row-inner">
            <div class="set-number">Set ${i} — ${isPaused ? 'paused' : 'in progress'}</div>
            <div class="ex-timer-display">
              <span class="ex-timer-value${isPaused ? ' is-paused' : ''}" id="ex-timer-val-${exercise.id}-${i}">${m}:${s}</span>
              <div class="ex-timer-btns">
                ${isPaused
                  ? `<button class="btn-timer-pause" onclick="resumeExerciseTimer()">Resume</button>`
                  : `<button class="btn-timer-pause" onclick="pauseExerciseTimer()">Pause</button>`}
                <button class="btn-timer-stop" onclick="stopExerciseTimer()">Stop</button>
              </div>
            </div>
          </div>
        </div>`;
      } else {
        let actionBtn = '';
        if (isLogged && !isEditing) {
          actionBtn = `<button class="btn-done is-logged" onclick="editSet('${exercise.id}', ${i})">Edit</button>`;
        } else if (isSkipped) {
          actionBtn = `<button class="btn-done" disabled>Done</button>`;
        } else if (isTimed && !exercise.noCountdown && !isEditing) {
          actionBtn = `<button class="btn-start-ex" onclick="beginExerciseTimer('${exercise.id}', ${i}, this)">Start</button>`;
        } else {
          actionBtn = `<button class="btn-done" onclick="logSet('${exercise.id}', ${i}, this)">Done</button>`;
        }

        setsHtml += `<div class="set-row ${isLogged && !isEditing ? 'is-logged' : ''}" id="setrow-${exercise.id}-${i}"${isDeletable ? ` data-deletable="true" data-ex="${exercise.id}" data-set="${i}"` : ''}>
          <div class="set-row-inner">
            <div class="set-number">Set ${i}</div>
            <div class="set-inputs">
              ${renderSetInputs(exercise, ls, prevSet, isEditing)}
              ${actionBtn}
            </div>
          </div>
          ${isDeletable ? `<button class="btn-swipe-delete" onclick="deleteSet('${exercise.id}', ${i})">Delete</button>` : ''}
        </div>`;
      }
    }

    detail = `<div class="exercise-detail">
      <div class="detail-actions">
        ${exercise.videoUrl ? `<a class="btn-video" href="${exercise.videoUrl}" target="_blank" rel="noopener">▶ Video</a>` : ''}
        ${isSkipped
          ? `<button class="btn-unskip" onclick="unskip('${exercise.id}')">Unskip</button>`
          : `<button class="btn-skip" onclick="skip('${exercise.id}')">Skip</button>`
        }
      </div>
      <div class="sets-list">
        ${setsHtml}
      </div>
      ${existingComment ? `<div class="comment-display">${existingComment}</div>` : ''}
      ${!isSkipped ? `<div class="set-actions-col">
        <button class="btn-add-set" onclick="addSet('${exercise.id}')">Add Set</button>
        <button class="btn-add-comment" onclick="startComment('${exercise.id}')">${existingComment ? 'View/Change Comment' : 'Add Comment'}</button>
      </div>` : ''}
    </div>`;
  }

  return `<div class="exercise-card ${cardClass}" id="card-${exercise.id}">
    <div class="exercise-header" onclick="toggleExercise('${exercise.id}')">
      <div class="status-dot ${dotClass}"></div>
      <div class="exercise-name">${exercise.name}</div>
      <div class="exercise-count">${logged.length}/${targetSets}</div>
      <span class="chevron">▾</span>
    </div>
    ${detail}
  </div>`;
}

function renderComplete() {
  const session = state.session;
  let duration = null;
  if (session?.startedAt && session?.completedAt) {
    duration = Math.round((new Date(session.completedAt) - new Date(session.startedAt)) / 60000);
  }
  return `<div class="complete-screen">
    <div class="complete-icon">🏋️</div>
    <div class="complete-title">Nice work!</div>
    ${duration != null ? `<div class="complete-sub">Finished in ${duration} min</div>` : ''}
    <button class="btn-primary" style="max-width:280px;margin-top:8px" onclick="goHome()">Done</button>
    <button class="btn-secondary" style="max-width:280px" onclick="openUpload('${session?.id}')">Send to...</button>
  </div>`;
}

function renderSessionDetail() {
  const s = state.detailSession;
  const workout = PROGRAM.workouts.find(w => w.id === s.workoutId);
  const d = new Date(s.date + 'T12:00:00');
  const dateStr = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const exerciseRows = (workout?.exercises || []).map(ex => {
    const exSets = s.sets
      .filter(set => set.exerciseId === ex.id)
      .sort((a, b) => a.setNumber - b.setNumber);
    const comment = s.comments?.[ex.id] || '';

    if (exSets.length === 0 && !comment) return `
      <div class="detail-exercise">
        <div class="detail-ex-name">${ex.name}</div>
        <div class="detail-ex-empty">Not logged</div>
      </div>`;

    return `<div class="detail-exercise">
      <div class="detail-ex-name">${ex.name}</div>
      ${exSets.length === 0 ? `<div class="detail-ex-empty">Not logged</div>` : ''}
      ${exSets.map(set => {
        const parts = [];
        if (set.band != null) parts.push(set.band);
        if (set.weight != null) parts.push(`${set.weight} lb`);
        if (set.reps != null) parts.push(`${set.reps} reps`);
        if (set.time != null) parts.push(`${set.time}s`);
        return `<div class="detail-set-row">
          <span class="detail-set-num">Set ${set.setNumber}</span>
          <span class="detail-set-values">${parts.join(' · ') || '—'}</span>
        </div>`;
      }).join('')}
      ${comment ? `<div class="detail-comment">${comment}</div>` : ''}
    </div>`;
  }).join('');

  return `<div class="screen">
    <div class="header">
      <button class="btn-icon" onclick="closeSessionDetail()">← Back</button>
      <div class="header-title">${workout?.name || ''}</div>
      <button class="btn-icon" onclick="editPriorSession('${s.id}')">Edit</button>
    </div>
    <div class="content">
      <div class="detail-date">${dateStr}</div>
      ${exerciseRows}
      <div class="detail-bottom-btns">
        <button class="btn-primary" onclick="openUpload('${s.id}')">Upload</button>
        <button class="btn-danger" onclick="confirmDeleteSession('${s.id}')">Delete</button>
      </div>
    </div>
  </div>`;
}

function renderExitModal() {
  if (state.exitModal === 'discard') {
    return `<div class="modal-overlay" onclick="closeExitModal()">
      <div class="modal-sheet" onclick="event.stopPropagation()">
        <div class="modal-confirm-text">Are you sure you want to discard this workout? All data will be lost.</div>
        <button class="modal-btn modal-btn--danger" onclick="discardAndExit()">Discard</button>
        <button class="modal-btn modal-btn--secondary" onclick="closeExitModal()">Cancel</button>
      </div>
    </div>`;
  }
  return `<div class="modal-overlay" onclick="closeExitModal()">
    <div class="modal-sheet" onclick="event.stopPropagation()">
      <div class="modal-title">End workout?</div>
      <button class="modal-btn" onclick="saveAndExit()">Save &amp; Exit</button>
      <button class="modal-btn modal-btn--danger" onclick="confirmDiscard()">Discard Workout</button>
      <button class="modal-btn modal-btn--secondary" onclick="closeExitModal()">Keep Going</button>
    </div>
  </div>`;
}

function renderDeleteModal() {
  return `<div class="modal-overlay" onclick="cancelDeleteSession()">
    <div class="modal-sheet" onclick="event.stopPropagation()">
      <div class="modal-confirm-text">Delete this session? All logged data will be permanently removed.</div>
      <button class="modal-btn modal-btn--danger" onclick="executeDeleteSession()">Delete</button>
      <button class="modal-btn modal-btn--secondary" onclick="cancelDeleteSession()">Cancel</button>
    </div>
  </div>`;
}

function renderCommentSheet() {
  const exerciseId = state.editingComment;
  const exercise = state.workout?.exercises.find(e => e.id === exerciseId);
  const existingComment = state.session?.comments?.[exerciseId] || '';
  return `<div class="modal-overlay" onclick="cancelComment()">
    <div class="modal-sheet comment-sheet" onclick="event.stopPropagation()">
      <div class="modal-title">${exercise?.name || 'Comment'}</div>
      <textarea class="comment-input" id="comment-sheet-input" rows="4"
        placeholder="Add a note about this exercise...">${existingComment}</textarea>
      <button class="modal-btn" onclick="saveComment()">Save</button>
      <button class="modal-btn modal-btn--secondary" onclick="cancelComment()">Cancel</button>
    </div>
  </div>`;
}

function renderUploadSheet() {
  const us = state.uploadSheet;
  return `<div class="modal-overlay" onclick="closeUpload()">
    <div class="modal-sheet upload-sheet" onclick="event.stopPropagation()">
      <div class="modal-title">Send to...</div>

      <div class="upload-field">
        <label class="upload-label">Title</label>
        <input type="text" class="upload-input" value="${us.title}"
          oninput="state.uploadSheet.title = this.value">
      </div>

      <div class="upload-field">
        <label class="upload-label">Description</label>
        <textarea class="upload-textarea" rows="3"
          placeholder="Enter a description for this workout"
          oninput="state.uploadSheet.description = this.value">${us.description}</textarea>
      </div>

      <div class="upload-toggle-row">
        <span class="upload-label">Include comments</span>
        <label class="platform-toggle">
          <input type="checkbox" ${us.includeComments ? 'checked' : ''}
            onchange="state.uploadSheet.includeComments = this.checked">
          <span class="platform-check"></span>
        </label>
      </div>

      <div class="upload-label" style="margin-bottom:4px;margin-top:2px">Platforms</div>
      <div class="upload-toggle-row">
        <span>Strava${Strava.isConnected() ? ` <span class="connection-ok">✓</span>` : ` <span class="connection-needed">(not connected)</span>`}</span>
        <label class="platform-toggle">
          <input type="checkbox" ${us.platforms.strava ? 'checked' : ''}
            onchange="togglePlatform('strava')" ${!Strava.isConnected() ? 'disabled' : ''}>
          <span class="platform-check"></span>
        </label>
      </div>

      ${us.error ? `<div class="upload-error">
        <div class="upload-error-warning">⚠ Check Strava before retrying — the workout may have uploaded despite this error.</div>
        <pre class="upload-error-text" id="upload-error-text">${us.error}</pre>
        <button class="btn-copy-error" onclick="copyUploadError()">Copy Error</button>
      </div>` : ''}

      ${us.uploading
        ? `<button class="modal-btn" disabled style="margin-top:4px">Uploading...</button>`
        : `<button class="modal-btn" onclick="sendToServices()" style="margin-top:4px">Send</button>`
      }
      <button class="modal-btn modal-btn--secondary" onclick="closeUpload()" ${us.uploading ? 'disabled' : ''}>Cancel</button>
    </div>
  </div>`;
}

function renderStravaConnectSheet() {
  const cfg = Strava.getConfig();
  return `<div class="modal-overlay" onclick="closeStravaConnect()">
    <div class="modal-sheet" onclick="event.stopPropagation()">
      <div class="modal-title">Connect Strava</div>
      <div class="upload-field">
        <label class="upload-label">Client ID</label>
        <input type="text" inputmode="numeric" class="upload-input" id="strava-client-id"
          placeholder="12345" value="${cfg.clientId || ''}">
      </div>
      <div class="upload-field">
        <label class="upload-label">Client Secret</label>
        <input type="text" class="upload-input" id="strava-client-secret"
          placeholder="abc123..." value="${cfg.clientSecret || ''}">
      </div>
      <p class="connect-help">
        Get these from <strong>strava.com/settings/api</strong>.<br>
        Set the Authorization Callback Domain to <strong>jsankovitch.github.io</strong>.
      </p>
      <button class="modal-btn" onclick="initiateStravaAuth()">Connect →</button>
      <button class="modal-btn modal-btn--secondary" onclick="closeStravaConnect()">Cancel</button>
    </div>
  </div>`;
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  switch (state.view) {
    case 'home':           app.innerHTML = renderHome(); break;
    case 'pre-session':    app.innerHTML = renderPreSession(); break;
    case 'session':        app.innerHTML = renderSession(); break;
    case 'complete':       app.innerHTML = renderComplete(); break;
    case 'session-detail': app.innerHTML = renderSessionDetail(); break;
  }
  if (state.exitModal) app.insertAdjacentHTML('beforeend', renderExitModal());
  if (state.deleteModal) app.insertAdjacentHTML('beforeend', renderDeleteModal());
  if (state.editingComment) {
    app.insertAdjacentHTML('beforeend', renderCommentSheet());
    requestAnimationFrame(() => document.getElementById('comment-sheet-input')?.focus());
  }
  if (state.uploadSheet.open) app.insertAdjacentHTML('beforeend', renderUploadSheet());
  if (state.stravaConnectSheet) app.insertAdjacentHTML('beforeend', renderStravaConnectSheet());
  if (state.timer.active) updateTimerBar();
  attachSwipeListeners();
}

// ── Swipe to delete ───────────────────────────────────────────────────────────
let swipeDocListenerAdded = false;

function closeAllSwipes() {
  document.querySelectorAll('.set-row[data-swipe-open="true"]').forEach(row => {
    const inner = row.querySelector('.set-row-inner');
    if (inner) {
      inner.style.transition = 'transform 0.2s ease';
      inner.style.transform = 'translateX(0)';
    }
    delete row.dataset.swipeOpen;
  });
}

function attachSwipeListeners() {
  if (!swipeDocListenerAdded) {
    document.addEventListener('touchstart', e => {
      if (!e.target.closest('.set-row')) closeAllSwipes();
    }, { passive: true });
    swipeDocListenerAdded = true;
  }

  document.querySelectorAll('.set-row[data-deletable="true"]').forEach(row => {
    let startX, startY, didMove = false;
    const inner = row.querySelector('.set-row-inner');
    if (!inner) return;

    row.addEventListener('touchstart', e => {
      if (e.target.closest('.btn-swipe-delete')) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      didMove = false;
    }, { passive: true });

    row.addEventListener('touchmove', e => {
      if (startX === undefined) return;
      const dx = startX - e.touches[0].clientX;
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (dy > Math.abs(dx) && !didMove) return; // vertical scroll
      didMove = true;
      const base = row.dataset.swipeOpen === 'true' ? 80 : 0;
      const tx = Math.max(0, Math.min(80, base + dx));
      inner.style.transition = 'none';
      inner.style.transform = `translateX(-${tx}px)`;
    }, { passive: true });

    row.addEventListener('touchend', e => {
      if (startX === undefined) return;
      const dx = startX - e.changedTouches[0].clientX;
      inner.style.transition = 'transform 0.2s ease';
      if (row.dataset.swipeOpen === 'true' && !didMove) {
        // tap on open row — close it
        inner.style.transform = 'translateX(0)';
        delete row.dataset.swipeOpen;
      } else if (dx > 40) {
        inner.style.transform = 'translateX(-80px)';
        row.dataset.swipeOpen = 'true';
        // close other open rows
        document.querySelectorAll('.set-row[data-swipe-open="true"]').forEach(other => {
          if (other !== row) {
            const otherInner = other.querySelector('.set-row-inner');
            if (otherInner) { otherInner.style.transition = 'transform 0.2s ease'; otherInner.style.transform = 'translateX(0)'; }
            delete other.dataset.swipeOpen;
          }
        });
      } else {
        inner.style.transform = 'translateX(0)';
        delete row.dataset.swipeOpen;
      }
      startX = undefined;
    }, { passive: true });
  });
}

// ── Actions ───────────────────────────────────────────────────────────────────
function goHome() {
  if (state.view === 'session') {
    state.exitModal = 'main';
    render();
    return;
  }
  resetToHome();
}

function resetToHome() {
  if (state.exTimer.interval) clearInterval(state.exTimer.interval);
  stopTimer();
  Object.assign(state, {
    view: 'home', workout: null, session: null, exitModal: null, deleteModal: null,
    expandedId: null, skipped: new Set(), extraSets: {},
    setOverrides: {}, repsOverrides: {}, editing: null,
    editingComment: null, editingPriorSession: false,
    exTimer: {
      active: false, paused: false, exerciseId: null, setNumber: null,
      remaining: 0, total: 0, startTime: null, interval: null, data: {},
    },
  });
  render();
}

function saveAndExit() {
  if (state.session && !state.session.completedAt) Store.completeSession(state.session.id);
  resetToHome();
}

function confirmDiscard() {
  state.exitModal = 'discard';
  render();
}

function discardAndExit() {
  if (state.session) Store.discardSession(state.session.id);
  resetToHome();
}

function closeExitModal() {
  state.exitModal = null;
  render();
}

function deleteSession(sessionId) {
  if (!confirm('Delete this session?')) return;
  Store.deleteSession(sessionId);
  render();
}

function confirmDeleteSession(sessionId) {
  state.deleteModal = sessionId;
  render();
}

function cancelDeleteSession() {
  state.deleteModal = null;
  render();
}

function executeDeleteSession() {
  const sessionId = state.deleteModal;
  state.deleteModal = null;
  state.detailSession = null;
  state.view = 'home';
  Store.deleteSession(sessionId);
  render();
}

function viewSession(sessionId) {
  state.detailSession = Store.allCompleted().find(s => s.id === sessionId) || null;
  if (!state.detailSession) return;
  state.view = 'session-detail';
  render();
}

function closeSessionDetail() {
  state.detailSession = null;
  state.view = 'home';
  render();
}

function editSet(exerciseId, setNumber) {
  state.editing = { exerciseId, setNumber };
  render();
}

function deleteSet(exerciseId, setNumber) {
  const exercise = state.workout.exercises.find(e => e.id === exerciseId);
  const targetSets = getTargetSets(exercise);
  state.session = Store.removeSet(state.session.id, exerciseId, setNumber);
  if (setNumber > targetSets) {
    state.extraSets[exerciseId] = Math.max(0, (state.extraSets[exerciseId] || 0) - 1);
  }
  render();
}

function startComment(exerciseId) {
  state.editingComment = exerciseId;
  render();
}

function saveComment() {
  const exerciseId = state.editingComment;
  const input = document.getElementById('comment-sheet-input');
  if (!input || !exerciseId) return;
  state.session = Store.saveComment(state.session.id, exerciseId, input.value);
  state.editingComment = null;
  render();
}

function cancelComment() {
  state.editingComment = null;
  render();
}

function editPriorSession(sessionId) {
  const session = Store.getById(sessionId);
  if (!session) return;
  const workout = PROGRAM.workouts.find(w => w.id === session.workoutId);
  if (!workout) return;
  state.session = session;
  state.workout = workout;
  state.week = session.week || 1;
  state.editingPriorSession = true;
  state.expandedId = workout.exercises[0]?.id || null;
  state.skipped = new Set();
  state.extraSets = {};
  state.editing = null;
  state.editingComment = null;
  state.view = 'session';
  render();
}

function closeSessionEdit() {
  const sessionId = state.session?.id;
  state.editingPriorSession = false;
  state.session = null;
  state.workout = null;
  state.expandedId = null;
  state.skipped = new Set();
  state.extraSets = {};
  state.editing = null;
  state.editingComment = null;
  if (sessionId) {
    state.detailSession = Store.getById(sessionId);
    state.view = 'session-detail';
  } else {
    state.view = 'home';
  }
  render();
}

function openUpload(sessionId) {
  state.uploadSheet.open = true;
  state.uploadSheet.sessionId = sessionId;
  state.uploadSheet.title = 'Strength Training';
  state.uploadSheet.description = '';
  state.uploadSheet.error = null;
  render();
}

function closeUpload() {
  state.uploadSheet.open = false;
  render();
}

function togglePlatform(platform) {
  state.uploadSheet.platforms[platform] = !state.uploadSheet.platforms[platform];
}

async function sendToServices() {
  const us = state.uploadSheet;
  if (!us.platforms.strava) { closeUpload(); return; }

  const session = Store.getById(us.sessionId);
  if (!session) { closeUpload(); return; }

  state.uploadSheet.uploading = true;
  state.uploadSheet.error = null;
  render();

  const result = await Strava.uploadActivity(
    session, us.title, us.description, us.includeComments
  );

  state.uploadSheet.uploading = false;

  if (result.ok) {
    closeUpload();
  } else {
    const lines = [`Error: ${result.error}`];
    if (result.status) lines.push(`HTTP status: ${result.status}`);
    if (result.detail) lines.push(`Response body:\n${result.detail}`);
    lines.push(`Session ID: ${us.sessionId}`);
    lines.push(`Started: ${session.startedAt}`);
    state.uploadSheet.error = lines.join('\n');
    render();
  }
}

function copyUploadError() {
  if (!state.uploadSheet.error) return;
  navigator.clipboard.writeText(state.uploadSheet.error).catch(() => {
    // fallback: select the text element
    const el = document.getElementById('upload-error-text');
    if (el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }
  });
}

function openStravaConnect() {
  state.stravaConnectSheet = true;
  render();
}

function closeStravaConnect() {
  state.stravaConnectSheet = false;
  render();
}

function initiateStravaAuth() {
  const clientId = document.getElementById('strava-client-id')?.value.trim();
  const clientSecret = document.getElementById('strava-client-secret')?.value.trim();
  if (!clientId || !clientSecret) {
    alert('Please enter both Client ID and Client Secret.');
    return;
  }
  Strava.initiateAuth(clientId, clientSecret);  // redirects away
}

function disconnectStrava() {
  Strava.disconnect();
  render();
}

function exportSessions() {
  alert('Export coming soon.');
}

function selectWorkout(workoutId) {
  state.workout = PROGRAM.workouts.find(w => w.id === workoutId);
  state.week = Math.min(Store.completedCount(workoutId) + 1, 5);
  state.view = 'pre-session';
  render();
}

function startSession() {
  ensureAudio();
  state.session = Store.createSession(state.workout.id, state.restDuration, state.week);
  state.expandedId = state.workout.exercises[0].id;
  state.view = 'session';
  render();
}

function toggleExercise(exerciseId) {
  state.expandedId = state.expandedId === exerciseId ? null : exerciseId;
  render();
  if (state.expandedId) {
    requestAnimationFrame(() => {
      document.getElementById(`card-${exerciseId}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }
}

function skip(exerciseId) {
  state.skipped.add(exerciseId);
  render();
}

function unskip(exerciseId) {
  state.skipped.delete(exerciseId);
  render();
}

function addSet(exerciseId) {
  state.extraSets[exerciseId] = (state.extraSets[exerciseId] || 0) + 1;
  render();
}

function logSet(exerciseId, setNumber, button) {
  ensureAudio();
  const row = button.closest('.set-row');
  const inputs = row.querySelectorAll('.set-input');
  const data = { setNumber };
  let hasAny = false;

  inputs.forEach(input => {
    const val = input.value.trim();
    if (!val) return;
    hasAny = true;
    const field = input.dataset.field;
    data[field] = field === 'band' ? val : parseFloat(val);
  });

  if (!hasAny) { inputs[0]?.focus(); return; }

  const wasEditing = !!state.editing;
  state.editing = null;
  state.session = Store.logSet(state.session.id, exerciseId, data);
  if (!state.editingPriorSession && !wasEditing) {
    startTimer(state.restDuration, `Rest — set ${setNumber} done`);
  }
  render();
}

function finishSession() {
  state.session = Store.completeSession(state.session.id);
  if (state.exTimer.interval) clearInterval(state.exTimer.interval);
  state.exTimer.active = false;
  state.exTimer.paused = false;
  stopTimer();
  state.view = 'complete';
  render();
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (code || error) {
    history.replaceState({}, '', window.location.pathname);
    if (code) await Strava.handleCallback(code);
  }
  render();
})();
