const Store = (() => {
  const KEY = 'gym_sessions';

  function all() {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  }

  function save(sessions) {
    localStorage.setItem(KEY, JSON.stringify(sessions));
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function createSession(workoutId, restDuration, week) {
    const session = {
      id: uuid(),
      workoutId,
      week: week || 1,
      date: new Date().toISOString().split('T')[0],
      startedAt: new Date().toISOString(),
      completedAt: null,
      restDuration,
      sets: [],
      comments: {},
      // sets schema: { exerciseId, setNumber, weight, reps, time, band, completedAt }
    };
    const sessions = all();
    sessions.push(session);
    save(sessions);
    return session;
  }

  function logSet(sessionId, exerciseId, setData) {
    const sessions = all();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return null;
    // Replace if already logged this set
    session.sets = session.sets.filter(
      s => !(s.exerciseId === exerciseId && s.setNumber === setData.setNumber)
    );
    session.sets.push({
      exerciseId,
      setNumber: setData.setNumber,
      weight: setData.weight ?? null,
      reps: setData.reps ?? null,
      time: setData.time ?? null,
      band: setData.band ?? null,
      completedAt: new Date().toISOString(),
    });
    save(sessions);
    return sessions.find(s => s.id === sessionId);
  }

  function completeSession(sessionId) {
    const sessions = all();
    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      session.completedAt = new Date().toISOString();
      save(sessions);
    }
    return session;
  }

  function getById(sessionId) {
    return all().find(s => s.id === sessionId) || null;
  }

  function lastCompleted(workoutId) {
    return all()
      .filter(s => s.workoutId === workoutId && s.completedAt)
      .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))[0] || null;
  }

  function completedCount(workoutId) {
    return all().filter(s => s.workoutId === workoutId && s.completedAt).length;
  }

  function removeSet(sessionId, exerciseId, setNumber) {
    const sessions = all();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return null;
    session.sets = session.sets.filter(
      s => !(s.exerciseId === exerciseId && s.setNumber === setNumber)
    );
    save(sessions);
    return session;
  }

  function saveComment(sessionId, exerciseId, text) {
    const sessions = all();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return null;
    if (!session.comments) session.comments = {};
    if (text.trim()) {
      session.comments[exerciseId] = text.trim();
    } else {
      delete session.comments[exerciseId];
    }
    save(sessions);
    return sessions.find(s => s.id === sessionId);
  }

  function deleteSession(sessionId) {
    save(all().filter(s => s.id !== sessionId));
  }

  function allCompleted() {
    return all()
      .filter(s => s.completedAt)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  function discardSession(sessionId) {
    save(all().filter(s => s.id !== sessionId));
  }

  function exportJSON() {
    return JSON.stringify(allCompleted(), null, 2);
  }

  return {
    createSession, logSet, removeSet, completeSession, getById,
    lastCompleted, completedCount, saveComment, deleteSession,
    discardSession, allCompleted, exportJSON,
  };
})();
