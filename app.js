// ── State ──────────────────────────────────────────────────────────────────
const state = {
  view: 'home',         // 'home' | 'pre-session' | 'session' | 'complete'
  workout: null,
  session: null,
  week: 1,
  restDuration: 90,
  expandedId: null,
  skipped: new Set(),
  extraSets: {},
  setOverrides: {},
  repsOverrides: {},
  exitModal: false,
  detailSession: null,
  editing: null,        // { exerciseId, setNumber } — set currently being re-edited
  // Rest timer (bottom bar)
  timer: {
    active: false,
    remaining: 0,
    interval: null,
    label: '',
  },
  // Exercise timer (in-set countdown for timed exercises)
  exTimer: {
    active: false,
    exerciseId: null,
    setNumber: null,
    remaining: 0,
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
  state.timer.active = true;
  state.timer.remaining = seconds;
  state.timer.label = label || 'Rest';
  updateTimerBar();
  state.timer.interval = setInterval(() => {
    state.timer.remaining = Math.max(0, state.timer.remaining - 1);
    if (state.timer.remaining === 0) {
      clearInterval(state.timer.interval);
      state.timer.interval = null;
      beep();
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
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
    <button class="btn-timer-skip" onclick="stopTimer()">Dismiss</button>
  `;
}

// ── Exercise timer (in-set countdown) ─────────────────────────────────────
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
  Object.assign(state.exTimer, { active: true, exerciseId, setNumber, remaining: seconds, data });
  render();

  state.exTimer.interval = setInterval(() => {
    state.exTimer.remaining = Math.max(0, state.exTimer.remaining - 1);
    if (state.exTimer.remaining === 0) {
      clearInterval(state.exTimer.interval);
      state.exTimer.interval = null;
      beep(660);
      if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
      autoLogTimedSet();
    } else {
      // Update the countdown in-place to avoid disrupting other inputs
      const el = document.getElementById(`ex-timer-val-${exerciseId}-${setNumber}`);
      if (el) {
        const m = Math.floor(state.exTimer.remaining / 60);
        const s = String(state.exTimer.remaining % 60).padStart(2, '0');
        el.textContent = `${m}:${s}`;
      }
    }
  }, 1000);
}

function autoLogTimedSet() {
  const { exerciseId, setNumber, data } = state.exTimer;
  state.exTimer.active = false;
  state.session = Store.logSet(state.session.id, exerciseId, data);
  startTimer(state.restDuration, `Rest — set ${setNumber} done`);
  render();
}

function stopExerciseTimer() {
  if (state.exTimer.interval) clearInterval(state.exTimer.interval);
  state.exTimer.active = false;
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
  const effective = getEffectiveSetCount(exercise); // uses effective, so adding a set reverts to grey
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

// ── Render: set inputs with hints ───────────────────────────────────────────
function renderSetInputs(exercise, loggedSet, prevSet, isEditing = false) {
  const m = exercise.metric;
  const ro = (loggedSet && !isEditing) ? 'readonly' : '';
  const v = loggedSet || {};  // values to pre-fill (works for both normal display and edit mode)
  const targetReps = getTargetReps(exercise);
  const targetTime = getTargetTime(exercise);
  let html = '';

  if (m === 'weight_reps' || m === 'weight_time') {
    const lastWeight = prevSet?.weight != null ? `${prevSet.weight} lb` : '—';
    html += `<div class="input-group">
      <span class="input-label">Weight (lb)</span>
      <input type="number" inputmode="decimal" class="set-input" data-field="weight"
        placeholder="0" value="${v.weight ?? ''}" ${ro}>
      <span class="input-hint">${lastWeight}</span>
    </div>`;
  }

  if (m === 'weight_reps' || m === 'reps_only' || m === 'time_reps') {
    const lastReps = prevSet?.reps != null ? `${prevSet.reps}` : '—';
    html += `<div class="input-group">
      <span class="input-label">Reps</span>
      <input type="number" inputmode="numeric" class="set-input" data-field="reps"
        placeholder="0" value="${v.reps ?? ''}" ${ro}>
      <span class="input-hint">target ${targetReps ?? '—'} · last ${lastReps}</span>
    </div>`;
  }

  if (m === 'weight_time' || m === 'time_only' || m === 'time_reps') {
    const lastTime = prevSet?.time != null ? `${prevSet.time}s` : '—';
    html += `<div class="input-group">
      <span class="input-label">Time (s)</span>
      <input type="number" inputmode="numeric" class="set-input" data-field="time"
        placeholder="${targetTime || 0}" value="${v.time ?? (targetTime || '')}" ${ro}>
      <span class="input-hint">target ${targetTime ?? '—'}s · last ${lastTime}</span>
    </div>`;
  }

  if (m === 'band_reps') {
    const lastBand = prevSet?.band ?? '—';
    const lastReps = prevSet?.reps != null ? `${prevSet.reps}` : '—';
    html += `<div class="input-group">
      <span class="input-label">${exercise.bandLabel || 'Band'}</span>
      <input type="text" class="set-input is-text" data-field="band"
        placeholder="color" value="${v.band ?? ''}" ${ro}>
      <span class="input-hint">last ${lastBand}</span>
    </div>
    <div class="input-group">
      <span class="input-label">Reps</span>
      <input type="number" inputmode="numeric" class="set-input" data-field="reps"
        placeholder="0" value="${v.reps ?? ''}" ${ro}>
      <span class="input-hint">target ${targetReps ?? '—'} · last ${lastReps}</span>
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
        const d = new Date(s.date + 'T12:00:00'); // noon to avoid timezone edge cases
        const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        const exerciseIds = [...new Set(s.sets.map(x => x.exerciseId))];
        const totalExercises = workout?.exercises.length || 0;
        return `<div class="session-item">
          <div class="session-info" onclick="viewSession('${s.id}')">
            <div class="session-date">${dateStr}</div>
            <div class="session-workout">${workout?.name || s.workoutId} · ${exerciseIds.length}/${totalExercises} exercises</div>
          </div>
          <button class="btn-delete-session" onclick="deleteSession('${s.id}')">Delete</button>
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

      <div class="sessions-header">
        <span class="section-label" style="margin:0">Prior Sessions</span>
        <button class="btn-export" onclick="exportSessions()">Export</button>
      </div>
      <div class="sessions-list">${sessionList}</div>
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

  return `<div class="screen">
    <div class="header">
      <button class="btn-icon" onclick="goHome()">End</button>
      <div class="header-title">${w.name}</div>
      <span style="font-size:13px;color:var(--text2)">${p.done}/${p.total}</span>
    </div>
    <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
    <div class="content ${state.timer.active ? 'timer-active' : ''}">
      ${w.exercises.map(e => renderExerciseCard(e)).join('')}
      ${allDone ? `<div class="finish-btn-row">
        <button class="btn-primary" onclick="finishSession()">Finish Workout</button>
      </div>` : ''}
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

      if (isActiveTimer) {
        const m = Math.floor(state.exTimer.remaining / 60);
        const s = String(state.exTimer.remaining % 60).padStart(2, '0');
        setsHtml += `<div class="set-row" id="setrow-${exercise.id}-${i}">
          <div class="set-number">Set ${i} — in progress</div>
          <div class="ex-timer-display">
            <span class="ex-timer-value" id="ex-timer-val-${exercise.id}-${i}">${m}:${s}</span>
            <button class="btn-timer-stop" onclick="stopExerciseTimer()">Stop</button>
          </div>
        </div>`;
      } else {
        let actionBtn = '';
        if (isLogged && !isEditing) {
          actionBtn = `<button class="btn-done is-logged" onclick="editSet('${exercise.id}', ${i})">Edit</button>`;
        } else if (isSkipped) {
          actionBtn = `<button class="btn-done" disabled>Done</button>`;
        } else if (isTimed && !isEditing) {
          actionBtn = `<button class="btn-start-ex" onclick="beginExerciseTimer('${exercise.id}', ${i}, this)">Start</button>`;
        } else {
          actionBtn = `<button class="btn-done" onclick="logSet('${exercise.id}', ${i}, this)">Done</button>`;
        }

        setsHtml += `<div class="set-row ${isLogged && !isEditing ? 'is-logged' : ''}" id="setrow-${exercise.id}-${i}">
          <div class="set-number">Set ${i}</div>
          <div class="set-inputs">
            ${renderSetInputs(exercise, ls, prevSet, isEditing)}
            ${actionBtn}
          </div>
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
        ${!isSkipped ? `<button class="btn-add-set" onclick="addSet('${exercise.id}')">+ Add Set</button>` : ''}
      </div>
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
  </div>`;
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderSessionDetail() {
  const s = state.detailSession;
  const workout = PROGRAM.workouts.find(w => w.id === s.workoutId);
  const d = new Date(s.date + 'T12:00:00');
  const dateStr = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  const exerciseRows = (workout?.exercises || []).map(ex => {
    const exSets = s.sets
      .filter(set => set.exerciseId === ex.id)
      .sort((a, b) => a.setNumber - b.setNumber);

    if (exSets.length === 0) return `
      <div class="detail-exercise">
        <div class="detail-ex-name">${ex.name}</div>
        <div class="detail-ex-empty">Not logged</div>
      </div>`;

    return `<div class="detail-exercise">
      <div class="detail-ex-name">${ex.name}</div>
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
    </div>`;
  }).join('');

  return `<div class="screen">
    <div class="header">
      <button class="btn-icon" onclick="closeSessionDetail()">← Back</button>
      <div class="header-title">${workout?.name || ''}</div>
    </div>
    <div class="content">
      <div class="detail-date">${dateStr}</div>
      ${exerciseRows}
    </div>
  </div>`;
}

function renderExitModal() {
  return `<div class="modal-overlay" onclick="closeExitModal()">
    <div class="modal-sheet" onclick="event.stopPropagation()">
      <div class="modal-title">End workout?</div>
      <button class="modal-btn" onclick="saveAndExit()">Save &amp; Exit</button>
      <button class="modal-btn modal-btn--danger" onclick="discardAndExit()">Discard Workout</button>
      <button class="modal-btn modal-btn--secondary" onclick="closeExitModal()">Keep Going</button>
    </div>
  </div>`;
}

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
  if (state.timer.active) updateTimerBar();
}

// ── Actions ───────────────────────────────────────────────────────────────────
function goHome() {
  if (state.view === 'session') {
    state.exitModal = true;
    render();
    return;
  }
  resetToHome();
}

function resetToHome() {
  if (state.exTimer.interval) clearInterval(state.exTimer.interval);
  stopTimer();
  Object.assign(state, {
    view: 'home', workout: null, session: null, exitModal: false,
    expandedId: null, skipped: new Set(), extraSets: {},
    setOverrides: {}, repsOverrides: {}, editing: null,
    exTimer: { active: false, exerciseId: null, setNumber: null, remaining: 0, interval: null, data: {} },
  });
  render();
}

function saveAndExit() {
  if (state.session && !state.session.completedAt) Store.completeSession(state.session.id);
  resetToHome();
}

function discardAndExit() {
  if (!confirm('Discard this workout? All logged sets will be lost.')) return;
  if (state.session) Store.discardSession(state.session.id);
  resetToHome();
}

function closeExitModal() {
  state.exitModal = false;
  render();
}

function deleteSession(sessionId) {
  if (!confirm('Delete this session?')) return;
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
  state.session = Store.createSession(state.workout.id, state.restDuration);
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

  state.editing = null;
  state.session = Store.logSet(state.session.id, exerciseId, data);
  startTimer(state.restDuration, `Rest — set ${setNumber} done`);
  render();
}

function finishSession() {
  state.session = Store.completeSession(state.session.id);
  if (state.exTimer.interval) clearInterval(state.exTimer.interval);
  state.exTimer.active = false;
  stopTimer();
  state.view = 'complete';
  render();
}

// ── Init ──────────────────────────────────────────────────────────────────────
render();
