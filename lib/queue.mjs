const cleanAttachments = value => (Array.isArray(value) ? value : []).slice(0, 12);
const dto = row => row ? { ...row, attachments: row.attachments ? JSON.parse(row.attachments) : [] } : null;

export const canSteer = provider => provider === 'claude';

export function byId(h, id) {
  return dto(h.get('SELECT * FROM queued_messages WHERE id=?', +id));
}

export function pending(h, chatId) {
  return h.all("SELECT * FROM queued_messages WHERE chat_id=? AND status='pending' ORDER BY id", chatId).map(dto);
}

export function enqueue(h, chatId, text, attachments = []) {
  const msg = String(text || '').trim();
  const atts = cleanAttachments(attachments);
  if (!msg && !atts.length) throw new Error('Пустое сообщение.');
  const now = Date.now();
  const r = h.run(`INSERT INTO queued_messages(chat_id,text,attachments,created_at,updated_at)
                   VALUES(?,?,?,?,?)`, chatId, msg, JSON.stringify(atts), now, now);
  return byId(h, Number(r.lastInsertRowid));
}

export function update(h, id, text) {
  const msg = String(text || '').trim();
  if (!msg) throw new Error('Пустое сообщение.');
  const now = Date.now();
  const r = h.run("UPDATE queued_messages SET text=?,updated_at=?,error=NULL WHERE id=? AND status='pending'", msg, now, +id);
  return r.changes ? byId(h, id) : null;
}

export function remove(h, id) {
  return !!h.run("DELETE FROM queued_messages WHERE id=? AND status='pending'", +id).changes;
}

export function claimNext(h, chatId) {
  return dto(h.get(`UPDATE queued_messages SET status='sending',updated_at=?,error=NULL
                    WHERE id=(SELECT id FROM queued_messages WHERE chat_id=? AND status='pending' ORDER BY id LIMIT 1)
                    RETURNING *`, Date.now(), chatId));
}

export function complete(h, id, runId) {
  h.run("UPDATE queued_messages SET status='sent',sent_at=?,updated_at=?,run_id=? WHERE id=? AND status='sending'",
    Date.now(), Date.now(), runId, +id);
}

export function fail(h, id, error) {
  h.run("UPDATE queued_messages SET status='pending',updated_at=?,error=? WHERE id=? AND status='sending'",
    Date.now(), String(error || 'Не удалось запустить.').slice(0, 500), +id);
}

export function restore(h) {
  return Number(h.run("UPDATE queued_messages SET status='pending',updated_at=? WHERE status='sending'", Date.now()).changes);
}
