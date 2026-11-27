"use strict";

// Start all cleanup tasks even if one throws synchronously; quit cannot be
// held hostage by a pending scan, a worker request, or a stalled log write.
function createShutdown({ tasks, finalize, forceExit, timeoutMs = 5000 }) {
  let started = false;
  let done = false;
  let timer;
  function finish(timedOut) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (timedOut) {
      forceExit();
      return;
    }
    try { finalize(); } catch { forceExit(); }
  }
  function start() {
    if (started) return;
    started = true;
    timer = setTimeout(() => finish(true), timeoutMs);
    Promise.allSettled(tasks.map(task => Promise.resolve().then(task)))
      .then(() => finish(false));
  }
  return { start, get started() { return started; } };
}
module.exports = { createShutdown };
