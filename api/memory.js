const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TABLE = 'user_memories';
const MAX_PER_USER_PROJECT = 50;

function headers() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Prefer': 'return=representation'
  };
}

async function sbFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: headers(),
    ...options
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const { userId, project } = req.query;
      if (!userId) return res.status(400).json({ error: 'userId required' });

      // Fetch project-specific + cross-project memories in parallel
      const projectFilter = project
        ? `user_id=eq.${encodeURIComponent(userId)}&project=eq.${encodeURIComponent(project)}`
        : `user_id=eq.${encodeURIComponent(userId)}&project=is.null`;
      const crossFilter = `user_id=eq.${encodeURIComponent(userId)}&project=is.null`;

      const orderClause = '&order=importance.desc,accessed_at.desc&limit=30';

      const [projectRows, crossRows] = await Promise.all([
        sbFetch(`${TABLE}?${projectFilter}${orderClause}`),
        project ? sbFetch(`${TABLE}?${crossFilter}${orderClause}`) : Promise.resolve([])
      ]);

      // Merge, deduplicate by id, cap at 20
      const seen = new Set();
      const merged = [...projectRows, ...crossRows].filter(r => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return true;
      }).slice(0, 20);

      // Update accessed_at for fetched rows (fire-and-forget)
      const ids = merged.map(r => r.id);
      if (ids.length > 0) {
        fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=in.(${ids.join(',')})`, {
          method: 'PATCH',
          headers: headers(),
          body: JSON.stringify({ accessed_at: new Date().toISOString() })
        }).catch(() => {});
      }

      return res.status(200).json({ memories: merged });
    }

    if (req.method === 'POST') {
      const { userId, project, memory_type, content, importance, source_msg } = req.body || {};
      if (!userId || !content) return res.status(400).json({ error: 'userId and content required' });

      const row = {
        user_id: userId,
        project: project || null,
        memory_type: memory_type || 'fact',
        content: content.slice(0, 500),
        importance: Math.min(10, Math.max(1, importance || 5)),
        source_msg: source_msg ? source_msg.slice(0, 200) : null
      };

      // Enforce row cap: delete oldest low-importance rows if over limit
      const countFilter = project
        ? `user_id=eq.${encodeURIComponent(userId)}&project=eq.${encodeURIComponent(project)}`
        : `user_id=eq.${encodeURIComponent(userId)}&project=is.null`;
      const existing = await sbFetch(`${TABLE}?${countFilter}&order=importance.asc,accessed_at.asc&limit=${MAX_PER_USER_PROJECT + 1}`);
      if (existing.length >= MAX_PER_USER_PROJECT) {
        const toDelete = existing[0];
        await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${toDelete.id}`, {
          method: 'DELETE',
          headers: headers()
        });
      }

      const [saved] = await sbFetch(TABLE, {
        method: 'POST',
        body: JSON.stringify(row)
      });
      return res.status(201).json({ memory: saved });
    }

    if (req.method === 'DELETE') {
      const { id, userId } = req.query;
      if (!id || !userId) return res.status(400).json({ error: 'id and userId required' });

      await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: headers()
      });
      return res.status(200).json({ deleted: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[memory]', err);
    return res.status(500).json({ error: err.message });
  }
}
