// A minimal History-API router — four named routes, each with onEnter /
// onLeave hooks and optional one-shot navigation state (e.g. a just-finished
// measurement handed from FEEL to BLOOM).
//
// Base-path aware: on GitHub Pages the app is served from a subpath
// (e.g. /rose-garden/), so routes are always registered/matched as
// app-relative paths ('/', '/feel', ...) while the actual URL the browser
// sees has BASE prepended. Vite bakes the configured `base` into
// import.meta.env.BASE_URL at build time, so this needs no other config.
const BASE = (import.meta.env?.BASE_URL || '/').replace(/\/$/, ''); // '' or e.g. '/rose-garden'

export function withBase(path) {
  return BASE + path;
}
function toAppPath(pathname) {
  const stripped = BASE && pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  return stripped || '/';
}

const routes = new Map();
let current = null;

// When set, blocks navigate()/back-forward and calls this instead of
// actually leaving — used while a felt-time measurement is in progress.
let guard = null;
let onChange = null;

export function registerRoute(path, { onEnter, onLeave } = {}) {
  routes.set(path, { onEnter, onLeave });
}

export function setNavigationGuard(fn) {
  guard = fn;
}

// Called with the resolved path after every successful activation (via
// navigate() or popstate) — lets the DOM layer stay in sync without each
// route handler having to remember to do it itself.
export function onRouteChange(fn) {
  onChange = fn;
}

function activate(path, state) {
  const route = routes.get(path) || routes.get('/');
  const resolvedPath = routes.has(path) ? path : '/';

  if (current && current !== resolvedPath) {
    const leaving = routes.get(current);
    leaving?.onLeave?.();
  }
  current = resolvedPath;
  route?.onEnter?.(state || {});
  onChange?.(resolvedPath);
}

export function navigate(path, state) {
  if (guard && !guard(path)) return;
  if (toAppPath(location.pathname) !== path) {
    history.pushState(state || {}, '', withBase(path));
  }
  activate(path, state);
}

// Updates the CURRENT history entry's state (e.g. to mark a just-shown
// result as "consumed") without creating a new entry or changing route.
export function replaceState(state) {
  history.replaceState(state, '', withBase(current || '/'));
}

export function currentPath() {
  return current;
}

window.addEventListener('popstate', (e) => {
  const appPath = toAppPath(location.pathname);
  if (guard && !guard(appPath)) {
    // veto the back/forward navigation by restoring the current entry
    history.pushState({}, '', withBase(current));
    return;
  }
  activate(appPath, e.state);
});

export function startRouter() {
  activate(toAppPath(location.pathname), history.state);
}
