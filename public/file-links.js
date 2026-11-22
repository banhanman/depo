function cleanRel(project, ref) {
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
  return clean || null;
}

export function projectFileUrl(project, ref) {
  const clean = cleanRel(project, ref);
  return clean && `/api/projects/${encodeURIComponent(project.id)}/raw?path=${encodeURIComponent(clean)}`;
}

export function projectPageUrl(project, ref) {
  const clean = cleanRel(project, ref);
  return clean && `/preview/${encodeURIComponent(project.id)}/${clean.split('/').map(encodeURIComponent).join('/')}`;
}

export const isImagePath = ref => /\.(?:png|jpe?g|gif|webp|svg)$/i.test(String(ref || '').trim());
export const isPagePath = ref => /\.html?$/i.test(String(ref || '').trim());
