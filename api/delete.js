/**
 * DELETE /api/delete?project=xxx[&file=yyy]
 * Deletes all chunks for a project, or a specific file within a project.
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });

  const { project, file } = req.query;
  if (!project) return res.status(400).json({ error: 'Thiếu tham số project' });

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY?.trim();
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'Thiếu Supabase config' });

  let url = `${supabaseUrl}/rest/v1/documents?project=eq.${encodeURIComponent(project)}`;
  if (file) url += `&file_name=eq.${encodeURIComponent(file)}`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Prefer: 'return=minimal'
    }
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    return res.status(500).json({ error: err.message || `Supabase delete lỗi: ${response.status}` });
  }

  return res.status(200).json({ ok: true });
};
