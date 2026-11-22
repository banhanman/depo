export const RESUME_TEXT = 'Depo перезапускался, и твой прошлый ход оборвался на середине. '
  + 'Продолжай с того места, где остановился: сначала проверь, что уже сделано, потом доведи задачу до конца.';
export const MAX_AGE_MS = 12 * 3600e3;
export const MAX_IN_ROW = 3;

export function resumable(h, { now = Date.now(), maxAgeMs = MAX_AGE_MS, maxInRow = MAX_IN_ROW } = {}) {
  const chats = h.all(`SELECT DISTINCT c.id FROM runs r JOIN chats c ON c.id=r.chat_id
    WHERE r.status='interrupted' AND r.ended_at > ? AND c.archived=0 AND COALESCE(c.team,0)=0`, now - maxAgeMs);
  const out = [];
  for (const { id } of chats) {
    const tail = h.all("SELECT status FROM runs WHERE chat_id=? AND status!='context' ORDER BY started_at DESC, id DESC LIMIT ?", id, maxInRow);
    if (tail[0]?.status !== 'interrupted') continue;
    if (tail.length >= maxInRow && tail.every(r => r.status === 'interrupted')) continue;
    if (h.get("SELECT 1 FROM queued_messages WHERE chat_id=? AND status='pending'", id)) { out.push({ id, queued: true }); continue; }
    out.push({ id, queued: false });
  }
  return out;
}
