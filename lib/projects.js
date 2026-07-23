// 项目关联层：项目间强弱关联（project_links 表）的读写与双向查询。
// relationDecay / relEnabled 在 util.js（被 memory 的跨项目衰减复用）。
const backend = require('./backend');

let projectLinksCache = null;
function loadProjectLinks() {
  try {
    const d = backend.sqliteInit();
    projectLinksCache = d.prepare('SELECT from_project, to_project, strength, note, created_at FROM project_links').all();
  } catch (e) { projectLinksCache = []; }
  return projectLinksCache || [];
}
// 双向查询：无论从哪一端定义，都视为相关
function getProjectLinks(project) {
  if (projectLinksCache === null) loadProjectLinks();
  return (projectLinksCache || [])
    .filter(r => r.from_project === project || r.to_project === project)
    .map(r => ({ to_project: r.from_project === project ? r.to_project : r.from_project, strength: r.strength, note: r.note }));
}
function upsertProjectLink(from, to, strength, note) {
  if (!from || !to || from === to) return false;
  const d = backend.sqliteInit();
  d.prepare('INSERT INTO project_links (from_project, to_project, strength, note, created_at) VALUES (?,?,?,?,?) ' +
    'ON CONFLICT(from_project, to_project) DO UPDATE SET strength=excluded.strength, note=excluded.note, created_at=excluded.created_at')
    .run(from, to, Number(strength) || 0, note || '', new Date().toISOString());
  projectLinksCache = null;
  return true;
}
function removeProjectLink(from, to) {
  const d = backend.sqliteInit();
  d.prepare('DELETE FROM project_links WHERE from_project=? AND to_project=?').run(from, to);
  projectLinksCache = null;
}

module.exports = { loadProjectLinks, getProjectLinks, upsertProjectLink, removeProjectLink };
