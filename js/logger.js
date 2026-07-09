window.SCSLogger = (function () {
  const MAX_LINES = 100;
  let lines = [];

  function log(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    lines.push(entry);
    if (lines.length > MAX_LINES) lines.shift();
    console.log(entry);
  }

  function getLines() {
    return lines.slice();
  }

  function clear() {
    lines = [];
  }

  return { log, getLines, clear };
})();
