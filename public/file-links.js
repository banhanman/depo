export function projectFileUrl(project, ref) {
  if (!project?.id || !project.path || !ref) return null;
  const text = String(ref).trim();
  if (!text || /[<>]/.test(text) || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(text)) return null;

  const root = String(project.path).replace(/\\/g, '/').replace(/\/+$/, '');
  let rel = text.replace(/\\/g, '/');
  if (root && rel.startsWith(root + '/')) rel = rel.slice(root.length + 1);
  else if (rel.startsWith('/')) return null;

  const parts = rel.split('/');
  if (parts.includes('..')) return null;
  const clean = parts.filter(part => part && part !== '.').join('/');
  if (!clean) return null;
  return `/api/projects/${encodeURIComponent(project.id)}/raw?path=${encodeURIComponent(clean)}`;
}

export const isImagePath = ref => /\.(?:png|jpe?g|gif|webp|svg)$/i.test(String(ref || '').trim());
