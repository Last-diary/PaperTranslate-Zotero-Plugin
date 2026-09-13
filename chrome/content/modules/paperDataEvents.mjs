const listeners = new Set();
const busyChecks = new Set();

export function onPaperDataChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyPaperDataChanged(detail) {
  for (const listener of [...listeners]) {
    try {
      listener(detail);
    } catch {}
  }
}

export function onPaperDataBusyCheck(check) {
  busyChecks.add(check);
  return () => busyChecks.delete(check);
}

export function isPaperDataBusy(detail) {
  for (const check of [...busyChecks]) {
    try {
      if (check(detail)) return true;
    } catch {}
  }
  return false;
}

export function clearPaperDataListeners() {
  listeners.clear();
  busyChecks.clear();
}
