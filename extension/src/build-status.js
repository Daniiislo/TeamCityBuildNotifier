// Derives "what is happening right now" from the server's replay buffer.
// A build that has a 'started' event but no 'finished' one is still running.
// Pure function, no chrome APIs, so it is testable on its own.

export function currentStatus(notifications) {
  // GetRecent returns oldest-first, so a later entry wins over an earlier one.
  const builds = new Map();
  for (const n of notifications) {
    const build = builds.get(n.buildId) || { buildId: n.buildId };
    if (n.event === 'started') build.started = n;
    else build.finished = n;
    builds.set(n.buildId, build);
  }

  // One row per build configuration - the newest run of it, not every run.
  const perConfig = new Map();
  for (const build of builds.values()) {
    const source = build.finished || build.started;
    if (!source) continue;

    const row = { running: !build.finished, build: source, at: timeOf(source) };
    const key = source.buildTypeId || source.buildId;
    const seen = perConfig.get(key);
    if (!seen || row.at > seen.at) perConfig.set(key, row);
  }

  // Running first, then most recently finished.
  const rows = [...perConfig.values()].sort((a, b) =>
    a.running === b.running ? b.at - a.at : (a.running ? -1 : 1));

  return {
    rows,
    counts: {
      running: rows.filter(r => r.running).length,
      success: rows.filter(r => !r.running && r.build.status === 'SUCCESS').length,
      failure: rows.filter(r => !r.running && r.build.status === 'FAILURE').length,
      cancelled: rows.filter(r => !r.running && r.build.status === 'CANCELLED').length
    }
  };
}

function timeOf(notification) {
  const date = new Date(notification.finishedAt || notification.startedAt || notification.receivedAt);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}
