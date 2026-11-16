/**
 * Führt `fn` höchstens einmal gleichzeitig aus: Aufrufe während eines laufenden
 * Durchgangs bekommen dasselbe Promise, statt einen weiteren Durchgang zu starten.
 */
export function createSingleFlight(fn) {
  let running = null;
  return () => {
    if (!running) {
      running = Promise.resolve()
        .then(fn)
        .finally(() => {
          running = null;
        });
    }
    return running;
  };
}

/**
 * Wartet höchstens `ms` Millisekunden auf `promise`.
 * Liefert true, wenn es rechtzeitig fertig wurde, sonst false (das Promise läuft weiter).
 * Ein Fehler des Promise wird nur weitergereicht, wenn er innerhalb der Frist auftritt.
 */
export function settlesWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([promise.then(() => true), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Liefert `run(fn)`: führt übergebene Funktionen strikt nacheinander aus
 * (auch nach einem Fehler der vorherigen) und gibt deren Ergebnis zurück.
 */
export function createMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const result = tail.then(fn, fn);
    tail = result.catch(() => {});
    return result;
  };
}
